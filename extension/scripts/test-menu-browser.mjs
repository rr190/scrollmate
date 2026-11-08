import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

const chrome = process.env.CHROME_PATH ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!chrome) throw new Error('Set CHROME_PATH to a Chromium browser.');
const temporary = await mkdtemp(join(tmpdir(), 'scrollmate-menu-'));
const artifacts = resolve('../.artifacts'); await mkdir(artifacts, { recursive: true });
const bundle = join(temporary, 'test.js');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', req.url === '/test.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/test.js' ? await readFile(bundle) : '<!doctype html><html><head><title>ScrollMate menu preview</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script type="module" src="/test.js"></script></body></html>');
});
try {
  await build({ entryPoints: ['tests/menu.browser.ts'], bundle: true, outfile: bundle, format: 'iife', loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'compact', width: 800, height: 600 }, { name: 'phone', width: 390, height: 844, reduced: true }]) {
    const profile = join(temporary, viewport.name);
    const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let socket;
    try {
      let debugPort;
      for (let i = 0; i < 100 && !debugPort; i++) {
        try { debugPort = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { await pause(100); }
      }
      if (!debugPort) throw new Error('Chrome did not start its test debugging endpoint.');
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
      await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
      let sequence = 0;
      const pending = new Map();
      socket.onmessage = (event) => {
        const value = JSON.parse(String(event.data));
        const request = pending.get(value.id);
        if (request) { pending.delete(value.id); value.error ? request.reject(new Error(JSON.stringify(value.error))) : request.resolve(value.result); }
      };
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
      });
      await send('Page.enable'); await send('Runtime.enable');
      await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: viewport.reduced ? 'reduce' : 'no-preference' }] });
      await send('Page.navigate', { url: `http://127.0.0.1:${port}/shorts/test123` });
      let result = '';
      // Real compositor frames are required by capture's requestAnimationFrame pair.
      for (let i = 0; i < 300; i++) {
        const value = await send('Runtime.evaluate', { expression: "document.getElementById('test-results')?.textContent ?? ''", returnByValue: true });
        result = value.result.value;
        if (result.startsWith('PASS:') || result.startsWith('FAIL:')) break;
        await pause(100);
      }
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(artifacts, `orbit-menu-${viewport.name}.png`), Buffer.from(screenshot.data, 'base64'));
      if (!result.startsWith('PASS:')) throw new Error(`${viewport.name}: ${result || 'browser test timed out'}`);
      await send('Runtime.evaluate', { expression: "[...document.querySelectorAll('div')].map(node => node.shadowRoot).find(root => root?.querySelector('.sm-talk-launch'))?.querySelector('.sm-talk-launch').click()" });
      await pause(150);
      const talkScreenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(artifacts, `talk-avatar-${viewport.name}.png`), Buffer.from(talkScreenshot.data, 'base64'));
      console.log(`${viewport.name} ${viewport.width}×${viewport.height}: ${result}`);
    } finally {
      socket?.close();
      if (child.exitCode === null) {
        const closed = new Promise((done) => child.once('close', done)); child.kill(); await closed;
      }
    }
  }
} finally {
  server.close();
  const target = resolve(temporary);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('scrollmate-menu-')) throw new Error('Unsafe temporary profile path.');
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
