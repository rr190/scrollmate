"""Session journal, reaction moves and the recall_history tool. Stubbed models: never contacts a provider."""
import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from app import main, tools
from app.journal import Journal, journal


def watched(j: Journal, vid: str, topic: str, feelings: list[str], line: str | None = None, move: str | None = None):
    j.start(vid, f"{topic} short")
    j.update(vid, topic, f"something with {topic}")
    for f in feelings:
        j.add_feeling(vid, f)
    if line:
        j.add_line(vid, line, move)


class DemoCallbackTests(unittest.TestCase):
    def test_demo_mode_opens_each_new_short_with_a_callback(self):
        from app import config
        j = Journal()
        watched(j, "a", "puppies", ["laughing"], "Puppies make my sprout wiggle!", "own_feeling")
        j.start("b", "I am your doggy")
        old = config.DEMO_MODE
        try:
            config.DEMO_MODE = True
            self.assertEqual(j.next_move("b", False), "connect")
            j.add_line("b", "You laughed at the puppy before!", "connect")
            self.assertNotEqual(j.next_move("b", False), "connect", "only the first line is forced")
            config.DEMO_MODE = False
            j.start("c", "another")
            j.move_history.append("connect")
            self.assertNotEqual(j.next_move("c", False), "connect", "normal rotation when demo is off")
        finally:
            config.DEMO_MODE = old

    def test_demo_mode_never_forces_a_callback_with_nothing_to_remember(self):
        from app import config
        j = Journal()
        j.start("first", "first ever")
        old = config.DEMO_MODE
        try:
            config.DEMO_MODE = True
            self.assertNotEqual(j.next_move("first", False), "connect")
        finally:
            config.DEMO_MODE = old


class JournalTests(unittest.TestCase):
    def test_compact_lists_earlier_shorts_and_patterns(self):
        j = Journal()
        watched(j, "a", "dogs", ["laughing"], "My sprout jumped!", "own_feeling")
        watched(j, "b", "cats", ["surprised"])
        watched(j, "c", "dogs", ["laughing", "happy"])
        j.start("d", "dog again")
        text = j.compact("d")
        self.assertIn("dogs: something with dogs", text)
        self.assertIn('You said "My sprout jumped!"', text)
        self.assertIn("the child laughed during 2 dogs Shorts", text)
        self.assertNotIn("dog again", text, "the current Short isn't listed as an earlier one")

    def test_compact_stays_small_with_20_shorts(self):
        j = Journal()
        for i in range(25):
            watched(j, f"v{i}", f"topic{i % 4}", ["laughing", "surprised"], "A fairly ordinary line from Mochi here.", "own_feeling")
        self.assertEqual(len(j.entries), 20, "keeps the last 20 Shorts")
        self.assertLess(len(j.compact("v24").split()), 260, "about 300 tokens or less")

    def test_streak_and_this_short_arc(self):
        j = Journal()
        for v in ("a", "b", "c"):
            watched(j, v, v, ["surprised"])
        self.assertIn("was surprised in the last 3 Shorts in a row", j.compact("z"))
        j.add_feeling("c", "laughing")
        self.assertIn("This Short so far, the child: was surprised -> laughed", j.compact("c"))

    def test_moves_rotate_never_repeat_and_questions_are_rare(self):
        j = Journal()
        watched(j, "a", "dogs", ["laughing"])
        j.start("b")
        seq = []
        for _ in range(12):
            m = j.next_move("b", has_feeling=True)
            seq.append(m)
            j.add_line("b", f"line {len(seq)}", m)
        self.assertTrue(all(x != y for x, y in zip(seq, seq[1:])), seq)
        for i in range(len(seq) - 2):
            self.assertLessEqual(seq[i:i + 3].count("question"), 1, seq)
        self.assertEqual(set(seq), {"own_feeling", "invite", "connect", "question"})

    def test_connect_needs_real_history_and_question_needs_a_feeling(self):
        j = Journal()
        j.start("first")
        moves = {j.next_move("first", has_feeling=False) for _ in range(3)}
        self.assertTrue(moves <= {"own_feeling", "invite"}, "nothing to connect to, no feeling to ask about")

    def test_recall_filters_and_clear(self):
        j = Journal()
        watched(j, "a", "dogs", ["laughing"])
        watched(j, "b", "cats", ["scared"])
        watched(j, "c", "dogs", ["sad"])
        self.assertEqual([r["topic"] for r in j.recall(topic="dog")], ["dogs", "dogs"])
        self.assertEqual([r["topic"] for r in j.recall(feeling="scared")], ["cats"])
        self.assertEqual(len(j.recall(n=1)), 1)
        j.clear()
        self.assertEqual(j.recall(), [])
        self.assertIn("(none yet)", j.compact("x"))


