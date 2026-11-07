import type { Analysis, Frequency, MemoryRecord, Personality, ReactionProposal, Rect } from './types';

/** Messages from content script / stage page to the background worker. */
export type BgRequest =
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
  | { type: 'OPEN_STAGE' }
  | { type: 'TELEMETRY'; event: TelemetryEvent };

/** Small scalar-only events for the backend's live feed (/ui). Never frames or transcripts. */
export type TelemetryEvent = { type: 'short_started' | 'short_left' | 'frame' | 'decision' | 'delivered' | 'status' } & Record<
  string,
  string | number | boolean | null
>;

export type CaptureResponse = { ok: true; data: string } | { ok: false; error: string };
export interface AnalyseReactResponse {
  analysis: Analysis | null;
  reactions: ReactionProposal[];
  error?: string;
}
export interface ReactResponse {
  reactions: ReactionProposal[];
  error?: string;
}

/** Messages from the background worker to the content script. */
export type TabMessage = { type: 'ACTIVE_TAB_GRANTED' };

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
