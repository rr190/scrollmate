/**
 * Demo mode: three predefined Short observations played on a simulated timeline.
 * Works fully offline with canned reactions; optionally asks the live backend
 * using the same predefined observations.
 */
import type { EmotionCue } from '../shared/emotions';
import type { MemoryRecord, Personality, ReactionProposal } from '../shared/types';

export interface DemoShort {
  videoId: string;
  title: string;
  channel: string;
  duration: number; // seconds
  art: 'success' | 'fail' | 'pro';
  record: MemoryRecord;
  /** Hand-timed to the stage art (see stage/main.tsx CakeArt). */
  cues: EmotionCue[];
  canned: Record<Personality, Omit<ReactionProposal, 'targetVideoId'>[]>;
}

const base = { preferredTiming: 'after_video' as const, requiresQuietMoment: true };

export const DEMO_SHORTS: DemoShort[] = [
  {
    videoId: 'demo-cake-success',
    title: '5-Min Chocolate Cake 🍫✨',
    channel: '@SweetBake',
    duration: 9,
    art: 'success',
    cues: [{ t: 5.6, emotion: 'love', intensity: 0.8 }], // strawberries pop on
    record: {
      videoId: 'demo-cake-success',
      topic: 'baking',
      summary: 'A home baker makes a layered chocolate cake and tops it with strawberries.',
      events: [
        { timestamp: 3, description: 'Batter goes into the pan.', confidence: 0.9 },
        { timestamp: 8, description: 'A neat two-layer cake with strawberries is revealed.', confidence: 0.88 },
      ],
      outcome: 'The cake turned out well.',
      mood: 'wholesome',
      themes: ['cake', 'baking', 'success'],
      secondsWatched: 9,
      skipped: false,
    },
    canned: {
      witty: [{ ...base, text: 'That cake trusted the process, and the process delivered.', importance: 0.35, expiresAfterSeconds: 15, isCallback: false }],
      hype: [{ ...base, text: 'Strawberries on top? Chef is cooking!', importance: 0.35, expiresAfterSeconds: 15, isCallback: false }],
      chill: [{ ...base, text: 'Nice, steady bake.', importance: 0.25, expiresAfterSeconds: 15, isCallback: false }],
    },
  },
  {
    videoId: 'demo-cake-fail',
    title: 'I tried the viral 5-minute cake… 💀',
    channel: '@OvenOops',
    duration: 9,
    art: 'fail',
    cues: [
      { t: 4.6, emotion: 'worried', intensity: 0.8 }, // smoke appears
      { t: 6.6, emotion: 'cringe', intensity: 1 }, // cake turns black
    ],
    record: {
      videoId: 'demo-cake-fail',
      topic: 'baking',
      summary: 'Someone attempts the same quick cake and pulls a blackened, smoking cake from the oven.',
      events: [
        { timestamp: 5, description: 'Smoke comes out of the oven.', confidence: 0.86 },
        { timestamp: 7, description: 'The cake is burnt black on top.', confidence: 0.84 },
      ],
      outcome: 'The baking attempt failed.',
      mood: 'fail',
      themes: ['cake', 'baking', 'fail'],
      secondsWatched: 9,
      skipped: false,
    },
    canned: {
      witty: [{ ...base, text: 'Five minutes, as promised. Just not the five minutes anyone wanted.', importance: 0.5, expiresAfterSeconds: 15, isCallback: false }],
      hype: [{ ...base, text: 'OKAY that smoke had main character energy!', importance: 0.5, expiresAfterSeconds: 15, isCallback: false }],
      chill: [{ ...base, text: 'Smoke alarm got its moment.', importance: 0.45, expiresAfterSeconds: 15, isCallback: false }],
    },
  },
  {
    videoId: 'demo-cake-pro',
    title: 'Mirror glaze cake decorating 🪞🎂',
    channel: '@PastryAtelier',
    duration: 9,
    art: 'pro',
    cues: [
      { t: 3.0, emotion: 'surprised', intensity: 0.7 }, // glaze starts pouring
      { t: 6.6, emotion: 'impressed', intensity: 1 }, // mirror finish revealed
    ],
    record: {
      videoId: 'demo-cake-pro',
      topic: 'baking',
      summary: 'A professional pastry chef pours a glossy mirror glaze and finishes a stunning cake.',
      events: [
        { timestamp: 4, description: 'Mirror glaze is poured over the cake.', confidence: 0.9 },
        { timestamp: 8, description: 'The finished cake reflects the kitchen lights.', confidence: 0.87 },
      ],
      outcome: 'A flawless professional cake.',
      mood: 'impressive',
      themes: ['cake', 'baking', 'success', 'professional'],
      secondsWatched: 9,
      skipped: false,
    },
    canned: {
      witty: [
        { ...base, text: "We've just witnessed the rise, fall and redemption of the entire baking industry.", importance: 0.95, expiresAfterSeconds: 40, isCallback: true },
        { ...base, text: 'That glaze is shinier than my future.', importance: 0.6, expiresAfterSeconds: 15, isCallback: false },
      ],
      hype: [
        { ...base, text: 'Cake, catastrophe, MASTERPIECE: the comeback arc is complete!', importance: 0.95, expiresAfterSeconds: 40, isCallback: true },
      ],
      chill: [
        { ...base, text: 'Rise, fall, redemption. Cake is going to be okay.', importance: 0.9, expiresAfterSeconds: 40, isCallback: true },
      ],
    },
  },
];

