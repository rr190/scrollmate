"""ScrollMate backend.

POST /scrollmate/analyse  frames + visible text  -> Analysis
POST /scrollmate/react    last 3 analyses + prefs -> 0..n reaction candidates

Every model response is validated with Pydantic (via Instructor). On any failure we
return *no reaction* rather than an error, because silence beats a wrong reaction.
Frames are used for the single LLM call and never stored or logged.
"""

from __future__ import annotations

import logging
import re
import time
from collections import OrderedDict, defaultdict, deque

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from . import config, mock
from .llm import structured
from .models import (
    AnalyseRequest,
    Analysis,
    Event,
    LLMAnalysis,
    LLMReactions,
    ReactionCandidate,
    ReactRequest,
    ReactResponse,
)
from .prompts import analyse_messages, react_messages

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("scrollmate")

app = FastAPI(title="ScrollMate backend", version="0.1.0")

# CORS restricted to the extension's origin (set SCROLLMATE_EXTENSION_ORIGIN once you know the ID).
if config.EXTENSION_ORIGIN:
    app.add_middleware(CORSMiddleware, allow_origins=[config.EXTENSION_ORIGIN], allow_methods=["POST", "GET"], allow_headers=["Content-Type"])
else:
    app.add_middleware(CORSMiddleware, allow_origin_regex=r"^chrome-extension://[a-p]{32}$", allow_methods=["POST", "GET"], allow_headers=["Content-Type"])

# ---------- tiny in-memory rate limiter (per client IP, sliding 60 s window) ----------
_hits: dict[str, deque[float]] = defaultdict(deque)


def rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    q = _hits[ip]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= config.RATE_LIMIT_PER_MIN:
        raise HTTPException(status_code=429, detail="rate limited")
    q.append(now)


# ---------- session cache of analyses by video ID (no frames kept) ----------
_cache: OrderedDict[str, Analysis] = OrderedDict()
CACHE_MAX = 300


def cache_put(a: Analysis) -> None:
    _cache[a.video_id] = a
    _cache.move_to_end(a.video_id)
    while len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)


# ---------- safety filter on generated text ----------
_BLOCK = re.compile(
    r"\b(ugly|fat|skinny|old|race|racist|black people|white people|gay|religio\w*|disabled|retard\w*|died|death|dead|kill\w*|suicide|cancer|nazi)\b",
    re.I,
)


def safe(text: str) -> bool:
    return 3 <= len(text) <= 160 and not _BLOCK.search(text)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "mock": config.MOCK,
        "visionModel": config.VISION_MODEL,
        "textModel": config.TEXT_MODEL,
        "textFallbackModel": config.TEXT_FALLBACK_MODEL,
    }


@app.post("/scrollmate/analyse", response_model=Analysis, response_model_by_alias=True)
async def analyse(req: AnalyseRequest, request: Request) -> Analysis:
    rate_limit(request)
    if req.video_id in _cache:
        return _cache[req.video_id]

    has_text = bool(req.title or req.captions)
    if req.frames:
        level = "visual_and_text" if has_text else "visual_only"
    else:
        level = "text_only" if has_text else "none"

    if level == "none":
        return Analysis(video_id=req.video_id, topic="unknown", summary="Nothing observable.", understanding_level="none", confidence=0.0)

    if config.MOCK:
        raw: LLMAnalysis | None = mock.analyse(req)
        level = "text_only"  # mock never looks at frames
    else:
        raw = await structured(LLMAnalysis, analyse_messages(req), model=config.VISION_MODEL if req.frames else config.TEXT_MODEL, temperature=0.2)
        if raw is None and req.frames and has_text:
            # Vision model failed or is rate limited: retry text-only on the text model.
            log.info("analyse %s: vision failed, falling back to %s (text only)", req.video_id, config.TEXT_MODEL)
            text_req = req.model_copy(update={"frames": [], "frame_times": [], "composite": False})
            raw = await structured(LLMAnalysis, analyse_messages(text_req), model=config.TEXT_MODEL, temperature=0.2)
            level = "text_only"

    if await request.is_disconnected():
        log.info("client left %s before analysis finished; result not cached", req.video_id)

    if raw is None:
        # Validation or provider failure: low-confidence placeholder so the extension stays quiet.
        return Analysis(video_id=req.video_id, topic="unknown", summary=req.title[:120] or "Unknown Short", understanding_level=level, confidence=0.0)

    conf = raw.confidence if level != "text_only" else min(raw.confidence, 0.6)
    a = Analysis(
        video_id=req.video_id,
        topic=raw.topic.strip().lower()[:40] or "unknown",
        summary=raw.summary.strip()[:240],
        events=[Event(timestamp=e.timestamp, description=e.description[:200], confidence=e.confidence) for e in raw.events[:4]],
        outcome=raw.outcome,
        mood=raw.mood,
        themes=[t.strip().lower()[:24] for t in raw.themes if t.strip()][:4],
        understanding_level=level,
        confidence=conf,
    )
    if not await request.is_disconnected():
        cache_put(a)
    log.info("analysed %s: %s (%s, conf %.2f)", a.video_id, a.topic, a.understanding_level, a.confidence)
    return a


@app.post("/scrollmate/react", response_model=ReactResponse, response_model_by_alias=True)
async def react(req: ReactRequest, request: Request) -> ReactResponse:
    rate_limit(request)
    current = next((m for m in req.memory if m.video_id == req.current_video_id), None)
    if current is None or current.topic == "unknown":
        return ReactResponse(reactions=[])

    if config.MOCK:
        raw: LLMReactions | None = mock.react(req)
    else:
        raw = await structured(LLMReactions, react_messages(req), model=config.TEXT_MODEL, temperature=0.8)
        if raw is None and config.TEXT_FALLBACK_MODEL:
            log.info("react %s: falling back to %s", req.current_video_id, config.TEXT_FALLBACK_MODEL)
            raw = await structured(LLMReactions, react_messages(req), model=config.TEXT_FALLBACK_MODEL, temperature=0.8)

    if raw is None or await request.is_disconnected():
        return ReactResponse(reactions=[])

    out: list[ReactionCandidate] = []
    for r in raw.reactions[:2]:
        text = " ".join(r.text.split())
        if not safe(text):
            log.info("dropped unsafe/invalid reaction: %r", text)
            continue
        out.append(
            ReactionCandidate(
                text=text,
                importance=r.importance,
                target_video_id=req.current_video_id,
                preferred_timing=r.preferred_timing,
                # Callbacks stay relevant across Shorts; moment reactions go stale fast.
                expires_after_seconds=60 if r.is_callback else (12 if r.preferred_timing == "now" else 25),
                requires_quiet_moment=r.requires_quiet_moment,
                is_callback=r.is_callback,
            )
        )
    log.info("react %s -> %s", req.current_video_id, [c.text for c in out])
    return ReactResponse(reactions=out)
