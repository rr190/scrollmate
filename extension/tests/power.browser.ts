/** The toolbar switch: hidden -> ScrollMate is not on the page at all; on again -> it comes back. */
import { DEFAULT_SETTINGS } from '../src/shared/types';
import { HIDDEN_KEY } from '../src/shared/power';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const store: Record<string, unknown> = {
  'scrollmate.settings': { ...DEFAULT_SETTINGS, enabled: true, userCam: true },
  [HIDDEN_KEY]: false,
};
const changeListeners: ((changes: Record<string, { newValue: unknown }>, area: string) => void)[] = [];
const sent: { type: string }[] = [];

Object.defineProperty(window, 'chrome', { value: {
  storage: {
    local: {
      get: async (key?: string | string[]) => (typeof key === 'string' ? { [key]: store[key] } : { ...store }),
      set: async (v: Record<string, unknown>) => { Object.assign(store, v); },
    },
    onChanged: { addListener: (fn: (typeof changeListeners)[number]) => changeListeners.push(fn) },
  },
  runtime: {
    lastError: null, onMessage: { addListener() {}, removeListener() {} },
    sendMessage: (m: { type: string }, cb?: (r: unknown) => void) => { sent.push(m); cb?.(m.type === 'GET_MEMORY' ? { memory: [] } : { ok: true }); },
  },
} });

const flip = (hidden: boolean) => {
  store[HIDDEN_KEY] = hidden;
  changeListeners.forEach((fn) => fn({ [HIDDEN_KEY]: { newValue: hidden } }, 'local'));
};

document.body.innerHTML = `<ytd-reel-video-renderer is-active><video style="width:300px;height:500px"></video></ytd-reel-video-renderer>
<pre id="test-results">RUNNING</pre>`;

(async () => {
  const out = document.getElementById('test-results')!;
  try {
    await import('../src/content/index');
    await wait(400);
    if (!document.getElementById('scrollmate-root')) throw new Error('should be on the page when switched on');
    if (!sent.some((m) => m.type === 'CAMERA_START')) throw new Error('camera should start (user turned it on)');

    flip(true);
    await wait(200);
    if (document.getElementById('scrollmate-root')) throw new Error('should be completely gone when switched off');
    if (!sent.some((m) => m.type === 'CAMERA_STOP')) throw new Error('camera should stop when switched off');
    if (!sent.some((m) => m.type === 'CANCEL_ALL')) throw new Error('in-flight AI requests should be cancelled');
    const before = sent.length;
    await wait(1000);
    if (sent.slice(before).some((m) => !['TELEMETRY'].includes(m.type))) throw new Error(`still sending while off: ${sent.slice(before).map((m) => m.type)}`);

    flip(false);
    await wait(400);
    if (document.querySelectorAll('#scrollmate-root').length !== 1) throw new Error('should come back exactly once');
    out.textContent = 'PASS: all browser checks (on -> completely off -> back on)';
  } catch (e) {
    out.textContent = `FAIL: ${(e as Error).message}`;
  }
})();
