import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


# Any LiteLLM model string. Vision model must accept images.
# Defaults (benchmarked on the cake strip, reasoning off):
#  - vision: OpenAI gpt-5.6-terra (~2.5-4 s); falls back to Groq Qwen (the only Groq vision model).
#  - text (reactions, captions): gpt-5.6-terra RACED against Groq gpt-oss-20b (~0.3-0.5 s, usually wins).
# Groq rate limits are per model (~7-8k tokens/min), so text races on gpt-oss-20b to keep
# Qwen's budget free for vision fallback.
VISION_MODEL = os.getenv("SCROLLMATE_VISION_MODEL", "openai/gpt-5.6-terra")
TEXT_MODEL = os.getenv("SCROLLMATE_TEXT_MODEL", "openai/gpt-5.6-terra")
VISION_FALLBACK_MODEL = os.getenv("SCROLLMATE_VISION_FALLBACK_MODEL", "groq/qwen/qwen3.8-27b").strip() or None
TEXT_FALLBACK_MODEL = os.getenv("SCROLLMATE_TEXT_FALLBACK_MODEL", "groq/openai/gpt-oss-20b").strip() or None
# OpenAI gpt-5/gpt-6 hidden reasoning: "none" is fastest. Use "low" if quality drops.
OPENAI_REASONING = os.getenv("SCROLLMATE_OPENAI_REASONING", "none").strip()
# Text calls (reactions, captions): ask TEXT_MODEL and TEXT_FALLBACK_MODEL at once, first valid answer wins.
RACE_TEXT = _bool("SCROLLMATE_RACE_TEXT", True)
# Per-frame vision in /observe: race VISION_MODEL against VISION_FALLBACK_MODEL (first valid wins).
RACE_VISION = _bool("SCROLLMATE_RACE_VISION", True)
# Frames analysed per Short: "auto" (by length: <=15 s -> 4, <=30 s -> 6, longer -> 8) or a fixed number 1-12.
FRAMES = os.getenv("SCROLLMATE_FRAMES", "auto").strip().lower()
# The swipe step answers from the title only; give up (stay silent) after this long.
SWIPE_DEADLINE_S = float(os.getenv("SCROLLMATE_SWIPE_DEADLINE", "1.5"))
# Gemini Live vision lane: per-frame deadline before falling back to the regular vision model.
LIVE_TIMEOUT_S = float(os.getenv("SCROLLMATE_LIVE_TIMEOUT", "2.5"))
LLM_TIMEOUT_S = float(os.getenv("SCROLLMATE_LLM_TIMEOUT", "15"))
# Ping each model once at startup so the first real request is not a ~5 s cold start.
WARMUP = _bool("SCROLLMATE_WARMUP", True)
# Use LiteLLM's bundled price map instead of downloading it at import time.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

