"""Cross-feature stress: every endpoint at once, interleaved, in mock mode. Never contacts a provider."""
import asyncio
import random
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app import main


def _memory(i: int) -> list[dict]:
    return [{"videoId": f"mem-{i}-{k}", "topic": "cake", "summary": "a cake", "themes": ["baking"]} for k in range(3)]


class StressTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        main._hits.clear()
        main.journal.clear()
        main._beliefs.clear()
        for p in (
            patch.object(main.config, "MOCK", True),
            patch.object(main.config, "RATE_LIMIT_PER_MIN", 100_000),
            patch.object(main, "maybe_recall", new=AsyncMock(side_effect=lambda m, *a, **k: (m, None))),
        ):
            p.start()
            self.addCleanup(p.stop)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    def _requests(self, rng: random.Random, n: int):
        """A random mix of what the extension sends when every feature is on."""
        for i in range(n):
            vid = f"video-{rng.randrange(40):03d}"
            kind = rng.choice(["swipe", "observe", "observe", "caption", "comment", "feeling", "react", "events", "clear", "analyse"])
            if kind == "swipe":
                yield kind, "/scrollmate/swipe", {"videoId": vid, "title": "I tried baking a cake", "memory": _memory(i)}
            elif kind == "observe":
                yield kind, "/scrollmate/observe", {"videoId": vid, "frameTime": rng.uniform(0, 30), "duration": 30,
                    "frameIndex": rng.randint(1, 12), "title": "cake", "captions": ["wow"], "memory": _memory(i),
                    "viewerFeeling": rng.choice([None, "happy", "laughing"]), "frequency": rng.choice(["rare", "balanced", "chatty"])}
            elif kind == "caption":
                yield kind, "/scrollmate/caption", {"videoId": vid, "lines": ["it collapsed!"], "currentTime": 3.2, "memory": _memory(i)}
            elif kind == "comment":
                yield kind, "/scrollmate/comment", {"requestId": f"r{i}", "videoId": vid, "commentId": f"c{i}",
                    "text": "That cake is a building now.", "previousComments": [{"text": "first", "reaction": "ha"}] * 5}
            elif kind == "feeling":
                yield kind, "/scrollmate/feeling", {"videoId": vid, "expression": rng.choice(["happy", "sad", "surprised", "laughing"])}
            elif kind == "react":
                yield kind, "/scrollmate/react", {"currentVideoId": vid, "memory": _memory(i)}
            elif kind == "analyse":
                yield kind, "/scrollmate/analyse", {"videoId": vid, "title": "cake", "captions": ["hi"]}
            elif kind == "events":
                yield kind, "/scrollmate/events", [{"type": "decision", "videoId": vid, "decision": "WAIT", "reason": "x"},
                                                   {"type": "user", "videoId": vid, "present": True, "expression": "neutral"}]
            else:
                yield kind, "/scrollmate/journal/clear", {}

    async def test_all_features_concurrently_never_error(self):
        rng = random.Random(7)
        reqs = list(self._requests(rng, 600))
        sem = asyncio.Semaphore(60)  # sixty requests in flight at a time

        async def go(kind, path, body):
            async with sem:
                return kind, await self.client.post(path, json=body)

        results = await asyncio.gather(*(go(*r) for r in reqs))
        bad = [(k, r.status_code, r.text[:200]) for k, r in results if r.status_code != 200]
        self.assertEqual(bad, [], f"{len(bad)} failed requests, first: {bad[:3]}")
        for kind, r in results:
            data = r.json()
            if kind == "comment":
                self.assertTrue(data["requestId"].startswith("r"))
            if kind in ("observe", "caption", "react", "comment"):
                self.assertIsInstance(data.get("reactions", []), list)
        # Per-video state stays bounded however many Shorts are interleaved.
        self.assertLessEqual(len(main._beliefs), main.BELIEFS_MAX)

    async def test_same_short_frames_race_without_corrupting_the_belief(self):
        bodies = [{"videoId": "same-video", "frameTime": t / 2, "duration": 20, "frameIndex": min(12, t % 12 + 1), "title": "cake"}
                  for t in range(40)]
        results = await asyncio.gather(*(self.client.post("/scrollmate/observe", json=b) for b in bodies))
        self.assertTrue(all(r.status_code == 200 for r in results))
        belief = main._beliefs["same-video"]
        self.assertLessEqual(len(belief.events), 12, "belief events must stay bounded under concurrent frames")

    async def test_model_path_frames_and_comments_interleave_with_slow_answers(self):
        """Non-mock path: vision answers arrive out of order while comments, captions and clears run alongside."""
        from app.models import LLMObserve
        rng = random.Random(3)

        async def slow_vision(*_a, **_k):
            await asyncio.sleep(rng.uniform(0, 0.05))
            return LLMObserve(seen_now="a cake leaning", topic="cake", happening="A cake is built.", moment_type="attempt",
                              mood="funny", confidence=0.9, change="minor", emotion=rng.choice(["laughing", "surprised"]),
                              level=rng.choice([1, 2, 3]), line=f"that cake has plans {rng.random():.4f}", next_look_at=5), "stub/vision"

        async def go(path, body):
            return await self.client.post(path, json=body)

        with patch.object(main.config, "MOCK", False), patch.object(main, "_vision_call", new=slow_vision), \
             patch.object(main, "_text_call", new=AsyncMock(return_value=(None, None))):  # structured() degrades to None, never raises
            calls = []
            for i in range(120):
                vid = f"model-{i % 5}"
                calls.append(go("/scrollmate/observe", {"videoId": vid, "frame": "aGk=", "frameTime": i % 20, "duration": 20,
                                                       "frameIndex": i % 12 + 1, "title": "cake"}))
                if i % 4 == 0:
                    calls.append(go("/scrollmate/comment", {"requestId": f"m{i}", "videoId": vid, "commentId": "c", "text": "lol"}))
                if i % 7 == 0:
                    calls.append(go("/scrollmate/caption", {"videoId": vid, "lines": ["oh no"]}))
                if i % 30 == 0:
                    calls.append(go("/scrollmate/journal/clear", {}))
            results = await asyncio.gather(*calls)
        bad = [(r.request.url.path, r.status_code, r.text[:200]) for r in results if r.status_code != 200]
        self.assertEqual(bad, [], f"first failures: {bad[:3]}")
        for r in results:
            if r.request.url.path.endswith("/comment"):
                self.assertEqual(r.json()["reactions"], [], "a failed comment model call degrades to silence")
        for k in range(5):
            b = main._beliefs[f"model-{k}"]
            self.assertLessEqual(len(b.events), 4)
            self.assertEqual(b.topic, "cake")

    async def test_burst_is_rate_limited_cleanly_not_crashing(self):
        with patch.object(main.config, "RATE_LIMIT_PER_MIN", 40):
            main._hits.clear()
            codes = [r.status_code for r in await asyncio.gather(*(
                self.client.post("/scrollmate/feeling", json={"videoId": "v-burst", "expression": "happy"}) for _ in range(60)))]
        self.assertEqual(codes.count(200), 40)
        self.assertEqual(codes.count(429), 20)

    async def test_hostile_inputs_are_rejected_not_500(self):
        cases = [
            ("/scrollmate/observe", {"videoId": "x" * 65}),
            ("/scrollmate/observe", {"videoId": "v", "frameIndex": 0}),
            ("/scrollmate/caption", {"videoId": "v", "lines": []}),
            ("/scrollmate/comment", {"requestId": "r", "videoId": "v", "commentId": "c", "text": "x" * 1201}),
            ("/scrollmate/comment", {"requestId": "r", "videoId": "v", "commentId": "c", "text": "hi", "previousComments": [{"text": "a"}] * 6}),
            ("/scrollmate/feeling", {"videoId": "v", "expression": "furious"}),
            ("/scrollmate/swipe", {"videoId": "v", "memory": _memory(0) + _memory(1)}),
            ("/scrollmate/events", {"not": "a list"}),
        ]
        for path, body in cases:
            r = await self.client.post(path, json=body)
            self.assertEqual(r.status_code, 422, f"{path} {list(body)} -> {r.status_code}")


if __name__ == "__main__":
    unittest.main()
