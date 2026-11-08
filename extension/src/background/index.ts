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
  TalkContext,
} from '../shared/messages';
import { badgeFor, HIDDEN_KEY } from '../shared/power';
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
    if (!res.ok) {
      if (path === '/scrollmate/talk') {
        const detail = await res.json().catch(() => null);
        throw new Error(typeof detail?.detail === 'string' ? detail.detail : `Talk unavailable (HTTP ${res.status}).`);
      }
      throw new Error(`${path} -> HTTP ${res.status}`);
    }
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

/** In-flight keys start with the tab that asked, so one tab's cancel never aborts another tab's requests. */
type TabKey = number | 'ext';
const tabKey = (sender: chrome.runtime.MessageSender): TabKey => sender.tab?.id ?? 'ext';

/** Abort one tab's requests, or every request when no tab is given (the toolbar power switch). */
function abortAll(tab?: TabKey) {
  for (const [key, c] of inflight) {
    if (tab !== undefined && !key.startsWith(`${tab}|`)) continue;
    c.abort();
    inflight.delete(key);
  }
}

async function react(tab: TabKey, currentVideoId: string, personality: string, frequency: string): Promise<ReactionProposal[]> {
  const res = await postJson<ReactResponse>(
    '/scrollmate/react',
    { memory, personality, frequency, currentVideoId },
    REACT_TIMEOUT_MS,
    `${tab}|react:${currentVideoId}`,
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
    // That is the normal state until the toolbar icon is clicked (frames come from the video canvas instead),
    // so it is logged as information, not as a warning in the extension's Errors list.
    if (/permission|activeTab|all_urls/i.test(msg)) {
      captureBlockedUntil = Date.now() + 30_000;
      console.info(LOG, 'screen capture not allowed in this tab yet (click the toolbar icon); using the video canvas');
    } else console.warn(LOG, 'captureVisibleTab failed:', msg);
    return { ok: false, error: msg };
  }
}

// ---------- message router ----------

async function handle(msg: BgRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  await ready;
  const tab = tabKey(sender);
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
          `${tab}|swipe:${msg.videoId}`,
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
          `${tab}|observe:${msg.videoId}`,
        );
        if (res.record && res.record.topic !== 'unknown') {
          const rec = { ...res.record, secondsWatched: Math.round(msg.frameTime), skipped: false };
          if (res.final) {
            remember(rec);
            pendingRecords.delete(msg.videoId);
          } else pendingRecords.set(msg.videoId, rec);
          if (talkTurn?.context.videoId === msg.videoId) void sendTalkContext(talkTurn).catch(() => undefined);
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
            `${tab}|analyse:${msg.videoId}`,
          );
          analysisCache.set(msg.videoId, analysis);
        }
        out.analysis = analysis;
        remember(toRecord(analysis, msg.secondsWatched));
        // Thin understanding: prefer silence to a wrong reaction.
        if (analysis.confidence < 0.35 || analysis.understandingLevel === 'none') return out;
        out.reactions = await react(tab, msg.videoId, msg.personality, msg.frequency);
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
          8_000, `${tab}|comment:${msg.requestId}`,
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
          5_000, `${tab}|feeling`,
        );
      } catch (e) {
        return { line: null, emotion: null, error: e instanceof Error ? e.message : String(e) } satisfies FeelingLineResponse;
      }
    }
    case 'CANCEL_COMMENT': {
      const key = `${tab}|comment:${msg.requestId}`;
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
          `${tab}|caption:${msg.videoId}`,
        );
        return { emotion: res.emotion ?? null, reactions: Array.isArray(res.reactions) ? res.reactions : [] } satisfies CaptionReactResponse;
      } catch (e) {
        return { emotion: null, reactions: [], error: e instanceof Error ? e.message : String(e) } satisfies CaptionReactResponse;
      }
    }
    case 'REACT_ONLY': {
      try {
        return { reactions: await react(tab, msg.currentVideoId, msg.personality, msg.frequency) } satisfies ReactResponse;
      } catch (e) {
        return { reactions: [], error: e instanceof Error ? e.message : String(e) } satisfies ReactResponse;
      }
    }
    case 'GET_MEMORY':
      return { memory };
    case 'CLEAR_MEMORY':
      abortAll(tab); // memory is shared, but another tab's requests are its own
      // also forget today's journal on the backend (earlier Shorts, the child's feelings, Mochi's lines)
      postJson('/scrollmate/journal/clear', {}, 3_000).catch(() => undefined);
      memory = [];
      pendingRecords.clear();
      analysisCache.clear();
      saveMemory();
      return { ok: true };
    case 'CANCEL_ALL':
      abortAll(tab);
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
let micWanted = false;
let creatingMedia: Promise<void> | null = null;
let talkTurn: { tabId: number; context: TalkContext } | null = null;