# Mock mode: no LLM calls, deterministic heuristics. Auto-on when no provider key is set.
_HAS_KEY = any(
    os.getenv(k) for k in ("GROQ_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "LITELLM_API_KEY")
)
MOCK = _bool("SCROLLMATE_MOCK", not _HAS_KEY)

# CORS: the extension's origin, e.g. chrome-extension://abcdefghijklmnopabcdefghijklmnop
EXTENSION_ORIGIN = os.getenv("SCROLLMATE_EXTENSION_ORIGIN", "").strip()

RATE_LIMIT_PER_MIN = int(os.getenv("SCROLLMATE_RATE_LIMIT_PER_MIN", "40"))

# Live feed on /ui: include the frame strip the AI saw (kept in RAM only, last 200 events).
DEV_FEED_IMAGES = _bool("SCROLLMATE_DEV_FEED_IMAGES", False)


# ---------- model presets (switchable at runtime from /ui, reset on restart) ----------
# Timings: warm runs on the cake strip / demo-cake reactions (see README).
PRESETS: dict[str, dict] = {
    "mixed": {
        "label": "Mixed (fastest)",
        "note": "OpenAI vision; text raced OpenAI vs Groq (~0.3-0.5 s); Groq Qwen vision fallback",
        "vision": "openai/gpt-5.6-terra",
        "vision_fallback": "groq/qwen/qwen3.8-27b",
        "text": "openai/gpt-5.6-terra",
        "text_fallback": "groq/openai/gpt-oss-20b",
        "keys": ["OPENAI_API_KEY", "GROQ_API_KEY"],
    },
    "groq": {
        "label": "Groq",
        "note": "Free tier, 8k tokens/min per model. Vision ~1.2 s, text ~0.3 s",
        "vision": "groq/qwen/qwen3.8-27b",
        "vision_fallback": None,
        "text": "groq/openai/gpt-oss-20b",
        "text_fallback": "groq/openai/gpt-oss-120b",
        "keys": ["GROQ_API_KEY"],
    },
    "openai": {
        "label": "OpenAI",
        "note": "Vision ~2.5 s, text ~1.2 s (terra raced with 4.1-mini)",
        "vision": "openai/gpt-5.6-terra",
        "vision_fallback": "openai/gpt-5.4-mini",
        "text": "openai/gpt-5.6-terra",
        "text_fallback": "openai/gpt-4.1-mini",
        "keys": ["OPENAI_API_KEY"],
    },
    "gemini_live": {
        "label": "Gemini Live",
        "note": "Live session per Short (remembers earlier frames). ~0.6-0.9 s per frame; Flash-Lite fallback",
        "vision": "gemini-live/gemini-3.1-flash-live-preview",
        "vision_fallback": "gemini/gemini-flash-lite-latest",
        "text": "gemini/gemini-flash-lite-latest",
        "text_fallback": "gemini/gemini-3.5-flash-lite",
        "keys": ["GEMINI_API_KEY"],
    },
    "gemini": {
        "label": "Gemini",
        "note": "Flash-Lite, thinking off. Vision ~1.6 s, text ~0.7 s",
        "vision": "gemini/gemini-flash-lite-latest",
        "vision_fallback": "gemini/gemini-3.1-flash-lite",
        "text": "gemini/gemini-flash-lite-latest",
        "text_fallback": "gemini/gemini-3.5-flash-lite",
        "keys": ["GEMINI_API_KEY"],
    },
}

KNOWN_MODELS = [
    "openai/gpt-5.6-terra", "openai/gpt-5.6-luna", "openai/gpt-5.4-mini", "openai/gpt-5.4-nano", "openai/gpt-4.1-mini",
    "openai/gpt-4o-mini", "openai/gpt-6-luna",
    "groq/qwen/qwen3.8-27b", "groq/openai/gpt-oss-20b", "groq/openai/gpt-oss-120b",
    "gemini/gemini-flash-lite-latest", "gemini/gemini-3.1-flash-lite", "gemini/gemini-3.5-flash-lite",
    "gemini/gemini-2.5-flash", "gemini/gemini-3.5-flash",
    "gemini-live/gemini-3.1-flash-live-preview", "gemini-live/gemini-3.8-live",
]
# Gemini Live models: vision lane of /observe only (not usable for text calls).
LIVE_ONLY_PREFIX = "gemini-live/"
# Groq/Gemini are text+vision except gpt-oss (text only).
TEXT_ONLY = {"groq/openai/gpt-oss-20b", "groq/openai/gpt-oss-120b"}


def has_key(name: str) -> bool:
    return bool(os.getenv(name))


def current_models() -> dict:
    return {
        "vision": VISION_MODEL,
        "vision_fallback": VISION_FALLBACK_MODEL,
        "text": TEXT_MODEL,
        "text_fallback": TEXT_FALLBACK_MODEL,
        "race_text": RACE_TEXT,
        "frames": FRAMES,
    }


def frames_for(duration: float) -> int:
    """How many frames to analyse for a Short of this length."""
    if FRAMES != "auto":
        try:
            return max(1, min(12, int(FRAMES)))
        except ValueError:
            pass
    if duration and duration <= 15:
        return 4
    if duration and duration <= 30:
        return 6
    return 8 if duration else 4  # unknown length: be modest


def set_frames(value: str) -> None:
    global FRAMES
    FRAMES = value


def apply_models(vision: str, text: str, vision_fallback: str | None, text_fallback: str | None, race_text: bool) -> None:
    """Swap models at runtime. Every call site reads config.X at call time, so this takes effect immediately."""
    global VISION_MODEL, TEXT_MODEL, VISION_FALLBACK_MODEL, TEXT_FALLBACK_MODEL, RACE_TEXT
    VISION_MODEL, TEXT_MODEL = vision, text
    VISION_FALLBACK_MODEL, TEXT_FALLBACK_MODEL = vision_fallback or None, text_fallback or None
    RACE_TEXT = race_text
