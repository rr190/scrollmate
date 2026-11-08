// Native Chrome headless + esbuild (already supplied by Vite); no browser-test dependency required.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';

const chrome = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(existsSync);
if (!chrome) throw new Error('Set CHROME_PATH to a Chrome/Chromium executable to run the browser checks.');
const temporary = await mkdtemp(join(tmpdir(), 'scrollmate-comments-'));
const bundle = join(temporary, 'test.js');
const server = createServer(async (req, res) => {
  if (req.url === '/test.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(await readFile(bundle));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><title>Comment hover fixture</title></head><body><script type="module" src="/test.js"></script></body></html>');
  }
});
try {
  await build({ entryPoints: [process.argv[2] ?? 'tests/comments.browser.ts'], bundle: true, outfile: bundle, format: 'iife',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  for (const reduced of [false, true]) {
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-features=Translate',
      `--user-data-dir=${join(temporary, reduced ? 'reduced' : 'normal')}`, '--window-size=1440,1000',
      `--virtual-time-budget=${process.argv[3] ?? 50000}`, '--dump-dom', ...(reduced ? ['--force-prefers-reduced-motion'] : []),
      `http://127.0.0.1:${port}/shorts/test123`];
    const result = await new Promise((resolve, reject) => {
      const child = spawn(chrome, args, { windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Headless browser timed out')); }, 30000);
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    });
    const summary = /<pre id="test-results"[^>]*>([\s\S]*?)<\/pre>/.exec(result.stdout)?.[1];
    if (!summary?.includes('PASS: all browser checks')) throw new Error(summary ?? result.stderr.slice(-2000) ?? 'No browser results');
    console.log(`${reduced ? 'Reduced motion' : 'Normal motion'}: ${summary}`);
  }
} finally {
  server.close();
  const target = resolve(temporary);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('scrollmate-comments-')) {
    throw new Error('Refusing to remove a browser profile outside the test temp directory.');
  }
  await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
