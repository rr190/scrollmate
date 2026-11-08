"""Shared safety checks for anything the child sees or hears (every feature, including voice talk)."""
from __future__ import annotations

import re

# Slurs, protected traits, self-harm, real deaths, appearance.
_COMMENT_BLOCK = re.compile(
    r"\b(ugly|fat|skinny|race|racist|black people|white people|gay|religio\w*|disabled|retard\w*|died|death|suicide|"
    r"cancer|nazi|kys|kill (yo)?ur ?self|kill (him|her|them)sel(f|ves))\b",
    re.I,
)
# On top of that, for a young child: nothing about watching them, their body, health, or scary or unkind words.
_KID_BLOCK = re.compile(
    r"\b(camera|webcam|watching you|your face|face looks|body|weight|sick|ill|illness|hospital|medicine|doctor|"
    r"disease|pain|hurt\w*|blood|scream\w*|die|dying|dead|stupid|dumb|crybaby)\b",
    re.I,
)


def comment_safe(text: str, max_len: int = 160) -> bool:
    return 3 <= len(text) <= max_len and not _COMMENT_BLOCK.search(text)


def kid_safe(text: str, max_len: int = 160) -> bool:
    return comment_safe(text, max_len) and not _KID_BLOCK.search(text)
