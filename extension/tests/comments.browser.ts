import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/content/App';
import { COMMENT_DWELL_MS } from '../src/content/comments';
import { Controller } from '../src/content/controller';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import type { BgRequest, CommentReactResponse } from '../src/shared/messages';
// esbuild's text loader is used by the browser-test runner.
// @ts-expect-error CSS is loaded as a string in this test bundle.
import styles from '../src/content/styles.css';
// @ts-expect-error CSS is loaded as a string in this test bundle.
import orbitStyles from '../src/content/orbit.css';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sent: BgRequest[] = [];
const writes: Record<string, unknown>[] = [];
const pending = new Map<string, { msg: Extract<BgRequest, { type: 'COMMENT_REACT' }>; callback: (res: unknown) => void }>();
const position = { fx: 0.45, fy: 0.2 };

Object.defineProperty(window, 'chrome', { value: {
  storage: { local: {
    get: async () => ({ 'scrollmate.settings': { ...DEFAULT_SETTINGS, enabled: true, frequency: 'chatty' }, 'scrollmate.position.youtube': position }),
    set: async (value: Record<string, unknown>) => { writes.push(value); },
  } },
  runtime: {
    lastError: null, onMessage: { addListener() {} },
    sendMessage: (msg: BgRequest, callback: (res: unknown) => void) => {
      sent.push(msg);
      if (msg.type === 'COMMENT_REACT') { pending.set(msg.requestId, { msg, callback }); return; }
      callback(msg.type === 'GET_MEMORY' ? { memory: [] } : { ok: true });
    },
  },
} });

document.body.innerHTML = `
<style>
body { margin: 0; background: #17131f; color: white; font: 16px system-ui; }
ytd-reel-video-renderer { display:block; position:fixed; left:240px; top:40px; }
video { width:450px; height:800px; background:#30233e; }
ytd-engagement-panel-section-list-renderer { display:block; position:fixed; top:40px; right:0; width:400px; height:760px; background:#292331; overflow:auto; }
ytd-engagement-panel-section-list-renderer[hidden] { display:none; }
ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model { display:block; }
ytd-comment-view-model { padding:24px; border-bottom:1px solid #51435f; }
#content-text { display:block; }
#test-results { position:fixed; left:8px; bottom:8px; white-space:pre-wrap; max-width:650px; pointer-events:none; }
</style>
<ytd-reel-video-renderer is-active><h2>A dog carries an oversized stick</h2><video></video></ytd-reel-video-renderer>
<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-comments-section" visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED">
<h2>Comments</h2><ytd-comments>
<ytd-comment-thread-renderer><ytd-comment-view-model><span id="content-text" data-fixture="first">The dog thinks that stick fits through the door.</span></ytd-comment-view-model></ytd-comment-thread-renderer>
<ytd-comment-thread-renderer><ytd-comment-view-model><span id="content-text" data-fixture="second">That doorway has met its match.</span></ytd-comment-view-model></ytd-comment-thread-renderer>
<ytd-comment-replies-renderer id="replies"><ytd-comment-view-model><span id="content-text" data-fixture="reply">A reply that should not trigger.</span></ytd-comment-view-model></ytd-comment-replies-renderer>
</ytd-comments></ytd-engagement-panel-section-list-renderer>
<pre id="test-results">RUNNING</pre>`;

const host = document.createElement('div');
host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000';
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = `${styles}\n${orbitStyles}`;
shadow.append(style);
const root = document.createElement('div'); shadow.append(root); document.body.append(host);
const ctl = new Controller('youtube', host);
createRoot(root).render(createElement(App, { ctl }));
let first = document.querySelector<HTMLElement>('[data-fixture=first]')!;
const second = document.querySelector<HTMLElement>('[data-fixture=second]')!;
const panel = document.querySelector<HTMLElement>('ytd-engagement-panel-section-list-renderer')!;
const hover = (el: HTMLElement, offset = 5) => {
  let rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    const range = document.createRange(); range.selectNodeContents(el);
    rect = range.getClientRects()[0] ?? rect;
  }
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: rect.left + offset, clientY: rect.top + 5 }));
};
const commentRequests = () => sent.filter((m): m is Extract<BgRequest, { type: 'COMMENT_REACT' }> => m.type === 'COMMENT_REACT');
const reply = (requestId: string) => {
  const p = pending.get(requestId)!;
  const response: CommentReactResponse = {
    requestId, targetCommentId: p.msg.commentId, emotion: 'laughing', reactions: [{
      text: 'the door disagrees.', importance: 0.8, targetVideoId: p.msg.videoId,
      targetCommentId: p.msg.commentId, commentRequestId: requestId,
      preferredTiming: 'now', expiresAfterSeconds: 8, requiresQuietMoment: false, isCallback: false,
    }],
  };
  p.callback(response); pending.delete(requestId);
};
const latest = () => commentRequests().at(-1)!;
// Wait just past the hover dwell: the visit has started and the buddy is still travelling.
const select = async (el: HTMLElement) => { hover(el); await wait(COMMENT_DWELL_MS + 100); assert(ctl.state.commentVisit, 'deliberate hover should start a visit'); };
const reset = async () => { panel.hidden = false; await ctl.clearMemory(); await wait(30); };