async function hasOffscreen(): Promise<boolean> {
  try {
    return await chrome.offscreen.hasDocument();
  } catch {
    return false;
  }
}

async function ensureCameraPage() {
  if (creatingMedia) return creatingMedia;
  if (await hasOffscreen()) return;
  if (creatingMedia) return creatingMedia;
  creatingMedia = chrome.offscreen.createDocument({
    url: 'camera-offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Camera expressions and microphone conversations explicitly started on the buddy.',
  });
  try { await creatingMedia; } finally { creatingMedia = null; }
}

async function closeCameraPage() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => undefined);
}

function toCamTab(msg: TabMessage) {
  if (camTabId !== null) chrome.tabs.sendMessage(camTabId, msg).catch(() => undefined);
}

const sendMedia = (type: string, requestId?: string) => chrome.runtime.sendMessage({ target: 'offscreen', type, requestId });
async function releaseMedia() { if (!camWanted && !micWanted) await closeCameraPage(); }

async function cancelTalk(turn = talkTurn) {
  if (!turn || talkTurn !== turn) return;
  talkTurn = null;
  micWanted = false;
  await sendMedia('TALK_CANCEL', turn.context.requestId).catch(() => undefined);
  await releaseMedia();
}

async function sendTalkContext(turn: NonNullable<typeof talkTurn>, start = false) {
  const record = pendingRecords.get(turn.context.videoId) ?? memory.find((item) => item.videoId === turn.context.videoId);
  const url = new URL('/scrollmate/talk/live', BACKEND);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  await chrome.runtime.sendMessage({ target: 'offscreen', type: start ? 'TALK_START' : 'TALK_CONTEXT', url: url.href,
    context: { ...turn.context, videoSummary: record?.summary.slice(0, 600) ?? '' } });
}

async function handleTalk(msg: BgRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (msg.type === 'TALK_START') {
    if (sender.tab?.id === undefined) return { ok: false, error: 'Open Talk on a YouTube Shorts tab.' };
    const previous = talkTurn;
    if (previous) {
      await cancelTalk(previous);
      void chrome.tabs.sendMessage(previous.tabId, { type: 'TALK_EVENT', requestId: previous.context.requestId,
        event: { type: 'status', state: 'error', error: 'A new voice session was started.' } }).catch(() => undefined);
    }
    const turn = talkTurn = { tabId: sender.tab.id, context: msg.context };
    micWanted = true;
    try {
      await ensureCameraPage();
      let mediaReady = false;
      for (let attempt = 0; attempt < 40 && talkTurn === turn; attempt++) {
        mediaReady = !!(await sendMedia('MEDIA_PING').catch(() => null))?.ready;
        if (mediaReady) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (talkTurn !== turn) { await releaseMedia(); return { ok: false, error: 'Voice session cancelled.' }; }
      if (!mediaReady) throw new Error('Microphone page did not start. Reload the extension and this tab.');
      await sendTalkContext(turn, true);
      return { ok: true };
    } catch (error) {
      await cancelTalk(turn);
      return { ok: false, error: error instanceof Error ? error.message : 'Microphone unavailable.' };
    }
  }
  if (msg.type === 'TALK_CONTEXT') {
    if (talkTurn && sender.tab?.id === talkTurn.tabId && msg.context.requestId === talkTurn.context.requestId) {
      talkTurn.context = msg.context;
      await sendTalkContext(talkTurn);
    }
    return { ok: true };
  }
  if (msg.type === 'TALK_CANCEL') {
    if (talkTurn && sender.tab?.id === talkTurn.tabId && (!msg.requestId || msg.requestId === talkTurn.context.requestId)) await cancelTalk();
    return { ok: true };
  }
  if (msg.type === 'TALK_MIC_PERMISSION_GRANTED') return { ok: true };
  const turn = talkTurn;
  // Only our media document can relay speech events; tab scripts cannot impersonate it.
  if (msg.type !== 'TALK_LIVE_EVENT' || sender.tab || sender.url !== chrome.runtime.getURL('camera-offscreen.html') ||
      !turn || msg.requestId !== turn.context.requestId) return { ok: true };
  await chrome.tabs.sendMessage(turn.tabId, { type: 'TALK_EVENT', requestId: msg.requestId, event: msg.event }).catch(() => undefined);
  if (msg.event.type === 'status' && ['error', 'needs_permission'].includes(msg.event.state)) {
    await cancelTalk(turn);
    if (msg.event.state === 'needs_permission') await chrome.tabs.create({ url: chrome.runtime.getURL('camera-setup.html?microphone=1') });
  }
  return { ok: true };
}

async function handleCamera(msg: BgRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'MEDIA_READY':
      return { camera: camWanted };
    case 'CAMERA_START':
      camTabId = sender.tab?.id ?? camTabId;
      camWanted = true;
      if (await hasOffscreen()) { await sendMedia('CAMERA_START').catch(() => undefined); }
      else await ensureCameraPage();
      return { ok: true };
    case 'CAMERA_STOP':
      camWanted = false;
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'CAMERA_STOP' }).catch(() => undefined);
      await releaseMedia();
      toCamTab({ type: 'CAMERA_STATUS', state: 'off' });
      return { ok: true };
    case 'USER_SIGNAL':
      toCamTab(msg);
      return { ok: true };
    case 'CAMERA_STATUS':
      if (msg.state === 'needs_permission') {
        if (!micWanted) await closeCameraPage();
        await chrome.tabs.create({ url: chrome.runtime.getURL('camera-setup.html') });
      }
      toCamTab(msg);
      return { ok: true };
    case 'CAMERA_PERMISSION_GRANTED':
      if (camWanted) {
        await ensureCameraPage();
        await sendMedia('CAMERA_START').catch(() => undefined);
      }
      return { ok: true };
  }
  return undefined;
}

