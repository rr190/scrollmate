"""Gemini Live as a vision lane for /scrollmate/observe.

One persistent Live session per Short: frames go in as turns, the model answers by calling an
`observe` tool whose arguments are validated as `LLMObserve`. The session remembers earlier
frames of the same Short, and a spare session is kept open so a new Short doesn't wait for a
connection. Measured in the spike: ~0.55-0.95 s per frame on gemini-3.1-flash-live-preview, with
an occasional long stall, so every turn has a hard timeout and the caller falls back.

Model strings look like "gemini-live/gemini-3.1-flash-live-preview".
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import os
import time
from collections import OrderedDict

from pydantic import ValidationError

from .emotions import EMOTION_IDS
from .models import LLMObserve

log = logging.getLogger("scrollmate.live")

PREFIX = "gemini-live/"
MAX_SESSIONS = 2  # current Short + the one just left
SPARE_MAX_AGE_S = 90  # Live sessions have a time cap; don't hand out stale spares
DRAIN_TIMEOUT_S = 6  # max time to let a turn finish (model may also produce audio) before dropping the session

def _system() -> str:
    from .character import EMOJI_RULE, character_block
    from .prompts import OBSERVE_SYSTEM

    rules = OBSERVE_SYSTEM.format(
        # the same character as every other feature; each turn repeats it with the current energy and age
        persona=character_block("chill") + "\n(Each turn restates this with the current personality energy; follow the newest.)",
        frequency="How often to comment is also given in each turn.",
        emoji=EMOJI_RULE,
    )
    return (
        rules
        + "\n\nEach turn gives you the newest frame plus short notes. Respond ONLY by calling the `observe` tool "
        "exactly once, immediately. Never speak."
    )

EMOTIONS = list(EMOTION_IDS)
MOMENTS = ["attempt", "reveal", "pov", "surprise", "tutorial", "continuation", "reaction", "other"]
MOODS = ["funny", "wholesome", "impressive", "fail", "informative", "dramatic", "calm", "unclear"]


def is_live(model: str | None) -> bool:
    return bool(model) and model.startswith(PREFIX)


def _tool():
    from google.genai import types

    S, T = types.Schema, types.Type
    props = {
        "seen_now": S(type=T.STRING, description="5-15 words: what is visible in THIS frame"),
        "topic": S(type=T.STRING, description="1-3 words, lowercase"),
        "happening": S(type=T.STRING, description="One factual sentence: what is happening so far"),
        "expected_next": S(type=T.STRING, description="What will probably happen next, or empty"),
        "moment_type": S(type=T.STRING, enum=MOMENTS),
        "outcome": S(type=T.STRING, nullable=True, description="How it ends, only if visible"),
        "mood": S(type=T.STRING, enum=MOODS),
        "themes": S(type=T.ARRAY, items=S(type=T.STRING), description="up to 4 lowercase single words"),
        "confidence": S(type=T.NUMBER, description="0-1, how sure you are about the whole picture"),
        "change": S(type=T.STRING, enum=["none", "minor", "major"]),
        "emotion": S(type=T.STRING, enum=EMOTIONS, nullable=True),
        "level": S(type=T.INTEGER, description="0 nothing, 1 face only, 2 short comment, 3 strong moment"),
        "line": S(type=T.STRING, nullable=True, description="One brief conversational reaction, usually 2-10 words, max 15. Fragments are welcome; only if level >= 2"),
        "line_is_callback": S(type=T.BOOLEAN),
        "running_joke": S(type=T.STRING, nullable=True),
        "next_look_at": S(type=T.NUMBER, nullable=True, description="video second of the next interesting moment, or null"),
    }
    required = ["seen_now", "topic", "happening", "moment_type", "mood", "confidence", "change", "level"]
    return types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="observe",
                description="Report what you see in this frame and how ScrollMate reacts.",
                parameters=S(type=T.OBJECT, properties=props, required=required),
            )
        ]
    )


def _coerce(a: dict) -> dict:
    """Live tool args are occasionally slightly off (enum case, a string for a list, ...). Fix, don't fail."""
    def enum(key, allowed, default):
        v = str(a.get(key, default) or default).strip().lower()
        a[key] = v if v in allowed else default

    def num(key, lo, hi, default):
        try:
            a[key] = max(lo, min(hi, float(a.get(key, default))))
        except (TypeError, ValueError):
            a[key] = default

    enum("moment_type", MOMENTS, "other")
    enum("mood", MOODS, "unclear")
    enum("change", ["none", "minor", "major"], "none")
    if "emotion" in a:
        e = str(a["emotion"]).strip().lower()
        a["emotion"] = e if e in EMOTIONS else None
    num("confidence", 0.0, 1.0, 0.5)
    num("level", 0, 3, 0)
    a["level"] = int(a["level"])
    if "next_look_at" in a:
        try:
            a["next_look_at"] = float(a["next_look_at"])
        except (TypeError, ValueError):
            a.pop("next_look_at")
    th = a.get("themes", [])
    a["themes"] = [str(t).strip().lower() for t in (th if isinstance(th, list) else str(th).split(",")) if str(t).strip()][:4]
    for key in ("seen_now", "topic", "happening"):
        a.setdefault(key, "")
        a[key] = str(a[key])
    a["line_is_callback"] = bool(a.get("line_is_callback", False))
    return a


