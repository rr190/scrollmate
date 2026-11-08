import { useId, type CSSProperties } from 'react';
import type { Frequency, Personality, Settings } from '../shared/types';
import { AVATARS, Avatar } from './Avatar';
import type { Controller, UiState } from './controller';

const point = (angle: number, radius: number) => ({ x: 240 + Math.sin(angle * Math.PI / 180) * radius, y: 240 - Math.cos(angle * Math.PI / 180) * radius });
function sector(start: number, end: number, inner: number, outer: number) {
  const a = point(start, outer), b = point(end, outer), c = point(end, inner), d = point(start, inner);
  const large = end - start > 180 ? 1 : 0;
  return `M${a.x},${a.y} A${outer},${outer} 0 ${large} 1 ${b.x},${b.y} L${c.x},${c.y} A${inner},${inner} 0 ${large} 0 ${d.x},${d.y}Z`;
}
const at = (angle: number, radius: number): CSSProperties => {
  const p = point(angle, radius); return { left: `${p.x / 4.8}%`, top: `${p.y / 4.8}%` };
};

function RingChoices<T extends string>({ label, value, options, angles, onChange }: {
  label: string; value: T; options: [T, string][]; angles: number[]; onChange(value: T): void;
}) {
  return <div className="sm-ring-choices" role="radiogroup" aria-label={label}>
    {options.map(([id, text], i) => <button key={id} type="button" role="radio" aria-checked={value === id}
      className={`sm-ring-choice ${value === id ? 'sm-ring-active' : ''}`}
      style={{ ...at(angles[i], 156), transform: `translate(-50%, -50%) rotate(${angles[i] > 180 ? angles[i] - 360 : angles[i]}deg)` }}
      onClick={() => onChange(id)} onKeyDown={(event) => {
        const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
        if (!delta) return;
        event.preventDefault(); const next = (i + delta + options.length) % options.length;
        onChange(options[next][0]); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next].focus();
      }}>{text}</button>)}
  </div>;
}

/** Only the ring: the existing floating buddy stays at its centre. */
export function RingMenu({ ctl, state, onClose }: { ctl: Controller; state: UiState; onClose(): void }) {
  const st = state.settings;
  const set = (patch: Partial<Settings>) => void ctl.updateSettings(patch);
  const id = useId().replace(/:/g, '');
  return <div className="sm-orbit-menu" role="group" aria-label="Buddy ring" onPointerDown={(event) => event.stopPropagation()}>
    <div className="sm-orbit-wheel">
      <svg className="sm-orbit-plate" viewBox="0 0 480 480" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-lavender`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#f8f5ff" /><stop offset="1" stopColor="#e9e1ff" /></linearGradient>
          <path id={`${id}-personality`} d={`M${point(277, 209).x},${point(277, 209).y} A209,209 0 0 1 ${point(355, 209).x},${point(355, 209).y}`} />
          <path id={`${id}-reactions`} d={`M${point(5, 209).x},${point(5, 209).y} A209,209 0 0 1 ${point(83, 209).x},${point(83, 209).y}`} />
        </defs>
        <path d={sector(0, 359.99, 118, 235)} fill={`url(#${id}-lavender)`} stroke="#d8c9ff" strokeWidth="2" />
        <path d={sector(271, 359, 183, 232)} className="sm-orbit-sector sm-orbit-personality" />
        <path d={sector(1, 89, 183, 232)} className="sm-orbit-sector" />
        {[272, 301, 330].map((start) => <path key={start} d={sector(start, start + 27, 132, 179)} className="sm-orbit-slot" />)}
        {[2, 31, 60].map((start) => <path key={start} d={sector(start, start + 27, 132, 179)} className="sm-orbit-slot" />)}
        <path d={sector(93, 267, 131, 232)} className="sm-orbit-avatar-track" />
        <text className="sm-orbit-arc"><textPath href={`#${id}-personality`} startOffset="50%" textAnchor="middle">Personality</textPath></text>
        <text className="sm-orbit-arc"><textPath href={`#${id}-reactions`} startOffset="50%" textAnchor="middle">Reactions</textPath></text>
      </svg>

      <RingChoices<Personality> label="Personality" value={st.personality} options={[[ 'witty', 'Witty' ], [ 'hype', 'Hype' ], [ 'chill', 'Chill' ]]} angles={[285, 315, 345]} onChange={(personality) => set({ personality })} />
      <RingChoices<Frequency> label="Reaction frequency" value={st.frequency} options={[[ 'rare', 'Rare' ], [ 'balanced', 'Balanced' ], [ 'chatty', 'Chatty' ]]} angles={[15, 45, 75]} onChange={(frequency) => set({ frequency })} />

      <div role="radiogroup" aria-label="Avatar" className="sm-orbit-avatars">
        {AVATARS.map((avatar, index) => <button key={avatar.id} type="button" role="radio" aria-checked={st.avatar === avatar.id}
          aria-label={`Choose ${avatar.label}`} title={`${avatar.label} · ${avatar.hint}`}
          className={`sm-orbit-avatar ${st.avatar === avatar.id ? 'sm-orbit-selected' : ''}`} style={at(255 - index * 30, 187)}
          onClick={() => set({ avatar: avatar.id })} onKeyDown={(event) => {
            const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
            if (!delta) return;
            event.preventDefault(); const next = (index + delta + AVATARS.length) % AVATARS.length;
            set({ avatar: AVATARS[next].id }); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next].focus();
          }}>
          <span><Avatar kind={avatar.id} mood={st.avatar === avatar.id ? 'amused' : 'idle'} /></span>
          {st.avatar === avatar.id && <i aria-hidden="true" />}
        </button>)}
      </div>

      <div className="sm-orbit-centre">
        <span className="sm-orbit-power-label">{st.enabled ? 'Tap to turn off' : 'Tap to turn on'}</span>
      </div>
      {st.enabled && <button type="button" className="sm-orbit-calibrate" onClick={() => ctl.openGazeCalibration()}
        title="Eye tracking needs camera permission and a one-time calibration">
        {state.gaze.calibrated ? 'Recalibrate eyes' : 'Set up eyes'}
      </button>}
      {st.enabled && state.camera === 'needs_permission' && <span className="sm-orbit-camera-note" role="status">Allow camera in setup tab</span>}
      {st.enabled && state.camera === 'error' && <span className="sm-orbit-camera-note" role="status">Camera unavailable</span>}
      {ctl.env === 'youtube' && <button type="button" className="sm-talk-launch" aria-label={state.talk.active ? 'Stop talking to buddy' : 'Talk to buddy'}
        aria-pressed={state.talk.active} disabled={!st.enabled || st.demo}
        title={st.enabled ? (state.talk.active ? 'Stop talking to buddy' : 'Tap to talk') : 'Turn the buddy on to talk'}
        onClick={() => { ctl.toggleTalk(); onClose(); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="8" y="2" width="8" height="13" rx="4" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </svg>
      </button>}
      <button type="button" className="sm-orbit-close" aria-label="Close ring" title="Close ring" onClick={onClose}>{'\u00d7'}</button>
    </div>
  </div>;
}
