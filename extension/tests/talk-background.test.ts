import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

let source = '';
before(async () => {
  const result = await build({ entryPoints: ['src/background/index.ts'], bundle: true, write: false, format: 'iife',
    define: { 'import.meta.env.VITE_BACKEND_URL': '"http://test-backend"' } });
  source = result.outputFiles[0].text;
});

function fixture(createWait?: Promise<void>) {
  let listener: (message: any, sender: any, reply: (result: any) => void) => void;
  const media: any[] = [], sent: { tabId: number; message: any }[] = [], opened: any[] = [];
  let exists = false, creates = 0, closes = 0;
  let toolbarClick!: (tab: { id: number }) => Promise<void>;
  const url = (path: string) => `chrome-extension://test/${path}`;
  const chrome = {
    runtime: { getURL: url, onMessage: { addListener: (value: typeof listener) => { listener = value; } },
      sendMessage: async (message: any) => { media.push(message); return message.type === 'MEDIA_PING' ? { ready: true } : { ok: true }; } },
    storage: { session: { get: async () => ({ memory: [{ videoId: 'reel-1', summary: 'A cake has purple frosting.' }] }), set: async () => {} },
      local: { get: async () => ({}), set: async () => {} } },
    offscreen: { Reason: { USER_MEDIA: 'USER_MEDIA' }, hasDocument: async () => exists,
      createDocument: async () => { creates++; await createWait; exists = true; }, closeDocument: async () => { closes++; exists = false; } },
    tabs: { sendMessage: async (tabId: number, message: any) => { sent.push({ tabId, message }); },
      create: async (value: any) => { opened.push(value); }, onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    action: { onClicked: { addListener(listener: typeof toolbarClick) { toolbarClick = listener; } },
      setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  };
  runInNewContext(source, { chrome, URL, console: { log() {}, warn() {} }, setTimeout, clearTimeout, AbortController,
    fetch: () => { throw new Error('No HTTP audio uploads should occur'); } });
  const request = (message: any, sender: number | object = 7) => new Promise<any>((resolve) => listener(message,
    typeof sender === 'number' ? { tab: { id: sender } } : sender, resolve));
  const context = (id = 'session-1') => ({ requestId: id, videoId: 'reel-1', title: 'Cake', personality: 'chill', selectedComment: '' });
  const start = (id = 'session-1', tabId = 7) => request({ type: 'TALK_START', context: context(id) }, tabId);
  const event = (value: any, id = 'session-1', sender: any = { url: url('camera-offscreen.html') }) =>
    request({ type: 'TALK_LIVE_EVENT', requestId: id, event: value }, sender);
  return { request, start, event, context, media, sent, opened, toolbarOff: () => toolbarClick({ id: 7 }),
    get creates() { return creates; }, get closes() { return closes; } };
}

test('one shared document keeps camera and continuous microphone lifecycles independent', async () => {
  const f = fixture(); await f.request({ type: 'CAMERA_START', gaze: true }); await f.start();
  assert.equal(f.creates, 1);
  const start = f.media.find((message) => message.type === 'TALK_START');
  assert.equal(start.url, 'ws://test-backend/scrollmate/talk/live');
  assert.equal(start.context.videoSummary, 'A cake has purple frosting.');
  await f.request({ type: 'CAMERA_STOP' }); assert.equal(f.closes, 0);
  await f.request({ type: 'TALK_CANCEL', requestId: 'session-1' }); assert.equal(f.closes, 1);
});

test('trusted media captions and speaking states stay attached to one session', async () => {
  const f = fixture(); await f.start();
  for (const event of [{ type: 'status', state: 'speaking' }, { type: 'caption', role: 'assistant', text: 'Hello' },
    { type: 'interrupted' }, { type: 'status', state: 'listening' }]) await f.event(event);
  assert.equal(f.sent.filter(({ message }) => message.type === 'TALK_EVENT').length, 4);
  assert(f.sent.every(({ tabId }) => tabId === 7));
  await f.request({ type: 'TALK_CANCEL', requestId: 'session-1' });
});

test('foreign tabs, forged media messages and stale session events are ignored', async () => {
  const f = fixture(); await f.start();
  await f.request({ type: 'TALK_CANCEL', requestId: 'session-1' }, 99);
  await f.event({ type: 'status', state: 'speaking' }, 'session-1', 7);
  await f.event({ type: 'status', state: 'speaking' }, 'old-session');
  await f.event({ type: 'status', state: 'speaking' }, 'session-1', { url: 'https://example.com' });
  assert.equal(f.sent.length, 0); assert.equal(f.closes, 0);
  await f.request({ type: 'TALK_CANCEL', requestId: 'session-1' });
});

test('reel context updates without restarting capture or leaking old reel notes', async () => {
  const f = fixture(); await f.start();
  await f.request({ type: 'TALK_CONTEXT', context: { ...f.context(), videoId: 'reel-2', title: 'Dog' } });
  const update = f.media.at(-1);
  assert.equal(update.type, 'TALK_CONTEXT'); assert.equal(update.context.videoId, 'reel-2');
  assert.equal(update.context.videoSummary, ''); assert.equal(f.creates, 1);
  const count = f.media.length;
  await f.request({ type: 'TALK_CONTEXT', context: f.context() }, 99);
  assert.equal(f.media.length, count);
  await f.request({ type: 'TALK_CANCEL', requestId: 'session-1' });
});

test('new sessions stop the previous session and notify its owning tab', async () => {
  const f = fixture(); await f.start(); await f.start('session-2', 8);
  assert(f.sent.some(({ tabId, message }) => tabId === 7 && message.event?.state === 'error'));
  assert(f.media.some((message) => message.type === 'TALK_CANCEL' && message.requestId === 'session-1'));
  await f.request({ type: 'TALK_CANCEL', requestId: 'session-2' }, 8);
});

test('microphone permission failures open setup and release the active session', async () => {
  const f = fixture(); await f.start();
  await f.event({ type: 'status', state: 'needs_permission', error: 'Allow microphone.' });
  assert(f.opened.some((page) => page.url.endsWith('camera-setup.html?microphone=1')));
  assert.equal(f.closes, 1);
});

test('the toolbar off switch cancels live voice before closing the shared media document', async () => {
  const f = fixture(); await f.request({ type: 'CAMERA_START', gaze: true }); await f.start();
  await f.toolbarOff();
  assert(f.media.some((message) => message.type === 'TALK_CANCEL' && message.requestId === 'session-1'));
  assert.equal(f.closes, 1);
  const before = f.sent.length;
  await f.event({ type: 'caption', role: 'assistant', text: 'A late reply' });
  assert.equal(f.sent.length, before, 'late voice events are ignored after switching off');
});

test('cancellation while the shared document is starting cannot leak a late microphone page', async () => {
  let resolve!: () => void;
  const f = fixture(new Promise<void>((done) => { resolve = done; }));
  const starting = f.start(); await new Promise(setImmediate);
  await f.request({ type: 'TALK_CANCEL', requestId: 'session-1' });
  resolve(); await starting;
  assert.equal(f.closes, 1); assert(!f.media.some((message) => message.type === 'TALK_START'));
});