class TalkToTheChildTests(unittest.TestCase):
    def test_shown_line_without_a_move_is_matched_by_text(self):
        j = Journal()
        j.start("a")
        j.note_proposed("You could paint that!", "invite")
        j.add_line("a", "You could paint that!")  # an older extension sends no move
        self.assertEqual(j.move_history, ["invite"])

    def test_repeated_openings_are_listed_to_avoid(self):
        j = Journal()
        j.start("a")
        for line in ("I'm curious about that pink edge.", "I'm curious what's next!", "Does the cheese look yummy?"):
            j.add_line("a", line, "own_feeling")
        self.assertEqual(j.used_openings(), ["I'm curious", "Does the"])


class JournalApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main._hits.clear()
        main._beliefs.clear()
        journal.clear()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        journal.clear()

    async def test_events_fill_the_journal_and_clear_empties_it(self):
        await self.client.post("/scrollmate/events", json=[
            {"type": "short_started", "videoId": "v1", "title": "Puppy in snow"},
            {"type": "user", "expression": "laughing", "present": True, "lookingAway": False},
            {"type": "delivered", "videoId": "v1", "text": "My sprout shot up!", "move": "own_feeling"},
            {"type": "short_left", "videoId": "v1", "secondsWatched": 9, "skipped": False},
        ])
        e = journal.entries["v1"]
        self.assertEqual(e.feeling_labels(), ["laughing"])
        self.assertEqual(e.lines, ["My sprout shot up!"])
        self.assertEqual(journal.move_history, ["own_feeling"])
        self.assertEqual(e.seconds_watched, 9)
        await self.client.post("/scrollmate/journal/clear")
        self.assertEqual(len(journal.entries), 0)

    async def test_lines_carry_their_move_and_the_prompt_carries_the_memory(self):
        watched(journal, "old", "dogs", ["laughing"], "Zoomies!", "own_feeling")
        captured = {}

        async def fake_text(model_cls, messages, **kw):
            captured["user"] = messages[1]["content"]
            return SimpleNamespace(emotion="laughing", reaction=SimpleNamespace(
                text="Another dog, you're a dog fan for sure!", importance=0.8, preferred_timing="now")), "stub"

        with patch.object(main.config, "MOCK", False), patch.object(main, "_text_call", new=fake_text):
            res = await self.client.post("/scrollmate/caption", json=dict(
                videoId="new", lines=["he did zoomies"], title="Dog zoomies", viewerFeeling="laughing", frequency="chatty"))
        data = res.json()
        self.assertEqual(data["reactions"][0]["move"], "invite", "least recently used after own_feeling")
        self.assertIn('You said "Zoomies!"', captured["user"])
        self.assertIn("Move for this line: INVITE", captured["user"])
        self.assertIn("talks TO the child", captured["user"])
        self.assertEqual(journal.entries["new"].feeling_labels(), ["laughing"])


class RecallToolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        journal.clear()
        watched(journal, "a", "dogs", ["laughing"], "Zoomies!", "own_feeling")
        self.messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]

    async def asyncTearDown(self):
        journal.clear()

    def reply(self, calls):
        msg = SimpleNamespace(tool_calls=calls)
        return SimpleNamespace(choices=[SimpleNamespace(message=msg)])

    async def test_tool_call_appends_the_history(self):
        call = SimpleNamespace(function=SimpleNamespace(name="recall_history", arguments=json.dumps({"topic": "dog"})))
        with patch.object(tools.config, "MOCK", False), patch("litellm.acompletion", new=AsyncMock(return_value=self.reply([call]))):
            msgs, looked = await tools.maybe_recall(self.messages, "openai/test")
        self.assertIn("recall_history", msgs[-1]["content"])
        self.assertIn("Zoomies!", msgs[-1]["content"])
        self.assertEqual(looked, "dog (1 found)")

    async def test_no_tool_call_or_slow_step_or_mock_leaves_the_prompt_alone(self):
        with patch.object(tools.config, "MOCK", False), patch("litellm.acompletion", new=AsyncMock(return_value=self.reply(None))):
            self.assertEqual(await tools.maybe_recall(self.messages, "openai/test"), (self.messages, None))

        async def slow(**kw):
            await asyncio.sleep(1)
        with patch.object(tools.config, "MOCK", False), patch("litellm.acompletion", new=slow):
            self.assertEqual(await tools.maybe_recall(self.messages, "openai/test", timeout=0.05), (self.messages, None))
        with patch.object(tools.config, "MOCK", True):
            self.assertEqual(await tools.maybe_recall(self.messages, "openai/test"), (self.messages, None))


if __name__ == "__main__":
    unittest.main()
