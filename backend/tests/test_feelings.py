"""Feeling-notice API checks with stubbed model output; never contacts a provider."""
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import main
from app.models import Belief, LLMFeelingLine
from app.prompts import feeling_messages

FEELINGS = ["happy", "laughing", "surprised", "sad", "scared", "confused", "disgusted", "angry"]


class FeelingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main._hits.clear()
        main.journal.clear()
        self._no_tool = patch.object(main, "maybe_recall", new=AsyncMock(side_effect=lambda m, *a, **k: (m, None)))
        self._no_tool.start()
        self.addCleanup(self._no_tool.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def post(self, expression="happy", result=None, mock=False, **extra):
        payload = dict(videoId="video-1", expression=expression, personality="hype", **extra)
        with patch.object(main.config, "MOCK", mock), patch.object(main, "_text_call", new=AsyncMock(return_value=(result, "groq/test"))):
            return await self.client.post("/scrollmate/feeling", json=payload)

    async def test_mock_mode_gives_a_kind_fallback_for_every_feeling(self):
        for expression in FEELINGS:
            data = (await self.post(expression, mock=True)).json()
            self.assertTrue(data["line"], expression)
            self.assertEqual(data["source"], "fallback")
            self.assertTrue(main.kid_safe(data["line"]), data["line"])
            self.assertIn(data["emotion"], main.EMOTIONS if isinstance(main.EMOTIONS, (set, dict, list)) else [data["emotion"]])

    async def test_ai_line_is_used_when_safe(self):
        data = (await self.post("surprised", LLMFeelingLine(line="Whoa, did the jump surprise you too?!", emotion="surprised"))).json()
        self.assertEqual(data["source"], "ai")
        self.assertEqual(data["line"], "Whoa, did the jump surprise you too?!")

    async def test_unsafe_or_watching_lines_fall_back(self):
        for text in ("I can see your face on my camera!", "You look sick, go to the hospital", "haha you crybaby"):
            data = (await self.post("sad", LLMFeelingLine(line=text, emotion="sad"))).json()
            self.assertEqual(data["source"], "fallback", text)
            self.assertNotEqual(data["line"], text)

    async def test_long_lines_are_trimmed_to_12_words(self):
        long = "You are smiling so much right now, did the puppy in the snow make you really really happy today?"
        data = (await self.post("happy", LLMFeelingLine(line=long, emotion="happy"))).json()
        self.assertLessEqual(len(data["line"].split()), 12)

    async def test_failed_or_silent_model_falls_back(self):
        for result in (None, LLMFeelingLine()):
            data = (await self.post("laughing", result)).json()
            self.assertEqual(data["source"], "fallback")
            self.assertTrue(data["line"])

    async def test_unknown_expression_is_rejected(self):
        self.assertEqual((await self.post("neutral")).status_code, 422)
        self.assertEqual((await self.post("bored")).status_code, 422)

    async def test_feed_gets_the_label_but_not_the_line(self):
        with patch.object(main.feed, "publish") as publish:
            data = (await self.post("happy", LLMFeelingLine(line="Was the puppy that funny? 😄", emotion="happy"))).json()
        args = str(publish.call_args_list)
        self.assertIn("happy", args)
        self.assertNotIn(data["line"], args)

    def test_prompt_includes_the_short_when_known_and_asks_not_tells(self):
        messages = feeling_messages("happy", "Puppy meets snow", "dogs: a puppy jumps into deep snow", "hype")
        data = json.loads(messages[1]["content"].splitlines()[0])
        self.assertEqual(data["feeling"], "happy")
        self.assertIn("puppy", data["short_context"])
        self.assertIn("Never state their feeling as a fact", messages[0]["content"])
        self.assertIn("Never mention cameras", messages[0]["content"])

    async def test_server_uses_the_belief_when_the_extension_sends_no_summary(self):
        main._beliefs["video-1"] = Belief(video_id="video-1", topic="dogs", happening="a puppy jumps into snow")
        call = AsyncMock(return_value=(LLMFeelingLine(line="Was the puppy that funny?", emotion="happy"), "groq/test"))
        with patch.object(main.config, "MOCK", False), patch.object(main, "_text_call", new=call):
            await self.client.post("/scrollmate/feeling", json=dict(videoId="video-1", expression="happy"))
        sent = json.loads(call.call_args.args[1][1]["content"].splitlines()[0])
        self.assertIn("puppy", sent["short_context"])
        main._beliefs.pop("video-1", None)


if __name__ == "__main__":
    unittest.main()
