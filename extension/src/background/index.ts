/**
 * Background service worker.
 *  - frame capture (chrome.tabs.captureVisibleTab), cropped + downscaled
 *  - the only component that talks to the ScrollMate backend (no API keys here)
 *  - three-Short memory ring buffer
 *
 * Memory lives in a JS array mirrored to chrome.storage.session, which is held
 * in RAM only (never written to disk) and survives MV3 worker restarts.
 */
import type {
  AnalyseReactResponse,
  BgRequest,
  CaptionReactResponse,
  CommentReactResponse,
  CaptureResponse,
  ObserveResponse,
  ReactResponse,
  SwipeResponse,
  TelemetryEvent,
  TabMessage,
  FeelingLineResponse,
  GazeConfig,
} from '../shared/messages';
import { GAZE_MODEL_KEY, type GazeModelData } from '../shared/faceSignals';
import type { Analysis, MemoryRecord, ReactionProposal, Rect } from '../shared/types';

const BACKEND = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';
const MEMORY_SIZE = 3;
const ANALYSE_TIMEOUT_MS = 20_000;
const REACT_TIMEOUT_MS = 15_000;
const CAPTION_TIMEOUT_MS = 8_000;
const SWIPE_TIMEOUT_MS = 3_000;
const OBSERVE_TIMEOUT_MS = 15_000; // stale quickly: words on screen change every few seconds
const MIN_CAPTURE_GAP_MS = 600; // Chrome allows ~2 captureVisibleTab calls per second
const LOG = '[ScrollMate:bg]';

let memory: MemoryRecord[] = [];
// Latest belief-based record per Short; committed to memory when the Short ends (never half-finished).
const pendingRecords = new Map<string, MemoryRecord>();
const analysisCache = new Map<string, Analysis>(); // per browser session, by video ID
const inflight = new Map<string, AbortController>();
let activeVideoId: string | null = null;
let lastCaptureAt = 0;
let captureBlockedUntil = 0;

const ready = chrome.storage.session
  .get('memory')
  .then((r) => {
    if (Array.isArray(r.memory)) memory = r.memory as MemoryRecord[];
  })
  .catch(() => undefined);

function saveMemory() {
  chrome.storage.session.set({ memory }).catch(() => undefined);
}

function remember(rec: MemoryRecord) {
  memory = memory.filter((m) => m.videoId !== rec.videoId);
  memory.push(rec);
  while (memory.length > MEMORY_SIZE) memory.shift(); // a fourth Short evicts the oldest
  saveMemory();
  console.log(LOG, 'memory', memory.map((m) => `${m.videoId}:${m.topic}${m.skipped ? '(skipped)' : ''}`));
}

function toRecord(a: Analysis, secondsWatched: number): MemoryRecord {
  return {
    videoId: a.videoId,
    topic: a.topic,
    summary: a.summary,
    events: a.events.slice(0, 4),
    outcome: a.outcome,
    mood: a.mood,
    themes: a.themes,
    secondsWatched: Math.round(secondsWatched),
    skipped: false,
  };
}

async function postJson<T>(path: string, body: unknown, timeoutMs: number, key?: string): Promise<T> {
  const ctrl = new AbortController();
  if (key) {
    inflight.get(key)?.abort();
    inflight.set(key, ctrl);
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BACKEND}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    if (key && inflight.get(key) === ctrl) inflight.delete(key);
  }
}

// ---------- live feed telemetry (batched, fire-and-forget) ----------
let telemetry: TelemetryEvent[] = [];
let telemetryTimer: ReturnType<typeof setTimeout> | null = null;

function queueTelemetry(ev: TelemetryEvent) {
  telemetry.push({ ...ev, sentAt: Date.now() }); // wall clock; `at` stays the video time
  if (telemetry.length > 100) telemetry = telemetry.slice(-100);
  if (!telemetryTimer) telemetryTimer = setTimeout(flushTelemetry, 300);
}

