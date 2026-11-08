"""The /ui "Knowing when to talk" panel reads the saved timing evaluation."""
import unittest

import httpx

from app import main


class EvalPanelTests(unittest.IsolatedAsyncioTestCase):
    async def test_saved_results_are_served_with_the_numbers_the_panel_needs(self):
        if not main._EVAL_RESULTS.exists():
            self.skipTest("run `npm run eval` in extension/ first")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t") as c:
            d = (await c.get("/scrollmate/eval")).json()
        self.assertEqual(d["kind"], "scripted simulation")
        for policy in ("naive", "scrollmate"):
            for key in ("interruptions", "stale", "duplicates", "callbacksDelivered"):
                self.assertIn(key, d["average"][policy])
        self.assertLess(d["average"]["scrollmate"]["interruptions"], d["average"]["naive"]["interruptions"])

    async def test_eval_has_its_own_page_linked_from_ui(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://t") as c:
            page = await c.get("/ui/eval")
            ui = (await c.get("/ui")).text
        self.assertEqual(page.status_code, 200)
        self.assertIn("Knowing When To Talk", page.text)
        self.assertIn('href="/ui/eval"', ui)
        self.assertNotIn("evalCards", ui, "the panel moved off the playground")


if __name__ == "__main__":
    unittest.main()
