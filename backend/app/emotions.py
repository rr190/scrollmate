"""The emotion catalog: the ONE place the backend lists ScrollMate's emotions.

Prompts, validation (models.Emotion), the Gemini Live tool and the /ui emoji all read from here.
The extension keeps the matching list in extension/src/shared/emotions.ts (EMOTION_IDS);
run `python backend/scripts/check_emotions.py` to verify both sides, and both avatars, agree.

To add an emotion:
  1. add it here (id, emoji, when to use it, which Mochi emotion it shows as),
  2. add the id to EMOTION_IDS in extension/src/shared/emotions.ts,
  3. give it a look in extension/src/content/mochi/moods.ts and a face in
     extension/src/content/avatars/ScrollMateCharacter.tsx (TypeScript errors until both exist),
  4. run the check script.
"""

from __future__ import annotations

# id -> emoji, when the AI should pick it, and which Companio (Mochi) emotion it is drawn as.
EMOTIONS: dict[str, dict[str, str]] = {
    "curious": {"emoji": "🤔", "when": "intrigued, waiting to see what happens", "mochi": "curious"},
    "surprised": {"emoji": "😮", "when": "sudden or unexpected", "mochi": "surprised"},
    "laughing": {"emoji": "😂", "when": "genuinely funny", "mochi": "amused"},
    "impressed": {"emoji": "🤩", "when": "skillful, beautiful, satisfying", "mochi": "excited"},
    "worried": {"emoji": "😟", "when": "something is about to go wrong", "mochi": "concerned"},
    "cringe": {"emoji": "😬", "when": "awkward or a fail", "mochi": "(ScrollMate extra)"},
    "love": {"emoji": "🥰", "when": "cute or adorable", "mochi": "supportive"},
    "sad": {"emoji": "😢", "when": "gentle sadness", "mochi": "concerned + tears"},
    "happy": {"emoji": "😊", "when": "feel-good, cheerful, a nice outcome", "mochi": "happy"},
    "bored": {"emoji": "😴", "when": "slow, nothing happening, a drawn-out intro", "mochi": "sleepy (no zzz)"},
}

EMOTION_IDS: tuple[str, ...] = tuple(EMOTIONS)


def emotion_names() -> str:
    """'curious, surprised, ...' for prompts."""
    return ", ".join(EMOTION_IDS)


def emotion_guide() -> str:
    """'curious (intrigued...), surprised (sudden...), ...' for prompts that explain each one."""
    return ", ".join(f"{k} ({v['when']})" for k, v in EMOTIONS.items())


def emoji_map() -> dict[str, str]:
    return {k: v["emoji"] for k, v in EMOTIONS.items()}
