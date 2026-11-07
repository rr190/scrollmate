"""Live event feed for the /ui page (dev tool).

Backend events (analyse/react requests and results) and extension events (new Short,
frames captured, timing decisions, deliveries) go into one in-memory ring buffer and are
streamed to browsers over Server-Sent Events. Nothing is written to disk; restarting
the server empties it. Frame images are only included when SCROLLMATE_DEV_FEED_IMAGES=1.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from collections.abc import AsyncIterator
from itertools import count

BACKLOG = 200


class Feed:
    def __init__(self) -> None:
        self._events: deque[dict] = deque(maxlen=BACKLOG)
        self._subs: set[asyncio.Queue[dict]] = set()
        self._ids = count(1)

    def publish(self, type_: str, source: str = "backend", **data) -> None:
        ev = {"id": next(self._ids), "ts": time.time(), "type": type_, "source": source, **data}
        self._events.append(ev)
        for q in list(self._subs):
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                pass  # slow viewer: drop rather than block the API

    def clear(self) -> None:
        self._events.clear()

    async def stream(self) -> AsyncIterator[str]:
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=500)
        self._subs.add(q)
        try:
            for ev in list(self._events):
                yield _sse(ev)
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield _sse(ev)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            self._subs.discard(q)


def _sse(ev: dict) -> str:
    return f"id: {ev['id']}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"


feed = Feed()