async function run() {
  await ctl.init(); await wait(300);
  hover(first); await wait(150); hover(second); await wait(150);
  document.body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 50, clientY: 50, pointerType: 'mouse' }));
  await wait(1100);
  assert(commentRequests().length === 0, 'passing over comments must not call the model');
  hover(document.querySelector<HTMLElement>('[data-fixture=reply]')!); await wait(1100);
  assert(commentRequests().length === 0, 'replies are outside this first-version scope');

  // Real comment hosts can be boxless while their nested text spans are painted normally.
  first.innerHTML = '<span>The dog thinks that stick fits through the door.</span>';
  first.style.display = 'contents';
  await select(first);
  reply(latest().requestId);
  await reset(); first.style.display = '';
  const commentsHost = panel.querySelector<HTMLElement>('ytd-comments')!;
  commentsHost.style.display = 'contents';
  await select(first);
  reply(latest().requestId);
  await reset(); commentsHost.style.display = '';
  document.body.setAttribute('aria-hidden', 'true'); // accessibility metadata alone does not hide painted text
  await select(first);
  reply(latest().requestId);
  await reset(); document.body.removeAttribute('aria-hidden');
  const clippingShell = document.createElement('div');
  clippingShell.style.cssText = 'width:20px;height:20px;overflow:hidden';
  panel.before(clippingShell); clippingShell.append(panel);
  await select(first); // a fixed panel escapes overflow on a non-containing ancestor
  reply(latest().requestId); await reset();
  const beforeRealClip = commentRequests().length;
  clippingShell.style.transform = 'translateZ(0)'; // now it really is the fixed panel's containing block
  hover(first); await wait(1100);
  assert(!ctl.state.commentVisit && commentRequests().length === beforeRealClip,
    'genuinely clipped comments must still be rejected');
  clippingShell.style.transform = '';
  clippingShell.before(panel); clippingShell.remove();
  hover(first); await wait(100); // still inside the hover dwell (COMMENT_DWELL_MS = 250)
  const replacement = first.cloneNode(true) as HTMLElement;
  first.replaceWith(replacement); first = replacement;
  await wait(1800);
  assert(ctl.state.commentVisit, 'a row replaced during dwell should be reconfirmed instead of leaving a stuck hint');
  reply(latest().requestId); await reset();
  first.style.opacity = '0';
  hover(first); await wait(1100);
  assert(!ctl.state.commentVisit && ctl.state.commentHint !== 'Hold still for a second…', 'failed visibility checks must explain the failure');
  first.style.opacity = '';
  await wait(400);
  assert(ctl.state.commentVisit, 'a transient visibility failure should retry after the text becomes visible');
  reply(latest().requestId); await reset();
  const initialRequests = commentRequests().length;

  await select(first);
  assert(commentRequests().length === initialRequests + 1, 'one deliberate hover should send exactly one request');
  if (!reduced) assert(ctl.state.commentVisit?.phase === 'running', 'buddy should run while the request starts');
  reply(latest().requestId); await wait(100);
  if (!reduced) assert(!ctl.state.bubble, 'reaction must wait until the buddy arrives');
  await wait(650);
  assert(ctl.state.bubble?.text === 'the door disagrees.', 'selected comment should get its reaction');
  const buddy = shadow.querySelector('.sm-companion')!.getBoundingClientRect();
  assert(buddy.right < panel.getBoundingClientRect().left, 'buddy must not cover the comment panel');
  assert(shadow.querySelector('.sm-comment-outline'), 'target comment should be highlighted');
  const bubble = shadow.querySelector('.sm-bubble')!.getBoundingClientRect();
  assert(bubble.right < panel.getBoundingClientRect().left && bubble.top >= 0 && bubble.left >= 0, 'reaction bubble must stay readable outside the panel');
  assert(!writes.some((w) => 'scrollmate.position.youtube' in w), 'automatic visits must not overwrite the saved position');
  if (reduced) assert(getComputedStyle(shadow.querySelector('.sm-companion')!).transitionDuration === '0s', 'reduced motion disables travel');
  shadow.querySelector<HTMLElement>('.sm-bubble')!.click(); await wait(1100);
  assert(!ctl.state.commentVisit, 'dismissing the bubble should send the buddy home');

  const count = commentRequests().length;
  hover(second); await wait(1100);
  // No wait between comment visits: once the previous bubble is gone, the next comment is visited right away.
  assert(ctl.state.commentVisit?.id && commentRequests().length === count + 1, 'the next comment should be visited with no countdown');
  assert(!ctl.state.commentHint?.startsWith('Next comment in '), 'there should be no "Next comment in" countdown');
  // Comment context: the earlier comment on this Short and ScrollMate's reply to it travel with the next request.
  const prev = latest().previousComments ?? [];
  assert(prev.length >= 1 && prev.at(-1)!.reaction === 'the door disagrees.', 'the next comment should carry the previous comment + reply as context');
  assert(!prev.some((p) => p.text === latest().text), 'the selected comment must not appear in its own context');
  reply(latest().requestId);

  await reset(); await select(second);
  const closing = latest().requestId;
  panel.hidden = true; reply(closing); await wait(250);
  assert(!ctl.state.commentVisit && !ctl.state.bubble, 'closing the panel must reject even a fast late response');
  assert(sent.some((m) => m.type === 'CANCEL_COMMENT' && m.requestId === closing), 'closing must cancel the network request');

  await reset(); await select(first);
  const scrolling = latest().requestId;
  panel.dispatchEvent(new Event('scroll')); reply(scrolling); await wait(250);
  assert(!ctl.state.commentVisit && !ctl.state.bubble, 'scrolling must cancel the visit and stale reply');

  await reset(); await select(second);
  const changed = latest().requestId;
  second.textContent = 'A virtualised row now contains a different comment.';
  reply(changed); await wait(250);
  assert(!ctl.state.commentVisit && !ctl.state.bubble, 'recycled comment rows must reject old reactions');

  await reset(); await select(first);
  const manual = latest().requestId;
  await wait(650);
  const button = shadow.querySelector<HTMLElement>('.sm-char-btn')!;
  const start = button.getBoundingClientRect();
  // Synthetic pointer events have no native pointer capture, so stub only that browser primitive.
  button.setPointerCapture = () => {};
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, button: 0, clientX: start.x + 20, clientY: start.y + 20 }));
  await wait(30);
  button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: start.x + 60, clientY: start.y + 40 }));
  await wait(30);
  button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
  reply(manual); await wait(100);
  assert(!ctl.state.commentVisit && !ctl.state.bubble, 'dragging must take priority over a visit');
  assert(!shadow.querySelector('.sm-dragging'), 'releasing a drag must restore automatic interaction');
  assert(Math.abs(ctl.state.position!.fx * innerWidth - start.x - 40) < 1,
    `dragging a visiting buddy saves its new position (saved=${ctl.state.position!.fx * innerWidth}, start=${start.x})`);
  ctl.savePosition(position);

  await reset(); await select(first);
  const settings = latest().requestId;
  button.click(); await wait(50); reply(settings); await wait(100);
  assert(shadow.querySelector('.sm-orbit-menu') && !ctl.state.commentVisit && !ctl.state.bubble, 'opening settings must cancel the visit');
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true })); await wait(50);
  assert(!shadow.querySelector('.sm-orbit-menu'), 'clicking outside must close settings and restore hover detection');

  await reset();
  panel.style.width = '100vw';
  hover(first); await wait(1100);
  assert(!ctl.state.commentVisit, 'buddy should stay home when no lane beside the comments fits');
  const column = panel.querySelector<HTMLElement>('ytd-comments')!;
  column.style.cssText = 'width:400px;margin-left:auto';
  hover(first); await wait(1100);
  assert(ctl.state.commentVisit, 'a narrow comment column inside a full-width wrapper should still allow a visit');
  reply(latest().requestId);
  ctl.checkCommentDetection();
  assert(ctl.state.note?.includes('2 visible comments detected'), 'diagnostics should report visible top-level comments');
  column.style.cssText = '';
  panel.style.width = '';

  await reset(); await select(first);
  const disabled = latest().requestId;
  await ctl.updateSettings({ enabled: false }); reply(disabled); await wait(200);
  assert(!ctl.state.commentVisit && !ctl.state.bubble, 'disabling the companion cancels the visit');
  hover(second); await wait(1100);
  assert(!ctl.state.commentVisit, 'sleeping buddy must disable comment selection');
  await ctl.updateSettings({ enabled: true });

  await reset(); await select(second);
  const navigating = latest().requestId;
  history.pushState({}, '', '/shorts/other123'); await wait(600); reply(navigating); await wait(100);
  assert(!ctl.state.commentVisit && !ctl.state.bubble, 'navigation must reject the previous video/comment response');
  assert(ctl.state.position?.fx === position.fx && ctl.state.position?.fy === position.fy, 'home position stays intact');
  ctl.destroy();
  document.getElementById('test-results')!.textContent = 'PASS: all browser checks (floating panels, real clipping, boxless text/panels, accessibility metadata, row replacement, visibility retry, hover intent, targeting, placement, cooldown retry, dismissal, closure, scrolling, recycled rows, manual controls, diagnostics, disable, navigation, saved position).';
}

run().catch((error) => {
  ctl.destroy();
  document.getElementById('test-results')!.textContent = `FAIL: ${error.stack ?? error}`;
});
