/**
 * Facial emotion, tab side: camera labels from the offscreen page reach the buddy, Mochi mirrors them,
 * a held feeling gets one kind line, and looking away / powering off behave. Stubs the background only.
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/content/App';
import { Controller } from '../src/content/controller';
import { DEFAULT_SETTINGS } from '../src/shared/types';
// @ts-expect-error CSS is loaded as a string in this test bundle.
import styles from '../src/content/styles.css';
// @ts-expect-error CSS is loaded as a string in this test bundle.
import orbitStyles from '../src/content/orbit.css';

/* eslint-disable @typescript-eslint/no-explicit-any */
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const failures: string[] = [];
const check = (c: unknown, m: string) => { if (!c) failures.push(m); };
const sent: any[] = [];
const listeners: ((m: any) => void)[] = [];
Object.defineProperty(window, 'chrome', { value: {
  storage: { local: { get: async () => ({ 'scrollmate.settings': { ...DEFAULT_SETTINGS, enabled: true } }), set: async () => {} }, onChanged: { addListener() {} } },
  runtime: { lastError: null, onMessage: { addListener: (fn: any) => listeners.push(fn) },
    sendMessage: (m: any, cb?: (r: unknown) => void) => { sent.push(m);
      cb?.(m.type === 'FEELING_LINE' ? { line: 'You are smiling! Did that make you happy?', emotion: 'happy', source: 'ai' }
        : m.type === 'GET_MEMORY' ? { memory: [] } : m.type === 'CAPTURE_FRAME' ? { ok: false } : { ok: true }); } },
} });
const toTab = (m: any) => listeners.forEach((fn) => fn(m));
const face = (expression: string, extra: Record<string, unknown> = {}) =>
  toTab({ type: 'USER_SIGNAL', signal: { present: true, lookingAway: false, expression, strength: 0.9, at: Date.now(), ...extra } });

history.replaceState(null, '', '/shorts/faceReel01');
document.body.innerHTML = `<style>ytd-reel-video-renderer{display:block;position:fixed;left:200px;top:40px} video{width:450px;height:800px;display:block}</style>
<ytd-reel-video-renderer is-active><h2>A cat discovers a cucumber</h2><video></video></ytd-reel-video-renderer><pre id="test-results">RUNNING</pre>`;
const host = document.createElement('div');
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style'); style.textContent = `${styles}\n${orbitStyles}`; shadow.append(style);
const root = document.createElement('div'); shadow.append(root); document.body.append(host);
const ctl = new Controller('youtube', host);
createRoot(root).render(createElement(App, { ctl }));

(async () => {
  const out = document.getElementById('test-results')!;
  try {
    await ctl.init(); await wait(300);
    check(sent.some((m) => m.type === 'CAMERA_START'), 'turning the buddy on starts the camera');
    toTab({ type: 'CAMERA_STATUS', state: 'on' }); await wait(50);
    check(ctl.state.camera === 'on', 'camera status reaches the buddy');

    // Mirroring: each new expression shows on Mochi as a face (never a bubble).
    for (const [expr, mood] of [['surprised', 'surprised'], ['laughing', 'laughing'], ['sad', 'sad'], ['disgusted', 'cringe'], ['confused', 'curious']]) {
      face(expr); await wait(200);
      check(ctl.state.user?.expression === expr, `${expr}: the label reaches the buddy`);
      check(ctl.state.mood === mood, `${expr}: Mochi should look ${mood}, looks ${ctl.state.mood}`);
      check(!ctl.state.bubble, `${expr}: mirroring must not speak`);
      face('neutral'); await wait(2500); // let the mirrored face ease back
    }
    check(!!shadow.querySelector('.sm-companion'), 'Mochi is drawn');

    // A held smile, a few seconds into the Short, gets one kind line.
    await wait(1500); // past the 4 s settle time after the swipe
    face('happy'); await wait(1600); face('happy'); await wait(400);
    check(sent.some((m) => m.type === 'FEELING_LINE' && m.expression === 'happy'), 'a held smile asks for a feeling line');
    check(ctl.state.bubble?.text === 'You are smiling! Did that make you happy?', `the feeling line is shown (got "${ctl.state.bubble?.text}")`);
    const lines = sent.filter((m) => m.type === 'FEELING_LINE').length;
    ctl.hideBubble(); face('neutral'); await wait(300); face('happy'); await wait(2000);
    check(sent.filter((m) => m.type === 'FEELING_LINE').length === lines, 'only one feeling line per Short');

    // Looking away is not mirrored and holds reel comments.
    face('laughing', { lookingAway: true }); await wait(100);
    check((ctl as any).snapshot().userAway === true, 'looking away holds reel comments');
    face('neutral', { present: false }); await wait(100);
    check((ctl as any).snapshot().userAway === true, 'no face in view counts as away');

    // Power off: camera stops and later labels change nothing.
    await ctl.updateSettings({ enabled: false }); await wait(50);
    check(sent.some((m) => m.type === 'CAMERA_STOP') && ctl.state.camera === 'off', 'power off stops the camera');
    face('surprised'); await wait(200);
    check(ctl.state.mood === 'sleeping', 'labels after power off do not move Mochi');
  } catch (e) {
    failures.push(`crashed: ${(e as Error).stack}`);
  }
  out.textContent = failures.length ? `FAIL:\n${failures.join('\n')}` : 'PASS: all browser checks (camera labels, mirroring, feeling line, away, power off)';
})();
