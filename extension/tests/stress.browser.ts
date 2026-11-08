/**
 * Cross-feature stress test: every feature switched on at once, driven together.
 *  - reel reactions (timing engine), comment visits, realtime Talk, camera expressions,
 *    feeling lines, voice, swiping, power off/on, clear memory, menu/drag pauses
 *  - deterministic scenarios first, then a seeded random fuzz that checks invariants after every step.
 * All background traffic is stubbed; nothing reaches a model.
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/content/App';
import { COMMENT_DWELL_MS } from '../src/content/comments';
import { Controller } from '../src/content/controller';
import { DEFAULT_SETTINGS } from '../src/shared/types';
// @ts-expect-error CSS is loaded as a string in this test bundle.
import styles from '../src/content/styles.css';
// @ts-expect-error CSS is loaded as a string in this test bundle.
import orbitStyles from '../src/content/orbit.css';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Msg = { type: string; [k: string]: any };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const failures: string[] = [];
let checks = 0;
const check = (cond: unknown, message: string) => { checks++; if (!cond) failures.push(message); };

// ---------- chrome stub ----------
const store: Record<string, unknown> = {
  'scrollmate.settings': { ...DEFAULT_SETTINGS, enabled: true, frequency: 'chatty' },
  'scrollmate.position.youtube': { fx: 0.45, fy: 0.2 },
};
const sent: Msg[] = [];
const listeners: ((m: any) => void)[] = [];
const pendingComments = new Map<string, { msg: Msg; cb: (r: unknown) => void }>();
let feelingLine: string | null = 'You look happy!';
const reply = (msg: Msg): unknown => {
  switch (msg.type) {
    case 'GET_MEMORY': return { memory: [] };
    case 'CAPTURE_FRAME': return { ok: false, error: 'stub' };
    case 'OBSERVE': return { emotion: null, level: 0, change: 'none', reactions: [], nextCaptureAt: null, final: true };
    case 'SWIPE': return { momentType: 'other', emotion: null, level: 0, lookFor: '' };
    case 'CAPTION_REACT': return { emotion: null, reactions: [] };
    case 'FEELING_LINE': return { line: feelingLine, emotion: 'happy' };
    default: return { ok: true };
  }
};
Object.defineProperty(window, 'chrome', { value: {
  storage: {
    local: {
      get: async (key?: string | string[]) => (typeof key === 'string' ? { [key]: store[key] } : { ...store }),
      set: async (v: Record<string, unknown>) => { Object.assign(store, v); },
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn: (m: any) => void) => listeners.push(fn), removeListener() {} },
    sendMessage: (msg: Msg, cb?: (r: unknown) => void) => {
      sent.push(msg);
      if (msg.type === 'COMMENT_REACT') { pendingComments.set(msg.requestId, { msg, cb: cb ?? (() => undefined) }); return; }
      cb?.(reply(msg));
    },
  },
} });
const toTab = (m: any) => listeners.forEach((fn) => fn(m));

// ---------- page fixture ----------
history.replaceState(null, '', '/shorts/videoA1');
document.body.innerHTML = `
<style>
body { margin: 0; background: #17131f; color: white; font: 16px system-ui; }
ytd-reel-video-renderer { display:block; position:fixed; left:240px; top:40px; }
video { width:450px; height:800px; background:#30233e; display:block; }
ytd-engagement-panel-section-list-renderer { display:block; position:fixed; top:40px; right:0; width:400px; height:760px; background:#292331; overflow:auto; }
ytd-comments, ytd-comment-thread-renderer, ytd-comment-view-model { display:block; }
ytd-comment-view-model { padding:24px; }
#content-text { display:block; }
#test-results { position:fixed; left:8px; bottom:8px; white-space:pre-wrap; max-width:900px; pointer-events:none; }
</style>
<ytd-reel-video-renderer is-active><h2>Cake attempt number one</h2><video></video></ytd-reel-video-renderer>
<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-comments-section">
<ytd-comments>
${Array.from({ length: 6 }, (_, i) => `<ytd-comment-thread-renderer><ytd-comment-view-model><span id="content-text" data-c="${i}">Comment number ${i} about the cake.</span></ytd-comment-view-model></ytd-comment-thread-renderer>`).join('')}
</ytd-comments></ytd-engagement-panel-section-list-renderer>
<pre id="test-results">RUNNING</pre>`;

// A controllable fake <video>.
const video = document.querySelector('video')!;
const vs = { paused: true, ended: false, currentTime: 0, duration: 20, muted: false };
for (const k of Object.keys(vs) as (keyof typeof vs)[])
  Object.defineProperty(video, k, { configurable: true, get: () => vs[k], set: (x) => { (vs as any)[k] = x; } });
Object.defineProperty(video, 'volume', { configurable: true, get: () => 1 });
const play = () => { vs.paused = false; video.dispatchEvent(new Event('play')); };
const pause = () => { vs.paused = true; video.dispatchEvent(new Event('pause')); };
const seek = (t: number) => { vs.currentTime = t; video.dispatchEvent(new Event('timeupdate')); };

const host = document.createElement('div');
host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000';
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = `${styles}\n${orbitStyles}`;
shadow.append(style);
const root = document.createElement('div'); shadow.append(root); document.body.append(host);
const ctl = new Controller('youtube', host);
const c = ctl as any; // white-box access for scenario set-up
createRoot(root).render(createElement(App, { ctl }));

// A speaker we control: voice playback ends only when the test says so.
const spoken: { text: string; end: () => void }[] = [];
c.speaker = {
  available: true,
  speak(text: string, onStart: () => void, onEnd: () => void) {
    let done = false;
    const end = () => { if (!done) { done = true; onEnd(); } };
    spoken.push({ text, end }); onStart();
  },
  cancel() { spoken.splice(0).forEach((s) => s.end()); },
  unlock() {}, setVolume() {},
};

const comment = (i: number) => document.querySelector<HTMLElement>(`[data-c="${i}"]`)!;
const hover = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: r.left + 5, clientY: r.top + 5 }));
};
const unhover = () => document.body.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 20, clientY: 20 }));
const commentReqs = () => sent.filter((m) => m.type === 'COMMENT_REACT');
const answerComment = (requestId: string, text: string | null) => {
  const p = pendingComments.get(requestId); if (!p) return;
  pendingComments.delete(requestId);
  p.cb({ requestId, targetCommentId: p.msg.commentId, emotion: 'laughing', reactions: text ? [{
    text, importance: 0.8, targetVideoId: p.msg.videoId, preferredTiming: 'now', expiresAfterSeconds: 8,
    requiresQuietMoment: false, isCallback: false }] : [] });
};
let seq = 0;
const proposal = (over: Record<string, unknown> = {}) => ({
  text: `line ${++seq} ${Math.random().toString(36).slice(2, 7)}`, importance: 0.9, targetVideoId: ctl.state.onShorts ? (c.watcher?.currentId ?? 'videoA1') : 'videoA1',
  preferredTiming: 'pause', expiresAfterSeconds: 30, requiresQuietMoment: false, isCallback: false, ...over,
});
const swipe = async (id: string) => {
  history.pushState(null, '', `/shorts/${id}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
  await wait(320);
};
const talkSession = () => (sent.filter((m) => m.type === 'TALK_START').at(-1) as any)?.context.requestId as string;
const lastTalkContext = () => (sent.filter((m) => m.type === 'TALK_START' || m.type === 'TALK_CONTEXT').at(-1) as any)?.context;
const decisionEvents = () => sent.filter((m) => m.type === 'TELEMETRY' && m.event?.type === 'decision').length;
const camOn = () => toTab({ type: 'CAMERA_STATUS', state: 'on' });
const face = (expression: string, extra: Record<string, unknown> = {}) =>
  toTab({ type: 'USER_SIGNAL', signal: { present: true, lookingAway: false, expression, strength: 0.9, at: Date.now(), ...extra } });
const resetAll = async () => {
  spoken.splice(0).forEach((s) => s.end());
  ctl.endTalk(); ctl.hideBubble(); unhover();
  await ctl.clearMemory(); await wait(50);
  ctl.hideBubble();
};

/** Invariants that must hold whatever combination of features is active. */
function invariants(where: string) {
  const s = ctl.state;
  if (!s.settings.enabled) {
    check(!s.talk.active, `${where}: Talk active while powered off`);
    check(!s.commentVisit, `${where}: comment visit while powered off`);
    check(s.mood === 'sleeping', `${where}: mood ${s.mood} while powered off`);
    check(s.camera === 'off', `${where}: camera ${s.camera} while powered off`);
    check(!c.engine.hasPending(), `${where}: queued reactions while powered off`);
    check(!c.speaking, `${where}: still speaking while powered off`);
  }
  if (s.commentVisit) check(c.commentAttempt?.requestId === s.commentVisit.requestId, `${where}: visit without a matching request`);
  if (s.bubble?.commentRequestId) check(!c.commentAttempt || c.commentAttempt.requestId === s.bubble.commentRequestId || !s.commentVisit,
    `${where}: comment bubble belongs to a different visit`);
  check(c.busy >= 0, `${where}: negative busy counter`);
  check(spoken.length <= 1, `${where}: ${spoken.length} voice lines playing at once`);
  check(!(s.talk.active && spoken.length), `${where}: TTS voice playing during a live Talk session`);
  check(c.engine.queue.length <= 6, `${where}: unbounded reaction queue`);
}

