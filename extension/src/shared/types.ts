import type { Emotion, EmotionCue } from './emotions';

export type AvatarKind = 'mochi' | 'scrollmate';

export type Personality = 'witty' | 'hype' | 'chill';
export type Frequency = 'rare' | 'balanced' | 'chatty';

export interface Settings {
  enabled: boolean; // user must turn the AI on explicitly
  voice: boolean; // off by default: the bubble is the main channel
  personality: Personality;
  frequency: Frequency;
  demo: boolean;
  demoLive: boolean; // demo uses the live LLM instead of canned reactions
  commentReactions: boolean; // deliberate hover on a visible top-level comment
  avatar: AvatarKind; // which character to draw
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  voice: false,
  personality: 'witty',
  frequency: 'balanced',
  demo: false,
  demoLive: false,
  commentReactions: true,
  avatar: 'mochi',
};

export type UnderstandingLevel = 'visual_and_text' | 'visual_only' | 'text_only' | 'none';

export interface ShortEvent {
  timestamp: number | null;
  description: string;
  /** Model estimate, not a calibrated probability. */
  confidence: number;
  emotion?: Emotion | null;
}

export interface Analysis {
  videoId: string;
  topic: string;
  summary: string;
  events: ShortEvent[];
  outcome: string | null;
  mood: string;
  themes: string[];
  understandingLevel: UnderstandingLevel;
  /** Model estimate, not a calibrated probability. */
  confidence: number;
  /** Timed facial reactions for the character (video seconds). */
  cues?: EmotionCue[];
}

/** One entry of the three-Short ring buffer. Never contains frames or transcripts. */
export interface MemoryRecord {
  videoId: string;
  topic: string;
  summary: string;
  events: ShortEvent[];
  outcome: string | null;
  mood: string;
  themes: string[];
  secondsWatched: number;
  skipped: boolean;
  runningJoke?: string | null;
}

export type PreferredTiming = 'now' | 'after_video' | 'next_gap';

/** What the backend (or the canned demo) proposes. The timing engine decides. */
export interface ReactionProposal {
  text: string;
  importance: number;
  targetVideoId: string;
  preferredTiming: PreferredTiming;
  expiresAfterSeconds: number;
  requiresQuietMoment: boolean;
  isCallback: boolean;
  targetCommentId?: string;
  commentRequestId?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