const CAMERA_TYPES = new Set([
  'MEDIA_READY',
  'CAMERA_START', 'CAMERA_STOP', 'USER_SIGNAL', 'CAMERA_STATUS', 'CAMERA_PERMISSION_GRANTED',
]);

chrome.tabs.onRemoved.addListener((tabId) => { if (talkTurn?.tabId === tabId) void cancelTalk(); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && talkTurn?.tabId === tabId) void cancelTalk();
});

chrome.runtime.onMessage.addListener((msg: BgRequest & { target?: string }, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false; // addressed to the camera page, not us
  if (msg?.type?.startsWith('TALK_')) {
    handleTalk(msg, sender).then(sendResponse).catch(() => sendResponse({ ok: false, error: 'Talk unavailable. Please try again.' }));
    return true;
  }
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

// ---------- one-click power switch: the toolbar icon turns ScrollMate completely on/off ----------
async function isHidden(): Promise<boolean> {
  const r = await chrome.storage.local.get(HIDDEN_KEY).catch(() => ({}) as Record<string, unknown>);
  return r[HIDDEN_KEY] === true;
}

async function showBadge(hidden: boolean) {
  const b = badgeFor(hidden);
  await chrome.action.setBadgeText({ text: b.text }).catch(() => undefined);
  await chrome.action.setBadgeBackgroundColor({ color: b.color }).catch(() => undefined);
  await chrome.action.setTitle({ title: b.title }).catch(() => undefined);
}

// Clicking the toolbar icon flips the switch. Content scripts follow chrome.storage, so every tab updates at once.
// Turning on also grants activeTab for this tab, which captureVisibleTab needs (as before).
chrome.action.onClicked.addListener(async (tab) => {
  const hidden = !(await isHidden());
  await chrome.storage.local.set({ [HIDDEN_KEY]: hidden });
  await showBadge(hidden);
  if (hidden) {
    // completely off: stop anything still running here too
    abortAll();
    await cancelTalk();
    camWanted = false;
    await closeCameraPage();
  } else {
    captureBlockedUntil = 0;
    if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: 'ACTIVE_TAB_GRANTED' }).catch(() => undefined);
  }
});

// keep the badge right after a browser restart or an extension update
void isHidden().then(showBadge);

// Remove the retired calibration data left by earlier extension versions.
void chrome.storage.local.remove('scrollmate.gazeModel').catch(() => undefined);
