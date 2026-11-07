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
