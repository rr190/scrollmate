"""The child's feeling blended into reel comments (observe / caption / react). Stubbed models, no provider calls."""
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import main
from app.models import Belief, CaptionRequest, LLMObserve, ObserveRequest, ReactRequest, ReactResponse
from app.prompts import caption_messages, observe_messages, react_messages


def observation(line: str, level: int = 2):
    return LLMObserve(
        seen_now="A puppy leaps into deep snow.", topic="puppy", happening="A puppy jumps into snow.",
        expected_next="it pops back up", moment_type="attempt", mood="funny", themes=["dog"], confidence=0.95,
        change="major", emotion="laughing", level=level, line=line, next_look_at=None,
    )


def text_of(messages) -> str:
    content = messages[1]["content"]
    return content if isinstance(content, str) else " ".join(p.get("text", "") for p in content if isinstance(p, dict))


class BlendPromptTests(unittest.TestCase):
    def test_note_only_when_a_feeling_is_sent(self):
        b = Belief(video_id="v1")
        with_f = observe_messages(ObserveRequest(video_id="v1", title="Puppy in snow", viewer_feeling="laughing"), b)
        without = observe_messages(ObserveRequest(video_id="v1", title="Puppy in snow"), b)
        self.assertIn("The child watching seems laughing", text_of(with_f))
        self.assertNotIn("child watching", text_of(without))

    def test_caption_and_react_paths_carry_it_too(self):
        cap = caption_messages(CaptionRequest(video_id="v1", lines=["no way"], viewer_feeling="surprised"))
        self.assertIn("seems surprised", text_of(cap))
        react = react_messages(ReactRequest(current_video_id="v1", viewer_feeling="happy"))
        self.assertIn("seems happy", text_of(react))
        self.assertIn("Move for this line", text_of(react))


class GentleTests(unittest.TestCase):
    def test_note_names_the_childs_own_feeling(self):
        from app.prompts import viewer_feeling_note
        self.assertIn("a bit sad", viewer_feeling_note("sad"))
        self.assertNotIn("surprise", viewer_feeling_note("sad"))
        self.assertIn("no jokes", viewer_feeling_note("scared"))
        self.assertNotIn("no jokes", viewer_feeling_note("laughing"))

    def test_mochi_never_laughs_or_cringes_while_the_child_looks_upset(self):
        self.assertEqual(main.gentle_face("laughing", "sad"), "love")
        self.assertEqual(main.gentle_face("cringe", "scared"), "worried")
        self.assertEqual(main.gentle_face("surprised", "sad"), "surprised")
        self.assertEqual(main.gentle_face("laughing", "laughing"), "laughing")
        self.assertEqual(main.gentle_face("laughing", None), "laughing")


class BlendObserveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main._beliefs.clear()
        main._hits.clear()
        main.journal.clear()
        self._no_tool = patch.object(main, "maybe_recall", new=AsyncMock(side_effect=lambda m, *a, **k: (m, None)))
        self._no_tool.start()
        self.addCleanup(self._no_tool.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def observe(self, line: str, feeling: str | None):
        body = dict(videoId="reel-1", frame="", frameTime=2, duration=10, frameIndex=1, maxFrames=4,
                    title="Puppy jumps into snow", personality="hype", frequency="balanced")
        if feeling:
            body["viewerFeeling"] = feeling
        vision = AsyncMock(return_value=(observation(line), "stub vision"))
        no_text = AsyncMock(return_value=(ReactResponse(reactions=[]), "stub text"))  # never call a real provider
        with patch.object(main.config, "MOCK", False), patch.object(main, "_vision_call", vision), patch.object(main, "_react", no_text):
            res = await self.client.post("/scrollmate/observe", json=body)
        return res, vision

    async def test_blended_line_is_shown_and_feeling_reaches_the_model(self):
        res, vision = await self.observe("Did the puppy's flop make you laugh too? 😄", "laughing")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["reactions"][0]["text"], "Did the puppy's flop make you laugh too? 😄")
        self.assertIn("seems laughing", text_of(vision.call_args.args[0]))

    async def test_with_a_feeling_lines_about_their_face_are_blocked(self):
        res, _ = await self.observe("I can see your face laughing!", "laughing")
        self.assertEqual(res.json()["reactions"], [])

    async def test_without_a_feeling_normal_reel_lines_still_work(self):
        res, vision = await self.observe("bring the whole snowbank!", None)
        self.assertEqual(len(res.json()["reactions"]), 1)
        self.assertNotIn("child watching", text_of(vision.call_args.args[0]))

    async def test_invalid_feeling_label_is_rejected(self):
        res, _ = await self.observe("ok", "furious-ish")
        self.assertEqual(res.status_code, 422)


if __name__ == "__main__":
    unittest.main()
