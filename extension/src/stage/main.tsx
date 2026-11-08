/**
 * Offline demo stage: an extension page with a fake Shorts player, so the pitch
 * doesn't depend on venue Wi-Fi or YouTube's layout on the day.
 */
import { createRoot } from 'react-dom/client';
import { useSyncExternalStore } from 'react';
import { mountScrollMate } from '../content/mount';
import type { Controller } from '../content/controller';
import type { DemoShort } from '../content/demo';
import './stage.css';

function CakeArt({ art, t }: { art: DemoShort['art']; t: number }) {
  if (art === 'success') {
    const berries = t > 5.5;
    return (
      <svg viewBox="0 0 300 300" className="art">
        <ellipse cx="150" cy="250" rx="125" ry="22" fill="#e9e4df" />
        <rect x="55" y="150" width="190" height="95" rx="16" fill="#5b3523" />
        <rect x="55" y="190" width="190" height="16" fill="#c79a7a" />
        <ellipse cx="150" cy="150" rx="95" ry="20" fill="#6b3e29" />
        {Array.from({ length: 26 }).map((_, i) => (
          <circle key={i} cx={70 + ((i * 37) % 160)} cy={140 + ((i * 13) % 20)} r="1.6" fill="#fff" opacity="0.8" />
        ))}
        {berries && (
          <g className="pop">
            <path d="M115 140 q15 -38 30 0 q-15 14 -30 0z" fill="#e8344e" />
            <path d="M150 136 q16 -40 32 0 q-16 15 -32 0z" fill="#f04157" />
            <path d="M135 146 q14 -30 28 0 q-14 12 -28 0z" fill="#d92a43" />
            <path d="M128 104 l6 6 l6 -6 M164 98 l6 6 l6 -6" stroke="#3f8a3a" strokeWidth="4" fill="none" />
          </g>
        )}
      </svg>
    );
  }
  if (art === 'fail') {
    const smoke = t > 4.5;
    return (
      <svg viewBox="0 0 300 300" className="art">
        <ellipse cx="150" cy="250" rx="120" ry="20" fill="#3b3b3b" />
        <path d="M60 245 C55 190 80 160 110 168 C125 140 175 140 190 165 C225 158 248 195 240 245 Z" fill={t > 6.5 ? '#1c1310' : '#6b3e29'} />
        {t > 6.5 && <path d="M90 200 l18 -10 l10 14 l20 -12 l14 16 l22 -10" stroke="#3a2a22" strokeWidth="4" fill="none" />}
        {smoke && (
          <g className="smoke">
            <circle cx="120" cy="120" r="26" />
            <circle cx="160" cy="95" r="34" />
            <circle cx="195" cy="125" r="22" />
            <circle cx="140" cy="60" r="28" />
          </g>
        )}
      </svg>
    );
  }
  const glaze = Math.min(1, Math.max(0, (t - 2.5) / 4));
  return (
    <svg viewBox="0 0 300 300" className="art">
      <defs>
        <linearGradient id="glz" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#ffb3d1" />
          <stop offset="50%" stopColor="#c58cff" />
          <stop offset="100%" stopColor="#7d5ce0" />
        </linearGradient>
      </defs>
      <ellipse cx="150" cy="252" rx="120" ry="20" fill="#f1eef7" />
      <path d="M70 245 L70 170 C70 110 230 110 230 170 L230 245 Z" fill="#f6efe6" />
      <clipPath id="glzClip">
        <rect x="60" y="100" width="180" height={150 * glaze} />
      </clipPath>
      <path clipPath="url(#glzClip)" d="M68 247 L68 170 C68 106 232 106 232 170 L232 247 Z" fill="url(#glz)" />
      {glaze > 0.95 && (
        <g className="pop">
          <path d="M100 150 C110 128 140 120 160 122" stroke="#fff" strokeWidth="8" strokeLinecap="round" opacity="0.55" fill="none" />
          <circle cx="150" cy="112" r="9" fill="#ffd34d" />
          <path d="M210 90 l6 -14 l6 14 l14 6 l-14 6 l-6 14 l-6 -14 l-14 -6z" fill="#fff" opacity="0.9" />
        </g>
      )}
    </svg>
  );
}

function Stage({ ctl }: { ctl: Controller }) {
  const s = useSyncExternalStore(ctl.subscribe, ctl.getState);
  const d = s.demo;
  if (!d) {
    return (
      <div className="wrap">
        <div className="phone" id="sm-stage-video">
          <div className="empty">Demo is off. Turn the AI companion on in ScrollMate's popover.</div>
        </div>
      </div>
    );
  }
  const pct = (d.elapsed / d.short.duration) * 100;
  return (
    <div className="wrap">
      <div className={`phone bg-${d.short.art}`} id="sm-stage-video" onClick={() => ctl.demoTogglePause()}>
        <div className="topbar">
          <span className="yt">▶</span> Shorts <span className="tag">DEMO STAGE</span>
        </div>
        <CakeArt art={d.short.art} t={d.elapsed} />
        <div className="rail" aria-hidden="true">
          <span>👍<small>128K</small></span>
          <span>💬<small>1.2K</small></span>
          <span>↗<small>Share</small></span>
        </div>
        <div className="meta">
          <div className="chan">{d.short.channel}</div>
          <div className="title">{d.short.title}</div>
        </div>
        <div className="bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        {d.paused && <div className="overlay">❚❚ paused</div>}
        {d.phase === 'finished' && <div className="overlay">Demo complete. Press ] to replay</div>}
      </div>
      <div className="controls">
        <div className="dots">
          {[0, 1, 2].map((i) => (
            <span key={i} className={i === d.index ? 'on' : i < d.index ? 'done' : ''} />
          ))}
        </div>
        <button onClick={() => ctl.demoNext()}>Next Short ]</button>
        <button onClick={() => ctl.demoTogglePause()}>{d.paused ? 'Play' : 'Pause'}</button>
        <button onClick={() => ctl.demoRestart()}>Restart</button>
      </div>
      <p className="tip">
        Watch ScrollMate stay quiet, remember each cake, start thinking during Short 3, and wait for the end before it speaks. Click the character for settings, Live LLM mode
        and the decision log.
      </p>
    </div>
  );
}

const { ctl } = mountScrollMate('stage');
createRoot(document.getElementById('stage')!).render(<Stage ctl={ctl} />);
