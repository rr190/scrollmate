// Smoke test for the webcam pipeline: runs the BUILT offscreen camera page (dist/) in headless Chrome
// with Chrome's fake camera, and checks MediaPipe loads, analyses frames and emits signals.
// Chrome's fake camera shows a test pattern (no face), so the expected signal is "not in view".
// Needs: npm run build (and npm run setup:mediapipe once).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';

const dist = resolve('dist');
const talk = process.argv.includes('--talk');
if (!existsSync(join(dist, 'camera-offscreen.html'))) throw new Error('Run `npm run build` first.');
if (!existsSync(join(dist, 'mediapipe', 'face_landmarker.task'))) throw new Error('Run `npm run setup:mediapipe` then `npm run build`.');
const chrome = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!chrome) throw new Error('Set CHROME_PATH to a Chrome/Chromium executable.');

// Stub just enough of the extension API for the camera page; collect what it sends.
const STUB = `<script>
window.__msgs = []; window.__mediaListeners = []; window.__streams = [];
window.__voiceStats = { frames: 0, duplexFrames: 0, interrupted: false, opened: 0, closed: 0, partialCaptions: 0 };
const originalMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
navigator.mediaDevices.getUserMedia = async (...args) => { const stream = await originalMedia(...args); window.__streams.push(stream); return stream; };
const dispatch = (type, requestId) => window.__mediaListeners.forEach(listener => listener({ target: 'offscreen', type, requestId,
  url: 'ws://test-backend/scrollmate/talk/live', context: { requestId, videoId: 'test-reel', title: 'Cake', personality: 'chill', selectedComment: '' } }, {}, () => {}));
let talkStarted = false, secondReply = false, ending = false, speaking = false;
if (${talk}) window.WebSocket = class {
  constructor() {
    this.readyState = 0; this.bufferedAmount = 0; this.frames = 0; window.__voiceStats.opened++;
    setTimeout(() => { if (this.readyState !== 3) { this.readyState = 1; this.onopen?.(); } }, 0);
  }
  receive(value) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }); }
  reply(generation, seconds) {
    this.receive({ type: 'response', generation });
    this.receive({ type: 'caption', generation, role: 'assistant', text: 'I am' });
    this.receive({ type: 'caption', generation, role: 'assistant', text: 'I am right here.' });
    const pcm = new Uint8Array(24000 * 2 * seconds), view = new DataView(pcm.buffer);
    for (let i = 0; i < pcm.length / 2; i++) view.setInt16(i * 2, Math.round(Math.sin(i / 10) * 3000), true);
    let binary = ''; for (let i = 0; i < pcm.length; i += 0x8000) binary += String.fromCharCode(...pcm.subarray(i, i + 0x8000));
    this.receive({ type: 'audio', generation, data: btoa(binary), rate: 24000 });
    this.receive({ type: 'complete', generation });
  }
  send(value) {
    if (typeof value === 'string') {
      const message = JSON.parse(value);
      if (message.type === 'start') this.receive({ type: 'ready' });
      if (message.type === 'ping') this.receive({ type: 'pong' });
    } else {
      if (value.byteLength !== 1280) throw new Error('Capture must send 40 ms PCM frames');
      this.frames++; window.__voiceStats.frames++;
      if (speaking) window.__voiceStats.duplexFrames++;
      if (this.frames === 15) this.reply(1, 4);
      if (this.frames === 40) this.receive({ type: 'interrupt', generation: 1 });
      if (this.frames === 50) { secondReply = true; this.reply(2, 1); }
    }
  }
  close() { if (this.readyState !== 3) window.__voiceStats.closed++; this.readyState = 3; }
};
window.chrome = { runtime: {
  getURL: (p) => '/' + p,
  sendMessage: (m) => {
    window.__msgs.push({ ...m, t: performance.now() });
    if (${talk} && m.type === 'CAMERA_STATUS' && m.state === 'on' && !talkStarted) {
      talkStarted = true; setTimeout(() => dispatch('TALK_START', 'capture'), 200);
    }
    if (${talk} && m.type === 'TALK_LIVE_EVENT') {
      const event = m.event;
      if (event.type === 'caption') window.__voiceStats.partialCaptions++;
      if (event.type === 'interrupted') window.__voiceStats.interrupted = true;
      if (event.type === 'status') {
        speaking = event.state === 'speaking';
        if (m.requestId === 'capture' && speaking) dispatch('CAMERA_STOP');
        if (m.requestId === 'capture' && event.state === 'listening' && secondReply && !ending) {
          ending = true; dispatch('TALK_CANCEL', 'capture'); setTimeout(() => dispatch('TALK_START', 'cancel'), 100);
        }
        if (m.requestId === 'cancel' && event.state === 'listening') setTimeout(() => dispatch('TALK_CANCEL', 'cancel'), 100);
      }
    }
    return Promise.resolve(m.type === 'MEDIA_READY' ? { camera: true } : undefined);
  },
  onMessage: { addListener(listener) { window.__mediaListeners.push(listener); } },
} };
setTimeout(() => fetch('/__result', { method: 'POST', body: JSON.stringify({ messages: window.__msgs, voiceStats: window.__voiceStats,
  tracks: window.__streams.flatMap(stream => stream.getTracks().map(track => ({ kind: track.kind, state: track.readyState }))) }) }), 14000);
</script>`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.task': 'application/octet-stream' };