async function scenarios() {
  await ctl.init(); await wait(300);
  camOn(); await wait(30);
  check(ctl.state.settings.enabled && ctl.state.settings.voice && ctl.state.settings.commentReactions &&
    ctl.state.settings.userCam, 'power switch enables every feature together');

  // 1. A bubble still being read is never replaced by the next reel reaction.
  await resetAll(); play(); seek(19); // near the end, audio playing: a silent bubble
  c.propose([proposal({ text: 'first reel line' })]);
  check(ctl.state.bubble?.text === 'first reel line', '1: reel line delivered near the end');
  check(spoken.length === 0, '1: audio may be playing, so the line is silent');
  await wait(3700); // past chatty's 3.5 s reading gap, inside the 4 s minimum linger
  c.propose([proposal({ text: 'second reel line' })]);
  check(ctl.state.bubble?.text === 'first reel line', `1: a visible bubble was replaced by a new reaction (now "${ctl.state.bubble?.text}")`);
  ctl.hideBubble(); await wait(200);
  check(ctl.state.bubble?.text === 'second reel line', `1: the held reaction appears once the bubble is gone (got "${ctl.state.bubble?.text}")`);
  invariants('1');

  // 2. Two voice lines never overlap, and the first line's end never hides the second bubble early.
  await resetAll(); pause();
  c.propose([proposal({ text: 'voice one' })]);
  check(spoken.length === 1, '2: paused + quiet... voice line starts');
  await wait(3700);
  c.propose([proposal({ text: 'voice two' })]);
  check(spoken.length <= 1, '2: a second voice line queued while the first is still speaking');
  spoken.splice(0).forEach((s) => s.end()); await wait(2400);
  check(!!ctl.state.bubble, '2: a bubble remains after the first voice line ends');
  invariants('2');

  // 3. A feeling line is not immediately overwritten by a reel reaction.
  await resetAll(); pause(); feelingLine = 'You are smiling!';
  face('happy'); await wait(20); ctl.hideBubble();
  await c.noticeFeeling('videoA1', 'happy'); await wait(20);
  check(ctl.state.bubble?.text === 'You are smiling!', '3: the feeling line is shown');
  spoken.splice(0).forEach((s) => s.end());
  c.propose([proposal({ text: 'reel line after feeling' })]);
  check(ctl.state.bubble?.text === 'You are smiling!', `3: a reel reaction replaced the feeling line (now "${ctl.state.bubble?.text}")`);
  invariants('3');

  // 4. Talk owns audio: ambient reactions and feeling lines stay silent while it is live.
  await resetAll(); pause();
  ctl.openTalk(); await wait(30);
  const sid = talkSession();
  toTab({ type: 'TALK_EVENT', requestId: sid, event: { type: 'status', state: 'listening' } });
  c.propose([proposal({ text: 'reel line during talk' })]);
  check(ctl.state.bubble?.text === 'reel line during talk' && spoken.length === 0, '4: reel reaction during Talk is a silent bubble');
  ctl.hideBubble(); await wait(4000);
  await c.noticeFeeling('videoA1', 'surprised'); await wait(20);
  check(spoken.length === 0, '4: feeling line during Talk does not use the TTS voice');
  invariants('4');

  // 5. Comment visit + Talk + camera, then a swipe: everything per-Short resets, Talk follows.
  await resetAll(); play(); seek(3);
  ctl.openTalk(); await wait(30);
  const sid5 = talkSession();
  toTab({ type: 'TALK_EVENT', requestId: sid5, event: { type: 'status', state: 'listening' } });
  hover(comment(1)); await wait(COMMENT_DWELL_MS + 120);
  check(!!ctl.state.commentVisit, '5: comment visit starts during Talk with camera on');
  check(lastTalkContext()?.selectedComment === comment(1).textContent, '5: Talk receives the hovered comment');
  c.propose([proposal({ text: 'video line held by comment', preferredTiming: 'now' })]);
  check(ctl.state.bubble?.text !== 'video line held by comment', '5: video reaction waits while a comment is being read');
  face('laughing'); await wait(50);
  const rid5 = commentReqs().at(-1)!.requestId;
  await swipe('videoB2');
  check(!ctl.state.commentVisit, '5: swipe cancels the comment visit');
  check(sent.some((m) => m.type === 'CANCEL_COMMENT' && m.requestId === rid5), '5: swipe aborts the comment request');
  answerComment(rid5, 'late line for vid1'); await wait(900);
  check(ctl.state.bubble?.text !== 'late line for vid1', '5: a late comment reply from the old Short is ignored');
  check(ctl.state.talk.active, '5: Talk survives a swipe');
  check(lastTalkContext()?.videoId === 'videoB2' && !lastTalkContext()?.selectedComment, '5: Talk context moves to the new Short and drops the old comment');
  check(!c.engine.queue.some((q: any) => q.targetVideoId === 'videoA1' && !q.isCallback), '5: non-callback reactions for the old Short are dropped');
  invariants('5');

  // 6. Power off with everything in flight, then power on again.
  await resetAll(); play(); seek(4);
  ctl.openTalk(); await wait(30);
  const sid6 = talkSession();
  hover(comment(2)); await wait(COMMENT_DWELL_MS + 120);
  const rid6 = commentReqs().at(-1)?.requestId;
  c.propose([proposal({ text: 'queued before power off' })]);
  feelingLine = 'late feeling'; const feelingP = c.noticeFeeling('videoB2', 'happy');
  await ctl.updateSettings({ enabled: false }); await wait(50);
  invariants('6 off');
  const before = sent.length;
  if (rid6) answerComment(rid6, 'late comment after power off');
  toTab({ type: 'TALK_EVENT', requestId: sid6, event: { type: 'caption', role: 'assistant', text: 'late talk caption' } });
  toTab({ type: 'USER_SIGNAL', signal: { present: true, lookingAway: false, expression: 'laughing', strength: 1, at: Date.now() } });
  hover(comment(3)); await feelingP; await wait(1200);
  check(!ctl.state.bubble, `6: something appeared while powered off ("${ctl.state.bubble?.text}")`);
  const leaked = sent.slice(before).filter((m) => !['TELEMETRY', 'CANCEL_COMMENT', 'CANCEL_ALL', 'TALK_CANCEL', 'CAMERA_STOP'].includes(m.type));
  check(leaked.length === 0, `6: requests sent while powered off: ${leaked.map((m) => m.type).join(',')}`);
  invariants('6 after late events');
  await ctl.updateSettings({ enabled: true }); camOn(); await wait(100);
  check(ctl.state.settings.commentReactions && ctl.state.camera !== 'off', '6: powering on restores comments and camera');
  hover(comment(4)); await wait(COMMENT_DWELL_MS + 120);
  check(!!ctl.state.commentVisit, '6: comment visits work again after power on');
  invariants('6 on');

  // 6b. Power off while a frame grab is waiting to capture: no screenshot is taken afterwards.
  await resetAll(); await swipe('videoC3'); await wait(300);
  play(); seek(1); // first frame is due: the buddy hides and waits two animation frames
  const grabbing = c.ctx?.capturing;
  await ctl.updateSettings({ enabled: false });
  const offAt = sent.length;
  for (let i = 0; i < 100 && host.style.visibility === 'hidden'; i++) await wait(100); // the grab resolves on its next frames
  await wait(300);
  check(grabbing, '6b: a frame grab was in progress');
  check(!sent.slice(offAt).some((m) => m.type === 'CAPTURE_FRAME' || m.type === 'OBSERVE'), '6b: a screen capture was sent after power off');
  check(host.style.visibility === '', '6b: the buddy is visible again after the cancelled grab');
  await ctl.updateSettings({ enabled: true }); camOn(); await wait(50);

  // 7. Opening the menu / dragging pauses visits; personality change cancels; clear memory resets.
  await resetAll(); hover(comment(5)); await wait(COMMENT_DWELL_MS + 120);
  ctl.pauseCommentVisits(true);
  check(!ctl.state.commentVisit, '7: opening the menu cancels the visit');
  ctl.pauseCommentVisits(false);
  unhover(); hover(comment(0)); await wait(COMMENT_DWELL_MS + 120);
  check(!!ctl.state.commentVisit, '7: visits resume after the menu closes');
  await ctl.updateSettings({ personality: ctl.state.settings.personality === 'witty' ? 'chill' : 'witty' });
  check(!ctl.state.commentVisit, '7: personality change cancels the visit');
  invariants('7');

  // 8. Decision telemetry keeps flowing in long sessions (past the engine's log cap).
  await resetAll();
  for (let i = 0; i < 1100; i++) c.propose([proposal({ importance: 0.01 })]);
  const at1100 = decisionEvents();
  for (let i = 0; i < 50; i++) c.propose([proposal({ importance: 0.01 })]);
  check(decisionEvents() - at1100 >= 50, `8: decision telemetry stalled after the log cap (${decisionEvents() - at1100} of 50 sent)`);
  invariants('8');
}

