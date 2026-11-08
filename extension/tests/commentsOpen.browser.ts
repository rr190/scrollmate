/** The child opens the comments and doesn't point at one: reel lines wait and the buddy reads a comment by itself. */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/content/App';
import { Controller } from '../src/content/controller';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import type { BgRequest } from '../src/shared/messages';
// @ts-expect-error CSS is loaded as a string in this test bundle.
import styles from '../src/content/styles.css';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sent: BgRequest[] = [];
Object.defineProperty(window, 'chrome', { value: {
  storage: { local: {
    get: async () => ({ 'scrollmate.settings': { ...DEFAULT_SETTINGS, enabled: true, commentReactions: true, frequency: 'chatty' } }),
    set: async () => undefined,
  }, onChanged: { addListener() {} } },
  runtime: {
    lastError: null, onMessage: { addListener() {}, removeListener() {} },
    sendMessage: (m: BgRequest, cb?: (r: unknown) => void) => { sent.push(m); if (m.type !== 'COMMENT_REACT') cb?.(m.type === 'GET_MEMORY' ? { memory: [] } : { ok: true }); },
  },
} });

document.body.innerHTML = `
<style>
body { margin: 0; background: #17131f; color: white; font: 16px system-ui; }
ytd-reel-video-renderer { display:block; position:fixed; left:240px; top:40px; }
video { width:450px; height:800px; background:#30233e; }
ytd-engagement-panel-section-list-renderer { display:block; position:fixed; top:40px; right:0; width:400px; height:760px; background:#292331; }
ytd-engagement-panel-section-list-renderer[hidden] { display:none; }
ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model { display:block; }
ytd-comment-view-model { padding:24px; }
#content-text { display:block; }
#test-results { position:fixed; left:8px; bottom:8px; white-space:pre-wrap; pointer-events:none; }
</style>
<ytd-reel-video-renderer is-active><video></video></ytd-reel-video-renderer>
<ytd-engagement-panel-section-list-renderer hidden target-id="engagement-panel-comments-section"><ytd-comments>
<ytd-comment-thread-renderer><ytd-comment-view-model><span id="content-text">The puppy is so happy with that stick!</span></ytd-comment-view-model></ytd-comment-thread-renderer>
<ytd-comment-thread-renderer><ytd-comment-view-model><span id="content-text">He tried so hard, love it.</span></ytd-comment-view-model></ytd-comment-thread-renderer>
</ytd-comments></ytd-engagement-panel-section-list-renderer>
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
const comments = () => sent.filter((m) => m.type === 'COMMENT_REACT');

(async () => {
  const out = document.getElementById('test-results')!;
  try {
    await ctl.init();
    await wait(1500);
    if (comments().length) throw new Error('should not read comments while the panel is closed');

    // the child opens the comments and doesn't point at anything
    document.querySelector('ytd-engagement-panel-section-list-renderer')!.removeAttribute('hidden');
    await wait(1200);
    const c = ctl as unknown as { propose(p: unknown[]): void; engine: { log: { reason: string }[] } };
    c.propose([{ text: 'Look at that big stick!', importance: 0.9, targetVideoId: ctl['watcher']?.currentId ?? 'x',
      preferredTiming: 'now', expiresAfterSeconds: 8, requiresQuietMoment: false, isCallback: false }]);
    await wait(300);
    if (ctl.state.bubble) throw new Error(`a reel line was shown while the comments were open: "${ctl.state.bubble.text}"`);
    if (!c.engine.log.some((e) => /comments are open/.test(e.reason))) throw new Error('reel line should wait because the comments are open, got: ' + c.engine.log.map((e) => e.reason).join(' | '));

    await wait(2500);
    const reqs = comments();
    if (reqs.length !== 1) throw new Error(`expected the buddy to read one comment by itself, got ${reqs.length}`);
    if (!/puppy is so happy/.test((reqs[0] as { text: string }).text)) throw new Error('should read the first visible comment');
    if (!ctl.state.commentVisit) throw new Error('the buddy should go over to that comment');
    out.textContent = 'PASS: all browser checks (opened comments: reel lines wait, buddy reads a comment by itself)';
  } catch (e) {
    out.textContent = `FAIL: ${(e as Error).message}`;
  }
})();
