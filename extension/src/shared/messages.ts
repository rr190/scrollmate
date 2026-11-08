import type { Emotion } from './emotions';
import type { UserSignal } from './faceSignals';
import type { Analysis, Frequency, MemoryRecord, Personality, ReactionProposal, Rect } from './types';

/** Messages from content script / stage page to the background worker. */
export type BgRequest =
  | { type: 'TALK_START'; context: TalkContext }
  | { type: 'TALK_CONTEXT'; context: TalkContext }
  | { type: 'TALK_CANCEL'; requestId?: string }
  | { type: 'TALK_LIVE_EVENT'; requestId: string; event: LiveVoiceEvent }
  | { type: 'TALK_MIC_PERMISSION_GRANTED' }
  | { type: 'MEDIA_READY' }
  | { type: 'CAPTURE_FRAME'; rect: Rect; viewport: { w: number; h: number } }
  | { type: 'SHORT_STARTED'; videoId: string }
  | { type: 'SHORT_SKIPPED'; videoId: string; title: string; secondsWatched: number }
  | {
      type: 'ANALYSE_AND_REACT';
      videoId: string;
      frames: string[];
      frameTimes: number[];
      title: string;
      channel: string;
      captions: string[];
      secondsWatched: number;
      personality: Personality;
      frequency: Frequency;
    }
  | { type: 'REMEMBER'; record: MemoryRecord }
  | { type: 'REACT_ONLY'; currentVideoId: string; personality: Personality; frequency: Frequency }
  | { type: 'GET_MEMORY' }
  | { type: 'CLEAR_MEMORY' }
  | { type: 'CANCEL_ALL' }
  | { type: 'CANCEL_COMMENT'; requestId: string }
  | {
      type: 'COMMENT_REACT';
      requestId: string;
      videoId: string;
      commentId: string;
      text: string;
      title: string;
      /** Comments already reacted to on this Short (oldest first) and what ScrollMate said. RAM only. */
      previousComments: PreviousComment[];
      personality: Personality;
      frequency: Frequency;
    }
  | { type: 'OPEN_STAGE' }
  // Mochi kindly notices the child's feeling: only the expression label goes to the backend, never an image
  | { type: 'FEELING_LINE'; videoId: string; expression: string; title: string; personality: Personality }
  // webcam (opt-in, on-device): content -> background, and offscreen camera page -> background
  | { type: 'CAMERA_START' }
  | { type: 'CAMERA_STOP' }
  | { type: 'CAMERA_PERMISSION_GRANTED' }
  | { type: 'USER_SIGNAL'; signal: UserSignal }
  | { type: 'CAMERA_STATUS'; state: CameraState; detail?: string }
  | { type: 'SWIPE'; videoId: string; title: string; channel: string; personality: Personality; frequency: Frequency }
  | {
      type: 'OBSERVE';
      videoId: string;
      frame: string; // one base64 JPEG, or '' for text only
      frameTime: number;
      duration: number;
      frameIndex: number;
      maxFrames: number;
      title: string;
      channel: string;
      captions: string[];
      personality: Personality;
      frequency: Frequency;
      viewerFeeling?: string; // how the child seems to feel right now (label only, never an image)
    }
  | {
      type: 'CAPTION_REACT';
      videoId: string;
      lines: string[];
      title: string;
      channel: string;
      currentTime: number;
      personality: Personality;
      frequency: Frequency;
      viewerFeeling?: string; // how the child seems to feel right now (label only)
    }
  | { type: 'TELEMETRY'; event: TelemetryEvent };

/** Small scalar-only events for the backend's live feed (/ui). Never frames or transcripts. */
export type TelemetryEvent = { type: 'short_started' | 'short_left' | 'frame' | 'decision' | 'delivered' | 'emotion' | 'status' | 'user' } & Record<
  string,
  string | number | boolean | null
>;

export type CaptureResponse = { ok: true; data: string } | { ok: false; error: string };
export interface AnalyseReactResponse {
  analysis: Analysis | null;
  reactions: ReactionProposal[];
  error?: string;
}
export interface CaptionReactResponse {
  emotion: Emotion | null;
  reactions: ReactionProposal[];
  error?: string;
}
export interface PreviousComment {
  text: string;
  reaction: string | null;
  emotion: string | null;
}

export interface CommentReactResponse {
  requestId: string;
  targetCommentId: string;
  emotion: Emotion | null;
  reactions: ReactionProposal[];
  error?: string;
}
export interface SwipeResponse {
  momentType: string;
  emotion: Emotion | null;
  level: number;
  lookFor: string;
  error?: string;
}
export interface ObserveResponse {
  emotion: Emotion | null;
  level: number;
  change: 'none' | 'minor' | 'major';
  reactions: ReactionProposal[];
  nextCaptureAt: number | null;
  final: boolean;
  maxFrames?: number; // effective frame limit for this Short
  belief?: { topic: string; happening: string; confidence: number; emotionArc: string[] };
  error?: string;
}
export interface FeelingLineResponse {
  line: string | null;
  emotion: Emotion | null;
  source?: 'ai' | 'fallback';
  ms?: number;
  move?: string;
  error?: string;
}
export interface ReactResponse {
  reactions: ReactionProposal[];
  error?: string;
}

/** Messages from the background worker to the content script. */
export type CameraState = 'off' | 'starting' | 'on' | 'needs_permission' | 'error';
export interface TalkContext {
  requestId: string;
  videoId: string;
  title: string;
  selectedComment: string;
  commentsOpen?: boolean;
  visibleComments?: string[];
  personality: Personality;
  videoSummary?: string;
}
export type LiveVoiceEvent =
  | { type: 'status'; state: 'listening' | 'thinking' | 'speaking' | 'error' | 'needs_permission'; error?: string }
  | { type: 'caption'; role: 'user' | 'assistant'; text: string }
  | { type: 'interrupted' };
export type TabMessage =
  | { type: 'TALK_EVENT'; requestId: string; event: LiveVoiceEvent }
  | { type: 'ACTIVE_TAB_GRANTED' }
  | { type: 'USER_SIGNAL'; signal: UserSignal }
  | { type: 'CAMERA_STATUS'; state: CameraState; detail?: string }

export function sendBg<T = unknown>(msg: BgRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (res: T) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res);
      });
    } catch (e) {
      // Extension was reloaded while the page stayed open.
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