function flushTelemetry() {
  telemetryTimer = null;
  const batch = telemetry;
  telemetry = [];
  if (!batch.length) return;
  fetch(`${BACKEND}/scrollmate/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  }).catch(() => undefined); // backend down: the feed is optional
}

function abortAll() {
  for (const c of inflight.values()) c.abort();
  inflight.clear();
}

async function react(currentVideoId: string, personality: string, frequency: string): Promise<ReactionProposal[]> {
  const res = await postJson<ReactResponse>(
    '/scrollmate/react',
    { memory, personality, frequency, currentVideoId },
    REACT_TIMEOUT_MS,
    `react:${currentVideoId}`,
  );
  return Array.isArray(res.reactions) ? res.reactions : [];
}

// ---------- frame capture ----------

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function cropAndScale(dataUrl: string, rect: Rect, viewport: { w: number; h: number }): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const k = bmp.width / viewport.w; // device pixel ratio as captured
  const sx = Math.max(0, Math.round(rect.x * k));
  const sy = Math.max(0, Math.round(rect.y * k));
  const sw = Math.min(bmp.width - sx, Math.round(rect.width * k));
  const sh = Math.min(bmp.height - sy, Math.round(rect.height * k));
  if (sw < 16 || sh < 16) throw new Error('video rect too small');
  const scale = Math.min(1, 512 / Math.max(sw, sh));
  const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
  return toBase64(await out.arrayBuffer());
}

/**
 * Stitch up to 3 frames into one left-to-right strip. Providers such as Groq bill a flat
 * ~1.8k tokens per image regardless of size, so one strip costs a third of three frames.
 */
async function stitchFrames(frames: string[]): Promise<string> {
  const H = 384;
  const GAP = 6;
  const bmps = await Promise.all(
    frames.map(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    }),
  );
  const widths = bmps.map((b) => Math.round((b.width * H) / b.height));
  const canvas = new OffscreenCanvas(widths.reduce((a, w) => a + w, 0) + GAP * (bmps.length - 1), H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, H);
  let x = 0;
  bmps.forEach((b, i) => {
    ctx.drawImage(b, x, 0, widths[i], H);
    x += widths[i] + GAP;
    b.close();
  });
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
  return toBase64(await out.arrayBuffer());
}

async function capture(windowId: number, rect: Rect, viewport: { w: number; h: number }): Promise<CaptureResponse> {
  const now = Date.now();
  if (now < captureBlockedUntil) return { ok: false, error: 'capture recently refused; using fallback' };
  const wait = lastCaptureAt + MIN_CAPTURE_GAP_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCaptureAt = Date.now();
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
    return { ok: true, data: await cropAndScale(dataUrl, rect, viewport) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Usually "activeTab permission not in effect": avoid flickering the character for nothing.
    if (/permission|activeTab|all_urls/i.test(msg)) captureBlockedUntil = Date.now() + 30_000;
    console.warn(LOG, 'captureVisibleTab failed:', msg);
    return { ok: false, error: msg };
  }
}

// ---------- message router ----------

async function handle(msg: BgRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await ready;
  switch (msg.type) {
    case 'CAPTURE_FRAME': {
      const windowId = sender.tab?.windowId;
      if (windowId === undefined) return { ok: false, error: 'no tab' } satisfies CaptureResponse;
      return capture(windowId, msg.rect, msg.viewport);
    }
    case 'SHORT_STARTED':
      activeVideoId = msg.videoId;
      for (const [id, rec] of pendingRecords) {
        if (id !== msg.videoId) {
          remember(rec); // the previous Short ended: commit what we understood of it
          pendingRecords.delete(id);
        }
      }
      return { ok: true };
    case 'SWIPE': {
      try {
        const res = await postJson<SwipeResponse>(
          '/scrollmate/swipe',
          { videoId: msg.videoId, title: msg.title, channel: msg.channel, memory, personality: msg.personality, frequency: msg.frequency },
          SWIPE_TIMEOUT_MS,
          `swipe:${msg.videoId}`,
        );
        return res;
      } catch (e) {
        return { momentType: 'other', emotion: null, level: 0, lookFor: '', error: String(e) } satisfies SwipeResponse;
      }
    }
    case 'OBSERVE': {
      try {
        const res = await postJson<ObserveResponse & { record?: MemoryRecord }>(
          '/scrollmate/observe',
          {
            videoId: msg.videoId,
            frame: msg.frame,
            frameTime: msg.frameTime,
            duration: msg.duration,
            frameIndex: msg.frameIndex,
            maxFrames: msg.maxFrames,
            title: msg.title,
            channel: msg.channel,
            captions: msg.captions.slice(-10),
            memory,
            personality: msg.personality,
            frequency: msg.frequency,
            viewerFeeling: msg.viewerFeeling ?? null,
          },
          OBSERVE_TIMEOUT_MS,
          `observe:${msg.videoId}`,
        );
        if (res.record && res.record.topic !== 'unknown') {
          const rec = { ...res.record, secondsWatched: Math.round(msg.frameTime), skipped: false };
          if (res.final) {
            remember(rec);
            pendingRecords.delete(msg.videoId);
          } else pendingRecords.set(msg.videoId, rec);
        }
        const { record: _r, ...rest } = res;
        return rest;
      } catch (e) {
        return { emotion: null, level: 0, change: 'none', reactions: [], nextCaptureAt: null, final: false, error: String(e) } satisfies ObserveResponse;
      }
    }
    case 'SHORT_SKIPPED':
      remember({
        videoId: msg.videoId,
        topic: 'unknown',
        summary: msg.title ? `Skipped: "${msg.title}"` : 'A Short the user skipped quickly',
        events: [],
        outcome: null,
        mood: 'unclear',
        themes: [],
        secondsWatched: Math.round(msg.secondsWatched),
        skipped: true,
      });
      return { ok: true };
    case 'ANALYSE_AND_REACT': {
      const out: AnalyseReactResponse = { analysis: null, reactions: [] };
      try {
        let analysis = analysisCache.get(msg.videoId) ?? null;
        if (!analysis) {
          let frames = msg.frames.slice(0, 3);
          let composite = false;
          if (frames.length > 1) {
            try {
              frames = [await stitchFrames(frames)];
              composite = true;
            } catch (e) {
              console.warn(LOG, 'stitch failed, sending first frame only', e);
              frames = frames.slice(0, 1);
            }
          }
          analysis = await postJson<Analysis>(
            '/scrollmate/analyse',
            {
              videoId: msg.videoId,
              frames,
              composite,
              frameTimes: composite ? msg.frameTimes.slice(0, 3) : msg.frameTimes.slice(0, frames.length),
              title: msg.title,
              channel: msg.channel,
              captions: msg.captions.slice(0, 20),
            },
            ANALYSE_TIMEOUT_MS,
            `analyse:${msg.videoId}`,
          );
          analysisCache.set(msg.videoId, analysis);
        }
        out.analysis = analysis;
        remember(toRecord(analysis, msg.secondsWatched));
        // Thin understanding: prefer silence to a wrong reaction.
        if (analysis.confidence < 0.35 || analysis.understandingLevel === 'none') return out;
        out.reactions = await react(msg.videoId, msg.personality, msg.frequency);
        if (activeVideoId !== msg.videoId) console.log(LOG, 'user left', msg.videoId, '- planner will drop non-callbacks');
      } catch (e) {
        out.error = e instanceof Error ? e.message : String(e);
        console.warn(LOG, 'analyse/react failed:', out.error);
      }
      return out;
    }
    case 'REMEMBER':
      remember(msg.record);
      return { ok: true };
    case 'COMMENT_REACT': {
      const empty: CommentReactResponse = { requestId: msg.requestId, targetCommentId: msg.commentId, emotion: null, reactions: [] };
      try {
        // Reuse this video's existing understanding. No extra vision call and no other tab's context.
        const record = pendingRecords.get(msg.videoId) ?? memory.find((m) => m.videoId === msg.videoId);
        return await postJson<CommentReactResponse>(
          '/scrollmate/comment',
          { requestId: msg.requestId, videoId: msg.videoId, commentId: msg.commentId, text: msg.text,
            title: msg.title, videoSummary: record?.summary.slice(0, 600) ?? '',
            previousComments: (msg.previousComments ?? []).slice(-5),
            personality: msg.personality, frequency: msg.frequency },
          8_000, `comment:${sender.tab?.id ?? 'stage'}:${msg.requestId}`,
        );
      } catch (e) {
        return { ...empty, error: e instanceof Error ? e.message : String(e) };
      }
    }
    case 'FEELING_LINE': {
      try {
        // Reuse what we already know about this Short; the backend gets the label, never an image.
        const record = pendingRecords.get(msg.videoId) ?? memory.find((m) => m.videoId === msg.videoId);
        return await postJson<FeelingLineResponse>(
          '/scrollmate/feeling',
          { videoId: msg.videoId, expression: msg.expression, title: msg.title.slice(0, 300),
            videoSummary: record?.summary.slice(0, 600) ?? '', personality: msg.personality },
          5_000, `feeling:${sender.tab?.id ?? 'stage'}`,
        );
      } catch (e) {
        return { line: null, emotion: null, error: e instanceof Error ? e.message : String(e) } satisfies FeelingLineResponse;
      }
    }
    case 'CANCEL_COMMENT': {
      const key = `comment:${sender.tab?.id ?? 'stage'}:${msg.requestId}`;
      inflight.get(key)?.abort();
      inflight.delete(key);
      return { ok: true };
    }
    case 'CAPTION_REACT': {
      try {
        const res = await postJson<CaptionReactResponse>(
          '/scrollmate/caption',
          {
            videoId: msg.videoId,
            lines: msg.lines.slice(-12),
            title: msg.title,
            channel: msg.channel,
            currentTime: msg.currentTime,
            memory,
            personality: msg.personality,
            frequency: msg.frequency,
            viewerFeeling: msg.viewerFeeling ?? null,
          },
          CAPTION_TIMEOUT_MS,
          `caption:${msg.videoId}`,
        );
        return { emotion: res.emotion ?? null, reactions: Array.isArray(res.reactions) ? res.reactions : [] } satisfies CaptionReactResponse;
      } catch (e) {
        return { emotion: null, reactions: [], error: e instanceof Error ? e.message : String(e) } satisfies CaptionReactResponse;
      }
    }
    case 'REACT_ONLY': {
      try {
        return { reactions: await react(msg.currentVideoId, msg.personality, msg.frequency) } satisfies ReactResponse;
      } catch (e) {
        return { reactions: [], error: e instanceof Error ? e.message : String(e) } satisfies ReactResponse;
      }
    }
    case 'GET_MEMORY':
      return { memory };
    case 'CLEAR_MEMORY':
      abortAll();
      // also forget today's journal on the backend (earlier Shorts, the child's feelings, Mochi's lines)
      postJson('/scrollmate/journal/clear', {}, 3_000).catch(() => undefined);
      memory = [];
      pendingRecords.clear();
      analysisCache.clear();
      saveMemory();
      return { ok: true };
    case 'CANCEL_ALL':
      abortAll();
      return { ok: true };
    case 'TELEMETRY':
      queueTelemetry(msg.event);
      return { ok: true };
    case 'OPEN_STAGE':
      await chrome.tabs.create({ url: chrome.runtime.getURL('stage.html') });
      return { ok: true };
  }
}

// ---------- webcam (opt-in): hidden offscreen page runs MediaPipe; we relay its tiny signals ----------
let camTabId: number | null = null;
let camWanted = false;
let gazeWanted = false; // eye tracking on (the content script re-sends this on every camera start)

async function gazeConfig(): Promise<GazeConfig> {
  const got = await chrome.storage.local.get(GAZE_MODEL_KEY).catch(() => ({}) as Record<string, unknown>);
  return { enabled: gazeWanted, model: (got[GAZE_MODEL_KEY] as GazeModelData | undefined) ?? null };
}

async function pushGazeConfig() {
  const config = await gazeConfig();
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'GAZE_CONFIG', config }).catch(() => undefined);
}

async function hasOffscreen(): Promise<boolean> {
  try {
    return await chrome.offscreen.hasDocument();
  } catch {
    return false;
  }
}

async function ensureCameraPage() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'camera-offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Opt-in, on-device face expression signals so ScrollMate can react to the viewer.',
  });
}

async function closeCameraPage() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => undefined);
}

function toCamTab(msg: TabMessage) {
  if (camTabId !== null) chrome.tabs.sendMessage(camTabId, msg).catch(() => undefined);
}

async function handleCamera(msg: BgRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'CAMERA_START':
      camTabId = sender.tab?.id ?? camTabId;
      camWanted = true;
      gazeWanted = !!msg.gaze;
      if (await hasOffscreen()) await pushGazeConfig();
      else await ensureCameraPage(); // it asks for the gaze config when it starts
      return { ok: true };
    case 'GAZE_ENABLE':
      gazeWanted = msg.enabled;
      await pushGazeConfig();
      return { ok: true };
    case 'GAZE_GET_CONFIG':
      return gazeConfig();
    case 'GAZE':
      toCamTab(msg);
      return { ok: true };
    case 'GAZE_MODEL_SAVED':
      await pushGazeConfig();
      toCamTab({ type: 'GAZE_CALIBRATED' });
      return { ok: true };
    case 'OPEN_GAZE_CALIBRATION':
      camTabId = sender.tab?.id ?? camTabId;
      await chrome.tabs.create({ url: chrome.runtime.getURL('gaze-calibrate.html') });
      return { ok: true };
    case 'CAMERA_STOP':
      camWanted = false;
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'CAMERA_STOP' }).catch(() => undefined);
      await closeCameraPage();
      toCamTab({ type: 'CAMERA_STATUS', state: 'off' });
      return { ok: true };
    case 'USER_SIGNAL':
      toCamTab(msg);
      return { ok: true };
    case 'CAMERA_STATUS':
      if (msg.state === 'needs_permission') {
        await closeCameraPage();
        await chrome.tabs.create({ url: chrome.runtime.getURL('camera-setup.html') });
      }
      toCamTab(msg);
      return { ok: true };
    case 'CAMERA_PERMISSION_GRANTED':
      if (camWanted) {
        await closeCameraPage();
        await ensureCameraPage();
      }
      return { ok: true };
  }
  return undefined;
}

const CAMERA_TYPES = new Set([
  'CAMERA_START', 'CAMERA_STOP', 'USER_SIGNAL', 'CAMERA_STATUS', 'CAMERA_PERMISSION_GRANTED',
  'GAZE_ENABLE', 'GAZE_GET_CONFIG', 'GAZE', 'GAZE_MODEL_SAVED', 'OPEN_GAZE_CALIBRATION',
]);

chrome.runtime.onMessage.addListener((msg: BgRequest & { target?: string }, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // addressed to the camera page, not us
  if (CAMERA_TYPES.has(msg?.type)) {
    handleCamera(msg, sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async response
});

// Clicking the toolbar icon grants activeTab, which captureVisibleTab needs.
chrome.action.onClicked.addListener((tab) => {
  captureBlockedUntil = 0;
  if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: 'ACTIVE_TAB_GRANTED' }).catch(() => undefined);
});
