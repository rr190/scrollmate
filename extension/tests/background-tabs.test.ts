/** Two YouTube tabs at once: one tab's cancel or reset never aborts the other tab's requests. */
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

function fixture() {
  let listener!: (message: any, sender: any, reply: (result: any) => void) => void;
  let toolbarClick!: (tab: { id: number }) => Promise<void>;
  const aborted: string[] = [];
  const waiting: { id: string; resolve: () => void }[] = [];
  const pending = { get: (id: string) => () => waiting.filter((w) => w.id === id).forEach((w) => w.resolve()), values: () => waiting.map((w) => w.resolve) };
  const chrome = {
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}`, onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
      sendMessage: async () => ({ ok: true }) },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    offscreen: { Reason: { USER_MEDIA: 'USER_MEDIA' }, hasDocument: async () => false, createDocument: async () => {}, closeDocument: async () => {} },
    tabs: { sendMessage: async () => {}, create: async () => {}, onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    action: { onClicked: { addListener(fn: typeof toolbarClick) { toolbarClick = fn; } },
      setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  };
  // Model requests hang until answered or aborted, like a slow provider.
  const fetch = (url: string, init: { body: string; signal: AbortSignal }) => new Promise((resolve, reject) => {
    if (url.endsWith('/scrollmate/events') || url.endsWith('/journal/clear')) { resolve({ ok: true, json: async () => ({}) }); return; }
    const body = JSON.parse(init.body);
    const id = `${url.split('/').pop()}:${body.requestId ?? body.videoId}`;
    init.signal.addEventListener('abort', () => { aborted.push(id); reject(new Error('aborted')); });
    waiting.push({ id, resolve: () => resolve({ ok: true, json: async () => ({ requestId: body.requestId, targetCommentId: body.commentId, reactions: [] }) }) });
  });
  runInNewContext(source, { chrome, URL, console: { log() {}, warn() {} }, setTimeout, clearTimeout, AbortController, fetch,
    createImageBitmap: undefined, OffscreenCanvas: undefined, atob, btoa });
  const request = (message: any, tabId: number) => new Promise<any>((resolve) => listener(message, { tab: { id: tabId, windowId: 1 } }, resolve));
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { request, aborted, pending, settle, toolbar: () => toolbarClick({ id: 1 }) };
}

const observe = (videoId: string) => ({ type: 'OBSERVE', videoId, frame: '', frameTime: 1, duration: 20, frameIndex: 1, maxFrames: 12,
  title: 't', channel: 'c', captions: [], personality: 'witty', frequency: 'chatty' });
const comment = (requestId: string, videoId: string) => ({ type: 'COMMENT_REACT', requestId, videoId, commentId: 'c1', text: 'hi',
  title: 't', previousComments: [], personality: 'witty', frequency: 'chatty' });

test("one tab's power-off and clear-memory do not abort another tab's requests", async () => {
  const f = fixture();
  const a = f.request(observe('reelAAAA'), 1), b = f.request(observe('reelBBBB'), 2);
  const bc = f.request(comment('req-b', 'reelBBBB'), 2);
  await f.settle();
  await f.request({ type: 'CANCEL_ALL' }, 1);
  assert.deepEqual(f.aborted.sort(), ['observe:reelAAAA']);
  assert.equal((await a).error?.includes('aborted'), true, 'the tab that switched off gets its own request cancelled');
  await f.request({ type: 'CLEAR_MEMORY' }, 1);
  assert.deepEqual(f.aborted, ['observe:reelAAAA'], "the other tab's frame and comment are still running");
  f.pending.get('comment:req-b')(); f.pending.get('observe:reelBBBB')();
  assert.equal((await bc).error, undefined); assert.equal((await b).error, undefined);
});

test('two tabs on the same Short keep separate frame requests', async () => {
  const f = fixture();
  const one = f.request(observe('sameReel'), 1), two = f.request(observe('sameReel'), 2);
  await f.settle();
  assert.deepEqual(f.aborted, [], 'a second tab watching the same Short must not abort the first tab\'s frame');
  for (const resolve of f.pending.values()) resolve();
  await one; await two;
});

test('the toolbar switch still stops every tab at once', async () => {
  const f = fixture();
  const a = f.request(observe('reelAAAA'), 1), b = f.request(comment('req-b', 'reelBBBB'), 2);
  await f.settle();
  await f.toolbar();
  assert.equal(f.aborted.length, 2);
  await a; await b;
});

test('cancelling a comment only aborts that tab\'s request', async () => {
  const f = fixture();
  const a = f.request(comment('same-id', 'reelAAAA'), 1), b = f.request(comment('same-id', 'reelBBBB'), 2);
  await f.settle();
  await f.request({ type: 'CANCEL_COMMENT', requestId: 'same-id' }, 2);
  assert.equal(f.aborted.length, 1);
  f.pending.get('comment:same-id')();
  await a; await b;
});