class _Session:
    def __init__(self, model: str, cm, session):
        self.model = model
        self.cm = cm
        self.session = session
        self.created = time.monotonic()
        self.lock = asyncio.Lock()
        self.dead = False
        self.turns = 0
        self.last_drain_s: float | None = None  # send -> turn_complete of the last turn
        self.audio_after_tool = False

    async def close(self):
        self.dead = True
        with contextlib.suppress(Exception):
            await self.cm.__aexit__(None, None, None)


class LiveObserver:
    def __init__(self):
        self._client = None
        self._sessions: OrderedDict[str, _Session] = OrderedDict()
        self._spare: _Session | None = None
        self._spare_task: asyncio.Task | None = None

    # ---------- connections ----------
    def _get_client(self):
        if self._client is None:
            from google import genai
            from google.genai import types

            self._client = genai.Client(api_key=os.environ["GEMINI_API_KEY"], http_options=types.HttpOptions(api_version="v1beta"))
        return self._client

    async def _connect(self, model: str) -> _Session:
        from google.genai import types

        cfg = types.LiveConnectConfig(response_modalities=["AUDIO"], system_instruction=_system(), tools=[_tool()])
        cm = self._get_client().aio.live.connect(model=model[len(PREFIX):], config=cfg)
        session = await cm.__aenter__()
        return _Session(model, cm, session)

    def _refill_spare(self, model: str):
        if self._spare_task and not self._spare_task.done():
            return

        async def make():
            try:
                self._spare = await self._connect(model)
            except Exception as e:  # noqa: BLE001
                log.warning("live spare connect failed: %s", e)

        self._spare_task = asyncio.create_task(make())

    async def warm(self, model: str) -> float | None:
        """Open a spare session now (startup / model switch). Returns connect seconds."""
        t0 = time.perf_counter()
        try:
            old, self._spare = self._spare, await self._connect(model)
            if old:
                await old.close()
            return time.perf_counter() - t0
        except Exception as e:  # noqa: BLE001
            log.warning("live warm-up failed for %s: %s", model, e)
            return None

    async def _session_for(self, model: str, video_id: str) -> _Session:
        s = self._sessions.get(video_id)
        if s and not s.dead and s.model == model:
            self._sessions.move_to_end(video_id)
            return s
        spare, self._spare = self._spare, None
        if spare and (spare.dead or spare.model != model or time.monotonic() - spare.created > SPARE_MAX_AGE_S):
            await spare.close()
            spare = None
        s = spare or await self._connect(model)
        self._sessions[video_id] = s
        while len(self._sessions) > MAX_SESSIONS:
            _, old = self._sessions.popitem(last=False)
            asyncio.create_task(old.close())
        self._refill_spare(model)  # next Short gets an already-open session
        return s

    async def reset(self):
        for s in list(self._sessions.values()):
            await s.close()
        self._sessions.clear()
        if self._spare:
            await self._spare.close()
            self._spare = None

    # ---------- one frame ----------
    async def observe(self, model: str, video_id: str, text: str, frame_b64: str, timeout: float) -> tuple[LLMObserve | None, str]:
        """Returns (result, note). Never raises; None means: fall back to the regular vision lane."""
        from google.genai import types

        t0 = time.perf_counter()
        try:
            s = await asyncio.wait_for(self._session_for(model, video_id), timeout=timeout)
        except Exception as e:  # noqa: BLE001
            return None, f"live connect failed: {type(e).__name__}"
        try:  # the previous turn usually closes within ~0.5 s of its tool call
            await asyncio.wait_for(s.lock.acquire(), timeout=0.6)
        except asyncio.TimeoutError:
            return None, "live busy (previous turn still finishing)"
        got: asyncio.Future = asyncio.get_running_loop().create_future()

        async def turn():
            try:
                parts = [types.Part(text=text)]
                if frame_b64:
                    parts.insert(0, types.Part(inline_data=types.Blob(data=base64.b64decode(frame_b64), mime_type="image/jpeg")))
                t_sent = time.perf_counter()
                await s.session.send_client_content(turns=types.Content(role="user", parts=parts), turn_complete=True)
                s.turns += 1
                async for msg in s.session.receive():  # ends at turn_complete
                    if msg.tool_call:
                        for fc in msg.tool_call.function_calls:
                            if not got.done():
                                got.set_result(dict(fc.args or {}))
                            await s.session.send_tool_response(
                                function_responses=[types.FunctionResponse(id=fc.id, name=fc.name, response={"ok": True})]
                            )
                    sc = msg.server_content
                    if sc and sc.model_turn and got.done():
                        s.audio_after_tool = True  # the model kept talking after the tool call
                    if sc and sc.turn_complete:
                        s.last_drain_s = time.perf_counter() - t_sent
                        break
                if not got.done():
                    got.set_result(None)
            except Exception as e:  # noqa: BLE001
                s.dead = True
                if not got.done():
                    got.set_exception(e)

        async def run_and_release():
            try:
                await asyncio.wait_for(turn(), timeout=DRAIN_TIMEOUT_S)
            except asyncio.TimeoutError:
                s.dead = True  # stuck turn: drop this session, the next frame opens a fresh one
                if not got.done():
                    got.set_result(None)
            finally:
                s.lock.release()
                if s.dead:
                    asyncio.create_task(s.close())

        asyncio.create_task(run_and_release())
        try:
            args = await asyncio.wait_for(asyncio.shield(got), timeout=timeout)
        except asyncio.TimeoutError:
            return None, f"live timeout (> {timeout:.1f}s)"
        except Exception as e:  # noqa: BLE001
            return None, f"live error: {type(e).__name__}: {str(e)[:80]}"
        if not args:
            return None, "live: no tool call"
        args = _coerce({k: v for k, v in args.items() if v is not None})
        try:
            res = LLMObserve(**args)
        except ValidationError as e:
            bad = "; ".join(f"{'.'.join(map(str, er['loc']))}: {er['msg']}" for er in e.errors()[:3])
            log.warning("live tool args invalid: %s | args=%s", bad, {k: args[k] for k in list(args)[:16]})
            return None, f"live: invalid tool args ({bad[:120]})"
        return res, f"{model} in {int((time.perf_counter() - t0) * 1000)} ms (turn {s.turns})"


live = LiveObserver()
