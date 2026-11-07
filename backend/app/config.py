import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


# Any LiteLLM model string. Vision model must accept images.
# Defaults: Groq free tier (8k tokens/min and 1k requests/day *per model*).
# qwen3.8-27b is the only Groq model that accepts images, so it is reserved for vision;
# reactions run on gpt-oss-20b (its own budget), falling back to gpt-oss-120b.
VISION_MODEL = os.getenv("SCROLLMATE_VISION_MODEL", "groq/qwen/qwen3.8-27b")
TEXT_MODEL = os.getenv("SCROLLMATE_TEXT_MODEL", "groq/openai/gpt-oss-20b")
TEXT_FALLBACK_MODEL = os.getenv("SCROLLMATE_TEXT_FALLBACK_MODEL", "groq/openai/gpt-oss-120b").strip() or None
LLM_TIMEOUT_S = float(os.getenv("SCROLLMATE_LLM_TIMEOUT", "15"))

# Mock mode: no LLM calls, deterministic heuristics. Auto-on when no provider key is set.
_HAS_KEY = any(
    os.getenv(k) for k in ("GROQ_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "LITELLM_API_KEY")
)
MOCK = _bool("SCROLLMATE_MOCK", not _HAS_KEY)

# CORS: the extension's origin, e.g. chrome-extension://abcdefghijklmnopabcdefghijklmnop
EXTENSION_ORIGIN = os.getenv("SCROLLMATE_EXTENSION_ORIGIN", "").strip()

RATE_LIMIT_PER_MIN = int(os.getenv("SCROLLMATE_RATE_LIMIT_PER_MIN", "40"))
