/**
 * The content-side brain. Wires together:
 *   ShortsWatcher / DemoDriver  ->  frame capture + analysis (via background)
 *   reaction proposals          ->  TimingEngine (decides)  ->  bubble / voice
 * The UI subscribes to `state` and stays dumb.
 */
import {
  sendBg,
  type AnalyseReactResponse,
  type CaptionReactResponse,
  type CaptureResponse,
  type ReactResponse,
  type TelemetryEvent,
} from '../shared/messages';
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
  frames: string[];
  frameTimes: number[];
  attempts: number;
  capturing: boolean;
  analysed: boolean;
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
      if (d) this.deliver(d);
      this.flushDecisions();
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
      if (d) this.deliver(d);
    }
    this.tick();
  }

  // ---------- YouTube pipeline ----------
  private newCtx(videoId: string): ShortCtx {
    return { videoId, startedAt: Date.now(), frames: [], frameTimes: [], attempts: 0, capturing: false, analysed: false, captions: new Set(), lastCaptionRead: 0, pendingCaptions: [], lastCaptionSent: 0, captionInflight: false };
  }

  private onShortChange(info: ShortInfo, prev: LeftInfo | null) {
    this.lastActivity = Date.now();
    if (this.demo) return;
    this.navTimes.push(info.startedAt);
    if (prev) this.handleLeft(prev);
    this.ctx = this.newCtx(info.videoId);
    if (!this.state.settings.enabled) return;
    sendBg({ type: 'SHORT_STARTED', videoId: info.videoId }).catch(() => undefined);
    // Title is read a moment later so YouTube has updated the active reel's DOM.
    window.setTimeout(() => {
      const { title, channel } = readPageText();
      this.emit({ type: 'short_started', videoId: info.videoId, title, channel });
    }, 800);
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
    if (!this.state.settings.enabled || !ctx || ctx.videoId !== prev.videoId || ctx.analysed) return;
    // Enough seen to remember it properly? Analyse with the frames we have (results may only serve callbacks).
    if (prev.secondsWatched >= 4 && ctx.frames.length > 0) this.analyse(ctx, prev.secondsWatched);
    else
      sendBg({ type: 'SHORT_SKIPPED', videoId: prev.videoId, title: readPageText().title, secondsWatched: prev.secondsWatched }).catch(
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
      this.maybeSendCaptions(ctx, video);
    }
    const d = isFinite(video.duration) ? video.duration : 0;
    if (d > 0 && !ctx.analysed && !ctx.capturing && ctx.attempts < 3) {
      const targets = [Math.min(1.5, d * 0.1), d * 0.5, d * 0.85];
      if (video.currentTime >= targets[ctx.attempts]) void this.captureFrame(ctx, video);
    }
    if (ev === 'loop' && !ctx.analysed && ctx.attempts > 0 && !ctx.capturing) this.analyse(ctx, this.watcher?.secondsWatched ?? 0);
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
    const epoch = this.epoch;
    const { title, channel } = readPageText();
    const at = Math.round(video.currentTime * 10) / 10;
    this.emit({ type: 'status', videoId: ctx.videoId, note: `captions sent: ${lines.join(' | ').slice(0, 200)}`, t: at });
    try {
      const res = await sendBg<CaptionReactResponse>({
        type: 'CAPTION_REACT',
        videoId: ctx.videoId,
        lines,
        title,
        channel,
        currentTime: at,
        personality: this.state.settings.personality,
        frequency: this.state.settings.frequency,
      });
      if (epoch !== this.epoch || this.ctx !== ctx || this.watcher?.currentId !== ctx.videoId) return; // scrolled away
      if (res?.emotion) {
        const cue = this.cues.fireNow(ctx.videoId, res.emotion, 0.8, video.currentTime, Date.now());
        console.log(LOG, 'emotion (captions)', cue.emotion);
        this.emit({ type: 'emotion', videoId: ctx.videoId, emotion: cue.emotion, t: at, at: Math.round(video.currentTime * 10) / 10, via: 'captions' });
      }
      this.propose(res?.reactions ?? []);
    } catch {
      /* backend down: captions are optional */
    } finally {
      ctx.captionInflight = false;
    }
  }

  private async captureFrame(ctx: ShortCtx, video: HTMLVideoElement) {
    ctx.capturing = true;
    const epoch = this.epoch;
    const t = video.currentTime;
    let frame: string | null = null;
    let source: UiState['frameSource'] = 'text';

    // 1) Primary: screenshot the tab, with ScrollMate hidden and cropped to the video.
    const r = video.getBoundingClientRect();
    const rect: Rect = { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, window.innerWidth), height: Math.min(r.height, window.innerHeight) };
    this.host.style.visibility = 'hidden';
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    try {
      const resp = await sendBg<CaptureResponse>({ type: 'CAPTURE_FRAME', rect, viewport: { w: window.innerWidth, h: window.innerHeight } });
      if (resp?.ok) {
        frame = resp.data;
        source = 'screen';
      }
    } catch {
      /* fall through */
    } finally {
      this.host.style.visibility = '';
    }

    // 2) Fallback: draw the <video> to a canvas (may throw SecurityError if tainted).
    if (!frame) {
      try {
        const scale = Math.min(1, 512 / Math.max(video.videoWidth || 1, video.videoHeight || 1));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(video.videoWidth * scale));
        c.height = Math.max(1, Math.round(video.videoHeight * scale));
        c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
        frame = c.toDataURL('image/jpeg', 0.72).split(',')[1] ?? null;
        if (frame) source = 'canvas';
      } catch (e) {
        console.warn(LOG, 'canvas fallback failed:', (e as Error).name);
      }
    }
    // 3) Last resort: text only (title, channel, visible captions).

    if (epoch !== this.epoch || this.ctx !== ctx) return;
    ctx.attempts++;
    ctx.capturing = false;
    if (frame) {
      ctx.frames.push(frame);
      ctx.frameTimes.push(Math.round(t * 10) / 10);
    }
    if (this.state.frameSource !== source) this.set({ frameSource: source });
    console.log(LOG, `frame ${ctx.attempts}/3 via ${source} at ${t.toFixed(1)}s`);
    this.emit({ type: 'frame', videoId: ctx.videoId, n: ctx.attempts, of: 3, via: frame ? source : 'failed', t: Math.round(t * 10) / 10 });
    if (ctx.attempts >= 3) this.analyse(ctx, this.watcher?.secondsWatched ?? 0);
  }

  private async analyse(ctx: ShortCtx, secondsWatched: number) {
    if (ctx.analysed) return;
    ctx.analysed = true;
    const epoch = this.epoch;
    const { title, channel, captions } = readPageText();
    captions.forEach((c) => ctx.captions.add(c));
    this.busy++;
    this.tick();
    try {
      const res = await sendBg<AnalyseReactResponse>({
        type: 'ANALYSE_AND_REACT',
        videoId: ctx.videoId,
        frames: ctx.frames,
        frameTimes: ctx.frameTimes,
        title,
        channel,
        captions: [...ctx.captions],
        secondsWatched,
        personality: this.state.settings.personality,
        frequency: this.state.settings.frequency,
      });
      ctx.frames = []; // never keep frames around
      if (epoch !== this.epoch) return;
      if (res?.error) this.set({ note: `Backend unreachable or failed (${res.error.slice(0, 60)}). Staying quiet.` });
      if (res?.analysis) console.log(LOG, 'analysis', res.analysis);
      if (res?.analysis?.cues?.length && this.watcher?.currentId === ctx.videoId) this.loadCues(ctx.videoId, res.analysis.cues);
      const avoid = (res?.analysis?.events ?? []).map((e) => e.timestamp).filter((t): t is number => typeof t === 'number');
      this.propose(res?.reactions ?? [], avoid);
    } catch (e) {
      console.warn(LOG, 'analyse failed', e);
    } finally {
      if (epoch === this.epoch) this.busy = Math.max(0, this.busy - 1);
      this.tick();
    }
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
