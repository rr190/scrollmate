/**
 * The content-side brain. Wires together:
 *   ShortsWatcher / DemoDriver  ->  frame capture + analysis (via background)
 *   reaction proposals          ->  TimingEngine (decides)  ->  bubble / voice
 * The UI subscribes to `state` and stays dumb.
 */
import {
  sendBg,
  type CaptionReactResponse,
  type CameraState,
  type CommentReactResponse,
  type TabMessage,
  type PreviousComment,
  type CaptureResponse,
  type ObserveResponse,
  type ReactResponse,
  type FeelingLineResponse,
  type SwipeResponse,
  type TelemetryEvent,
  type TalkContext,
} from '../shared/messages';
import { predictMoment } from '../shared/moments';
import { FeelingNoticer, MIRROR_POP } from '../shared/feelings';
import type { UserSignal } from '../shared/faceSignals';
import { CueTrack, type Emotion, type EmotionCue } from '../shared/emotions';
import { TimingEngine, type Candidate, type Delivery, type PlaybackSnapshot } from '../shared/timing';
import { DEFAULT_SETTINGS, type MemoryRecord, type ReactionProposal, type Rect, type Settings } from '../shared/types';
import { applySettings } from '../shared/settings';
import { DEMO_SHORTS, DemoDriver, type DemoShort, type DemoView } from './demo';
import { readPageText, ShortsWatcher, type LeftInfo, type ShortInfo } from './shorts';
import { Speaker } from './speech';
import { CommentsWatcher, COMMENT_TRAVEL_MS, commentPosition, type CommentTarget, type CommentSelection } from './comments';

const LOG = '[ScrollMate]';
export type Mood = 'idle' | 'watching' | 'thinking' | 'amused' | 'speaking' | 'sleeping' | Emotion;
export type Env = 'youtube' | 'stage';

export interface Position {
  fx: number; // fraction of viewport width
  fy: number;
}

export interface UiState {
  talk: { active: boolean; phase: 'ready' | 'starting' | 'listening' | 'thinking' | 'speaking' | 'error';
    transcript: string; reply: string; error: string | null; emotion: Mood };
  mood: Mood;
  bubble: { id: string; text: string; commentRequestId?: string } | null;
  settings: Settings;
  position: Position | null;
  demo: DemoView | null;
  onShorts: boolean;
  frameSource: 'screen' | 'canvas' | 'text' | null;
  note: string | null;
  commentHint: string | null;
  commentVisit: (CommentTarget & { requestId: string; phase: 'running' | 'reading' | 'reacting'; emotion: Emotion | null }) | null;
  camera: CameraState; // webcam status (opt-in)
  user: UserSignal | null; // latest on-device face signal
  /** A short "I see you!" pop under the buddy when it mirrors the child's face (e.g. "😂 you're laughing!"). */
  mirrorPop: { id: number; text: string } | null;
}

