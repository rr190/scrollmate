import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Avatar, avatarAspect } from './Avatar';
import type { Controller, Position } from './controller';
import { Popover } from './Popover';
import { COMMENT_TRAVEL_MS, commentPosition, companionSize, PANEL } from './comments';
import { RoamPlanner, roamArea, type Pt } from './roam';
import type { Rect } from '../shared/types';

function useViewport() {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

/** Default: upper right of the video, clear of the right-hand action column and the bottom title. */
function defaultPosition(ctl: Controller, w: number, h: number): Position {
  const size = companionSize(w);
  let anchor: DOMRect | null = null;
  if (ctl.env === 'stage') anchor = document.getElementById('sm-stage-video')?.getBoundingClientRect() ?? null;
  else anchor = document.querySelector('ytd-reel-video-renderer[is-active] video, ytd-shorts video')?.getBoundingClientRect() ?? null;
  if (anchor && anchor.width > 100) {
    const x = anchor.right - size - 18;
    const y = anchor.top + anchor.height * 0.16;
    return { fx: x / w, fy: y / h };
  }
  const playerH = h - 80;
  const playerW = (playerH * 9) / 16;
  return { fx: (w / 2 + playerW / 2 - size - 18) / w, fy: (64 + playerH * 0.16) / h };
}

function visibleRect(el: Element | null | undefined, vp: { w: number; h: number }): Rect | null {
  const r = el?.getBoundingClientRect();
  if (!r || r.width < 40 || r.height < 40 || r.right < 0 || r.left > vp.w || r.bottom < 0 || r.top > vp.h) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function App({ ctl }: { ctl: Controller }) {
  const s = useSyncExternalStore(ctl.subscribe, ctl.getState);
  const vp = useViewport();
  const size = companionSize(vp.w);
  const [open, setOpen] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [fallback, setFallback] = useState<Position | null>(null);
  const [travelling, setTravelling] = useState(false);
  const visitKey = s.commentVisit?.requestId ?? 'home';
  const previousVisit = useRef(visitKey);
  const companion = useRef<HTMLDivElement>(null);
  // roaming: the planner picks walks; `roam` is the current target (null = stay at home)
  const planner = useRef(new RoamPlanner());
  const [roam, setRoam] = useState<(Pt & { ms: number; dir: number; stroll: boolean }) | null>(null);
  const [walking, setWalking] = useState(false);
  const rendered = useRef<Pt | null>(null); // where it was last drawn

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (companion.current && !event.composedPath().includes(companion.current)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);

  useEffect(() => {
    if (visitKey === previousVisit.current) return;
    previousVisit.current = visitKey;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setTravelling(true);
    const timer = window.setTimeout(() => setTravelling(false), COMMENT_TRAVEL_MS);
    return () => window.clearTimeout(timer);
  }, [visitKey]);

  const dragging = dragPos !== null;
  useEffect(() => {
    ctl.pauseCommentVisits(open || dragging);
    return () => ctl.pauseCommentVisits(false);
  }, [ctl, open, dragging]);

  useEffect(() => {
    if (s.position) return;
    const id = window.setTimeout(() => setFallback(defaultPosition(ctl, vp.w, vp.h)), 50);
    return () => window.clearTimeout(id);
  }, [s.position, vp.w, vp.h, s.onShorts, ctl]);

  // Close popover on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === ']' && s.demo) ctl.demoNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.demo, ctl]);

  // ---------- roaming (ticks ~4x a second; only reads state, never changes what the AI does) ----------
  const st0 = s.settings;
  const holdRoam = open || dragPos !== null || !!s.commentVisit || !!s.bubble || s.mood === 'speaking';
  const roamOn = st0.roam && st0.enabled && (ctl.env === 'stage' || s.onShorts);
  const latest = useRef({ holdRoam, roamOn, mood: s.mood, gazeZone: st0.eyeTrack ? s.gaze.zone : null, size, vp });
  latest.current = { holdRoam, roamOn, mood: s.mood, gazeZone: st0.eyeTrack ? s.gaze.zone : null, size, vp };
  useEffect(() => {
    if (!roamOn) {
      setRoam(null);
      return;
    }
    let walkTimer: number | undefined;
    const id = window.setInterval(() => {
      const L = latest.current;
      const from = rendered.current;
      if (!from) return;
      const videoEl = ctl.env === 'stage' ? document.getElementById('sm-stage-video') : document.querySelector('ytd-reel-video-renderer[is-active] video, ytd-shorts video');
      const panels = Array.from(document.querySelectorAll(PANEL)).map((el) => visibleRect(el, L.vp)).filter((r): r is Rect => !!r);
      const step = planner.current.tick({
        now: Date.now(),
        enabled: L.roamOn,
        reducedMotion: reducedMotion(),
        hold: L.holdRoam,
        mood: L.mood,
        pos: from,
        rects: { video: visibleRect(videoEl, L.vp), comments: panels.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null },
        area: roamArea(L.vp, L.size),
        size: L.size,
        gazeZone: L.gazeZone,
        gazeY: ctl.gazePoint?.y ?? null,
      });
      if (!step) return;
      setRoam({ ...step.target, ms: step.ms, dir: Math.sign(step.target.x - from.x), stroll: step.stroll });
      setWalking(true);
      window.clearTimeout(walkTimer);
      walkTimer = window.setTimeout(() => setWalking(false), step.ms);
    }, 250);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(walkTimer);
    };
  }, [roamOn, ctl]);

  if (ctl.env === 'youtube' && !s.onShorts) return null; // dormant outside /shorts/

  const pos = s.position ?? fallback ?? { fx: 0.7, fy: 0.2 };
  const visit = s.commentVisit;
  const destination = visit ? commentPosition(visit, vp.w, vp.h) : null;
  const clampX = (x: number) => Math.min(vp.w - size - 4, Math.max(4, x));
  const clampY = (y: number) => Math.min(vp.h - size - 4, Math.max(4, y));
  const x = dragPos ? dragPos.x : destination?.x ?? (roam ? clampX(roam.x) : clampX(pos.fx * vp.w));
  const y = dragPos ? dragPos.y : destination?.y ?? (roam ? clampY(roam.y) : clampY(pos.fy * vp.h));
  rendered.current = { x, y };
  const onRight = x + size / 2 > vp.w / 2;
  const roamingWalk = walking && !dragPos && !destination;
  // face the way it walks; otherwise toward your gaze (eye tracking)
  const look = roamingWalk && roam ? { x: roam.dir, y: 0 } : s.settings.eyeTrack ? s.gaze.look : null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Use the rendered position, which may still be between home and a comment destination.
    const rendered = e.currentTarget.getBoundingClientRect();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: rendered.left, oy: rendered.top, moved: false };
    setDragPos({ x: rendered.left, y: rendered.top });
    ctl.pauseCommentVisits(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    setDragPos({ x: clampX(d.ox + dx), y: clampY(d.oy + dy) });
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    setDragPos(null);
    if (d.moved && dragPos) {
      ctl.savePosition({ fx: dragPos.x / vp.w, fy: dragPos.y / vp.h });
      planner.current.park(Date.now()); // stay where you dropped it for 30 s
      setRoam(null);
      setWalking(false);
    } else {
      setOpen((o) => !o);
    }
  };

  const st = s.settings;
  return (
    <div className="sm-layer">
      {visit && <div className="sm-comment-outline" aria-hidden="true" style={{ left: visit.rect.x - 4, top: visit.rect.y - 4, width: visit.rect.width + 8, height: visit.rect.height + 8 }} />}
      <div
        ref={companion}
        className={`sm-companion ${onRight ? 'sm-right' : 'sm-left'} ${dragPos ? 'sm-manual-position' : ''} ${travelling || visit?.phase === 'running' || roamingWalk ? 'sm-travelling' : ''} ${roamingWalk && roam?.stroll ? 'sm-strolling' : ''} ${destination ? `sm-comment-${destination.side}` : ''} ${y < 130 ? 'sm-bubble-below' : ''}`}
        style={{
          left: 0, top: 0, transform: `translate3d(${x}px, ${y}px, 0)`, width: size,
          ...(roamingWalk && roam ? { transitionDuration: `${roam.ms}ms`, transitionTimingFunction: roam.stroll ? 'linear' : 'cubic-bezier(0.45, 0.05, 0.55, 0.95)' } : {}),
        }}
      >
        {s.bubble && (
          <div key={s.bubble.id} className="sm-bubble" style={{ maxWidth: Math.max(60, Math.min(260, (destination ? destination.side === 'left' : onRight) ? x + size - 12 : vp.w - x - 12)) }} role="status" aria-live="polite" onClick={() => ctl.hideBubble()}>
            {s.bubble.text}
          </div>
        )}
        <button
          className={`sm-char-btn ${dragPos ? 'sm-dragging' : ''}`}
          style={{ width: size, height: Math.round(size * avatarAspect(s.settings.avatar)) }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
            setDragPos(null);
          }}
          aria-label={`ScrollMate (${st.enabled ? 'active' : 'off'}). Click for settings, drag to move.`}
          aria-expanded={open}
          onClick={(e) => {
            // Pointer clicks are handled above to distinguish dragging; keyboard activation still opens settings.
            if (e.detail === 0) setOpen((o) => !o);
          }}
        >
          <span className="sm-float">
            <Avatar kind={s.settings.avatar} mood={s.mood} look={look} />
          </span>
          <span className={`sm-dot ${st.enabled ? 'sm-on' : 'sm-off'}`} title={st.enabled ? 'Active' : 'Off'} />
          {st.demo && st.enabled && <span className="sm-demo-badge">DEMO</span>}
          {st.enabled && st.userCam && s.camera === 'on' && (
            <span className="sm-cam-badge" title="Camera on: processed on this computer only">📷</span>
          )}
        </button>
        {/* No label once it's reacting: a face-only reaction speaks for itself (no lone "Hmm…"). */}
        {visit && !s.bubble && visit.phase !== 'reacting' && (
          <span className="sm-reading-label" role="status">{visit.phase === 'running' ? 'Coming over…' : 'Reading…'}</span>
        )}
        {!visit && st.enabled && s.commentHint && <span className="sm-reading-label" role="status">{s.commentHint}</span>}

        {s.demo && ctl.env === 'youtube' && (
          <div className="sm-demo-strip">
            <div className="sm-demo-strip-title">
              Short {s.demo.index + 1}/3 · {s.demo.short.title}
            </div>
            <div className="sm-progress">
              <div style={{ width: `${(s.demo.elapsed / s.demo.short.duration) * 100}%` }} />
            </div>
            <button className="sm-mini-btn" onClick={() => ctl.demoNext()}>
              Next ]
            </button>
          </div>
        )}

        {open && <Popover ctl={ctl} state={s} onClose={() => setOpen(false)} />}
      </div>
    </div>
  );
}
