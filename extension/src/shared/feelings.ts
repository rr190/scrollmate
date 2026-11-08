/**
 * When Mochi kindly notices the child's feeling out loud ("You're smiling! Did that make you happy?").
 * Pure and time-injected so it can be unit-tested. Rare on purpose: it should feel special, not watched.
 */
import type { UserExpression } from './faceSignals';

export const NOTICEABLE: ReadonlySet<UserExpression> = new Set<UserExpression>([
  'happy', 'laughing', 'surprised', 'sad', 'scared', 'confused', 'disgusted', 'angry',
]);

export const FEELING_RULES = {
  holdMs: 1_200, // the feeling must last this long (on top of the tracker's 250 ms hold)
  minStrength: 0.5,
  gapMs: 90_000, // between any two notices
  sameFeelingGapMs: 240_000, // before naming the same feeling again
  afterSwipeMs: 4_000, // let a new Short settle first
} as const;

/** Demo mode (for presenting): the same idea, just sooner and more often so it shows up on stage. */
export const DEMO_FEELING_RULES = {
  holdMs: 800,
  minStrength: 0.45,
  gapMs: 30_000,
  sameFeelingGapMs: 60_000,
  afterSwipeMs: 2_000,
} as const;

/** What the buddy says it saw when it mirrors the child (a small pop under it, not a speech bubble). */
export const MIRROR_POP: Partial<Record<UserExpression, string>> = {
  laughing: "😂 you're laughing!",
  happy: "😊 you're smiling!",
  surprised: '😮 whoa, you too!',
  sad: '😢 aww…',
  scared: '😨 eek!',
  confused: '🤨 hmm?',
  disgusted: '🤢 eww!',
  angry: '😠 grr!',
};

export interface FeelingInput {
  now: number;
  enabled: boolean; // companion + camera on
  videoId: string | null;
  shortStartedAt: number; // ms, when this Short appeared
  present: boolean;
  lookingAway: boolean;
  expression: UserExpression;
  strength: number;
  busy: boolean; // a bubble is showing, Mochi is speaking, or a comment visit is running
}

export class FeelingNoticer {
  private current: UserExpression = 'neutral';
  private since = 0;
  private lastAt = -Infinity;
  private lastFor = new Map<UserExpression, number>();
  private noticedShort: string | null = null;
  /** A line is being fetched: don't start another. */
  pending = false;
  /** Demo mode: sooner, more often, and allowed over a speech bubble. */
  demo = false;

  /** Returns the feeling to notice now, or null. */
  update(i: FeelingInput): UserExpression | null {
    if (i.expression !== this.current) {
      this.current = i.expression;
      this.since = i.now;
    }
    const R = this.demo ? DEMO_FEELING_RULES : FEELING_RULES;
    if (this.pending || !i.enabled || !i.videoId || !i.present || i.lookingAway || (i.busy && !this.demo)) return null;
    if (!NOTICEABLE.has(i.expression) || i.strength < R.minStrength) return null;
    if (i.now - this.since < R.holdMs) return null;
    if (i.now - i.shortStartedAt < R.afterSwipeMs) return null;
    if (this.noticedShort === i.videoId) return null; // one per Short
    if (i.now - this.lastAt < R.gapMs) return null;
    if (i.now - (this.lastFor.get(i.expression) ?? -Infinity) < R.sameFeelingGapMs) return null;
    this.lastAt = i.now;
    this.lastFor.set(i.expression, i.now);
    this.noticedShort = i.videoId;
    this.pending = true;
    return i.expression;
  }

  /** A reel comment already tied the moment to this feeling: count it as this Short's notice. */
  markNoticed(videoId: string, expression: UserExpression, now: number) {
    this.noticedShort = videoId;
    this.lastAt = now;
    this.lastFor.set(expression, now);
  }

  /** The request finished (line shown or not). */
  done() {
    this.pending = false;
  }
}
