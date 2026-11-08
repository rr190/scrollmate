"""Reel comment generation and recovery, with stubbed models and no provider requests."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import main
from app.models import LLMObserve, ReactionCandidate, ReactResponse


def observation(**changes):
    return LLMObserve(**{
        "seen_now": "A cake is being covered with purple frosting.", "topic": "cake decorating",
        "happening": "Purple frosting is being spread over a small cake.", "expected_next": "decorations",
        "moment_type": "tutorial", "mood": "wholesome", "themes": ["cake"], "confidence": .95,
        "change": "minor", "emotion": "happy", "level": 1, "next_look_at": 15,
        **changes,
    })


class ObserveReactionsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main._beliefs.clear()
        main._hits.clear()
        main.journal.clear()
        self._no_tool = patch.object(main, "maybe_recall", new=AsyncMock(side_effect=lambda m, *a, **k: (m, None)))
        self._no_tool.start()
        self.addCleanup(self._no_tool.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")
        self.vision = AsyncMock(return_value=(observation(), "stub vision"))
        self.comments = AsyncMock(return_value=(ReactResponse(reactions=[ReactionCandidate(
            text="That frosting is doing all the work.", importance=.85, target_video_id="reel-1",
        )]), "stub text"))
        self.patches = [patch.object(main.config, "MOCK", False), patch.object(main, "_vision_call", self.vision),
                        patch.object(main, "_react", self.comments)]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        for item in reversed(self.patches):
            item.stop()
        await self.client.aclose()

    async def frame(self, index, **changes):
        response = await self.client.post("/scrollmate/observe", json={
            "videoId": "reel-1", "frame": "local-test-frame", "frameTime": index * 3,
            "duration": 30, "frameIndex": index, "maxFrames": 4, "frequency": "balanced", **changes,
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_face_only_scene_gets_one_grounded_comment_check(self):
        self.assertEqual((await self.frame(1))["reactions"], [])
        self.comments.assert_not_awaited()
        second = await self.frame(2)
        line = second["reactions"][0]
        self.assertEqual(line["targetVideoId"], "reel-1")
        self.assertEqual(line["preferredTiming"], "now")
        self.assertFalse(line["requiresQuietMoment"])
        self.assertEqual(second["emotion"], "happy")
        request = self.comments.await_args.args[0]
        self.assertEqual(request.memory[-1].summary, "Purple frosting is being spread over a small cake.")
        await self.frame(3)
        self.assertEqual(self.comments.await_count, 1)
        self.assertEqual(self.vision.await_count, 3, "no additional image analysis")

    async def test_vision_line_does_not_trigger_an_extra_comment(self):
        self.vision.return_value = (observation(level=2, line="Purple was the right choice."), "stub vision")
        self.assertEqual(len((await self.frame(1))["reactions"]), 1)
        self.vision.return_value = (observation(), "stub vision")
        await self.frame(2)
        self.comments.assert_not_awaited()

    async def test_unknown_low_confidence_and_text_only_scenes_do_not_get_fallback_lines(self):
        for raw, frame in [(observation(confidence=.4), "test"), (observation(topic="unknown"), "test"),
                           (observation(), "")]:
            main._beliefs.clear()
            self.vision.return_value = (raw, "stub vision")
            await self.frame(1, frame=frame)
            self.assertEqual((await self.frame(2, frame=frame))["reactions"], [])
        self.comments.assert_not_awaited()

    async def test_rare_waits_until_final_and_keeps_its_importance_threshold(self):
        await self.frame(1, frequency="rare", maxFrames=2)
        self.comments.assert_not_awaited()
        result = await self.frame(2, frequency="rare", maxFrames=2)
        self.assertEqual(len(result["reactions"]), 1)
        self.assertEqual(self.comments.await_args.args[0].frequency, "rare")
        main._beliefs.clear()
        self.comments.return_value[0].reactions[0].importance = .65
        await self.frame(1, frequency="rare", maxFrames=2)
        self.assertEqual((await self.frame(2, frequency="rare", maxFrames=2))["reactions"], [])

    async def test_comment_timeout_keeps_the_face_and_does_not_repeat_requests(self):
        self.comments.side_effect = asyncio.TimeoutError
        await self.frame(1)
        result = await self.frame(2)
        self.assertEqual(result["emotion"], "happy")
        self.assertEqual(result["reactions"], [])
        self.assertIsNone(result["error"])
        await self.frame(3)
        self.assertEqual(self.comments.await_count, 1)

    async def test_a_vision_line_filtered_by_rare_does_not_prevent_the_final_comment_check(self):
        self.vision.return_value = (observation(level=2, line="Purple was the right choice."), "stub vision")
        self.assertEqual((await self.frame(1, frequency="rare", maxFrames=2))["reactions"], [])
        self.comments.assert_not_awaited()
        result = await self.frame(2, frequency="rare", maxFrames=2)
        self.assertEqual(result["reactions"][0]["importance"], .85)
        self.assertEqual(self.comments.await_count, 1)

    async def test_model_can_choose_silence_without_getting_asked_every_frame(self):
        self.comments.return_value = (ReactResponse(), "stub text")
        await self.frame(1)
        await self.frame(2)
        await self.frame(3)
        self.assertEqual(self.comments.await_count, 1)

    async def test_failed_observation_returns_retry_information_instead_of_silent_completion(self):
        self.vision.return_value = (None, None)
        result = await self.frame(1)
        self.assertIsNotNone(result["error"])
        self.assertFalse(result["final"])
        self.assertEqual(result["nextCaptureAt"], 6)
        final = await self.frame(4)
        self.assertTrue(final["final"])
        self.assertIsNone(final["nextCaptureAt"])
        self.comments.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
