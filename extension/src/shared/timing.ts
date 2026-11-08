/**
 * Reaction timing engine.
 *
 * The LLM *proposes* reactions; this deterministic state machine *decides* when
 * (and whether) to deliver them. It never touches playback: it only reads a
 * snapshot of what the player is doing. Pure TypeScript with injected time so
 * the evaluation script can replay sessions through exactly the same code.
 */
import type { Frequency, ReactionProposal } from './types';

export type Decision = 'SPEAK_NOW' | 'WAIT' | 'SAVE_FOR_LATER' | 'STAY_SILENT';
export type DeliveryMode = 'voice' | 'bubble';

export interface Candidate extends ReactionProposal {
  id: string;
  createdAt: number; // ms
  /** Video-time seconds of key moments we should not talk over. */
  avoidTimes?: number[];
}

export interface PlaybackSnapshot {
  enabled: boolean;
  videoId: string | null;
  playing: boolean;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number; // 0 when unknown
  lastLoopAt: number | null; // ms
  muted: boolean;
  /** true = we know it's quiet, false = we know it's loud, null = unknown (assume it might be loud). */
  audioQuiet: boolean | null;
  navTimes: number[]; // ms timestamps of recent Short changes
  commentRequestId?: string | null; // active, visible selection; absent for normal video viewing
  commentReady?: boolean; // the buddy has arrived beside it
  readingComments?: boolean; // a hovered comment may be waiting for the previous bubble to finish
}

export interface EngineOptions {
  frequency: Frequency;
  voiceEnabled: boolean;
}

export const COOLDOWN_MS: Record<Frequency, number> = { rare: 45_000, balanced: 20_000, chatty: 12_000 };
export const MIN_IMPORTANCE: Record<Frequency, number> = { rare: 0.75, balanced: 0.55, chatty: 0.4 };
// No limit on comments per Short for now (frequency still sets the importance bar and the gap).
export const MAX_PER_SHORT: Record<Frequency, number> = { rare: Infinity, balanced: Infinity, chatty: Infinity };
/** Minimum gap between any two bubbles, so a new one doesn't replace one still being read. */
export const SAME_SHORT_GAP_MS: Record<Frequency, number> = { rare: 8_000, balanced: 5_000, chatty: 3_500 };
export const FAST_SCROLL = { count: 3, windowMs: 6_000 };
export const LOOP_GAP_MS = 2_500;
export const END_GAP_S = 1.2;
const KEY_MOMENT_S = 1.5;
const MAX_QUEUE = 6;
const MAX_LOG = 1_000;

export interface Verdict {
  decision: Decision;
  /** Stable short code, used to avoid logging the same verdict every tick. */
  code: string;
  reason: string;
  mode?: DeliveryMode;
}

export interface DecisionInputs {
  videoOnScreen: string | null;
  playing: boolean;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
  sinceLoopMs: number | null;
  naturalGap: string | null;
  quiet: boolean;
  fastScrolling: boolean;
  cooldownLeftMs: number;
  importance: number;
  ageSeconds: number;
}

export interface DecisionLogEntry {
  t: number;
  reactionId: string;
  text: string;
  targetVideoId: string;
  isCallback: boolean;
  decision: Decision;
  reason: string;
  inputs: DecisionInputs;
}

export interface Delivery {
  candidate: Candidate;
  mode: DeliveryMode;
  reason: string;
}

interface EngineMemory {
  lastSpokeAt: number | null;
  lastSpokeVideo: string | null;
  deliveredTexts: Set<string>;
  deliveredPerVideo: Map<string, number>;
}

