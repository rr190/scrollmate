"""The /ui reaction threshold: set, cleared, applied to reel lines, and passed to the extension. No provider calls."""
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import config, main
from app.models import LLMObserve


def observation(level=2):
    return LLMObserve(seen_now="a puppy jumps", topic="puppy", happening="a puppy jumps into snow", expected_next="",
                      moment_type="attempt", mood="funny", themes=[], confidence=0.95, change="major", emotion="laughing",
                      level=level, line="You could jump like that too!", next_look_at=5)


class ThresholdTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main._hits.clear()
        main._beliefs.clear()
        main.journal.clear()
        self.was = (config.MIN_IMPORTANCE, config.DEMO_MODE)
        config.set_demo(False)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")

    async def asyncTearDown(self):
        config.set_min_importance(self.was[0])
        config.set_demo(self.was[1])
        await self.client.aclose()

    async def settings(self, value):
        with patch.object(main.live, "reset", new=AsyncMock()), patch.object(main.config, "MOCK", True):
            return await self.client.post("/scrollmate/settings", json={"min_importance": value})

    async def observe(self, frequency="balanced", vid="t1"):
        nothing = AsyncMock(return_value=(main.ReactResponse(reactions=[]), "stub"))
        with patch.object(main.config, "MOCK", False), patch.object(main, "_vision_call", new=AsyncMock(return_value=(observation(), "stub"))), \
                patch.object(main, "_react", nothing):
            return (await self.client.post("/scrollmate/observe", json=dict(
                videoId=vid, frame="", frameTime=1, duration=10, title="puppy", frequency=frequency))).json()

    async def test_set_show_and_clear(self):
        self.assertEqual((await self.settings(0.8)).status_code, 200)
        self.assertEqual(config.MIN_IMPORTANCE, 0.8)
        self.assertEqual((await self.client.get("/scrollmate/settings")).json()["current"]["min_importance"], 0.8)
        await self.settings(-1)
        self.assertIsNone(config.MIN_IMPORTANCE)
        self.assertEqual((await self.settings(1.5)).status_code, 400)

    async def test_override_applies_to_reel_lines_and_reaches_the_extension(self):
        await self.settings(0.8)  # a normal (level 2, 0.65) line is now not interesting enough
        high = await self.observe("chatty", "t-high")
        self.assertEqual(high["reactions"], [])
        self.assertEqual(high["minImportance"], 0.8)
        await self.settings(0.5)  # now even Rare lets it through
        low = await self.observe("rare", "t-low")
        self.assertEqual(len(low["reactions"]), 1)

    async def test_without_override_the_frequency_decides(self):
        await self.settings(-1)
        self.assertEqual(len((await self.observe("balanced", "f-bal"))["reactions"]), 1)
        self.assertEqual((await self.observe("rare", "f-rare"))["reactions"], [])
        self.assertIsNone((await self.observe("chatty", "f-ch"))["minImportance"])


if __name__ == "__main__":
    unittest.main()
