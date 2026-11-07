"""Check that every emotion exists everywhere it needs to.

  backend catalog (app/emotions.py)  ==  extension list (src/shared/emotions.ts EMOTION_IDS)
  and every emotion has a look in BOTH avatars:
    - Companio / Mochi:  src/content/mochi/moods.ts            (LOOKS)
    - ScrollMate:        src/content/avatars/ScrollMateCharacter.tsx (FACES)

Run from anywhere:  python backend/scripts/check_emotions.py   (exit code 1 on any mismatch)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.emotions import EMOTION_IDS  # noqa: E402

EXT = ROOT / "extension" / "src"
STATES = {"idle", "watching", "thinking", "amused", "speaking", "sleeping"}  # ScrollMate's own (non-AI) moods


def ts_list(path: Path, const: str) -> set[str]:
    m = re.search(rf"{const}\s*=\s*\[(.*?)\]", path.read_text(encoding="utf-8"), re.S)
    return set(re.findall(r"'([a-z]+)'", m.group(1))) if m else set()


def record_keys(path: Path, const: str) -> set[str]:
    text = path.read_text(encoding="utf-8")
    m = re.search(rf"const {const}\b[^=]*=\s*\{{(.*?)\n\}};", text, re.S)
    body = m.group(1) if m else ""
    # top-level keys: "  key:" or "  key," (shorthand)
    return set(re.findall(r"^\s{2}([a-z]+)\s*[:,]", body, re.M))


def main() -> int:
    backend = set(EMOTION_IDS)
    extension = ts_list(EXT / "shared" / "emotions.ts", "EMOTION_IDS")
    needed = backend | STATES
    checks = [
        ("extension EMOTION_IDS", extension, backend),
        ("Mochi looks (mochi/moods.ts LOOKS)", record_keys(EXT / "content" / "mochi" / "moods.ts", "LOOKS"), needed),
        ("ScrollMate faces (avatars/ScrollMateCharacter.tsx FACES)", record_keys(EXT / "content" / "avatars" / "ScrollMateCharacter.tsx", "FACES"), needed),
    ]
    ok = True
    print(f"backend catalog: {len(backend)} emotions -> {', '.join(EMOTION_IDS)}")
    for name, have, want in checks:
        missing, extra = sorted(want - have), sorted(have - want)
        status = "OK" if not missing and (name != "extension EMOTION_IDS" or not extra) else "MISMATCH"
        ok &= status == "OK"
        print(f"  [{status}] {name}: {len(have)} found" + (f" | missing: {missing}" if missing else "") + (f" | extra: {extra}" if extra else ""))
    print("all avatars have every emotion" if ok else "fix the mismatches above")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