export function normalizeText(t: string): string {
  return t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

/** A natural pause in the viewing: the best time to say something. */
export function naturalGap(s: PlaybackSnapshot, now: number): string | null {
  if (!s.videoId) return null;
  if (s.ended) return 'ended';
  if (s.paused) return 'paused';
  if (s.lastLoopAt !== null && now - s.lastLoopAt < LOOP_GAP_MS) return 'loop';
  if (s.playing && s.duration > 0 && s.duration - s.currentTime < END_GAP_S) return 'near_end';
  return null;
}

/** Only claim quiet when we actually know it. Unknown audio = maybe loud. */
export function isQuiet(s: PlaybackSnapshot): boolean {
  return s.paused || s.ended || s.muted || s.audioQuiet === true;
}

export function isFastScrolling(s: PlaybackSnapshot, now: number): boolean {
  return s.navTimes.filter((t) => now - t < FAST_SCROLL.windowMs).length >= FAST_SCROLL.count;
}

function v(decision: Decision, code: string, reason: string, mode?: DeliveryMode): Verdict {
  return { decision, code, reason, mode };
}

export function decide(
  c: Candidate,
  s: PlaybackSnapshot,
  mem: EngineMemory,
  opts: EngineOptions,
  now: number,
): Verdict {
  if (!s.enabled) return v('STAY_SILENT', 'disabled', 'companion disabled: queue cancelled');
  if (c.targetCommentId && (!c.commentRequestId || c.commentRequestId !== s.commentRequestId))
    return v('STAY_SILENT', 'stale_comment', 'selected comment changed or closed: reaction cancelled');

  if (mem.deliveredTexts.has(normalizeText(c.text)))
    return v('STAY_SILENT', 'duplicate', 'duplicate of a reaction already delivered');

  const ageS = (now - c.createdAt) / 1000;
  if (ageS > c.expiresAfterSeconds)
    return v('STAY_SILENT', 'expired', `expired after ${c.expiresAfterSeconds}s without a good moment`);

  // A comment the user deliberately picked is its own moment: no importance bar, no reading gap.
  // Only wait for the buddy to arrive beside it. Always a silent bubble, even when Voice is enabled.
  if (c.targetCommentId) {
    if (s.videoId !== c.targetVideoId) return v('STAY_SILENT', 'stale', 'user scrolled away from the commented Short');
    if (!s.commentReady) return v('WAIT', 'comment_travel', 'buddy is moving beside the selected comment');
    return v('SPEAK_NOW', 'selected_comment', 'reacting beside the visible selected comment', 'bubble');
  }

  const minImp = MIN_IMPORTANCE[opts.frequency];
  if (c.importance < minImp)
    return v('STAY_SILENT', 'low_importance', `importance ${c.importance.toFixed(2)} < ${minImp} for "${opts.frequency}"`);

  const onScreen = s.videoId === c.targetVideoId;
  if (!onScreen && !c.isCallback)
    return v('STAY_SILENT', 'stale', 'user scrolled away: reaction is about a Short no longer on screen');

  // (Comment lines returned above; everything below is a video reaction.)
  if (s.readingComments || s.commentRequestId)
    return v('WAIT', 'reading_comments', 'reading a comment: video reactions wait');

  if (s.videoId && (mem.deliveredPerVideo.get(s.videoId) ?? 0) >= MAX_PER_SHORT[opts.frequency])
    return c.isCallback
      ? v('SAVE_FOR_LATER', 'per_short_cap', 'already reacted on this Short: saving the callback')
      : v('WAIT', 'per_short_cap', 'already reacted on this Short');

  if (isFastScrolling(s, now))
    return c.isCallback
      ? v('SAVE_FOR_LATER', 'fast_scroll', 'user is scrolling fast: saving the callback')
      : v('WAIT', 'fast_scroll', 'user is scrolling fast');

  // Comments aren't limited for now: only a short reading gap between bubbles (COOLDOWN_MS is kept for later).
  const sameShort = mem.lastSpokeVideo !== null && mem.lastSpokeVideo === s.videoId;
  const cooldown = SAME_SHORT_GAP_MS[opts.frequency];
  if (mem.lastSpokeAt !== null && now - mem.lastSpokeAt < cooldown) {
    const left = Math.ceil((cooldown - (now - mem.lastSpokeAt)) / 1000);
    const what = sameShort ? 'gap between comments' : 'cooldown';
    return c.isCallback && !onScreen
      ? v('SAVE_FOR_LATER', 'cooldown', `${what} (${left}s left): saving the callback`)
      : v('WAIT', 'cooldown', `${what} (${left}s left)`);
  }

  const gap = naturalGap(s, now);
  if (gap) {
    const quiet = isQuiet(s);
    if (opts.voiceEnabled && quiet) return v('SPEAK_NOW', `gap_${gap}`, `natural gap (${gap}), quiet: speaking`, 'voice');
    const why = opts.voiceEnabled ? ', audio may be playing: silent bubble' : '';
    return v('SPEAK_NOW', `gap_${gap}`, `natural gap (${gap})${why}`, 'bubble');
  }

  // Mid-playback from here on.
  if (!onScreen) return v('SAVE_FOR_LATER', 'callback_saved', 'callback saved for the next natural gap');

  // Live comments: a 'now' line that already cleared this frequency's importance bar may show mid-video.
  if (c.preferredTiming === 'now' && !c.requiresQuietMoment && s.currentTime >= 2) {
    const nearKey = (c.avoidTimes ?? []).some((t) => Math.abs(t - s.currentTime) < KEY_MOMENT_S);
    if (!nearKey) return v('SPEAK_NOW', 'live', 'live comment: silent bubble mid-playback', 'bubble');
    return v('WAIT', 'key_moment', 'would cover a key moment');
  }

  return v('WAIT', 'mid_playback', 'video mid-playback: waiting for a natural gap');
}

export class TimingEngine {
  queue: Candidate[] = [];
  log: DecisionLogEntry[] = [];
  private mem: EngineMemory = { lastSpokeAt: null, lastSpokeVideo: null, deliveredTexts: new Set(), deliveredPerVideo: new Map() };
  private lastCode = new Map<string, string>();

  constructor(public opts: EngineOptions) {}

  get lastSpokeAt(): number | null {
    return this.mem.lastSpokeAt;
  }

  /** Add a proposal and evaluate immediately. */
  propose(c: Candidate, s: PlaybackSnapshot, now: number): Delivery | null {
    if (this.queue.some((q) => q.id === c.id)) return null;
    this.queue.push(c);
    return this.tick(s, now);
  }

  /** Re-evaluate the queue. Delivers at most one reaction per tick. */
  tick(s: PlaybackSnapshot, now: number): Delivery | null {
    let delivered: Delivery | null = null;
    const keep: Candidate[] = [];
    const ordered = [...this.queue].sort((a, b) => b.importance - a.importance || a.createdAt - b.createdAt);

    for (const c of ordered) {
      const verdict = decide(c, s, this.mem, this.opts, now);
      this.record(c, s, verdict, now);
      if (verdict.decision === 'SPEAK_NOW') {
        delivered = { candidate: c, mode: verdict.mode ?? 'bubble', reason: verdict.reason };
        this.mem.lastSpokeAt = now;
        this.mem.lastSpokeVideo = s.videoId;
        this.mem.deliveredTexts.add(normalizeText(c.text));
        if (s.videoId) this.mem.deliveredPerVideo.set(s.videoId, (this.mem.deliveredPerVideo.get(s.videoId) ?? 0) + 1);
      } else if (verdict.decision === 'WAIT' || verdict.decision === 'SAVE_FOR_LATER') {
        keep.push(c);
      }
    }

    // Bound the queue: drop the least important.
    while (keep.length > MAX_QUEUE) {
      const dropped = keep.pop()!;
      this.record(dropped, s, v('STAY_SILENT', 'queue_full', 'queue full: dropped least important'), now);
    }
    this.queue = keep;
    return delivered;
  }

  /** Disabling cancels everything queued, immediately. */
  cancelAll(s: PlaybackSnapshot, now: number, reason = 'companion disabled: queue cancelled'): void {
    for (const c of this.queue) this.record(c, s, v('STAY_SILENT', 'cancelled', reason), now, true);
    this.queue = [];
  }

  cancelComment(requestId: string, s: PlaybackSnapshot, now: number): void {
    this.queue = this.queue.filter((c) => {
      if (c.commentRequestId !== requestId) return true;
      this.record(c, s, v('STAY_SILENT', 'cancelled_comment', 'selected comment closed or changed'), now, true);
      return false;
    });
  }

  clear(): void {
    this.queue = [];
    this.log = [];
    this.lastCode.clear();
    this.mem = { lastSpokeAt: null, lastSpokeVideo: null, deliveredTexts: new Set(), deliveredPerVideo: new Map() };
  }

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  private record(c: Candidate, s: PlaybackSnapshot, verdict: Verdict, now: number, force = false): void {
    const key = `${verdict.decision}:${verdict.code}`;
    if (!force && this.lastCode.get(c.id) === key) return; // log changes, not every tick
    this.lastCode.set(c.id, key);
    const cooldown = SAME_SHORT_GAP_MS[this.opts.frequency];
    this.log.push({
      t: now,
      reactionId: c.id,
      text: c.text,
      targetVideoId: c.targetVideoId,
      isCallback: c.isCallback,
      decision: verdict.decision,
      reason: verdict.reason,
      inputs: {
        videoOnScreen: s.videoId,
        playing: s.playing,
        paused: s.paused,
        ended: s.ended,
        currentTime: Math.round(s.currentTime * 10) / 10,
        duration: Math.round(s.duration * 10) / 10,
        sinceLoopMs: s.lastLoopAt === null ? null : now - s.lastLoopAt,
        naturalGap: naturalGap(s, now),
        quiet: isQuiet(s),
        fastScrolling: isFastScrolling(s, now),
        cooldownLeftMs: this.mem.lastSpokeAt === null ? 0 : Math.max(0, cooldown - (now - this.mem.lastSpokeAt)),
        importance: c.importance,
        ageSeconds: Math.round((now - c.createdAt) / 100) / 10,
      },
    });
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
  }
}
