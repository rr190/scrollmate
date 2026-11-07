import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Avatar, avatarAspect } from './Avatar';
import type { Controller, Position } from './controller';
import { Popover } from './Popover';
import { COMMENT_TRAVEL_MS, commentPosition, companionSize } from './comments';

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

  if (ctl.env === 'youtube' && !s.onShorts) return null; // dormant outside /shorts/

  const pos = s.position ?? fallback ?? { fx: 0.7, fy: 0.2 };
  const visit = s.commentVisit;
  const destination = visit ? commentPosition(visit, vp.w, vp.h) : null;
  const clampX = (x: number) => Math.min(vp.w - size - 4, Math.max(4, x));
  const clampY = (y: number) => Math.min(vp.h - size - 4, Math.max(4, y));
  const x = dragPos ? dragPos.x : destination?.x ?? clampX(pos.fx * vp.w);
  const y = dragPos ? dragPos.y : destination?.y ?? clampY(pos.fy * vp.h);
  const onRight = x + size / 2 > vp.w / 2;

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
        className={`sm-companion ${onRight ? 'sm-right' : 'sm-left'} ${dragPos ? 'sm-manual-position' : ''} ${travelling || visit?.phase === 'running' ? 'sm-travelling' : ''} ${destination ? `sm-comment-${destination.side}` : ''} ${destination && y < 130 ? 'sm-comment-below' : ''}`}
        style={{ left: 0, top: 0, transform: `translate3d(${x}px, ${y}px, 0)`, width: size }}
      >
        {s.bubble && (
          <div key={s.bubble.id} className="sm-bubble" style={destination ? { maxWidth: Math.max(60, Math.min(260, (destination.side === 'left' ? x + size : vp.w - x) - 40)) } : undefined} role="status" aria-live="polite" onClick={() => ctl.hideBubble()}>
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
            <Avatar kind={s.settings.avatar} mood={s.mood} />
          </span>
          <span className={`sm-dot ${st.enabled ? 'sm-on' : 'sm-off'}`} title={st.enabled ? 'Active' : 'Off'} />
          {st.demo && st.enabled && <span className="sm-demo-badge">DEMO</span>}
        </button>
        {visit && !s.bubble && <span className="sm-reading-label" role="status">{visit.phase === 'running' ? 'Coming over…' : visit.phase === 'reading' ? 'Reading…' : 'Hmm…'}</span>}
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
