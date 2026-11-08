import { useEffect, useState } from 'react';
import type { MemoryRecord, Settings } from '../shared/types';
import { AVATARS, Avatar } from './Avatar';
import type { Controller, UiState } from './controller';
import type { GazeZone } from '../shared/faceSignals';

const GAZE_ZONE_TEXT: Record<GazeZone, string> = {
  video: 'the video',
  comments: 'the comments',
  mochi: 'Mochi',
  elsewhere: 'the page',
  off_screen: 'off screen',
};

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="sm-row">
      <span>
        <span className="sm-label">{label}</span>
        {hint && <span className="sm-hint">{hint}</span>}
      </span>
      <button role="switch" aria-checked={checked} className={`sm-switch ${checked ? 'sm-switch-on' : ''}`} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </label>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="sm-field">
      <div className="sm-label">{label}</div>
      <div className="sm-seg" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'sm-seg-on' : ''} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Popover({ ctl, state, onClose }: { ctl: Controller; state: UiState; onClose: () => void }) {
  const st = state.settings;
  const set = (p: Partial<Settings>) => void ctl.updateSettings(p);
  const [memory, setMemory] = useState<MemoryRecord[]>([]);
  const [showPrivacy, setShowPrivacy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => ctl.getMemory().then((m) => alive && setMemory(m));
    load();
    const id = window.setInterval(load, 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [ctl]);

  return (
    <div className="sm-popover" role="dialog" aria-label="ScrollMate settings" onPointerDown={(e) => e.stopPropagation()}>
      <div className="sm-pop-head">
        <strong>ScrollMate</strong>
        <span className={`sm-pill ${st.enabled ? 'sm-pill-on' : ''}`}>{st.enabled ? 'Active' : 'Off'}</span>
        <button className="sm-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <Toggle label="AI companion" hint={st.enabled ? 'Watching with you' : 'Asleep. Nothing is analysed'} checked={st.enabled} onChange={(v) => set({ enabled: v })} />
      <Toggle label="Voice" hint="Speaks only when it's quiet" checked={st.voice} onChange={(v) => set({ voice: v })} />
      <Toggle label="Roam around 🚶" hint="Small steps left and right; drag to park it for 30 s" checked={st.roam} onChange={(v) => set({ roam: v })} />
      <Toggle
        label="React to me 📷"
        hint={st.userCam ? {off: 'Off. Mochi only watches the video', starting: 'Starting the camera…', on: 'On: laughs along with you, waits while you look away', needs_permission: 'Allow the camera in the tab that opened', error: 'Camera unavailable'}[state.camera] : 'Webcam, on this computer only. Off by default'}
        checked={st.userCam}
        onChange={(v) => set({ userCam: v })}
      />
      {st.userCam && state.user && state.camera === 'on' && (
        <div className="sm-hint" style={{ marginTop: -4 }}>
          You: {state.user.present ? (state.user.lookingAway ? 'looking away' : state.user.expression) : 'not in view'}
          {st.eyeTrack && state.gaze.zone && ` · eyes on ${GAZE_ZONE_TEXT[state.gaze.zone]}`}
        </div>
      )}
      {st.userCam && (
        <>
          <Toggle
            label="Eye tracking 👀"
            hint={
              !state.gaze.calibrated
                ? 'Needs a 30-second calibration first'
                : st.eyeTrack
                  ? `Knows video vs comments vs Mochi (accuracy ~${Math.round((state.gaze.error ?? 0) * 100)}% of the screen)`
                  : 'Off. Calibrated and ready'
            }
            checked={st.eyeTrack}
            onChange={(v) => set({ eyeTrack: v })}
          />
          <button className="sm-link" onClick={() => ctl.openGazeCalibration()}>
            {state.gaze.calibrated ? 'Re-calibrate my eyes' : 'Calibrate my eyes'}
          </button>
        </>
      )}
      {ctl.env === 'youtube' && <>
        <Toggle label="Comment reactions" hint="Close settings, then hover over comment text for a second" checked={st.commentReactions} onChange={(v) => set({ commentReactions: v })} />
        <button className="sm-link" onClick={() => ctl.checkCommentDetection()}>Check comment detection</button>
      </>}

      <Segmented label="Personality" value={st.personality} options={[['witty', 'Witty'], ['hype', 'Hype'], ['chill', 'Chill']]} onChange={(v) => set({ personality: v })} />
      <Segmented label="Reactions" value={st.frequency} options={[['rare', 'Rare'], ['balanced', 'Balanced'], ['chatty', 'Chatty']]} onChange={(v) => set({ frequency: v })} />

      <div className="sm-field">
        <div className="sm-label">Avatar</div>
        <div className="sm-avatars" role="radiogroup" aria-label="Avatar">
          {AVATARS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={st.avatar === a.id}
              className={`sm-avatar-opt ${st.avatar === a.id ? 'sm-avatar-on' : ''}`}
              onClick={() => set({ avatar: a.id })}
              title={a.hint}
            >
              <span className="sm-avatar-prev">
                <Avatar kind={a.id} mood={st.avatar === a.id ? 'amused' : 'idle'} />
              </span>
              <span className="sm-avatar-name">{a.label}</span>
              <span className="sm-hint">{a.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sm-field">
        <div className="sm-label">Remembers (last 3 Shorts)</div>
        {memory.length === 0 ? (
          <div className="sm-hint">Nothing yet.</div>
        ) : (
          <ol className="sm-memory">
            {memory.map((m) => (
              <li key={m.videoId} title={m.summary}>
                <span className="sm-chip">{m.skipped ? 'skipped' : m.topic}</span> {m.summary}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="sm-actions">
        <button className="sm-btn" onClick={() => void ctl.clearMemory().then(() => setMemory([]))}>
          Clear memory
        </button>
        <button className="sm-btn" onClick={() => ctl.exportLog()} title="Download the timing engine's decision log (JSON)">
          Export log ({ctl.engine.log.length})
        </button>
      </div>

      <div className="sm-section">
        {ctl.env === 'youtube' && <Toggle label="Demo mode" hint="3 scripted Shorts, works offline" checked={st.demo} onChange={(v) => set({ demo: v, enabled: v ? true : st.enabled })} />}
        {st.demo && (
          <>
            <Segmented label="Demo reactions" value={st.demoLive ? 'live' : 'canned'} options={[['canned', 'Canned (offline)'], ['live', 'Live LLM']]} onChange={(v) => set({ demoLive: v === 'live' })} />
            <div className="sm-actions">
              <button className="sm-btn" onClick={() => ctl.demoRestart()}>
                Restart demo
              </button>
              <button className="sm-btn" onClick={() => ctl.demoNext()}>
                Next Short ]
              </button>
            </div>
          </>
        )}
        {ctl.env === 'youtube' && (
          <button className="sm-link" onClick={() => ctl.openStage()}>
            Open offline demo stage ↗
          </button>
        )}
      </div>

      {state.note && <div className="sm-note">{state.note}</div>}
      {ctl.env === 'youtube' && state.frameSource && state.frameSource !== 'screen' && st.enabled && !st.demo && (
        <div className="sm-note">
          Seeing via {state.frameSource === 'canvas' ? 'video canvas' : 'title & captions only'}. Click the ScrollMate toolbar icon to allow screen frames.
        </div>
      )}

      <button className="sm-link" onClick={() => setShowPrivacy((p) => !p)} aria-expanded={showPrivacy}>
        {showPrivacy ? 'Hide' : 'What is sent to the AI?'}
      </button>
      {showPrivacy && (
        <div className="sm-privacy">
          <p>
            <b>Sent</b> (only while Active, only on youtube.com/shorts): up to 3 downscaled frames (≤512 px JPEG) per Short, its title, channel name and any captions visible on the page,
            plus short text notes about the last 3 Shorts. With Comment reactions on, hovering for a second also sends that visible comment's text and the current video's notes. Author metadata is not sent.
          </p>
          <p>
            <b>Never stored</b>: frames, audio or transcripts. Memory is the last 3 one-line summaries, held in RAM and wiped by “Clear memory”. No other browsing data is read. The camera (if on) is processed on this computer only; eye tracking keeps its personal model (numbers, no images) in this browser.
          </p>
        </div>
      )}
    </div>
  );
}