let resolveResult;
const result = new Promise((r) => (resolveResult = r));
const server = createServer((req, res) => {
  if (req.url === '/__result') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.end('ok');
      resolveResult(JSON.parse(body));
    });
    return;
  }
  const path = normalize(join(dist, decodeURIComponent(req.url.split('?')[0])));
  if (!path.startsWith(dist) || !existsSync(path)) return void res.writeHead(404).end();
  let data = readFileSync(path);
  if (path.endsWith('camera-offscreen.html')) data = Buffer.from(data.toString().replace('<head>', `<head>${STUB}`));
  res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream');
  res.end(data);
});

const profile = await mkdtemp(join(tmpdir(), 'scrollmate-face-'));
let child;
let timeout;
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/camera-offscreen.html`;
  child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    url], { windowsHide: true });
  const outcome = await Promise.race([result, new Promise((_, rej) => { timeout = setTimeout(() => rej(new Error('timed out')), 40000); })]);
  const msgs = outcome.messages;
  const statuses = msgs.filter((m) => m.type === 'CAMERA_STATUS');
  const signals = msgs.filter((m) => m.type === 'USER_SIGNAL');
  const on = statuses.find((m) => m.state === 'on');
  const fps = statuses.map((m) => /([\d.]+) fps/.exec(m.detail ?? '')?.[1]).filter(Boolean).map(Number);
  console.log('statuses:', statuses.map((m) => `${m.state}${m.detail ? ` (${m.detail})` : ''} @${Math.round(m.t)}ms`).join(' -> '));
  console.log('signals :', signals.map((m) => JSON.stringify({ present: m.signal.present, away: m.signal.lookingAway, expr: m.signal.expression })).join(' '));
  const voice = outcome.voiceStats;
  const talkOk = voice.frames > 50 && voice.duplexFrames > 0 && voice.interrupted && voice.partialCaptions >= 4 &&
    voice.opened === 2 && voice.closed === 2 && outcome.tracks.filter(track => track.kind === 'audio').length === 2 &&
    outcome.tracks.every(track => track.state === 'ended');
  if (talk) console.log('voice:', JSON.stringify(voice));
  const ok = !!on && signals.some((m) => m.signal.present === false) && (talk ? talkOk : fps.some((f) => f > 0));
  console.log(ok
    ? talk ? 'PASS: built audio worklets streamed 40 ms PCM during reply playback, flushed interruption, kept camera independent, and released both microphone sessions'
      : `PASS: camera started, MediaPipe ran at ~${Math.max(...fps)} fps, and reported "not in view" for the fake camera (no face)`
    : 'FAIL: see statuses/signals above');
  process.exitCode = ok ? 0 : 1;
} finally {
  clearTimeout(timeout);
  child?.kill();
  server.close();
  const target = resolve(profile);
  if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('scrollmate-face-')) {
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch(() => undefined);
  }
}
