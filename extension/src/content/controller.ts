/**
 * The content-side brain. Wires together:
 *   ShortsWatcher / DemoDriver  ->  frame capture + analysis (via background)
 *   reaction proposals          ->  TimingEngine (decides)  ->  bubble / voice
 * The UI subscribes to `state` and stays dumb.
 */
import {
  sendBg,
  type CaptionReactResponse,
  type CaptureResponse,
  type ObserveResponse,
  type ReactResponse,
  type SwipeResponse,
  type TelemetryEvent,
} from '../shared/messages';
import { predictMoment } from '../shared/moments';
import { CueTrack, type Emotion, type EmotionCue } from '../shared/emotions';
import { TimingEngine, type Candidate, type Delivery, type PlaybackSnapshot } from '../shared/timing';
import { DEFAULT_SETTINGS, type MemoryRecord, type ReactionProposal, type Rect, type Settings } from '../shared/types';
import { DEMO_SHORTS, DemoDriver, type DemoShort, type DemoView } from './demo';
import { readPageText, ShortsWatcher, type LeftInfo, type ShortInfo } from './shorts';
import { Speaker } from './speech';

const LOG = '[ScrollMate]';
export type Mood = 'idle' | 'watching' | 'thinking' | 'amused' | 'speaking' | 'sleeping' | Emotion;
export type Env = 'youtube' | 'stage';

export interface Position {
  fx: number; // fraction of viewport width
  fy: number;
}

export interface UiState {
  mood: Mood;
  bubble: { id: string; text: string } | null;
  settings: Settings;
  position: Position | null;
  demo: DemoView | null;
  onShorts: boolean;
  frameSource: 'screen' | 'canvas' | 'text' | null;
  note: string | null;
}

interface ShortCtx {
  videoId: string;
  startedAt: number;
  frameCount: number; // frames analysed so far (max MAX_FRAMES)
  nextAt: number; // video second for the next frame
  capturing: boolean;
  observing: boolean; // an /observe call is in flight
  done: boolean; // seen enough of this Short
  title: string;
  firstFaceAt: number | null; // ms after the swipe
  captions: Set<string>;
  lastCaptionRead: number;
  pendingCaptions: string[]; // new lines not yet sent to the caption step
  lastCaptionSent: number;
  captionInflight: boolean;
}

const SETTINGS_KEY = 'scrollmate.settings';
const posKey = (env: Env) => `scrollmate.position.${env}`;
const SLEEP_AFTER_MS = 90_000;
const CAPTION_EVERY_MS = 4_000;
const MAX_FRAMES = 3;
const FIRST_FRAME_AT_S = 0.4; // as soon as the video is really playing
const MIN_FRAME_GAP_S = 1.5; // leave room for the call + Chrome's capture limit

