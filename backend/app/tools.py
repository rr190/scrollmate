"""recall_history: a tool the AI can call to look back at today's Shorts in more detail than the compact journal.

Used only off the real-time path (the feeling line and the reel comment check). One quick tool-enabled call:
if the model asks for history, the result is appended to the prompt before the normal structured call; if it
doesn't, or the step is slow, we go straight on with the compact journal that is always included.
"""
from __future__ import annotations

import asyncio
import json
import logging

from . import config
from .journal import FEELING_WORDS, journal

log = logging.getLogger("scrollmate.tools")
RECALL_TIMEOUT_S = 1.2

RECALL_TOOL = {
    "type": "function",
    "function": {
        "name": "recall_history",
        "description": (
            "Look up earlier Shorts watched today with this child: what happened, how the child felt, and what you said. "
            "Call it only if a specific earlier moment would make your line more personal (e.g. another dog video)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "topic": {"type": "string", "description": "A word to match, e.g. 'dog', 'cake'. Optional."},
                "feeling": {"type": "string", "enum": list(FEELING_WORDS), "description": "Only Shorts where the child felt this. Optional."},
                "n": {"type": "integer", "minimum": 1, "maximum": 8, "description": "How many Shorts (default 5)."},
            },
        },
    },
}

ASK = (
    "Before you write: would a specific earlier Short from today make your line more personal? "
    "If yes, call recall_history. If not, reply just: no."
)


def _append(messages: list[dict], note: str) -> list[dict]:
    last = dict(messages[-1])
    content = last["content"]
    if isinstance(content, str):
        last["content"] = content + "\n" + note
    else:  # multimodal list
        last["content"] = list(content) + [{"type": "text", "text": note}]
    return messages[:-1] + [last]


async def maybe_recall(messages: list[dict], model: str | None = None, timeout: float = RECALL_TIMEOUT_S) -> tuple[list[dict], str | None]:
    """Returns (messages, note). `note` describes the look-up for the dev feed, or None if the tool wasn't used."""
    model = model or config.TEXT_MODEL
    if config.MOCK or not model or not journal.entries:
        return messages, None
    try:
        import litellm

        from .llm import _extra_for

        resp = await asyncio.wait_for(
            litellm.acompletion(
                model=model, messages=messages + [{"role": "user", "content": ASK}], tools=[RECALL_TOOL],
                tool_choice="auto", max_tokens=80, **_extra_for(model, 0.2),
            ),
            timeout=timeout,
        )
        calls = resp.choices[0].message.tool_calls or []
    except Exception as exc:  # timeout, provider without tools, etc.: carry on with the compact journal
        log.info("recall_history step skipped: %s", type(exc).__name__)
        return messages, None
    call = next((c for c in calls if c.function.name == "recall_history"), None)
    if call is None:
        return messages, None
    try:
        args = json.loads(call.function.arguments or "{}")
    except json.JSONDecodeError:
        args = {}
    found = journal.recall(topic=args.get("topic"), feeling=args.get("feeling"), n=args.get("n") or 5)
    note = "History you looked up with recall_history (real, use it if it fits): " + json.dumps(found, ensure_ascii=False)
    what = ", ".join(str(v) for v in (args.get("topic"), args.get("feeling")) if v) or "today"
    return _append(messages, note), f"{what} ({len(found)} found)"
