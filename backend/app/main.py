"""ScrollMate backend.

POST /scrollmate/analyse  frames + visible text  -> Analysis
POST /scrollmate/react    last 3 analyses + prefs -> 0..n reaction candidates

Every model response is validated with Pydantic (via Instructor). On any failure we
return *no reaction* rather than an error, because silence beats a wrong reaction.
Frames are used for the single LLM call and never stored or logged.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import OrderedDict, defaultdict, deque
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse

from . import config, mock
from .feed import feed
from .gemini_live import is_live, live
from .llm import ping, race, structured, warm_up
from .models import (
    AnalyseRequest,
    Analysis,
    Belief,
    CaptionRequest,
    CaptionResponse,
    EmotionCue,
    Event,
    LLMAnalysis,
    LLMObserve,
    LLMSwipe,
    LLMCaptionReaction,
    LLMReactions,
    MemoryItem,
    ObserveRequest,
    ObserveResponse,
    ReactionCandidate,
    ReactRequest,
    ReactResponse,
    SwipeRequest,
    SwipeResponse,
)
from .prompts import (
    FREQUENCY_HINT,
    PERSONAS,
    analyse_messages,
    caption_messages,
    observe_messages,
    react_messages,
    swipe_messages,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("scrollmate")

@asynccontextmanager
async def lifespan(_: FastAPI):
    # Warm models in the background so the server is ready instantly but the first Short is fast.
    task = None
    if not config.MOCK and config.WARMUP:
        task = asyncio.create_task(
            warm_up([config.VISION_MODEL, config.TEXT_MODEL, config.VISION_FALLBACK_MODEL, config.TEXT_FALLBACK_MODEL])
        )
        if is_live(config.VISION_MODEL):
            asyncio.create_task(live.warm(config.VISION_MODEL))
    yield
    await live.reset()
    if task and not task.done():
        task.cancel()


app = FastAPI(title="ScrollMate backend", version="0.1.0", lifespan=lifespan)

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


_UI = Path(__file__).resolve().parent / "static" / "ui.html"


@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse("/ui")


@app.get("/ui", include_in_schema=False)
async def ui():
    """Dev playground for /analyse and /react without the extension."""
    return FileResponse(_UI, media_type="text/html")


@app.get("/health")
async def health():
    return {
        "ok": True,
        "mock": config.MOCK,
        "visionModel": config.VISION_MODEL,
        "textModel": config.TEXT_MODEL,
        "textFallbackModel": config.TEXT_FALLBACK_MODEL,
        "visionFallbackModel": config.VISION_FALLBACK_MODEL,
        "openaiReasoning": config.OPENAI_REASONING,
        "feedImages": config.DEV_FEED_IMAGES,
    }


async def _text_call(response_model, messages, temperature: float, max_tokens: int):
    """Text-only LLM call. With racing on, primary and fallback run at once and the first valid answer wins."""
    if config.RACE_TEXT:
        return await race(response_model, messages, [config.TEXT_MODEL, config.TEXT_FALLBACK_MODEL], temperature, max_tokens)
    res = await structured(response_model, messages, config.TEXT_MODEL, temperature, max_tokens)
    if res is None and config.TEXT_FALLBACK_MODEL:
        return await structured(response_model, messages, config.TEXT_FALLBACK_MODEL, temperature, max_tokens), config.TEXT_FALLBACK_MODEL
    return res, config.TEXT_MODEL if res is not None else None


def _race_path(winner: str | None) -> str:
    if winner is None:
        return f"{config.TEXT_MODEL} + {config.TEXT_FALLBACK_MODEL}"
    return f"race won by {winner}" if config.RACE_TEXT else winner


# Output caps: shorter answers come back faster (benchmarked with these values).
ANALYSE_MAX_TOKENS = 450
REACT_MAX_TOKENS = 250
CAPTION_MAX_TOKENS = 150
SWIPE_MAX_TOKENS = 90
OBSERVE_MAX_TOKENS = 380


def _snap(t: float | None, frame_times: list[float]) -> float | None:
    """Pin a model timestamp to the nearest real frame capture time (models drift on strips)."""
    if t is None or not frame_times:
        return t
    return min(frame_times, key=lambda f: abs(f - t))


CUE_MIN_GAP_S = 1.2


def build_cues(events: list[Event], level: str, confidence: float) -> list[EmotionCue]:
    """Timed facial reactions. Only from moments actually seen in frames, never from text alone."""
    if level not in ("visual_and_text", "visual_only") or confidence < 0.35:
        return []
    cues: list[EmotionCue] = []
    for e in sorted((e for e in events if e.emotion and e.timestamp is not None and e.confidence >= 0.5), key=lambda e: e.timestamp):
        cue = EmotionCue(t=round(e.timestamp, 2), emotion=e.emotion, intensity=round(min(1.0, e.confidence * confidence + 0.2), 2))
        if cues and cue.t - cues[-1].t < CUE_MIN_GAP_S:
            if cue.intensity > cues[-1].intensity:
                cues[-1] = cue  # two reactions too close together: keep the stronger one
            continue
        cues.append(cue)
    return cues[:4]


def _ms(t0: float) -> int:
    return int((time.perf_counter() - t0) * 1000)


@app.post("/scrollmate/analyse", response_model=Analysis, response_model_by_alias=True)
async def analyse(req: AnalyseRequest, request: Request) -> Analysis:
    rate_limit(request)
    t0 = time.perf_counter()
    feed.publish(
        "analyse_request",
        videoId=req.video_id,
        title=req.title,
        channel=req.channel,
        captions=req.captions[:5],
        frames=len(req.frames),
        composite=req.composite,
        frameTimes=req.frame_times,
        image=req.frames[0] if (req.frames and config.DEV_FEED_IMAGES) else None,
    )
    a, path = await _analyse(req, request)
    feed.publish("analyse_result", videoId=req.video_id, path=path, ms=_ms(t0), analysis=a.model_dump(by_alias=True))
    return a


async def _analyse(req: AnalyseRequest, request: Request) -> tuple[Analysis, str]:
    """Returns the analysis plus a short note on which path produced it (shown in the live feed)."""
    if req.video_id in _cache:
        return _cache[req.video_id], "cache"

    has_text = bool(req.title or req.captions)
    if req.frames:
        level = "visual_and_text" if has_text else "visual_only"
    else:
        level = "text_only" if has_text else "none"

    if level == "none":
        return (
            Analysis(video_id=req.video_id, topic="unknown", summary="Nothing observable.", understanding_level="none", confidence=0.0),
            "nothing to analyse",
        )

    if config.MOCK:
        raw: LLMAnalysis | None = mock.analyse(req)
        level = "text_only"  # mock never looks at frames
        path = "mock"
    else:
        model = config.VISION_MODEL if req.frames else config.TEXT_MODEL
        path = model
        raw = await structured(LLMAnalysis, analyse_messages(req), model=model, temperature=0.2, max_tokens=ANALYSE_MAX_TOKENS)
        if raw is None and req.frames and config.VISION_FALLBACK_MODEL and config.VISION_FALLBACK_MODEL != model:
            # Primary vision model failed or timed out: try the other provider, still with the image.
            log.info("analyse %s: %s failed, falling back to %s", req.video_id, model, config.VISION_FALLBACK_MODEL)
            raw = await structured(
                LLMAnalysis, analyse_messages(req), model=config.VISION_FALLBACK_MODEL, temperature=0.2, max_tokens=ANALYSE_MAX_TOKENS
            )
            path = f"{model} failed -> {config.VISION_FALLBACK_MODEL}"
        if raw is None and req.frames and has_text:
            # No vision model available: last resort, text-only on the text model.
            log.info("analyse %s: vision failed, falling back to %s (text only)", req.video_id, config.TEXT_MODEL)
            text_req = req.model_copy(update={"frames": [], "frame_times": [], "composite": False})
            raw = await structured(
                LLMAnalysis, analyse_messages(text_req), model=config.TEXT_MODEL, temperature=0.2, max_tokens=ANALYSE_MAX_TOKENS
            )
            level = "text_only"
            path = f"{path} -> {config.TEXT_MODEL} (text only)"

    if await request.is_disconnected():
        log.info("client left %s before analysis finished; result not cached", req.video_id)

    if raw is None:
        # Validation or provider failure: low-confidence placeholder so the extension stays quiet.
        return (
            Analysis(video_id=req.video_id, topic="unknown", summary=req.title[:120] or "Unknown Short", understanding_level=level, confidence=0.0),
            f"{path}: FAILED (see server log)",
        )

    conf = raw.confidence if level != "text_only" else min(raw.confidence, 0.6)
    events = [
        Event(
            timestamp=_snap(e.timestamp, req.frame_times) if level != "text_only" else None,
            description=e.description[:200],
            confidence=e.confidence,
            emotion=e.emotion,
        )
        for e in raw.events[:4]
    ]
    a = Analysis(
        video_id=req.video_id,
        topic=raw.topic.strip().lower()[:40] or "unknown",
        summary=raw.summary.strip()[:240],
        events=events,
        outcome=raw.outcome,
        mood=raw.mood,
        themes=[t.strip().lower()[:24] for t in raw.themes if t.strip()][:4],
        understanding_level=level,
        confidence=conf,
        cues=build_cues(events, level, conf),
    )
    if not await request.is_disconnected():
        cache_put(a)
    log.info("analysed %s: %s (%s, conf %.2f)", a.video_id, a.topic, a.understanding_level, a.confidence)
    return a, path


@app.post("/scrollmate/react", response_model=ReactResponse, response_model_by_alias=True)
async def react(req: ReactRequest, request: Request) -> ReactResponse:
    rate_limit(request)
    t0 = time.perf_counter()
    feed.publish(
        "react_request",
        videoId=req.current_video_id,
        personality=req.personality,
        frequency=req.frequency,
        memory=[{"videoId": m.video_id, "topic": m.topic, "skipped": m.skipped} for m in req.memory],
    )
    res, path = await _react(req, request)
    feed.publish(
        "react_result",
        videoId=req.current_video_id,
        path=path,
        ms=_ms(t0),
        reactions=[r.model_dump(by_alias=True) for r in res.reactions],
    )
    return res


async def _react(req: ReactRequest, request: Request) -> tuple[ReactResponse, str]:
    current = next((m for m in req.memory if m.video_id == req.current_video_id), None)
    if current is None or current.topic == "unknown":
        return ReactResponse(reactions=[]), "skipped: current Short unknown"

    if config.MOCK:
        raw: LLMReactions | None = mock.react(req)
        path = "mock"
    else:
        raw, winner = await _text_call(LLMReactions, react_messages(req), temperature=0.8, max_tokens=REACT_MAX_TOKENS)
        path = _race_path(winner)

    if raw is None:
        return ReactResponse(reactions=[]), f"{path}: FAILED (see server log)"
    if await request.is_disconnected():
        return ReactResponse(reactions=[]), f"{path}: client left"

    out: list[ReactionCandidate] = []
    for r in raw.reactions[:2]:
        text = " ".join(r.text.split())
        if not safe(text):
            log.info("dropped unsafe/invalid reaction: %r", text)
            feed.publish("reaction_blocked", videoId=req.current_video_id, text=text)
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
    return ReactResponse(reactions=out), path


@app.post("/scrollmate/caption", response_model=CaptionResponse, response_model_by_alias=True)
async def caption(req: CaptionRequest, request: Request) -> CaptionResponse:
    """Fast text-only step: react to captions as they appear (runs alongside frame analysis)."""
    rate_limit(request)
    t0 = time.perf_counter()
    feed.publish("caption_request", videoId=req.video_id, lines=req.lines[:6], at=req.current_time)
    out = CaptionResponse()
    path = "mock"
    if not config.MOCK:
        raw, winner = await _text_call(LLMCaptionReaction, caption_messages(req), temperature=0.7, max_tokens=CAPTION_MAX_TOKENS)
        path = _race_path(winner)
        if raw is not None and not await request.is_disconnected():
            out.emotion = raw.emotion
            r = raw.reaction
            if r is not None:
                text = " ".join(r.text.split())
                if safe(text):
                    out.reactions.append(
                        ReactionCandidate(
                            text=text,
                            importance=r.importance,
                            target_video_id=req.video_id,
                            preferred_timing=r.preferred_timing,
                            expires_after_seconds=15,  # about words just said: goes stale fast
                            requires_quiet_moment=True,
                            is_callback=False,
                        )
                    )
                else:
                    feed.publish("reaction_blocked", videoId=req.video_id, text=text)
    feed.publish(
        "caption_result",
        videoId=req.video_id,
        path=path,
        ms=_ms(t0),
        emotion=out.emotion,
        reactions=[r.model_dump(by_alias=True) for r in out.reactions],
    )
    return out


# ---------- live loop: swipe (title, instant) + observe (one frame at a time) ----------
# Per-Short belief, text only, RAM only. The extension sends only the videoId; notes stay here.
_beliefs: OrderedDict[str, Belief] = OrderedDict()
BELIEFS_MAX = 30


def _belief(video_id: str, title: str = "") -> Belief:
    b = _beliefs.get(video_id)
    if b is None:
        b = Belief(video_id=video_id, title=title)
        _beliefs[video_id] = b
        while len(_beliefs) > BELIEFS_MAX:
            _beliefs.popitem(last=False)
    elif title and not b.title:
        b.title = title
    _beliefs.move_to_end(video_id)
    return b


def _cap_level(level: int, confidence: float) -> int:
    """Deterministic reaction hierarchy: low confidence can only ever earn a face."""
    level = max(0, min(3, level))
    if confidence < 0.5:
        return min(level, 1)
    if confidence < 0.75:
        return min(level, 2)
    return level


def _record(b: Belief, seconds_watched: float = 0) -> MemoryItem:
    return MemoryItem(
        video_id=b.video_id,
        topic=b.topic,
        summary=b.happening or (f'"{b.title[:80]}"' if b.title else ""),
        events=b.events[:4],
        outcome=b.outcome,
        mood=b.mood,
        themes=b.themes,
        seconds_watched=seconds_watched,
        skipped=False,
        running_joke=b.running_joke,
    )


async def _vision_call(messages: list[dict], max_tokens: int, video_id: str = "", frame: str = "", persona_line: str = ""):
    """One frame: Gemini Live session if selected, else race the two vision models (first valid answer wins)."""
    if is_live(config.VISION_MODEL):
        text = persona_line + "\n" + messages[1]["content"][0]["text"]  # rules live in the session's system prompt
        res, note = await live.observe(config.VISION_MODEL, video_id, text, frame, config.LIVE_TIMEOUT_S)
        if res is not None:
            return res, note
        fb = config.VISION_FALLBACK_MODEL
        log.info("observe %s: %s -> falling back to %s", video_id, note, fb)
        if not fb or is_live(fb):
            return None, None
        res = await structured(LLMObserve, messages, fb, 0.3, max_tokens)
        return res, (f"{note} -> {fb}" if res is not None else None)
    models = [config.VISION_MODEL, config.VISION_FALLBACK_MODEL]
    if config.RACE_VISION:
        return await race(LLMObserve, messages, models, 0.3, max_tokens)
    res = await structured(LLMObserve, messages, config.VISION_MODEL, 0.3, max_tokens)
    if res is None and config.VISION_FALLBACK_MODEL:
        return await structured(LLMObserve, messages, config.VISION_FALLBACK_MODEL, 0.3, max_tokens), config.VISION_FALLBACK_MODEL
    return res, config.VISION_MODEL if res is not None else None


@app.post("/scrollmate/swipe", response_model=SwipeResponse, response_model_by_alias=True)
async def swipe(req: SwipeRequest, request: Request) -> SwipeResponse:
    """Instant, title-only prediction of what kind of moment is coming. Never speaks: face only."""
    rate_limit(request)
    t0 = time.perf_counter()
    b = _belief(req.video_id, req.title)
    out = SwipeResponse()
    path = "mock"
    if req.title and not config.MOCK:
        try:
            raw, winner = await asyncio.wait_for(
                _text_call(LLMSwipe, swipe_messages(req), temperature=0.4, max_tokens=SWIPE_MAX_TOKENS), timeout=config.SWIPE_DEADLINE_S
            )
        except asyncio.TimeoutError:
            raw, winner = None, None
            path = f"late (> {config.SWIPE_DEADLINE_S:.1f}s): stayed silent"
        else:
            path = _race_path(winner)
        if raw is not None:
            out = SwipeResponse(moment_type=raw.moment_type, emotion=raw.emotion, level=1 if raw.emotion else 0, look_for=raw.look_for[:120])
            if b.frames_seen == 0:  # seed the belief; frames will confirm or overrule it
                b.moment_type = raw.moment_type
                b.expected_next = raw.look_for[:160]
                b.confidence = min(b.confidence or 0.3, 0.3)
                if raw.emotion:
                    b.emotion_arc = [raw.emotion]
                b.version += 1
    elif not req.title:
        path = "no title yet"
    feed.publish(
        "swipe_result",
        videoId=req.video_id,
        title=req.title,
        path=path,
        ms=_ms(t0),
        momentType=out.moment_type,
        emotion=out.emotion,
        lookFor=out.look_for,
    )
    return out


@app.post("/scrollmate/observe", response_model=ObserveResponse, response_model_by_alias=True)
async def observe(req: ObserveRequest, request: Request) -> ObserveResponse:
    """One frame (plus new captions) -> updated belief, a face now, maybe a line, and when to look next."""
    rate_limit(request)
    t0 = time.perf_counter()
    b = _belief(req.video_id, req.title)
    feed.publish(
        "observe_request",
        videoId=req.video_id,
        n=req.frame_index,
        of=req.max_frames,
        t=req.frame_time,
        duration=req.duration,
        captions=req.captions[:4],
        image=req.frame if (req.frame and config.DEV_FEED_IMAGES) else None,
    )

    raw: LLMObserve | None = None
    path = "mock"
    if config.MOCK:
        path = "mock (no vision)"
    elif req.frame or req.captions or req.title:
        persona_line = f"Personality: {PERSONAS[req.personality]} {FREQUENCY_HINT[req.frequency]}"
        raw, winner = await _vision_call(observe_messages(req, b), OBSERVE_MAX_TOKENS, req.video_id, req.frame, persona_line)
        if winner and is_live(config.VISION_MODEL):
            path = winner
        else:
            path = (f"race won by {winner}" if config.RACE_VISION else winner) if winner else "vision FAILED (see server log)"

    out = ObserveResponse(belief=b, record=_record(b))
    if raw is not None and not await request.is_disconnected():
        conf = raw.confidence if req.frame else min(raw.confidence, 0.5)
        prev_topic = b.topic
        b.topic = raw.topic.strip().lower()[:40] or b.topic
        b.happening = raw.happening.strip()[:240]
        b.expected_next = raw.expected_next.strip()[:160]
        b.moment_type = raw.moment_type
        b.outcome = raw.outcome or b.outcome
        b.mood = raw.mood
        b.themes = [t.strip().lower()[:24] for t in raw.themes if t.strip()][:4] or b.themes
        b.confidence = conf
        b.running_joke = (raw.running_joke or "").strip()[:120] or b.running_joke
        b.events = (
            b.events
            + [Event(timestamp=round(req.frame_time, 1), description=raw.seen_now.strip()[:200], confidence=conf, emotion=raw.emotion)]
        )[-4:]
        if raw.emotion and (not b.emotion_arc or b.emotion_arc[-1] != raw.emotion):
            b.emotion_arc = (b.emotion_arc + [raw.emotion])[-6:]
        b.frames_seen += 1
        b.version += 1

        level = _cap_level(raw.level, conf)
        out.emotion = raw.emotion if level >= 1 else None
        out.level = level
        out.change = raw.change if prev_topic != "unknown" or b.frames_seen > 1 else "major"
        if level >= 2 and raw.line:
            text = " ".join(raw.line.split())
            if safe(text):
                out.reactions.append(
                    ReactionCandidate(
                        text=text,
                        importance=0.9 if level == 3 else 0.6,
                        target_video_id=req.video_id,
                        preferred_timing="after_video",
                        expires_after_seconds=60 if raw.line_is_callback else 25,
                        requires_quiet_moment=True,
                        is_callback=raw.line_is_callback,
                    )
                )
            else:
                feed.publish("reaction_blocked", videoId=req.video_id, text=text)

        nxt = raw.next_look_at
        if nxt is None and req.frame_index == 1 and req.max_frames > 1 and req.duration > 6:
            # One frame is rarely enough to judge a Short: look again halfway through what's left.
            nxt = req.frame_time + (req.duration - req.frame_time) / 2
        if nxt is not None and req.duration:
            nxt = min(max(nxt, req.frame_time + 1.5), req.duration - 0.5)
            if nxt <= req.frame_time:
                nxt = None
        out.next_capture_at = nxt
        out.final = req.frame_index >= req.max_frames or nxt is None
        out.belief = b
        out.record = _record(b)
    else:
        out.final = req.frame_index >= req.max_frames

    feed.publish(
        "observe_result",
        videoId=req.video_id,
        n=req.frame_index,
        path=path,
        ms=_ms(t0),
        seen=b.events[-1].description if (raw is not None and b.events) else None,
        emotion=out.emotion,
        level=out.level,
        change=out.change,
        confidence=round(b.confidence, 2),
        arc=b.emotion_arc,
        happening=b.happening,
        nextCaptureAt=out.next_capture_at,
        final=out.final,
        reactions=[r.model_dump(by_alias=True) for r in out.reactions],
        runningJoke=b.running_joke,
    )
    return out


# ---------- model settings (dev): switch providers from /ui at runtime ----------
class ModelSettings(BaseModel):
    preset: str | None = None
    vision: str | None = None
    vision_fallback: str | None = None
    text: str | None = None
    text_fallback: str | None = None
    race_text: bool | None = None


def _provider_key(model: str | None) -> str | None:
    if not model:
        return None
    return {"openai": "OPENAI_API_KEY", "groq": "GROQ_API_KEY", "gemini": "GEMINI_API_KEY", "gemini-live": "GEMINI_API_KEY"}.get(
        model.split("/", 1)[0]
    )


def _settings_view() -> dict:
    cur = config.current_models()
    return {
        "current": cur,
        "mock": config.MOCK,
        "presets": {
            k: {**{f: v for f, v in p.items() if f != "keys"}, "available": all(config.has_key(x) for x in p["keys"]), "keys": p["keys"]}
            for k, p in config.PRESETS.items()
        },
        "activePreset": next(
            (
                k
                for k, p in config.PRESETS.items()
                if all(p[f] == cur[f] for f in ("vision", "vision_fallback", "text", "text_fallback"))
            ),
            None,
        ),
        "knownModels": config.KNOWN_MODELS,
        "textOnly": sorted(config.TEXT_ONLY),
        "keys": {k: config.has_key(k) for k in ("OPENAI_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY")},
    }


@app.get("/scrollmate/settings", include_in_schema=False)
async def get_settings() -> dict:
    return _settings_view()


@app.post("/scrollmate/settings", include_in_schema=False)
async def set_settings(body: ModelSettings) -> dict:
    """Switch models immediately (in memory; restarting the server goes back to .env)."""
    cur = config.current_models()
    if body.preset:
        p = config.PRESETS.get(body.preset)
        if not p:
            raise HTTPException(400, f"unknown preset {body.preset!r}")
        missing = [k for k in p["keys"] if not config.has_key(k)]
        if missing:
            raise HTTPException(400, f"missing {', '.join(missing)} in backend/.env")
        new = {f: p[f] for f in ("vision", "vision_fallback", "text", "text_fallback")}
    else:
        new = {f: getattr(body, f) if getattr(body, f) is not None else cur[f] for f in ("vision", "vision_fallback", "text", "text_fallback")}
        for f in ("vision_fallback", "text_fallback"):
            if new[f] == "":
                new[f] = None
    if not new["vision"] or not new["text"]:
        raise HTTPException(400, "vision and text models are required")
    for f in ("vision", "vision_fallback"):
        if new[f] in config.TEXT_ONLY:
            raise HTTPException(400, f"{new[f]} is text-only and cannot be the {f.replace('_', ' ')} model")
    for f in ("text", "text_fallback"):
        if is_live(new[f]):
            raise HTTPException(400, f"{new[f]} is a Gemini Live model: it can only be the vision model")
    if is_live(new["vision_fallback"]):
        raise HTTPException(400, "the vision fallback must be a regular model (it covers Live stalls)")
    for f, m in new.items():
        k = _provider_key(m)
        if m and k and not config.has_key(k):
            raise HTTPException(400, f"{m} needs {k} in backend/.env")
    race_text = body.race_text if body.race_text is not None else cur["race_text"]
    config.apply_models(new["vision"], new["text"], new["vision_fallback"], new["text_fallback"], race_text)
    _cache.clear()  # analyses from the old model shouldn't be reused
    await live.reset()  # close Live sessions from the previous model
    if is_live(new["vision"]) and not config.MOCK:
        asyncio.create_task(live.warm(new["vision"]))  # spare session ready for the next Short
    log.info("models switched: %s", config.current_models())
    feed.publish("status", note=f"models switched -> vision {new['vision']} | text {new['text']}" + (" (raced)" if race_text else ""))
    if not config.MOCK and config.WARMUP:
        asyncio.create_task(warm_up([new["vision"], new["text"], new["vision_fallback"], new["text_fallback"]]))
    return _settings_view()


@app.post("/scrollmate/settings/ping", include_in_schema=False)
async def ping_models() -> dict:
    """Time a 1-token request to each active model, all at once."""
    cur = config.current_models()
    slots = [(f, cur[f]) for f in ("vision", "vision_fallback", "text", "text_fallback") if cur[f]]
    results = await asyncio.gather(*(ping(m) for _, m in slots))
    return {
        "results": [
            {"slot": f, "model": m, "ms": None if dt is None else int(dt * 1000), "error": err}
            for (f, m), (dt, err) in zip(slots, results)
        ]
    }


# ---------- live feed (dev): extension events in, SSE out ----------
_CLIENT_TYPES = {"short_started", "short_left", "frame", "decision", "delivered", "emotion", "status"}


@app.post("/scrollmate/events")
async def client_events(events: list[dict]) -> dict:
    """The extension reports what it is doing (fire-and-forget). Small scalar fields only, no images."""
    n = 0
    for ev in events[:50]:
        t = ev.get("type")
        if t not in _CLIENT_TYPES:
            continue
        reserved = {"type", "source", "id", "ts"}
        data = {k: v for k, v in ev.items() if k not in reserved and isinstance(v, (str, int, float, bool, type(None)))}
        data = {k: (v[:300] if isinstance(v, str) else v) for k, v in list(data.items())[:20]}
        feed.publish(t, source="extension", **data)
        n += 1
    return {"accepted": n}


@app.get("/scrollmate/feed", include_in_schema=False)
async def feed_stream():
    return StreamingResponse(
        feed.stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


@app.post("/scrollmate/feed/clear", include_in_schema=False)
async def feed_clear() -> dict:
    feed.clear()
    return {"ok": True}