let idSeq = 0;
const newId = () => `r${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export class Controller {
  state: UiState = {
    mood: 'sleeping',
    bubble: null,
    settings: { ...DEFAULT_SETTINGS },
    position: null,
    demo: null,
    onShorts: false,
    frameSource: null,
    note: null,
  };
  engine = new TimingEngine({ frequency: 'balanced', voiceEnabled: false });
  private listeners = new Set<() => void>();
  private speaker = new Speaker();
  private watcher: ShortsWatcher | null = null;
  private demo: DemoDriver | null = null;
  private ctx: ShortCtx | null = null;
  private navTimes: number[] = [];
  private busy = 0;
  private speaking = false;
  private bubbleTimer: number | undefined;
  private tickTimer: number | undefined;
  private lastActivity = Date.now();
  private demoTimers: number[] = [];
  private epoch = 0; // bumps on disable/clear so late async results are ignored
  private logSent = 0; // decision-log entries already sent to the live feed
  private cues = new CueTrack(); // timed facial reactions for the Short on screen

  constructor(public env: Env, private host: HTMLElement) {}

  // ---------- store plumbing ----------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;
  private set(patch: Partial<UiState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // ---------- lifecycle ----------
  async init() {
    try {
      const r = await chrome.storage.local.get([SETTINGS_KEY, posKey(this.env)]);
      const settings = { ...DEFAULT_SETTINGS, ...(r[SETTINGS_KEY] ?? {}) } as Settings;
      if (this.env === 'stage') Object.assign(settings, { demo: true, enabled: true });
      this.set({ settings, position: (r[posKey(this.env)] as Position) ?? null });
    } catch {
      /* storage unavailable: defaults */
    }
    this.applyEngineOpts();
    if (this.env === 'youtube') {
      this.watcher = new ShortsWatcher({
        onShortChange: (i, p) => this.onShortChange(i, p),
        onLeaveShorts: (p) => this.onLeaveShorts(p),
        onPlayback: (ev, video) => this.onPlayback(ev, video),
      });
      this.watcher.start();
      chrome.runtime.onMessage.addListener((m: { type?: string }) => {
        if (m?.type === 'ACTIVE_TAB_GRANTED') this.set({ note: 'Screen frames allowed for this tab.' });
      });
    }
    if (this.state.settings.demo && this.state.settings.enabled) this.startDemo();
    this.tickTimer = window.setInterval(() => this.tick(), 150); // fast enough to land faces on the moment
    this.tick();
  }

  destroy() {
    window.clearInterval(this.tickTimer);
    this.watcher?.stop();
    this.speaker.cancel();
  }

  // ---------- settings ----------
  async updateSettings(patch: Partial<Settings>) {
    const prev = this.state.settings;
    const next = { ...prev, ...patch };
    if (this.env === 'stage') next.demo = true;
    this.set({ settings: next });
    this.applyEngineOpts();
    chrome.storage.local.set({ [SETTINGS_KEY]: next }).catch(() => undefined);

    if (prev.enabled && !next.enabled) this.disable();
    if (!prev.voice && next.voice === false) this.speaker.cancel();
    if (prev.voice && !next.voice) this.speaker.cancel();
    const demoWasOn = prev.demo && prev.enabled;
    const demoIsOn = next.demo && next.enabled;
    if (!demoWasOn && demoIsOn) this.startDemo();
    if (demoWasOn && !demoIsOn) this.stopDemo();
    if (!prev.enabled && next.enabled && !next.demo) {
      this.set({ note: 'ScrollMate is watching. Reactions appear only at natural pauses.' });
      // Start fresh on the Short already on screen.
      if (this.watcher?.currentId) this.ctx = this.newCtx(this.watcher.currentId);
    }
    this.tick();
  }

  savePosition(p: Position) {
    this.set({ position: p });
    chrome.storage.local.set({ [posKey(this.env)]: p }).catch(() => undefined);
  }

  private applyEngineOpts() {
    this.engine.opts = { frequency: this.state.settings.frequency, voiceEnabled: this.state.settings.voice };
  }

  /** Stop all processing immediately. */
  private disable() {
    this.epoch++;
    this.cues.clear();
    this.engine.cancelAll(this.snapshot(), Date.now());
    this.speaker.cancel();
    this.hideBubble();
    this.busy = 0;
    this.ctx = null;
    this.stopDemo();
    sendBg({ type: 'CANCEL_ALL' }).catch(() => undefined);
    console.log(LOG, 'disabled: all processing stopped');
  }

  async clearMemory() {
    this.epoch++;
    this.cues.clear();
    this.engine.clear();
    this.speaker.cancel();
    this.hideBubble();
    this.busy = 0;
    if (this.ctx) this.ctx = this.newCtx(this.ctx.videoId);
    await sendBg({ type: 'CLEAR_MEMORY' }).catch(() => undefined);
    this.set({ note: 'Memory, queue and decision log cleared.' });
  }

  async getMemory(): Promise<MemoryRecord[]> {
    try {
      const r = await sendBg<{ memory: MemoryRecord[] }>({ type: 'GET_MEMORY' });
      return r?.memory ?? [];
    } catch {
      return [];
    }
  }

  exportLog() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), env: this.env, settings: this.state.settings, decisions: this.engine.log }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scrollmate-decisions-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  openStage() {
    sendBg({ type: 'OPEN_STAGE' }).catch(() => undefined);
  }

  private loadCues(videoId: string, cues: EmotionCue[]) {
    this.cues.load(videoId, cues);
    console.log(LOG, 'emotion cues', videoId, cues.map((c) => `${c.emotion}@${c.t}s`).join(', '));
  }

  // ---------- live feed telemetry (backend /ui) ----------
  private emit(ev: TelemetryEvent) {
    if (!this.state.settings.enabled) return;
    sendBg({ type: 'TELEMETRY', event: { demo: !!this.demo, ...ev } }).catch(() => undefined);
  }

  /** Forward new timing-engine decisions to the feed. */
  private flushDecisions() {
    const log = this.engine.log;
    if (this.logSent > log.length) this.logSent = 0; // log was cleared or trimmed
    for (; this.logSent < log.length; this.logSent++) {
      const d = log[this.logSent];
      this.emit({
        type: 'decision',
        videoId: d.inputs.videoOnScreen,
        target: d.targetVideoId,
        decision: d.decision,
        reason: d.reason,
        text: d.text,
        importance: d.inputs.importance,
        isCallback: d.isCallback,
        currentTime: d.inputs.currentTime,
        gap: d.inputs.naturalGap,
      });
    }
  }

  // ---------- snapshot + tick ----------
  snapshot(): PlaybackSnapshot {
    const now = Date.now();
    this.navTimes = this.navTimes.filter((t) => now - t < 30_000);
    const enabled = this.state.settings.enabled;
    if (this.demo) {
      const dv = this.demo.view(now);
      return {
        enabled,
        videoId: dv.short.videoId,
        playing: dv.phase === 'playing' && !dv.paused,
        paused: dv.paused,
        ended: dv.phase !== 'playing',
        currentTime: dv.elapsed,
        duration: dv.short.duration,
        lastLoopAt: null,
        muted: false,
        audioQuiet: true, // the demo has no soundtrack
        navTimes: this.navTimes,
      };
    }
    const v = this.watcher?.video ?? null;
    const id = this.watcher?.currentId ?? null;
    return {
      enabled,
      videoId: id,
      playing: !!v && !v.paused && !v.ended,
      paused: !!v && v.paused && !v.ended,
      ended: !!v && v.ended,
      currentTime: v?.currentTime ?? 0,
      duration: v && isFinite(v.duration) ? v.duration : 0,
      lastLoopAt: this.watcher?.lastLoopAt ?? null,
      muted: !!v && (v.muted || v.volume === 0),
      audioQuiet: null, // no audio analysis without tabCapture: assume it might be loud
      navTimes: this.navTimes,
    };
  }

  private tick() {
    const now = Date.now();
    if (this.demo) {
      this.demo.tick(now);
      this.set({ demo: this.demo.view(now) });
    }
    const snap = this.snapshot();
    if (this.state.settings.enabled) {
      const d = this.engine.tick(snap, now);
      this.flushDecisions(); // log the decision first, then the delivery it caused
      if (d) this.deliver(d);
      const cue = this.cues.update(snap.videoId, snap.currentTime, snap.playing, now);
      if (cue) {
        console.log(LOG, 'emotion', cue.emotion, `at ${snap.currentTime.toFixed(1)}s (cue ${cue.t}s)`);
        this.emit({ type: 'emotion', videoId: snap.videoId, emotion: cue.emotion, t: cue.t, at: Math.round(snap.currentTime * 10) / 10 });
      }
    }
    if (snap.playing) this.lastActivity = now;
    this.set({ mood: this.computeMood(snap, now), onShorts: this.env === 'stage' || !!snap.videoId });
  }

  private computeMood(s: PlaybackSnapshot, now: number): Mood {
    if (!this.state.settings.enabled) return 'sleeping';
    if (this.speaking) return 'speaking';
    if (this.state.bubble) return 'amused';
    const emo = this.cues.current(now); // a timed reaction to the moment on screen
    if (emo) return emo;
    if (this.busy > 0 || this.engine.hasPending()) return 'thinking';
    if (now - this.lastActivity > SLEEP_AFTER_MS) return 'sleeping';
    if (s.playing) return 'watching';
    return 'idle';
  }

  // ---------- delivery ----------
  private deliver(d: Delivery) {
    console.log(LOG, 'DELIVER', d.mode, `"${d.candidate.text}"`, '-', d.reason);
    this.emit({ type: 'delivered', videoId: d.candidate.targetVideoId, text: d.candidate.text, mode: d.mode, reason: d.reason });
    window.clearTimeout(this.bubbleTimer);
    this.set({ bubble: { id: d.candidate.id, text: d.candidate.text } });
    const linger = Math.min(8000, Math.max(4000, d.candidate.text.length * 75));
    if (d.mode === 'voice' && this.state.settings.voice && this.speaker.available) {
      this.speaker.speak(
        d.candidate.text,
        () => {
          this.speaking = true;
          this.tick();
        },
        () => {
          this.speaking = false;
          window.clearTimeout(this.bubbleTimer);
          this.bubbleTimer = window.setTimeout(() => this.hideBubble(), 2200);
          this.tick();
        },
      );
      this.bubbleTimer = window.setTimeout(() => this.hideBubble(), linger + 6000);
    } else {
      this.bubbleTimer = window.setTimeout(() => this.hideBubble(), linger);
    }
  }

  hideBubble() {
    window.clearTimeout(this.bubbleTimer);
    if (this.state.bubble) this.set({ bubble: null });
  }

  private propose(proposals: ReactionProposal[], avoidTimes: number[] = []) {
    if (!this.state.settings.enabled) return;
    const now = Date.now();
    for (const p of proposals) {
      if (!p?.text) continue;
      const c: Candidate = { ...p, id: newId(), createdAt: now, avoidTimes };
      console.log(LOG, 'proposal', c.importance, c.isCallback ? '(callback)' : '', `"${c.text}"`);
      const d = this.engine.propose(c, this.snapshot(), now);
      this.flushDecisions();
      if (d) this.deliver(d);
    }
    this.tick();
  }

  // ---------- YouTube pipeline: live loop ----------
  //  swipe  -> rules face (<1 ms) -> AI title step (~0.6 s) confirms
  //  frame 1 at ~0.5 s -> observe (~1-2 s) -> face now + maybe a line + "next frame at Xs"
  //  frames 2..3 at the predicted times (clamped), then the final belief becomes memory.
  private newCtx(videoId: string): ShortCtx {
    return {
      videoId,
      startedAt: Date.now(),
      frameCount: 0,
      nextAt: FIRST_FRAME_AT_S,
      capturing: false,
      observing: false,
      done: false,
      title: '',
      captions: new Set(),
      lastCaptionRead: 0,
      pendingCaptions: [],
      lastCaptionSent: 0,
      captionInflight: false,
      firstFaceAt: null,
    };
  }

  private onShortChange(info: ShortInfo, prev: LeftInfo | null) {
    this.lastActivity = Date.now();
    if (this.demo) return;
    this.navTimes.push(info.startedAt);
    if (prev) this.handleLeft(prev);
    const prevTitle = this.ctx?.title ?? '';
    const ctx = (this.ctx = this.newCtx(info.videoId));
    if (!this.state.settings.enabled) return;
    sendBg({ type: 'SHORT_STARTED', videoId: info.videoId }).catch(() => undefined);
    // YouTube updates the active reel's title a moment after the URL changes; skip a stale title.
    const readTitle = (attempt: number) => {
      if (this.ctx !== ctx) return;
      const { title, channel } = readPageText();
      if ((!title || title === prevTitle) && attempt < 4) {
        window.setTimeout(() => readTitle(attempt + 1), 250);
        return;
      }
      ctx.title = title;
      this.emit({ type: 'short_started', videoId: info.videoId, title, channel });
      void this.swipeStep(ctx, title, channel);
    };
    window.setTimeout(() => readTitle(0), 150);
    this.tick();
  }

  /** Instant face from title rules, then the AI title step refines it. Faces only: nothing is said yet. */
  private async swipeStep(ctx: ShortCtx, title: string, channel: string) {
    const now = Date.now();
    const rule = predictMoment(title);
    if (rule.emotion && this.isCurrent(ctx)) {
      this.showFace(ctx, rule.emotion, 0.5, 'title rules');
      this.emit({ type: 'status', videoId: ctx.videoId, note: `rules: ${rule.moment} → ${rule.emotion} in ${Date.now() - now} ms` });
    }
    if (!title) return;
    try {
      const res = await sendBg<SwipeResponse>({
        type: 'SWIPE',
        videoId: ctx.videoId,
        title,
        channel,
        personality: this.state.settings.personality,
        frequency: this.state.settings.frequency,
      });
      // Frames are more trustworthy than the title: never overwrite a face from frame analysis.
      if (!this.isCurrent(ctx) || ctx.frameCount > 0 || !res?.emotion) return;
      if (res.emotion !== rule.emotion) this.showFace(ctx, res.emotion, 0.6, 'title AI');
    } catch {
      /* optional */
    }
  }

  private isCurrent(ctx: ShortCtx): boolean {
    return this.ctx === ctx && this.watcher?.currentId === ctx.videoId && this.state.settings.enabled && !this.demo;
  }

  private showFace(ctx: ShortCtx, emotion: Emotion, intensity: number, via: string, momentT?: number) {
    const v = this.watcher?.video;
    const at = v ? Math.round(v.currentTime * 10) / 10 : 0;
    this.cues.fireNow(ctx.videoId, emotion, intensity, at, Date.now());
    if (momentT !== undefined) this.cues.add(ctx.videoId, { t: momentT, emotion, intensity }); // replay on the loop
    if (ctx.firstFaceAt === null) ctx.firstFaceAt = Date.now() - ctx.startedAt;
    console.log(LOG, 'face', emotion, `via ${via}`, `(${ctx.firstFaceAt} ms after swipe for the first face)`);
    this.emit({ type: 'emotion', videoId: ctx.videoId, emotion, t: momentT ?? at, at, via, sinceSwipeMs: Date.now() - ctx.startedAt });
    this.tick();
  }

  private onLeaveShorts(prev: LeftInfo | null) {
    if (prev) this.handleLeft(prev);
    this.ctx = null;
    this.engine.cancelAll(this.snapshot(), Date.now(), 'left Shorts');
    this.hideBubble();
  }

  private handleLeft(prev: LeftInfo) {
    const ctx = this.ctx;
    this.emit({
      type: 'short_left',
      videoId: prev.videoId,
      secondsWatched: Math.round(prev.secondsWatched * 10) / 10,
      skipped: prev.skipped,
      looped: prev.looped,
    });
    if (!this.state.settings.enabled || !ctx || ctx.videoId !== prev.videoId) return;
    // Nothing analysed: remember it as skipped. Otherwise the background commits the belief on the next SHORT_STARTED.
    if (ctx.frameCount === 0)
      sendBg({ type: 'SHORT_SKIPPED', videoId: prev.videoId, title: ctx.title || readPageText().title, secondsWatched: prev.secondsWatched }).catch(
        () => undefined,
      );
  }

  private onPlayback(ev: string, video: HTMLVideoElement) {
    this.lastActivity = Date.now();
    const ctx = this.ctx;
    if (!this.state.settings.enabled || this.demo || !ctx || ctx.videoId !== this.watcher?.currentId) {
      if (ev !== 'time') this.tick();
      return;
    }
    const now = Date.now();
    if (now - ctx.lastCaptionRead > 1500) {
      ctx.lastCaptionRead = now;
      for (const c of readPageText().captions) {
        if (ctx.captions.has(c) || ctx.captions.size >= 30) continue;
        ctx.captions.add(c);
        ctx.pendingCaptions.push(c);
      }
      // Captions run on their own while no frame step is in flight (a frame step carries them instead).
      if (!ctx.observing) this.maybeSendCaptions(ctx, video);
    }
    // Next frame when playback reaches the planned time (first frame as soon as the video is really playing).
    if (!ctx.done && !ctx.capturing && !ctx.observing && ctx.frameCount < MAX_FRAMES && !video.paused && video.currentTime >= ctx.nextAt) {
      void this.frameStep(ctx, video);
    }
    if (ev !== 'time') this.tick();
  }

  /**
   * Caption step: react to what was just said. Runs alongside frame analysis (independent request,
   * fast text model). Batched to at most one request every CAPTION_EVERY_MS per Short.
   */
  private async maybeSendCaptions(ctx: ShortCtx, video: HTMLVideoElement) {
    const now = Date.now();
    if (!ctx.pendingCaptions.length || ctx.captionInflight || now - ctx.lastCaptionSent < CAPTION_EVERY_MS) return;
    const lines = ctx.pendingCaptions.splice(0);
    ctx.captionInflight = true;
    ctx.lastCaptionSent = now;
    const at = Math.round(video.currentTime * 10) / 10;
    this.emit({ type: 'status', videoId: ctx.videoId, note: `captions sent: ${lines.join(' | ').slice(0, 200)}`, t: at });
    try {
      const res = await sendBg<CaptionReactResponse>({
        type: 'CAPTION_REACT',
        videoId: ctx.videoId,
        lines,
        title: ctx.title,
        channel: readPageText().channel,
        currentTime: at,
        personality: this.state.settings.personality,
        frequency: this.state.settings.frequency,
      });
      if (!this.isCurrent(ctx)) return; // scrolled away
      if (res?.emotion) this.showFace(ctx, res.emotion, 0.8, 'captions', at);
      this.propose(res?.reactions ?? []);
    } catch {
      /* backend down: captions are optional */
    } finally {
      ctx.captionInflight = false;
    }
  }

  /** One step of the live loop: grab a frame, ask /observe, react, and plan the next frame. */
  private async frameStep(ctx: ShortCtx, video: HTMLVideoElement) {
    ctx.capturing = true;
    const t = Math.round(video.currentTime * 10) / 10;
    const duration = isFinite(video.duration) ? video.duration : 0;
    const { frame, source } = await this.grabFrame(video);
    ctx.capturing = false;
    if (!this.isCurrent(ctx)) return;
    ctx.frameCount++;
    const index = ctx.frameCount;
    if (this.state.frameSource !== source) this.set({ frameSource: source });
    console.log(LOG, `frame ${index}/${MAX_FRAMES} via ${source} at ${t.toFixed(1)}s`);
    this.emit({ type: 'frame', videoId: ctx.videoId, n: index, of: MAX_FRAMES, via: frame ? source : 'failed', t });

    const captions = ctx.pendingCaptions.splice(0); // the frame step carries any new captions
    ctx.observing = true;
    this.busy++;
    this.tick();
    try {
      const res = await sendBg<ObserveResponse>({
        type: 'OBSERVE',
        videoId: ctx.videoId,
        frame: frame ?? '',
        frameTime: t,
        duration,
        frameIndex: index,
        maxFrames: MAX_FRAMES,
        title: ctx.title,
        channel: readPageText().channel,
        captions,
        personality: this.state.settings.personality,
        frequency: this.state.settings.frequency,
      });
      if (!this.isCurrent(ctx)) return;
      if (res?.error) this.set({ note: `Backend unreachable or failed (${res.error.slice(0, 60)}). Staying quiet.` });
      if (res?.emotion && res.level >= 1) this.showFace(ctx, res.emotion, res.level >= 3 ? 1 : 0.8, `frame ${index}`, t);
      this.propose(res?.reactions ?? [], [t]);
      // Plan the next frame: trust the model's guess only within sane bounds.
      const now = video.currentTime;
      let next = res?.nextCaptureAt ?? null;
      if (next !== null) next = Math.max(next, t + MIN_FRAME_GAP_S, now + 0.3);
      if (res?.final || next === null || index >= MAX_FRAMES || (duration > 0 && next > duration - 0.5)) ctx.done = true;
      else ctx.nextAt = next;
      this.emit({
        type: 'status',
        videoId: ctx.videoId,
        note: ctx.done ? `done after ${index} frame(s)` : `next frame at ${next?.toFixed(1)}s (asked ${res?.nextCaptureAt ?? 'null'})`,
      });
    } catch (e) {
      console.warn(LOG, 'observe failed', e);
      if (index >= MAX_FRAMES) ctx.done = true;
      else ctx.nextAt = t + 3; // try again a bit later
    } finally {
      ctx.observing = false;
      this.busy = Math.max(0, this.busy - 1);
      this.tick();
    }
  }

  /** Screenshot (character hidden, cropped) -> video canvas -> nothing (text only). */
  private async grabFrame(video: HTMLVideoElement): Promise<{ frame: string | null; source: UiState['frameSource'] }> {
    const r = video.getBoundingClientRect();
    const rect: Rect = { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, window.innerWidth), height: Math.min(r.height, window.innerHeight) };
    this.host.style.visibility = 'hidden';
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    try {
      const resp = await sendBg<CaptureResponse>({ type: 'CAPTURE_FRAME', rect, viewport: { w: window.innerWidth, h: window.innerHeight } });
      if (resp?.ok) return { frame: resp.data, source: 'screen' };
    } catch {
      /* fall through */
    } finally {
      this.host.style.visibility = '';
    }
    try {
      const scale = Math.min(1, 512 / Math.max(video.videoWidth || 1, video.videoHeight || 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(video.videoWidth * scale));
      c.height = Math.max(1, Math.round(video.videoHeight * scale));
      c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
      const frame = c.toDataURL('image/jpeg', 0.72).split(',')[1] ?? null;
      if (frame) return { frame, source: 'canvas' };
    } catch (e) {
      console.warn(LOG, 'canvas fallback failed:', (e as Error).name);
    }
    return { frame: null, source: 'text' };
  }

  // ---------- demo ----------
  private startDemo() {
    if (this.demo) return;
    this.epoch++;
    this.cues.clear();
    this.engine.clear();
    this.speaker.cancel();
    this.hideBubble();
    this.busy = 0;
    this.navTimes = [];
    sendBg({ type: 'CLEAR_MEMORY' }).catch(() => undefined);
    this.demo = new DemoDriver((s, i) => this.onDemoShort(s, i));
    this.demo.start();
    console.log(LOG, 'demo mode started');
  }

  private stopDemo() {
    if (!this.demo) return;
    this.demoTimers.forEach((t) => window.clearTimeout(t));
    this.demoTimers = [];
    this.demo = null;
    this.epoch++;
    this.cues.clear();
    this.busy = 0;
    this.engine.cancelAll(this.snapshot(), Date.now(), 'demo stopped');
    this.set({ demo: null });
  }

  demoNext() {
    this.demo?.next();
  }

  demoTogglePause() {
    this.demo?.togglePause();
    this.tick();
  }

  demoRestart() {
    if (!this.demo) return;
    this.stopDemo();
    this.startDemo();
  }

  private onDemoShort(s: DemoShort, index: number) {
    this.navTimes.push(Date.now());
    this.loadCues(s.videoId, s.cues); // demo moments are known, so faces sync on the first play
    this.emit({ type: 'short_started', videoId: s.videoId, title: s.title, channel: s.channel });
    this.lastActivity = Date.now();
    if (index === 0) {
      this.engine.clear();
      sendBg({ type: 'CLEAR_MEMORY' }).catch(() => undefined);
    }
    const epoch = this.epoch;
    // Simulate "frames captured, analysis running" a few seconds into the Short.
    this.demoTimers.push(
      window.setTimeout(() => {
        if (epoch !== this.epoch) return;
        this.busy++;
        this.tick();
      }, 2200),
      window.setTimeout(async () => {
        if (epoch !== this.epoch) return;
        await sendBg({ type: 'REMEMBER', record: s.record }).catch(() => undefined);
        let proposals: ReactionProposal[] = [];
        const { personality, frequency, demoLive } = this.state.settings;
        if (demoLive) {
          try {
            const r = await sendBg<ReactResponse>({ type: 'REACT_ONLY', currentVideoId: s.videoId, personality, frequency });
            proposals = r?.reactions ?? [];
            if (r?.error) this.set({ note: 'Live LLM unavailable: using canned demo reactions.' });
          } catch {
            /* fall back */
          }
        }
        if (!demoLive || proposals.length === 0) proposals = s.canned[personality].map((p) => ({ ...p, targetVideoId: s.videoId }));
        if (epoch !== this.epoch) return;
        this.busy = Math.max(0, this.busy - 1);
        const avoid = s.record.events.map((e) => e.timestamp).filter((t): t is number => typeof t === 'number');
        this.propose(proposals, avoid);
      }, 3600),
    );
  }
}

export { DEMO_SHORTS };