/** Seeded fuzz: random interleavings of every feature, invariants after each step. */
async function fuzz(steps: number, seed: number) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  let vid = 2;
  const ops: [string, () => unknown][] = [
    ['propose', () => c.propose([proposal({ importance: 0.3 + rnd() * 0.7, preferredTiming: pick(['now', 'pause']), isCallback: rnd() < 0.2 })])],
    ['play', play], ['pause', pause], ['seek', () => seek(rnd() * 20)], ['loop', () => { seek(19.5); seek(0.2); }],
    ['hover', () => hover(comment(Math.floor(rnd() * 6)))], ['unhover', unhover],
    ['answer', () => { const r = [...pendingComments.keys()]; if (r.length) answerComment(pick(r), rnd() < 0.7 ? `fuzz reply ${rnd()}` : null); }],
    ['talk', () => ctl.toggleTalk()],
    ['talkEvent', () => { const id = talkSession(); if (id) toTab({ type: 'TALK_EVENT', requestId: id, event: pick([
      { type: 'status', state: 'listening' }, { type: 'status', state: 'speaking' }, { type: 'status', state: 'thinking' },
      { type: 'caption', role: 'assistant', text: 'fuzz caption' }, { type: 'interrupted' }]) }); }],
    ['face', () => face(pick(['laughing', 'happy', 'neutral', 'surprised', 'sad']), { lookingAway: rnd() < 0.2, present: rnd() > 0.1 })],
    ['camera', () => toTab({ type: 'CAMERA_STATUS', state: pick(['on', 'on', 'error', 'starting']) })],
    ['feeling', () => { void c.noticeFeeling(c.watcher?.currentId ?? 'videoA1', pick(['happy', 'surprised'])); }],
    ['voiceEnd', () => spoken.splice(0).forEach((s) => s.end())],
    ['dismiss', () => ctl.hideBubble()],
    ['menu', () => { const p = rnd() < 0.5; ctl.pauseCommentVisits(p); }],
    ['swipe', () => swipe(`videoF${++vid}`)],
    ['power', () => ctl.updateSettings({ enabled: !ctl.state.settings.enabled })],
    ['frequency', () => ctl.updateSettings({ frequency: pick(['rare', 'balanced', 'chatty']) })],
    ['clear', () => ctl.clearMemory()],
  ];
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  for (let i = 0; i < steps; i++) {
    const [name, op] = pick(ops);
    try { await op(); } catch (e) { errors.push(`${name}: ${(e as Error).message}`); }
    await wait(Math.floor(rnd() * 120));
    invariants(`fuzz#${i} after ${name}`);
  }
  ctl.pauseCommentVisits(false);
  if (!ctl.state.settings.enabled) await ctl.updateSettings({ enabled: true });
  camOn(); await wait(9000); // let every bubble/visit time out
  spoken.splice(0).forEach((s) => s.end()); await wait(2500);
  check(!ctl.state.commentVisit, 'fuzz: a comment visit got stuck');
  check(!c.speaking, 'fuzz: speaking flag got stuck');
  check(errors.length === 0, `fuzz: runtime errors: ${errors.slice(0, 5).join(' | ')}`);
  // The buddy still works normally after the storm.
  ctl.endTalk(); ctl.hideBubble(); unhover(); await ctl.clearMemory(); await wait(50);
  hover(comment(1)); await wait(COMMENT_DWELL_MS + 150);
  check(!!ctl.state.commentVisit, 'fuzz: comment visits still work after the fuzz');
}

(async () => {
  const out = document.getElementById('test-results')!;
  try {
    await scenarios();
    await fuzz(350, 7);
  } catch (e) {
    failures.push(`crashed: ${(e as Error).stack ?? e}`);
  }
  // De-duplicate repeated invariant failures from the fuzz loop.
  const unique = [...new Map(failures.map((f) => [f.replace(/fuzz#\d+ after \w+/, 'fuzz'), f])).values()];
  out.textContent = unique.length ? `FAIL (${unique.length} of ${checks} checks):\n${unique.join('\n')}` : `PASS: all browser checks (${checks} cross-feature checks)`;
})();
