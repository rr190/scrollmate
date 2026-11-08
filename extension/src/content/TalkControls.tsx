import { useId } from 'react';
import type { Controller, UiState } from './controller';

/** One microphone on the character; conversation needs no separate panel. */
export function TalkControls({ ctl, state }: { ctl: Controller; state: UiState }) {
  const { talk } = state;
  const id = useId();
  const status = { ready: 'Listening next…', starting: 'Opening mic…', listening: 'Listening…',
    thinking: 'Thinking…', speaking: 'Speaking…', error: 'Mic off' }[talk.phase];
  return <div className="sm-talk-control">
    <button type="button" className={`sm-talk-toggle ${talk.active ? 'sm-talk-active' : ''}`}
      aria-label={talk.active ? 'Stop talking to buddy' : 'Talk to buddy'} aria-pressed={talk.active}
      aria-describedby={talk.active ? id : undefined}
      title={talk.error ?? (talk.active ? 'Tap to stop talking (Escape)' : 'Tap to talk. Your buddy listens and replies automatically.')}
      onClick={() => ctl.toggleTalk()}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <rect x="8" y="2" width="8" height="13" rx="4" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
      </svg>
    </button>
    {talk.active && <span id={id} className="sm-talk-status" role="status" aria-live="polite">{status}</span>}
  </div>;
}
