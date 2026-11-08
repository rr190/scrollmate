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
window.__msgs = [];
window.chrome = { runtime: {
  getURL: (p) => '/' + p,
  sendMessage: (m) => { window.__msgs.push({ ...m, t: performance.now() }); return Promise.resolve(); },
  onMessage: { addListener() {} },
} };
setTimeout(() => fetch('/__result', { method: 'POST', body: JSON.stringify(window.__msgs) }), 14000);
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
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/camera-offscreen.html`;
  child = spawn(chrome, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', url], { windowsHide: true });
  const msgs = await Promise.race([result, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 40000))]);
  const statuses = msgs.filter((m) => m.type === 'CAMERA_STATUS');
  const signals = msgs.filter((m) => m.type === 'USER_SIGNAL');
  const on = statuses.find((m) => m.state === 'on');
  const fps = statuses.map((m) => /([\d.]+) fps/.exec(m.detail ?? '')?.[1]).filter(Boolean).map(Number);
  console.log('statuses:', statuses.map((m) => `${m.state}${m.detail ? ` (${m.detail})` : ''} @${Math.round(m.t)}ms`).join(' -> '));
  console.log('signals :', signals.map((m) => JSON.stringify({ present: m.signal.present, away: m.signal.lookingAway, expr: m.signal.expression })).join(' '));
  const ok = !!on && fps.some((f) => f > 0) && signals.some((m) => m.signal.present === false);
  console.log(ok
    ? `PASS: camera started, MediaPipe ran at ~${Math.max(...fps)} fps, and reported "not in view" for the fake camera (no face)`
    : 'FAIL: see statuses/signals above');
  process.exitCode = ok ? 0 : 1;
} finally {
  child?.kill();
  server.close();
  const target = resolve(profile);
  if (dirname(target) === resolve(tmpdir()) && basename(target).startsWith('scrollmate-face-')) {
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }).catch(() => undefined);
  }
}
