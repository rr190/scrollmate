"""Thin structured-output client: LiteLLM (any OpenAI-compatible model) + Instructor.

If the team repo's `structured()` is available, swap this module for it: the
signature is the same idea (messages + response_model -> validated object).
"""

from __future__ import annotations

import asyncio
import logging
from typing import TypeVar

from pydantic import BaseModel

from . import config

log = logging.getLogger("scrollmate.llm")
T = TypeVar("T", bound=BaseModel)

_clients: dict[str, object] = {}


def _mode_for(model: str) -> str:
    # Groq validates tool calls server-side against the schema and rejects near-misses,
    # so for Groq we use JSON mode and let Pydantic validate (and Instructor retry) instead.
    return "json" if model.startswith("groq/") else "tools"


def _get_client(mode: str):
    if mode not in _clients:
        import instructor
        import litellm

        litellm.drop_params = True  # tolerate provider differences
        imode = instructor.Mode.JSON if mode == "json" else instructor.Mode.TOOLS
        _clients[mode] = instructor.from_litellm(litellm.acompletion, mode=imode)
    return _clients[mode]


async def structured(response_model: type[T], messages: list[dict], model: str, temperature: float = 0.4) -> T | None:
    """Return a validated `response_model`, or None on any failure (timeout, bad JSON, provider error, rate limit)."""
    try:
        client = _get_client(_mode_for(model))
        coro = client.chat.completions.create(  # type: ignore[attr-defined]
            model=model,
            response_model=response_model,
            messages=messages,
            max_retries=2,  # one validation retry
            temperature=temperature,
            max_tokens=700,
            timeout=config.LLM_TIMEOUT_S,
        )
        return await asyncio.wait_for(coro, timeout=config.LLM_TIMEOUT_S + 3)
    except Exception as e:  # noqa: BLE001 - we deliberately degrade to "no reaction"
        log.warning("structured() failed for %s on %s: %s: %s", response_model.__name__, model, type(e).__name__, str(e)[:300])
        return None
