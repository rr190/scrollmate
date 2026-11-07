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


def _is_reasoning_family(model: str) -> bool:
    name = model.split("/", 1)[-1]
    return name.startswith(("gpt-5", "gpt-6", "o3", "o4"))


def _extra_for(model: str, temperature: float) -> dict:
    """Per-model params. Hidden 'thinking' is the main source of latency, so we switch it off.

    Measured on the cake strip: Groq Qwen ~7 s -> 1.2 s with reasoning off.
    """
    extra: dict = {}
    if model.startswith("openai/") and _is_reasoning_family(model):
        extra["reasoning_effort"] = config.OPENAI_REASONING  # these models only accept the default temperature
    elif model.startswith("groq/qwen/"):
        extra["reasoning_effort"] = "none"
        extra["temperature"] = temperature
    elif model.startswith("groq/openai/gpt-oss"):
        extra["reasoning_effort"] = "low"
        extra["temperature"] = temperature
    else:
        extra["temperature"] = temperature
    return extra


async def race(
    response_model: type[T], messages: list[dict], models: list[str | None], temperature: float = 0.4, max_tokens: int = 700
) -> tuple[T | None, str | None]:
    """Ask several models at once; return the first *valid* answer and cancel the rest.

    Cuts latency to the fastest provider at that moment and doubles as instant failover:
    if one provider is down or rate limited, the other has usually already answered.
    Returns (result, winning_model) or (None, None) if every model failed.
    """
    unique = list(dict.fromkeys(m for m in models if m))
    if len(unique) <= 1:
        model = unique[0] if unique else None
        return (await structured(response_model, messages, model, temperature, max_tokens) if model else None), model

    tasks = {
        asyncio.create_task(structured(response_model, messages, m, temperature, max_tokens)): m for m in unique
    }
    try:
        pending = set(tasks)
        while pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                result = t.result()  # structured() never raises
                if result is not None:
                    return result, tasks[t]
        return None, None
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()  # closes the losing HTTP request


async def warm_up(models: list[str]) -> None:
    """Pay the cold-start cost at server start, not on the user's first Short.

    The first call in a fresh process measured ~7.4 s vs ~2.5 s warm: LiteLLM/Instructor import
    lazily and the HTTPS connection to each provider is new. A 1-token ping per model fixes both.
    """
    import litellm

    for mode in ("json", "tools"):
        _get_client(mode)
    for model in dict.fromkeys(m for m in models if m):  # unique, keep order
        t0 = asyncio.get_running_loop().time()
        try:
            extra = _extra_for(model, 0.0)
            await asyncio.wait_for(
                litellm.acompletion(model=model, messages=[{"role": "user", "content": "ok"}], max_tokens=16, **extra),
                timeout=config.LLM_TIMEOUT_S,
            )
            log.info("warmed up %s in %.1fs", model, asyncio.get_running_loop().time() - t0)
        except Exception as e:  # noqa: BLE001 - warm-up is best effort
            log.warning("warm-up failed for %s: %s: %s", model, type(e).__name__, str(e)[:200])


async def structured(
    response_model: type[T], messages: list[dict], model: str, temperature: float = 0.4, max_tokens: int = 700
) -> T | None:
    """Return a validated `response_model`, or None on any failure (timeout, bad JSON, provider error, rate limit)."""
    try:
        client = _get_client(_mode_for(model))
        coro = client.chat.completions.create(  # type: ignore[attr-defined]
            model=model,
            response_model=response_model,
            messages=messages,
            max_retries=2,  # one validation retry
            max_tokens=max_tokens,
            timeout=config.LLM_TIMEOUT_S,
            **_extra_for(model, temperature),
        )
        return await asyncio.wait_for(coro, timeout=config.LLM_TIMEOUT_S + 3)
    except Exception as e:  # noqa: BLE001 - we deliberately degrade to "no reaction"
        log.warning("structured() failed for %s on %s: %s: %s", response_model.__name__, model, type(e).__name__, str(e)[:300])
        return None
