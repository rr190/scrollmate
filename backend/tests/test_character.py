"""One character in every feature, talking to a child of the configured age. Never contacts a provider."""
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import config, gemini_live, main
from app.character import character_block
from app.models import Belief, CaptionRequest, CommentRequest, ObserveRequest, ReactRequest, SwipeRequest
from app.prompts import (
    caption_messages, comment_messages, feeling_messages, observe_messages, react_messages, swipe_messages,
)

CORE_LINE = "You are the buddy: a small cartoon friend watching YouTube Shorts WITH a child"


def systems(personality="witty"):
    b = Belief(video_id="v")
    return {
        "react": react_messages(ReactRequest(current_video_id="v", personality=personality))[0]["content"],
        "caption": caption_messages(CaptionRequest(video_id="v", lines=["hi"], personality=personality))[0]["content"],
        "comment": comment_messages(CommentRequest(request_id="r", video_id="v", comment_id="c", text="nice", personality=personality))[0]["content"],
        "feeling": feeling_messages("happy", "t", "", personality, "v")[0]["content"],
        "observe": observe_messages(ObserveRequest(video_id="v", personality=personality), b)[0]["content"],
        "live": gemini_live._system(),
        "live_turn": character_block(personality),
    }


class CharacterTests(unittest.TestCase):
    def setUp(self):
        self.age = (config.AUDIENCE_MIN, config.AUDIENCE_MAX)
        config.set_audience(5, 9)
        main.journal.clear()

    def tearDown(self):
        config.set_audience(*self.age)

    def test_every_feature_uses_the_same_character_and_age(self):
        for name, text in systems().items():
            with self.subTest(name):
                self.assertIn(CORE_LINE, text)
                self.assertIn("a child aged 5-9", text)
                self.assertIn("At most one emoji in a line", text)
                for old in ("You are ScrollMate", "You are Mochi", "the user", "The user"):
                    self.assertNotIn(old, text)

    def test_swipe_talks_about_the_child_too(self):
        text = " ".join(m["content"] for m in swipe_messages(SwipeRequest(video_id="v", title="t")))
        self.assertIn("the buddy", text)
        self.assertNotIn("the user", text)

    def test_personalities_only_change_the_energy(self):
        blocks = {p: character_block(p) for p in ("witty", "hype", "chill")}
        cores = {b.split("Your personality right now:")[0] for b in blocks.values()}
        self.assertEqual(len(cores), 1, "same character for every personality")
        self.assertEqual(len(set(blocks.values())), 3)

    def test_age_change_reaches_the_prompts(self):
        config.set_audience(8, 12)
        self.assertIn("a child aged 8-12", systems()["observe"])
        self.assertIn("an 8-year-old", systems()["observe"])
        self.assertNotIn("a 8-year-old", systems()["observe"])

    def test_kid_filter(self):
        self.assertTrue(main.kid_safe("Look at that baby goat jump!"))
        self.assertFalse(main.kid_safe("That looked so dead scary"))


class AudienceSettingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.age = (config.AUDIENCE_MIN, config.AUDIENCE_MAX)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")

    async def asyncTearDown(self):
        config.set_audience(*self.age)
        await self.client.aclose()

    async def post(self, audience):
        with patch.object(main.live, "reset", new=AsyncMock()), patch.object(main.config, "MOCK", True):
            return await self.client.post("/scrollmate/settings", json={"audience": audience})

    async def test_valid_age_range_is_applied_and_shown(self):
        res = await self.post("6-8")
        self.assertEqual(res.status_code, 200)
        self.assertEqual((config.AUDIENCE_MIN, config.AUDIENCE_MAX), (6, 8))
        self.assertEqual((await self.client.get("/scrollmate/settings")).json()["current"]["audience"], "6-8")

    async def test_bad_ranges_are_rejected(self):
        for bad in ("9-5", "2-20", "abc"):
            self.assertEqual((await self.post(bad)).status_code, 400, bad)

    async def test_plain_reel_comment_path_is_kid_filtered(self):
        from app.models import LLMObserve
        main.journal.clear()
        obs = LLMObserve(seen_now="a skater falls", topic="skate", happening="a skater falls", expected_next="", moment_type="attempt",
                         mood="fail", themes=[], confidence=0.95, change="major", emotion="surprised", level=2,
                         line="He's dead, that hurt so much!", next_look_at=None)
        no_text = AsyncMock(return_value=(main.ReactResponse(reactions=[]), "stub"))
        with patch.object(main.config, "MOCK", False), patch.object(main, "_vision_call", new=AsyncMock(return_value=(obs, "stub"))), \
                patch.object(main, "_react", no_text), patch.object(main, "maybe_recall", new=AsyncMock(side_effect=lambda m, *a, **k: (m, None))):
            res = await self.client.post("/scrollmate/observe", json=dict(videoId="k1", frame="", frameTime=1, duration=10, title="skate"))
        self.assertEqual(res.json()["reactions"], [], "no feeling attached, still kid-filtered")


if __name__ == "__main__":
    unittest.main()
