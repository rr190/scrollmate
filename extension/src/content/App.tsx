import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Character } from './Character';
import type { Controller, Position } from './controller';
import { Popover } from './Popover';

function useViewport() {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
}

function charSize(w: number) {
  return Math.round(Math.min(110, Math.max(80, w * 0.065)));
}

/** Default: upper right of the video, clear of the right-hand action column and the bottom title. */
function defaultPosition(ctl: Controller, w: number, h: number): Position {
  const size = charSize(w);
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
  const size = charSize(vp.w);
  const [open, setOpen] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const [fallback, setFallback] = useState<Position | null>(null);

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
  const clampX = (x: number) => Math.min(vp.w - size - 4, Math.max(4, x));
  const clampY = (y: number) => Math.min(vp.h - size - 4, Math.max(4, y));
  const x = dragPos ? dragPos.x : clampX(pos.fx * vp.w);
  const y = dragPos ? dragPos.y : clampY(pos.fy * vp.h);
  const onRight = x + size / 2 > vp.w / 2;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, ox: x, oy: y, moved: false };
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
    if (d.moved && dragPos) {
      ctl.savePosition({ fx: dragPos.x / vp.w, fy: dragPos.y / vp.h });
      setDragPos(null);
    } else {
      setOpen((o) => !o);
    }
  };

  const st = s.settings;
  return (
    <div className="sm-layer">
      <div className={`sm-companion ${onRight ? 'sm-right' : 'sm-left'}`} style={{ left: x, top: y, width: size }}>
        {s.bubble && (
          <div key={s.bubble.id} className="sm-bubble" role="status" aria-live="polite" onClick={() => ctl.hideBubble()}>
            {s.bubble.text}
          </div>
        )}
        <button
          className={`sm-char-btn ${dragPos ? 'sm-dragging' : ''}`}
          style={{ width: size, height: Math.round(size * 0.86) }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
            setDragPos(null);
          }}
          aria-label={`ScrollMate (${st.enabled ? 'active' : 'off'}). Click for settings, drag to move.`}
          aria-expanded={open}
        >
          <span className="sm-float">
            <Character mood={s.mood} />
          </span>
          <span className={`sm-dot ${st.enabled ? 'sm-on' : 'sm-off'}`} title={st.enabled ? 'Active' : 'Off'} />
          {st.demo && st.enabled && <span className="sm-demo-badge">DEMO</span>}
        </button>

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