interface ShortCtx {
  videoId: string;
  startedAt: number;
  frameCount: number; // frames analysed so far
  maxFrames: number; // limit for this Short (set by the backend /ui setting after frame 1)
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
/** Which of the viewer's expressions Mochi mirrors. */
const USER_TO_EMOTION: Partial<Record<UserSignal['expression'], Emotion>> = {
  laughing: 'laughing',
  happy: 'happy',
  surprised: 'surprised',
  sad: 'sad',
  disgusted: 'cringe', // 😬 "ew, same"
  scared: 'worried', // 😟 nervous with you
  angry: 'worried', // 😟 "uh oh": a companion backs off rather than mirroring anger
  confused: 'curious', // 🤔 puzzled with you
};
const CAPTION_EVERY_MS = 4_000;
const COMMENT_HISTORY_MAX = 5; // earlier comments sent as context
const MAX_FRAMES_REQUEST = 12; // upper bound we ask for; the backend's setting decides
const DEFAULT_MAX_FRAMES = 4; // until the backend has told us
const FIRST_FRAME_AT_S = 0.4; // as soon as the video is really playing
const MIN_FRAME_GAP_S = 1.5; // leave room for the call + Chrome's capture limit

let idSeq = 0;
const newId = () => `r${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export class Controller {
  state: UiState = {
    talk: { active: false, phase: 'ready', transcript: '', reply: '', error: null, emotion: 'curious' },
    mood: 'sleeping',
    bubble: null,
    settings: { ...DEFAULT_SETTINGS },
    position: null,
    demo: null,
    onShorts: false,
    frameSource: null,
    note: null,
    commentHint: null,
    commentVisit: null,
    camera: 'off',
    user: null,
    mirrorPop: null,
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
  private comments: CommentsWatcher | null = null;
  private commentAttempt: { requestId: string; videoId: string; readyAt: number; expiresAt: number; response?: CommentReactResponse; handled: boolean } | null = null;
  private seenComments = new Set<string>(); // bounded to the current Short; no persistent comment text
  /** Last few comments reacted to on this Short + what ScrollMate said, sent as context. RAM only, per Short. */
  private commentHistory: PreviousComment[] = [];
  private commentsPaused = false; // settings/dragging take precedence over automatic movement
  private talkTurnId: string | null = null;
  private talkTimer: number | undefined;
  private discussedComment: { videoId: string; text: string } | null = null;
  private talkContextKey = '';
  private nextTalkContextAt = 0;

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
      const saved = { ...DEFAULT_SETTINGS, ...(r[SETTINGS_KEY] ?? {}) } as Settings;
      const settings = applySettings(saved, { enabled: this.env === 'stage' || saved.enabled });
      if (this.env === 'stage') Object.assign(settings, { demo: true, enabled: true });
      this.set({ settings, position: (r[posKey(this.env)] as Position) ?? null });
      if (JSON.stringify(r[SETTINGS_KEY]) !== JSON.stringify(settings))
        chrome.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => undefined);
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
      this.comments = new CommentsWatcher({
        enabled: () => this.commentsEnabled(),
        onSelect: (target) => this.visitComment(target),
        onFocus: (target) => {
          const videoId = this.watcher?.currentId;
          if (!videoId) return;
          this.discussedComment = { videoId, text: target.text };
          this.syncTalkContext();
        },
        onCancel: () => this.cancelCommentVisit(),
        onHint: (message) => this.setCommentHint(message),
      });
      this.comments.start();
      chrome.runtime.onMessage.addListener((m: { type?: string }) => {
        if (m?.type === 'ACTIVE_TAB_GRANTED') {
          this.set({ note: 'Screen frames allowed for this tab.' });
        }
      });
    }
    chrome.runtime.onMessage.addListener((m: TabMessage) => {
      if (this.destroyed) return false;
      if (m?.type === 'USER_SIGNAL') this.onUserSignal(m.signal);
      else if (m?.type === 'CAMERA_STATUS') this.onCameraStatus(m.state, m.detail);
      else if (m?.type === 'TALK_EVENT') this.onTalkEvent(m);
      return false;
    });
    if (this.state.settings.enabled && this.state.settings.userCam) this.startCamera();
    if (this.state.settings.demo && this.state.settings.enabled) this.startDemo();
    this.tickTimer = window.setInterval(() => this.tick(), 150); // fast enough to land faces on the moment
    this.tick();
  }

  private destroyed = false;

  destroy() {
    this.destroyed = true;
    this.endTalk();
    this.epoch++; // late async results are ignored
    sendBg({ type: 'CANCEL_ALL' }).catch(() => undefined);
    this.stopDemo();
    window.clearInterval(this.tickTimer);
    this.watcher?.stop();
    this.comments?.stop();
    this.cancelCommentVisit();
    this.speaker.cancel();
    if (this.state.camera !== 'off') this.stopCamera();
  }

  // ---------- settings ----------
  openTalk() {
    if (this.destroyed || !this.state.settings.enabled || this.env !== 'youtube' || this.state.settings.demo || this.state.talk.active) return;
    const requestId = this.talkTurnId = newId();
    this.set({ talk: { ...this.state.talk, active: true, phase: 'starting', transcript: '', reply: '', error: null, emotion: 'curious' } });
    this.speaker.cancel();
    this.armTalkTimeout(30_000);
    const context = this.talkContext(requestId);
    this.talkContextKey = JSON.stringify(context);
    this.nextTalkContextAt = Date.now() + 600;
    void sendBg<{ ok: boolean; error?: string }>({ type: 'TALK_START', context }).then((result) => {
      if (this.talkTurnId !== requestId) { void sendBg({ type: 'TALK_CANCEL', requestId }).catch(() => undefined); return; }
      if (!result?.ok) this.stopTalk(result?.error ?? 'Microphone unavailable. Tap to retry.');
    }).catch(() => { if (this.talkTurnId === requestId) this.stopTalk('Connection lost. Reload the extension and this tab.'); });
    this.tick();
  }

  toggleTalk() { if (this.state.talk.active) this.endTalk(); else this.openTalk(); }
  endTalk() { this.stopTalk(); }

  private stopTalk(error?: string) {
    const requestId = this.talkTurnId;
    this.talkTurnId = null;
    this.talkContextKey = '';
    window.clearTimeout(this.talkTimer);
    if (requestId) void sendBg({ type: 'TALK_CANCEL', requestId }).catch(() => undefined);
    this.set({ talk: { active: false, phase: error ? 'error' : 'ready', transcript: '', reply: '', error: error ?? null, emotion: 'curious' } });
    if (error) {
      window.clearTimeout(this.bubbleTimer);
      this.set({ bubble: { id: newId(), text: error } });
      this.bubbleTimer = window.setTimeout(() => this.hideBubble(), 8000);
    }
    this.tick();
  }

  private talkContext(requestId: string): TalkContext {
    const videoId = this.watcher?.currentId ?? '';
    const discussion = this.comments?.discussionContext() ?? { commentsOpen: false, visibleComments: [] };
    return { requestId, videoId, title: this.ctx?.title || readPageText().title,
      selectedComment: this.discussedComment?.videoId === videoId ? this.discussedComment.text : this.state.commentVisit?.text ?? '',
      ...discussion, personality: this.state.settings.personality };
  }

  private syncTalkContext() {
    this.nextTalkContextAt = Date.now() + 600;
    if (!this.talkTurnId) return;
    const context = this.talkContext(this.talkTurnId);
    const key = JSON.stringify(context);
    if (key === this.talkContextKey) return;
    this.talkContextKey = key;
    void sendBg({ type: 'TALK_CONTEXT', context }).catch(() => {
      if (this.talkContextKey === key) this.talkContextKey = '';
    });
  }

  private talkBusy() { return this.state.talk.active; }

  private armTalkTimeout(ms: number) {
    window.clearTimeout(this.talkTimer);
    this.talkTimer = window.setTimeout(() => this.stopTalk('Voice connection stopped. Tap the microphone to reconnect.'), ms);
  }

  private onTalkEvent(message: Extract<TabMessage, { type: 'TALK_EVENT' }>) {
    if (!this.state.talk.active || message.requestId !== this.talkTurnId || !this.state.settings.enabled) return;
    const event = message.event;
    if (event.type === 'status') {
      if (event.state === 'error' || event.state === 'needs_permission') { this.stopTalk(event.error ?? 'Live voice unavailable. Tap the microphone to retry.'); return; }
      this.set({ talk: { ...this.state.talk, phase: event.state } });
    } else if (event.type === 'caption') {
      this.set({ talk: { ...this.state.talk, [event.role === 'user' ? 'transcript' : 'reply']: event.text } });
    } else if (event.type === 'interrupted') {
      this.set({ talk: { ...this.state.talk, phase: 'listening', reply: '', transcript: '' } });
    }
    this.armTalkTimeout(45_000); this.tick();
  }

  async updateSettings(patch: Partial<Settings>) {
    const prev = this.state.settings;
    const next = applySettings(prev, patch);
    if (this.env === 'stage') next.demo = true;
    this.set({ settings: next });
    if (!next.commentReactions || next.personality !== prev.personality || next.frequency !== prev.frequency) this.cancelCommentVisit();
    this.applyEngineOpts();
    chrome.storage.local.set({ [SETTINGS_KEY]: next }).catch(() => undefined);

    if (prev.enabled && !next.enabled) this.disable();
    const camWas = prev.enabled && prev.userCam;
    const camIs = next.enabled && next.userCam;
    if (!camWas && camIs) this.startCamera();
    if (camWas && !camIs && this.state.camera !== 'off') this.stopCamera();
    if (!prev.voice && next.voice === false) this.speaker.cancel();
    if (prev.voice && !next.voice) this.speaker.cancel();
    const demoWasOn = prev.demo && prev.enabled;
    const demoIsOn = next.demo && next.enabled;
    if (!demoWasOn && demoIsOn) this.startDemo();
    if (demoWasOn && !demoIsOn) this.stopDemo();
    if (!prev.enabled && next.enabled && !next.demo) {
      this.set({ note: 'ScrollMate is watching. Reactions appear only at natural pauses.' });
      // Start fresh on the Short already on screen.
      if (this.watcher?.currentId) this.onShortChange({ videoId: this.watcher.currentId, startedAt: Date.now() }, null);
    }
    this.tick();
  }

  savePosition(p: Position) {
    this.set({ position: p });
    chrome.storage.local.set({ [posKey(this.env)]: p }).catch(() => undefined);
  }

  pauseCommentVisits(paused: boolean) {
    this.commentsPaused = paused;
    if (paused) { this.cancelCommentVisit(); this.comments?.reset(); }
  }

  // ---------- comments open: the buddy reads them by itself if the child doesn't point at one ----------
  private commentsOpen = false; // the child opened the comment panel (seen going from closed to open)
  private commentsSeenClosed = false;
  private commentsOpenSince = 0;
  private lastCommentBusyAt = 0;
  private lastOpenCheckAt = 0;
  private autoReads = new Map<string, number>(); // per Short
  private static readonly AUTO_READ_AFTER_MS = 2_500;
  private static readonly AUTO_READS_PER_SHORT = 3;

  private tickCommentsOpen(videoId: string | null, now: number) {
    if (this.env !== 'youtube' || !this.comments) return;
    if (now - this.lastOpenCheckAt >= 500) { // the DOM check is cheap but not free
      this.lastOpenCheckAt = now;
      const visible = this.comments.discussionContext().commentsOpen; // the page's panel, not our on/off state
      if (!visible) {
        this.commentsSeenClosed = true;
        this.commentsOpen = false;
      } else if (!this.commentsOpen && this.commentsSeenClosed) {
        // a deliberate open (closed -> open), not a page that happened to load with comments showing
        this.commentsOpen = true;
        this.commentsOpenSince = now;
      }
    }
    if (this.state.commentVisit || this.commentAttempt || this.state.commentHint) this.lastCommentBusyAt = now;
    if (!this.commentsOpen || !this.commentsEnabled() || !videoId || this.state.bubble || this.speaking) return;
    const done = this.autoReads.get(videoId) ?? 0;
    if (done >= Controller.AUTO_READS_PER_SHORT) return;
    const idleSince = Math.max(this.commentsOpenSince, this.lastCommentBusyAt);
    if (now - idleSince < Controller.AUTO_READ_AFTER_MS) return;
    if (this.comments.autoSelect((text) => this.seenComments.has(text))) {
      this.autoReads.set(videoId, done + 1);
      this.lastCommentBusyAt = now;
      console.log(LOG, 'comments open: reading one by myself');
    } else {
      this.lastCommentBusyAt = now; // nothing new to read right now: try again in a bit
    }
  }

  private commentsEnabled() {
    return this.env === 'youtube' && this.state.settings.enabled && this.state.settings.commentReactions &&
      !this.state.settings.demo && !this.commentsPaused && !!this.watcher?.currentId;
  }

  private setCommentHint(message: string | null) {
    if (this.state.commentHint === message) return;
    this.set({ commentHint: message });
    if (message) console.debug(LOG, 'comments:', message);
  }

  checkCommentDetection() {
    const info = this.comments?.diagnostics();
    console.info(LOG, 'comment detection', info);
    const message = !info?.visible
      ? 'No visible top-level comments detected. Open the Shorts comments panel first.'
      : `${info.visible} visible comment${info.visible === 1 ? '' : 's'} detected. ${info.room ? 'Close these settings, then hover over the comment text.' : 'There is no room beside the comment panel; try a wider window.'}`;
    this.set({ note: message });
  }

  private visitComment(target: CommentTarget): CommentSelection {
    const videoId = this.watcher?.currentId;
    const now = Date.now();
    if (!this.commentsEnabled() || !videoId) return { accepted: false, hint: "Close my menu and I'll read comments!" };
    if (this.state.bubble || this.speaking) return { accepted: false, retryAfterMs: 500, hint: "One sec, I'm still talking!" };
    if (!commentPosition(target, window.innerWidth, window.innerHeight)) return { accepted: false, hint: 'I need a bit more room to sit by the comments!' };
    if (this.seenComments.has(target.text)) return { accepted: false, hint: 'We read that one! Pick another?' };
    if (this.seenComments.size >= 100) return { accepted: false, hint: "That's lots of comments! Let's watch the next one." };
    // No wait between comment visits (no cooldown, no reading gap). A bubble still on screen is handled above.
    this.cancelCommentVisit();
    const requestId = newId();
    const travel = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : COMMENT_TRAVEL_MS;
    this.commentAttempt = { requestId, videoId, readyAt: now + travel, expiresAt: now + 12_000, handled: false };
    this.seenComments.add(target.text);
    this.set({ commentVisit: { ...target, requestId, phase: 'running', emotion: null } });
    this.syncTalkContext();
    this.emit({ type: 'status', videoId, note: 'reading a selected comment' });
    void this.requestComment(target, requestId, videoId);
    this.tick();
    return { accepted: true };
  }

  private async requestComment(target: CommentTarget, requestId: string, videoId: string) {
    try {
      const res = await sendBg<CommentReactResponse>({
        type: 'COMMENT_REACT', requestId, videoId, commentId: target.id, text: target.text,
        title: this.ctx?.title || readPageText().title,
        previousComments: this.commentHistory.slice(-COMMENT_HISTORY_MAX),
        personality: this.state.settings.personality, frequency: this.state.settings.frequency,
      });
      if (this.commentAttempt?.requestId !== requestId || res?.requestId !== requestId || res.targetCommentId !== target.id) return;
      this.commentAttempt.response = res;
      this.tick();
    } catch {
      if (this.commentAttempt?.requestId === requestId) this.cancelCommentVisit();
    }
  }

  private cancelCommentVisit() {
    const attempt = this.commentAttempt;
    if (!attempt) return;
    this.commentAttempt = null; // invalidate before an abort reply can arrive
    const hadCommentBubble = this.state.bubble?.commentRequestId === attempt.requestId;
    this.set({ commentVisit: null });
    sendBg({ type: 'CANCEL_COMMENT', requestId: attempt.requestId }).catch(() => undefined);
    if (hadCommentBubble) this.hideBubble();
    this.engine.cancelComment(attempt.requestId, this.snapshot(), Date.now());
    this.flushDecisions();
  }

  private tickComment(now: number) {
    const attempt = this.commentAttempt;
    const visit = this.state.commentVisit;
    if (!attempt || !visit) return;
    if (!this.commentsEnabled() || this.watcher?.currentId !== attempt.videoId ||
        !this.comments?.selectionValid(visit.id) || now >= attempt.expiresAt) {
      this.cancelCommentVisit();
      return;
    }
    if (now < attempt.readyAt) return;
    if (visit.phase === 'running') this.set({ commentVisit: { ...visit, phase: 'reading' } });
    const res = attempt.response;
    if (!res || attempt.handled) return;
    attempt.handled = true;
    if (res.error) {
      this.seenComments.delete(visit.text);
      this.cancelCommentVisit();
      this.set({ note: `Comment reaction failed (${res.error.slice(0, 80)}). Check the backend.` });
      return;
    }
    this.set({ commentVisit: { ...this.state.commentVisit!, emotion: res.emotion, phase: 'reacting' } });
    // Remember this exchange so the next comment on this Short can build on it.
    this.commentHistory = [
      ...this.commentHistory,
      { text: visit.text.slice(0, 300), reaction: res.reactions?.[0]?.text ?? null, emotion: res.emotion ?? null },
    ].slice(-COMMENT_HISTORY_MAX);
    // The extension binds targets and timing itself; the model cannot redirect a reaction.
    this.propose((res.reactions ?? []).slice(0, 1).map((r) => ({
      ...r, targetVideoId: attempt.videoId, targetCommentId: visit.id, commentRequestId: attempt.requestId,
      preferredTiming: 'now', requiresQuietMoment: false, isCallback: false, expiresAfterSeconds: 8,
    })));
    if (!res.reactions?.length) attempt.expiresAt = Math.min(attempt.expiresAt, now + 2500);
  }

  private applyEngineOpts() {
    this.engine.opts = { frequency: this.state.settings.frequency, voiceEnabled: this.state.settings.voice };
  }

  /** Stop all processing immediately. */
  // ---------- webcam (opt-in, on-device MediaPipe; only labels arrive here) ----------
  private startCamera() {
    this.set({ camera: 'starting' });
    sendBg({ type: 'CAMERA_START' }).catch(() => this.set({ camera: 'error' }));
  }

  private stopCamera() {
    sendBg({ type: 'CAMERA_STOP' }).catch(() => undefined);
    this.set({ camera: 'off', user: null });
  }

  private userFlags(): { userAway: boolean; userLaughing: boolean } {
    const u = this.state.settings.userCam && this.state.camera === 'on' ? this.state.user : null;
    return {
      userAway: !this.demoMode && !!u && (u.lookingAway || !u.present),
      userLaughing: !!u && u.expression === 'laughing',
    };
  }

  // ---------- Mochi kindly notices the child's feeling ("You're smiling! Did that make you happy?") ----------
  private feelings = new FeelingNoticer();
  private feelingShort: { id: string | null; at: number } = { id: null, at: 0 };

  private tickFeelings(videoId: string | null, now: number) {
    if (videoId !== this.feelingShort.id) this.feelingShort = { id: videoId, at: now };
    const st = this.state.settings, u = this.state.user;
    if (!u) return;
    const expression = this.feelings.update({
      now,
      enabled: st.enabled && st.userCam && this.state.camera === 'on',
      videoId,
      shortStartedAt: this.feelingShort.at,
      present: u.present,
      lookingAway: u.lookingAway,
      expression: u.expression,
      strength: u.strength,
      busy: !!this.state.bubble || this.speaking || !!this.state.commentVisit,
    });
    if (expression && videoId) void this.noticeFeeling(videoId, expression);
  }

  private async noticeFeeling(videoId: string, expression: string) {
    const epoch = this.epoch;
    const { personality } = this.state.settings;
    const title = this.demo ? this.demo.short.title : this.ctx?.title ?? '';
    console.log(LOG, 'noticing your feeling:', expression);
    this.emit({ type: 'user', videoId, feelingNoticed: expression });
    try {
      const res = await sendBg<FeelingLineResponse>({ type: 'FEELING_LINE', videoId, expression, title, personality });
      const now = Date.now();
      const u = this.state.user;
      const current = this.demo ? this.demo.short.videoId : this.watcher?.currentId;
      // still a good moment? same Short, nothing else on screen, child still here
      const blocked = (this.state.bubble && !this.demoMode) || this.speaking || this.state.commentVisit;
      if (epoch !== this.epoch || !res?.line || current !== videoId || blocked || !u?.present || u.lookingAway) return;
      if (res.emotion) this.cues.fireNow(videoId, res.emotion, 0.8, this.snapshot().currentTime, now);
      this.deliver({
        candidate: {
          id: newId(), text: res.line, importance: 1, targetVideoId: videoId, preferredTiming: 'now', expiresAfterSeconds: 8,
          requiresQuietMoment: false, isCallback: false, createdAt: now, move: res.move,
        },
        mode: this.state.settings.voice ? 'voice' : 'bubble',
        reason: `noticed you looked ${expression}${res.source === 'fallback' ? ' (written line)' : ''}`,
      });
    } catch {
      /* no line this time */
    } finally {
      this.feelings.done();
    }
  }

  private lastFeeling: { expression: UserSignal['expression']; at: number } | null = null;

  /** The child's feeling in the last 5 s (label only), to blend into the reel comment. */
  private viewerFeeling(): UserSignal['expression'] | undefined {
    const st = this.state.settings, u = this.state.user;
    if (!st.userCam || this.state.camera !== 'on' || !this.lastFeeling) return undefined;
    if (u && (!u.present || u.lookingAway)) return undefined;
    return Date.now() - this.lastFeeling.at < 5_000 ? this.lastFeeling.expression : undefined;
  }

  /** A reel line that carried a feeling counts as noticing it (no separate "noticed" line on this Short). */
  private noteBlended(videoId: string, feeling: UserSignal['expression'] | undefined, lines: number) {
    if (feeling && lines > 0 && !this.demoMode) this.feelings.markNoticed(videoId, feeling, Date.now());
  }

  // ---------- demo mode (set in /ui): reliable for presenting ----------
  private demoMode = false;

  private setDemoMode(on: boolean | undefined) {
    if (typeof on !== 'boolean' || on === this.demoMode) return;
    this.demoMode = on;
    this.feelings.demo = on;
    console.log(LOG, on ? 'demo mode on: guaranteed comments, faster feelings, no "looked away" holds' : 'demo mode off');
  }

  // ---------- "I see you!" pop: makes the face reading visible ----------
  private popTimer: number | undefined;
  private lastPopAt = 0;
  private popSeq = 0;

  private showMirrorPop(expression: UserSignal['expression']) {
    const text = MIRROR_POP[expression];
    const now = Date.now();
    if (!text || now - this.lastPopAt < 2_500) return;
    this.lastPopAt = now;
    window.clearTimeout(this.popTimer);
    this.set({ mirrorPop: { id: ++this.popSeq, text } });
    this.popTimer = window.setTimeout(() => this.set({ mirrorPop: null }), 1_800);
  }

  private onUserSignal(sig: UserSignal) {
    const prev = this.state.user;
    this.set({ user: sig });
    // remember the last real feeling; viewerFeeling() keeps it for 5 s after it fades
    if (sig.present && !sig.lookingAway && sig.expression !== 'neutral') this.lastFeeling = { expression: sig.expression, at: Date.now() };
    this.emit({ type: 'user', expression: sig.expression, present: sig.present, lookingAway: sig.lookingAway });
    if (!this.state.settings.enabled || !this.state.settings.userCam) return;
    // Mirror the viewer: laugh along, look surprised with them (a face, never a bubble).
    const mirror = USER_TO_EMOTION[sig.expression];
    const videoId = this.demo ? this.demo.short.videoId : this.watcher?.currentId;
    if (mirror && videoId && sig.expression !== prev?.expression && sig.present && !sig.lookingAway) {
      this.showMirrorPop(sig.expression); // visible proof the face reading works
      if (!this.state.bubble) {
        this.cues.fireNow(videoId, mirror, Math.max(0.6, sig.strength), this.snapshot().currentTime, Date.now());
        console.log(LOG, 'mirroring you:', sig.expression);
      }
    }
    this.tick();
  }

  private onCameraStatus(state: CameraState, detail?: string) {
    // A status still in flight when the camera was switched off must not bring the badge back.
    if (state !== 'off' && !(this.state.settings.enabled && this.state.settings.userCam)) return;
    this.set({ camera: state });
    if (state === 'needs_permission') this.set({ note: 'Allow the camera in the tab that just opened, then come back.' });
    else if (state === 'error') this.set({ note: `Camera unavailable (${(detail ?? '').slice(0, 80)}).` });
    else if (state === 'on' && !detail) this.set({ note: 'Camera on — processed on this computer only.' });
  }

  private disable() {
    this.endTalk();
    this.discussedComment = null;
    this.epoch++;
    this.cancelCommentVisit();
    this.comments?.reset();
    this.cues.clear();
    this.engine.cancelAll(this.snapshot(), Date.now());
    this.speaker.cancel();
    this.hideBubble();
    this.busy = 0;
    this.ctx = null;
    this.stopDemo();
    if (this.state.camera !== 'off') this.stopCamera();
    sendBg({ type: 'CANCEL_ALL' }).catch(() => undefined);
    console.log(LOG, 'disabled: all processing stopped');
  }

  async clearMemory() {
    this.endTalk();
    this.discussedComment = null;
    this.epoch++;
    this.cancelCommentVisit();
    this.comments?.reset();
    this.seenComments.clear();
    this.commentHistory = [];
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
    const total = this.engine.logTotal; // monotonic, so trimming or clearing the log never stalls the feed
    const start = total - log.length;
    for (this.logSent = Math.max(this.logSent, start); this.logSent < total; this.logSent++) {
      const d = log[this.logSent - start];
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
        bubbleVisible: !!this.state.bubble || this.speaking,
        ...this.userFlags(),
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
      commentRequestId: this.commentAttempt?.requestId ?? null,
      commentReady: this.state.commentVisit?.phase !== 'running',
      readingComments: !!this.commentAttempt || !!this.state.commentHint,
      commentsOpen: this.commentsOpen && this.commentsEnabled(),
      conversationBusy: this.talkBusy(),
      bubbleVisible: !!this.state.bubble || this.speaking,
      ...this.userFlags(),
    };
  }

  private tick() {
    if (this.destroyed) return;
    const now = Date.now();
    if (this.talkTurnId && now >= this.nextTalkContextAt) this.syncTalkContext();
    this.tickComment(now);
    this.tickCommentsOpen(this.demo ? null : this.watcher?.currentId ?? null, now);
    if (this.demo) {
      this.demo.tick(now);
      this.set({ demo: this.demo.view(now) });
    }
    const snap = this.snapshot();
    this.tickFeelings(snap.videoId, now);
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
    if (this.state.talk.active && this.state.talk.phase === 'speaking') return 'speaking';
    if (this.state.commentVisit) {
      if (this.state.commentVisit.phase === 'running') return 'curious';
      return this.state.commentVisit.emotion ?? (this.state.commentVisit.phase === 'reading' ? 'thinking' : 'curious');
    }
    if (this.speaking) return 'speaking';
    if (this.state.bubble) return 'amused';
    const emo = this.cues.current(now); // a timed reaction to the moment on screen
    if (emo) return emo;
    if (this.busy > 0 || this.engine.hasPending() || (this.state.talk.active && this.state.talk.phase === 'thinking')) return 'thinking';
    if (now - this.lastActivity > SLEEP_AFTER_MS) return 'sleeping';
    if (s.playing) return 'watching';
    return 'idle';
  }

  // ---------- delivery ----------
  private deliver(d: Delivery) {
    console.log(LOG, 'DELIVER', d.mode, `"${d.candidate.text}"`, '-', d.reason);
    this.emit({
      type: 'delivered', videoId: d.candidate.targetVideoId, text: d.candidate.text, mode: d.mode, reason: d.reason,
      move: d.candidate.move ?? null, // the backend journal records which kind of line was shown
    });
    window.clearTimeout(this.bubbleTimer);
    this.set({ bubble: { id: d.candidate.id, text: d.candidate.text, commentRequestId: d.candidate.commentRequestId } });
    const linger = Math.min(8000, Math.max(4000, d.candidate.text.length * 75));
    if (d.candidate.commentRequestId === this.commentAttempt?.requestId && this.commentAttempt)
      this.commentAttempt.expiresAt = Date.now() + linger + 1000;
    if (d.mode === 'voice' && this.state.settings.voice && this.speaker.available && !this.talkBusy()) {
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
    if (this.commentAttempt?.handled) this.commentAttempt.expiresAt = Math.min(this.commentAttempt.expiresAt, Date.now() + 800);
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
      maxFrames: DEFAULT_MAX_FRAMES,
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
    this.discussedComment = null;
    this.lastActivity = Date.now();
    if (this.demo) return;
    this.cancelCommentVisit();
    this.comments?.reset();
    this.seenComments.clear();
    this.commentHistory = [];
    this.navTimes.push(info.startedAt);
    if (prev) this.handleLeft(prev);
    const prevTitle = this.ctx?.title ?? '';
    const ctx = (this.ctx = this.newCtx(info.videoId));
    this.syncTalkContext();
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
      this.syncTalkContext();
      this.emit({ type: 'short_started', videoId: info.videoId, title, channel });
      void this.swipeStep(ctx, title, channel);
    };
    window.setTimeout(() => readTitle(0), 150);
    if (this.watcher?.video && !this.watcher.video.paused) this.onPlayback('play', this.watcher.video);
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
      this.setDemoMode(res?.demoMode);
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
    this.endTalk();
    this.discussedComment = null;
    this.cancelCommentVisit();
    this.comments?.reset();
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
    if (!ctx.done && !ctx.capturing && !ctx.observing && ctx.frameCount < ctx.maxFrames && !video.paused && video.currentTime >= ctx.nextAt) {
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
      const feeling = this.viewerFeeling();
      const res = await sendBg<CaptionReactResponse>({
        type: 'CAPTION_REACT',
        videoId: ctx.videoId,
        lines,
        title: ctx.title,
        channel: readPageText().channel,
        currentTime: at,
        personality: this.state.settings.personality,
        frequency: this.state.settings.frequency,
        viewerFeeling: feeling,
      });
      if (!this.isCurrent(ctx)) return; // scrolled away
      if (res?.emotion) this.showFace(ctx, res.emotion, 0.8, 'captions', at);
      this.noteBlended(ctx.videoId, feeling, res?.reactions?.length ?? 0);
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
    const { frame, source } = await this.grabFrame(video, () => this.isCurrent(ctx));
    ctx.capturing = false;
    if (!this.isCurrent(ctx)) return;
    ctx.frameCount++;
    const index = ctx.frameCount;
    if (this.state.frameSource !== source) this.set({ frameSource: source });
    console.log(LOG, `frame ${index}/${ctx.maxFrames} via ${source} at ${t.toFixed(1)}s`);
    this.emit({ type: 'frame', videoId: ctx.videoId, n: index, of: ctx.maxFrames, via: frame ? source : 'failed', t });

    const captions = ctx.pendingCaptions.splice(0); // the frame step carries any new captions
    ctx.observing = true;
    this.busy++;
    this.tick();
    try {
      const feeling = this.viewerFeeling();
      const res = await sendBg<ObserveResponse>({
        type: 'OBSERVE',
        videoId: ctx.videoId,
        frame: frame ?? '',
        frameTime: t,
        duration,
        frameIndex: index,
        maxFrames: MAX_FRAMES_REQUEST,
        title: ctx.title,
        channel: readPageText().channel,
        captions,
        personality: this.state.settings.personality,
        frequency: this.state.settings.frequency,
        viewerFeeling: feeling,
      });
      if (!this.isCurrent(ctx)) return;
      this.setDemoMode(res?.demoMode);
      if (typeof res?.maxFrames === 'number' && res.maxFrames > 0) ctx.maxFrames = res.maxFrames;
      if (!res || res.error) {
        // The backend answered but its vision model missed this frame: handled by retrying, so not an extension error.
        // Unreachable backends and HTTP failures stay warnings, because they need fixing.
        const handled = !!res?.error && !res.error.includes('HTTP') && !/fetch|abort/i.test(res.error);
        (handled ? console.info : console.warn)(LOG, 'reel observation unavailable:', res?.error ?? 'empty response');
        this.set({ note: 'Reel analysis unavailable. Retrying a later frame.' });
        if (res?.final || index >= ctx.maxFrames) ctx.done = true;
        else ctx.nextAt = Math.max(t + 3, video.currentTime + 1.5);
        return;
      }
      if (res?.emotion && res.level >= 1) this.showFace(ctx, res.emotion, res.level >= 3 ? 1 : 0.8, `frame ${index}`, t);
      // No "avoid" time: the line is a reaction to a moment that just happened, so showing it now is the point.
      // (Level 2-3 lines are marked 'now' by the backend; the timing engine still applies the reading gap.)
      this.noteBlended(ctx.videoId, feeling, res?.reactions?.length ?? 0);
      this.propose(res?.reactions ?? []);
      // Plan the next frame: trust the model's guess only within sane bounds.
      const now = video.currentTime;
      let next = res?.nextCaptureAt ?? null;
      if (next !== null) next = Math.max(next, t + MIN_FRAME_GAP_S, now + 0.3);
      if (res?.final || next === null || index >= ctx.maxFrames || (duration > 0 && next > duration - 0.5)) ctx.done = true;
      else ctx.nextAt = next;
      this.emit({
        type: 'status',
        videoId: ctx.videoId,
        note: ctx.done ? `done after ${index} frame(s)` : `next frame at ${next?.toFixed(1)}s (asked ${res?.nextCaptureAt ?? 'null'})`,
      });
    } catch (e) {
      console.warn(LOG, 'observe failed', e);
      if (index >= ctx.maxFrames) ctx.done = true;
      else ctx.nextAt = t + 3; // try again a bit later
    } finally {
      ctx.observing = false;
      this.busy = Math.max(0, this.busy - 1);
      this.tick();
    }
  }

  /** Screenshot (character hidden, cropped) -> video canvas -> nothing (text only). */
  private async grabFrame(video: HTMLVideoElement, wanted: () => boolean): Promise<{ frame: string | null; source: UiState['frameSource'] }> {
    const r = video.getBoundingClientRect();
    const rect: Rect = { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, window.innerWidth), height: Math.min(r.height, window.innerHeight) };
    this.host.style.visibility = 'hidden';
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    // Switched off or swiped away while hidden: never capture the screen after that.
    if (!wanted()) { this.host.style.visibility = ''; return { frame: null, source: 'text' }; }
    try {
      const resp = await sendBg<CaptureResponse>({ type: 'CAPTURE_FRAME', rect, viewport: { w: window.innerWidth, h: window.innerHeight } });
      if (resp?.ok) return { frame: resp.data, source: 'screen' };
    } catch {
      /* fall through */
    } finally {
      this.host.style.visibility = '';
    }
    if (!wanted()) return { frame: null, source: 'text' };
    try {
      const scale = Math.min(1, 512 / Math.max(video.videoWidth || 1, video.videoHeight || 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(video.videoWidth * scale));
      c.height = Math.max(1, Math.round(video.videoHeight * scale));
      c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
      const frame = c.toDataURL('image/jpeg', 0.72).split(',')[1] ?? null;
      if (frame) return { frame, source: 'canvas' };
    } catch (e) {
      console.info(LOG, 'canvas fallback unavailable, using title and captions only:', (e as Error).name);
    }
    return { frame: null, source: 'text' };
  }

  // ---------- demo ----------
  private startDemo() {
    if (this.demo) return;
    this.cancelCommentVisit();
    this.comments?.reset();
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
