"""Deterministic no-LLM fallback so the backend runs without any API key.

Text-only and heuristic: good enough to exercise the pipeline end to end,
clearly labelled `text_only` with low confidence.
"""

from __future__ import annotations

from .models import AnalyseRequest, LLMAnalysis, LLMReaction, LLMReactions, ReactRequest

TOPICS = {
    "baking": ["cake", "bake", "baking", "cookie", "bread", "dessert", "frosting", "glaze"],
    "cooking": ["recipe", "cook", "pasta", "chef", "kitchen", "food"],
    "pets": ["dog", "cat", "puppy", "kitten", "pet"],
    "fitness": ["gym", "workout", "lift", "run"],
    "gaming": ["game", "minecraft", "fortnite", "speedrun"],
    "diy": ["diy", "build", "craft", "hack"],
}
FAIL_WORDS = ["fail", "burnt", "burned", "disaster", "oops", "💀", "gone wrong", "tried"]


def analyse(req: AnalyseRequest) -> LLMAnalysis:
    text = f"{req.title} {' '.join(req.captions)}".lower()
    topic = next((t for t, kws in TOPICS.items() if any(k in text for k in kws)), "unknown")
    failed = any(w in text for w in FAIL_WORDS)
    themes = [topic] if topic != "unknown" else []
    themes += ["fail"] if failed else []
    return LLMAnalysis(
        topic=topic,
        summary=f'A Short titled "{req.title[:80]}".' if req.title else "A Short with no readable title.",
        events=[],
        outcome="It seems to go wrong." if failed else None,
        mood="fail" if failed else "unclear",
        themes=themes,
        confidence=0.45 if topic != "unknown" else 0.2,
    )


def react(req: ReactRequest) -> LLMReactions:
    cur = next((m for m in req.memory if m.video_id == req.current_video_id), None)
    if cur is None or cur.topic == "unknown":
        return LLMReactions(reactions=[])
    same = [m for m in req.memory if m.topic == cur.topic and not m.skipped]
    if len(same) >= 2:
        lines = {
            "witty": f"That's {len(same)} {cur.topic} Shorts in a row. We're basically enrolled now.",
            "hype": f"{len(same)} {cur.topic} Shorts back to back. THIS IS OUR ARC!",
            "chill": f"{cur.topic.capitalize()} again. I'm not complaining.",
        }
        return LLMReactions(reactions=[LLMReaction(text=lines[req.personality], importance=0.85, is_callback=True, preferred_timing="after_video")])
    if "fail" in cur.themes:
        lines = {
            "witty": "Bold of the title to admit it upfront.",
            "hype": "Respect for posting the fail, honestly!",
            "chill": "Happens to the best of us.",
        }
        return LLMReactions(reactions=[LLMReaction(text=lines[req.personality], importance=0.6, is_callback=False, preferred_timing="after_video")])
    return LLMReactions(reactions=[])
