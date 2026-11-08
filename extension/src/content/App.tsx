import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Avatar, avatarAspect } from './Avatar';
import type { Controller, Position } from './controller';
import { RingMenu } from './RingMenu';
import { TalkControls } from './TalkControls';
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
      const path = event.composedPath();
      if (companion.current && !path.includes(companion.current)) setOpen(false);
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

  // Close the ring on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); if (s.talk.active) ctl.endTalk(); }
      if (e.key === ']' && s.demo) ctl.demoNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.demo, s.talk.active, ctl]);

  // ---------- roaming (ticks ~4x a second; only reads state, never changes what the AI does) ----------
  const st0 = s.settings;
  const holdRoam = open || dragPos !== null || !!s.commentVisit || !!s.bubble || s.mood === 'speaking';
  const roamOn = st0.roam && st0.enabled && (ctl.env === 'stage' || s.onShorts);
  const latest = useRef({ holdRoam, roamOn, mood: s.mood, size, vp });
  latest.current = { holdRoam, roamOn, mood: s.mood, size, vp };
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
  const clampY = (y: number) => Math.min(vp.h - size - 32, Math.max(4, y));
  const homeX = destination?.x ?? clampX(roam?.x ?? pos.fx * vp.w);
  const homeY = destination?.y ?? clampY(roam?.y ?? pos.fy * vp.h);
  const height = Math.round(size * avatarAspect(s.settings.avatar));
  const ringSize = Math.min(320, vp.w - 24, vp.h - 24);
  const insetX = (ringSize - size) / 2;
  const insetY = (ringSize - height) / 2;
  // Make room for the ring near an edge without changing the saved home position.
  const x = dragPos?.x ?? (open ? Math.max(12 + insetX, Math.min(vp.w - ringSize - 12 + insetX, homeX)) : homeX);
  const y = dragPos?.y ?? (open ? Math.max(12 + insetY, Math.min(vp.h - ringSize - 12 + insetY, homeY)) : homeY);
  rendered.current = { x, y };
  const onRight = x + size / 2 > vp.w / 2;
  const activate = () => {
    if (!open) { setOpen(true); return; }
    void ctl.updateSettings({ enabled: !s.settings.enabled });
    setOpen(false);
  };
  const roamingWalk = walking && !open && !dragPos && !destination;
  // Face the direction of ordinary walking.
  const look = roamingWalk && roam ? { x: roam.dir, y: 0 } : null;

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
    setOpen(false);
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
      activate();
    }
  };

  const st = s.settings;
  const talkCaption = s.talk.active && ['thinking', 'speaking'].includes(s.talk.phase) ? s.talk.reply : '';
  return (
    <div className="sm-layer">
      {visit && <div className="sm-comment-outline" aria-hidden="true" style={{ left: visit.rect.x - 4, top: visit.rect.y - 4, width: visit.rect.width + 8, height: visit.rect.height + 8 }} />}
      <div
        ref={companion}
        className={`sm-companion ${onRight ? 'sm-right' : 'sm-left'} ${dragPos || open ? 'sm-manual-position' : ''} ${open ? 'sm-ring-open' : ''} ${!open && (travelling || visit?.phase === 'running' || roamingWalk) ? 'sm-travelling' : ''} ${roamingWalk && roam?.stroll ? 'sm-strolling' : ''} ${destination ? `sm-comment-${destination.side}` : ''} ${y < 130 ? 'sm-bubble-below' : ''}`}
        style={{
          left: 0, top: 0, transform: `translate3d(${x}px, ${y}px, 0)`, width: size,
          ...(roamingWalk && roam ? { transitionDuration: `${roam.ms}ms`, transitionTimingFunction: roam.stroll ? 'linear' : 'cubic-bezier(0.45, 0.05, 0.55, 0.95)' } : {}),
        }}
      >
        {open && <div className="sm-ring-anchor" style={{ left: -insetX, top: -insetY, width: ringSize, height: ringSize, '--sm-buddy-height': `${height}px`, '--sm-buddy-width': `${size}px` } as CSSProperties}>
          <RingMenu ctl={ctl} state={s} onClose={() => {
            setOpen(false); companion.current?.querySelector<HTMLButtonElement>('.sm-char-btn')?.focus({ preventScroll: true });
          }} />
        </div>}
        {!open && (talkCaption || s.bubble) && (
          <div key={talkCaption ? 'talk-reply' : s.bubble!.id} className="sm-bubble" style={{ maxWidth: Math.max(60, Math.min(260, (destination ? destination.side === 'left' : onRight) ? x + size - 12 : vp.w - x - 12)) }} role="status" aria-live="polite" onClick={talkCaption ? undefined : () => ctl.hideBubble()}>
            {talkCaption || s.bubble!.text}
          </div>
        )}
        <button
          className={`sm-char-btn ${dragPos ? 'sm-dragging' : ''}`}
          style={{ width: size, height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
            setDragPos(null);
          }}
          aria-label={open ? (st.enabled ? 'Turn buddy off' : 'Turn buddy on') : `ScrollMate (${st.enabled ? 'active' : 'off'}). Click to open ring, drag to move.`}
          aria-expanded={open}
          onClick={(e) => {
            // Pointer clicks are handled above to distinguish dragging; keyboard activation still opens settings.
            if (e.detail === 0) activate();
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
        {!open && st.enabled && !st.demo && ctl.env === 'youtube' && <TalkControls ctl={ctl} state={s} />}
        {/* No label once it's reacting: a face-only reaction speaks for itself (no lone "Hmm…"). */}
        {!open && !s.talk.active && visit && !s.bubble && visit.phase !== 'reacting' && (
          <span className="sm-reading-label" role="status">{visit.phase === 'running' ? 'Coming over…' : 'Reading…'}</span>
        )}
        {!open && !s.talk.active && !visit && st.enabled && s.commentHint && <span className="sm-reading-label" role="status">{s.commentHint}</span>}
        {!open && st.enabled && s.mirrorPop && !s.commentHint && (
          <span key={s.mirrorPop.id} className="sm-mirror-pop" role="status">{s.mirrorPop.text}</span>
        )}

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

      </div>

    </div>
  );
}
