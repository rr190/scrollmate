import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/content/App';
import { Controller } from '../src/content/controller';
import { DEFAULT_SETTINGS } from '../src/shared/types';
// @ts-expect-error CSS is loaded as a string in this test bundle.
import styles from '../src/content/styles.css';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

Object.defineProperty(window, 'chrome', { value: {
  storage: { local: {
    get: async () => ({ 'scrollmate.settings': { ...DEFAULT_SETTINGS, enabled: true, roam: true }, 'scrollmate.position.youtube': { fx: 0.45, fy: 0.2 } }),
    set: async () => undefined,
  } },
  runtime: { lastError: null, onMessage: { addListener() {} }, sendMessage: (_m: unknown, cb?: (r: unknown) => void) => cb?.({ ok: true }) },
} });

document.body.innerHTML = `
<style>
body { margin: 0; background: #17131f; color: white; font: 16px system-ui; }
ytd-reel-video-renderer { display:block; position:fixed; left:240px; top:60px; }
video { width:450px; height:800px; background:#30233e; }
ytd-engagement-panel-section-list-renderer { display:block; position:fixed; top:60px; right:0; width:400px; height:760px; background:#292331; }
#test-results { position:fixed; left:8px; bottom:8px; white-space:pre-wrap; pointer-events:none; }
</style>
<ytd-reel-video-renderer is-active><video></video></ytd-reel-video-renderer>
<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-comments-section"><ytd-comments></ytd-comments></ytd-engagement-panel-section-list-renderer>
<pre id="test-results">RUNNING</pre>`;

const host = document.createElement('div');
host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000';
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = styles;
shadow.append(style);
const root = document.createElement('div');
shadow.append(root);
document.body.append(host);
const ctl = new Controller('youtube', host);
createRoot(root).render(createElement(App, { ctl }));

const place = () => {
  const el = shadow.querySelector<HTMLElement>('.sm-companion');
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el?.style.transform ?? '');
  return m ? { x: Math.round(+m[1]), y: Math.round(+m[2]), walking: !!el?.classList.contains('sm-travelling') } : null;
};

(async () => {
  const out = document.getElementById('test-results')!;
  try {
    await ctl.init();
    const spots = new Set<string>();
    let sawWalking = false;
    for (let i = 0; i < 360; i++) { // 90 s
      await wait(250);
      const p = place();
      if (!p) continue;
      spots.add(`${p.x},${p.y}`);
      sawWalking ||= p.walking;
      if (p.x < 0 || p.y < 56 || p.x > innerWidth - 80 || p.y > innerHeight - 80) throw new Error(`went off screen: ${JSON.stringify(p)}`);
    }
    if (reduced) {
      if (spots.size !== 1) throw new Error(`reduced motion should not roam, saw ${spots.size} spots`);
    } else {
      if (spots.size < 3) throw new Error(`expected it to step around in 90 s, saw ${spots.size} spots`);
      const ys = new Set([...spots].map((k) => k.split(',')[1]));
      const xs = [...spots].map((k) => +k.split(',')[0]);
      if (ys.size !== 1) throw new Error(`should only step left/right, saw ${ys.size} heights`);
      if (Math.max(...xs) - Math.min(...xs) > 130) throw new Error(`strayed too far: ${Math.max(...xs) - Math.min(...xs)} px`);
      if (!sawWalking) throw new Error('never showed the walking animation');
    }
    out.textContent = `PASS: all browser checks (roam: ${spots.size} spots in 90 s${reduced ? ', stays put with reduced motion' : ''})`;
  } catch (e) {
    out.textContent = `FAIL: ${(e as Error).message}`;
  }
})();