export type DemoPhase = 'playing' | 'ended' | 'finished';

export interface DemoView {
  index: number;
  short: DemoShort;
  elapsed: number;
  phase: DemoPhase;
  paused: boolean;
}

const HOLD_AFTER_END_MS = [5000, 5000, 9000];

export class DemoDriver {
  index = -1;
  private startedAt = 0;
  private pausedTotal = 0;
  private pausedAt: number | null = null;
  private endedAt: number | null = null;
  phase: DemoPhase = 'playing';

  constructor(private onShortChange: (s: DemoShort, index: number) => void) {}

  start() {
    this.go(0);
  }

  next() {
    if (this.index >= DEMO_SHORTS.length - 1) this.go(0);
    else this.go(this.index + 1);
  }

  togglePause() {
    if (this.phase !== 'playing') return;
    const now = Date.now();
    if (this.pausedAt === null) this.pausedAt = now;
    else {
      this.pausedTotal += now - this.pausedAt;
      this.pausedAt = null;
    }
  }

  private go(i: number) {
    this.index = i;
    this.startedAt = Date.now();
    this.pausedTotal = 0;
    this.pausedAt = null;
    this.endedAt = null;
    this.phase = 'playing';
    this.onShortChange(DEMO_SHORTS[i], i);
  }

  get short(): DemoShort {
    return DEMO_SHORTS[Math.max(0, this.index)];
  }

  elapsed(now: number): number {
    const paused = this.pausedTotal + (this.pausedAt !== null ? now - this.pausedAt : 0);
    return Math.min(this.short.duration, (now - this.startedAt - paused) / 1000);
  }

  tick(now: number) {
    if (this.index < 0) return;
    if (this.phase === 'playing' && this.elapsed(now) >= this.short.duration) {
      this.phase = 'ended';
      this.endedAt = now;
    }
    if (this.phase === 'ended' && this.endedAt !== null && now - this.endedAt > HOLD_AFTER_END_MS[this.index]) {
      if (this.index < DEMO_SHORTS.length - 1) this.go(this.index + 1);
      else this.phase = 'finished';
    }
  }

  view(now: number): DemoView {
    return { index: this.index, short: this.short, elapsed: this.elapsed(now), phase: this.phase, paused: this.pausedAt !== null };
  }
}
