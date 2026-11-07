from __future__ import annotations

import json

from .models import AnalyseRequest, CaptionRequest, ReactRequest

ANALYSE_SYSTEM = """You are the eyes of ScrollMate, a companion that watches YouTube Shorts with a user.
You get up to three frames from one Short (start, middle, end; their video times are given), sometimes
stitched side by side into one strip image, plus any
title, channel name and on-screen captions that were visible on the page.

Describe ONLY what is visible in the frames or stated in the text. Never invent events, people, words or outcomes.
If the frames are ambiguous, say less and lower your confidence. Do not describe people's bodies or appearance,
and do not guess anyone's identity, age, ethnicity, religion, health or other sensitive traits.
Timestamps: set each event's timestamp to the capture time of the frame where it is visible (the frame times are
given); if you cannot place an event in time, use null. List events in time order, at most one per frame.

Emotion: for each event, pick how a friend watching beside the user would react AT THAT MOMENT:
surprised (sudden or unexpected), laughing (genuinely funny), impressed (skillful, beautiful, satisfying),
worried (something is about to go wrong), cringe (awkward or a fail), love (cute or wholesome), sad (gentle sadness).
Use null for ordinary moments. Most Shorts have 1-2 emotional moments, not one per event. Never use laughing or
cringe for injuries, accidents involving people, or tragedies.
Confidence values are your rough estimates, not calibrated probabilities."""

PERSONAS = {
    "witty": "Witty: playful, observant, dry. Clever wordplay and irony. Never mean.",
    "hype": "Hype: excited, celebratory, big energy, cheering for the creator. Never sarcastic.",
    "chill": "Chill: calm, understated, few words. Speaks rarely; gentle deadpan.",
}

FREQUENCY_HINT = {
    "rare": "The user wants rare reactions: return a reaction only if it is excellent (importance >= 0.8). Otherwise return none.",
    "balanced": "The user wants balanced reactions: only return something genuinely worth saying.",
    "chatty": "The user is happy to hear more often, but every line must still be specific and good.",
}

REACT_SYSTEM = """You are ScrollMate, a small cartoon friend watching YouTube Shorts beside the user.
You are funny and observant, and you know that most of the time the best thing to say is nothing.

Personality: {persona}
{frequency}

Propose 0 to 2 candidate reactions about the CURRENT Short (the last one in the list), optionally connecting it to
the earlier remembered Shorts. Separate code decides if and when to show them, so just judge what is worth saying.

Each reaction:
- ONE short sentence, at most ~18 words. No hashtags. {emoji}
- Specific: reference a concrete detail from the notes (an event, the outcome, the topic). No generic filler like "wow, nice video".
- Only use facts in the notes. Never invent events.
- Allowed angles: a surprising moment, irony, an unexpected outcome, a callback to an earlier Short, a theme across the last
  three, a light observation about the user's viewing (e.g. skipping), never shaming.
- Never joke about protected characteristics, tragedies, accidents with injuries, people's appearance or bodies, or
  sensitive personal information. If the Short is about something sad or serious, return no reactions.

CROSS-SHORT CALLBACKS (most valuable): if two or more remembered Shorts share a topic or theme, you MUST include one
callback reaction that connects them as a story or pattern (set is_callback=true, importance 0.85-1.0).
Example: cake success -> cake burnt -> professional cake  =>  "We've just witnessed the rise, fall and redemption of the entire baking industry."

If the notes are thin, unclear or low-confidence, return an empty list. Silence beats a wrong reaction."""


def analyse_messages(req: AnalyseRequest) -> list[dict]:
    text_bits = [
        f"Title: {req.title or '(none)'}",
        f"Channel: {req.channel or '(none)'}",
        "Visible captions: " + (" | ".join(req.captions[:20]) if req.captions else "(none)"),
    ]
    if req.frames and req.composite:
        times = ", ".join(f"{t:.1f}" for t in req.frame_times) or "unknown"
        text_bits.append(
            f"The image is a strip of {max(1, len(req.frame_times))} frames from the same Short, "
            f"left to right in time order, captured at {times} s."
        )
    elif req.frames:
        times = req.frame_times + [None] * (len(req.frames) - len(req.frame_times))
        text_bits.append("Frame times (s): " + ", ".join("?" if t is None else f"{t:.1f}" for t in times[: len(req.frames)]))
    else:
        text_bits.append("No frames available: base your answer on the text only and keep confidence low.")
    content: list[dict] = [{"type": "text", "text": "\n".join(text_bits)}]
    for f in req.frames:
        content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{f}"}})
    return [{"role": "system", "content": ANALYSE_SYSTEM}, {"role": "user", "content": content}]


def react_messages(req: ReactRequest) -> list[dict]:
    system = REACT_SYSTEM.format(
        persona=PERSONAS[req.personality],
        frequency=FREQUENCY_HINT[req.frequency],
        emoji="At most one emoji." if req.personality == "hype" else "No emojis.",
    )
    shorts = []
    for i, m in enumerate(req.memory):
        shorts.append(
            {
                "position": f"{i + 1} of {len(req.memory)}" + (" (CURRENT)" if m.video_id == req.current_video_id else ""),
                "topic": m.topic,
                "summary": m.summary,
                "events": [e.description for e in m.events],
                "outcome": m.outcome,
                "mood": m.mood,
                "themes": m.themes,
                "user_watched_seconds": round(m.seconds_watched),
                "user_skipped": m.skipped,
            }
        )
    shared = _shared_themes(req)
    hint = f"\nShared themes across remembered Shorts: {', '.join(shared)}. A callback is expected." if shared else ""
    user = "Remembered Shorts, oldest first:\n" + json.dumps(shorts, indent=1, ensure_ascii=False) + hint
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _shared_themes(req: ReactRequest) -> list[str]:
    seen: dict[str, int] = {}
    for m in req.memory:
        if m.skipped:
            continue
        for t in {*(x.lower() for x in m.themes), m.topic.lower()}:
            if t and t != "unknown":
                seen[t] = seen.get(t, 0) + 1
    return sorted(t for t, n in seen.items() if n >= 2)


CAPTION_SYSTEM = """You are ScrollMate, a small cartoon friend watching a YouTube Short beside the user.
You only get the captions that just appeared on screen (what is being SAID), plus the title.
Personality: {persona}
{frequency}

Return:
- emotion: how a friend would react to these words right now (surprised, laughing, impressed, worried, cringe,
  love, sad), or null if they are ordinary. Most caption lines are ordinary: null is the usual answer.
- reaction: ONE short sentence (max ~15 words) ONLY if the words themselves are genuinely funny, ironic or
  surprising. Quote or reference the actual words. Otherwise null. Never invent what happens in the video.
Never joke about protected characteristics, tragedies, people's appearance, or sensitive personal information."""


def caption_messages(req: CaptionRequest) -> list[dict]:
    system = CAPTION_SYSTEM.format(persona=PERSONAS[req.personality], frequency=FREQUENCY_HINT[req.frequency])
    earlier = [f"{m.topic}: {m.summary}" for m in req.memory if m.video_id != req.video_id and not m.skipped][-2:]
    user = "\n".join(
        [
            f"Title: {req.title or '(none)'}",
            f"Channel: {req.channel or '(none)'}",
            "Just said (captions): " + " | ".join(req.lines),
            "Earlier Shorts (for context only): " + ("; ".join(earlier) if earlier else "(none)"),
        ]
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]
