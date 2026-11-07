/**
 * Emotion cue track: plays the character's facial reactions in sync with the video.
 *
 * A cue fires when playback *crosses* its time (shortly before it, so the face lands on
 * the moment), holds briefly, then lets the face ease back. Facial reactions never
 * interrupt the video, so unlike speech they may happen mid-playback. On real Shorts
 * the analysis arrives near the end of the first play, so cues mostly fire on the loop.
 * Pure: time is injected so it can be tested without a browser.
 */
export type Emotion = 'curious' | 'surprised' | 'laughing' | 'impressed' | 'worried' | 'cringe' | 'love' | 'sad';

export interface EmotionCue {
  t: number; // video seconds
  emotion: Emotion;
  intensity: number; // 0..1
}

export const LEAD_S = 0.3; // react slightly before the moment
const HOLD_MS = 1400;
const HOLD_EXTRA_MS = 800; // stronger reactions hold a little longer
const SEEK_BACK_S = 0.75; // currentTime jumping back this much = loop or seek

export interface ActiveEmotion {
  emotion: Emotion;
  cue: EmotionCue;
  until: number; // ms wall time
}

export class CueTrack {
  private videoId: string | null = null;
  private cues: EmotionCue[] = [];
  private prev: number | null = null;
  active: ActiveEmotion | null = null;

  get loadedFor(): string | null {
    return this.videoId;
  }

  load(videoId: string, cues: EmotionCue[]) {
    this.videoId = videoId;
    this.cues = [...cues].filter((c) => Number.isFinite(c.t)).sort((a, b) => a.t - b.t);
    this.prev = null; // don't fire cues we're already past
    this.active = null;
  }

  clear() {
    this.videoId = null;
    this.cues = [];
    this.prev = null;
    this.active = null;
  }

  /** Call often (every tick). Returns the cue that just fired, if any. */
  update(videoId: string | null, currentTime: number, playing: boolean, now: number): EmotionCue | null {
    if (videoId !== this.videoId) {
      this.active = null; // scrolled away: drop the face reaction immediately
      return null;
    }
    if (this.active && now > this.active.until) this.active = null;
    const prev = this.prev;
    this.prev = currentTime;
    if (!playing || prev === null) return null;

    // Loop or seek backwards: restart the window from the beginning.
    const from = currentTime < prev - SEEK_BACK_S ? -Infinity : prev;
    let fired: EmotionCue | null = null;
    for (const c of this.cues) {
      const start = Math.max(0, c.t - LEAD_S);
      if (from < start && start <= currentTime) fired = c; // latest crossed cue wins
    }
    if (fired) this.active = { emotion: fired.emotion, cue: fired, until: now + HOLD_MS + HOLD_EXTRA_MS * fired.intensity };
    return fired;
  }

  /** Remember a cue so it replays in sync on the next loop (does not fire it now). */
  add(videoId: string, cue: EmotionCue) {
    if (videoId !== this.videoId) this.load(videoId, []);
    if (this.cues.some((c) => Math.abs(c.t - cue.t) < 1)) return;
    this.cues = [...this.cues, cue].sort((a, b) => a.t - b.t);
  }

  /** Show a face right now for the Short on screen (e.g. reacting to captions just said). */
  fireNow(videoId: string, emotion: Emotion, intensity: number, currentTime: number, now: number): EmotionCue {
    if (videoId !== this.videoId) this.load(videoId, []); // keep any cues already loaded for this Short
    const cue: EmotionCue = { t: currentTime, emotion, intensity };
    this.active = { emotion, cue, until: now + HOLD_MS + HOLD_EXTRA_MS * intensity };
    return cue;
  }

  current(now: number): Emotion | null {
    return this.active && now <= this.active.until ? this.active.emotion : null;
  }
}
