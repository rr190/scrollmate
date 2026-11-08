import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/content/App';
import { Controller } from '../src/content/controller';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import type { BgRequest, TabMessage } from '../src/shared/messages';
// @ts-expect-error the test runner loads CSS as text
import styles from '../src/content/styles.css';
// @ts-expect-error the test runner loads CSS as text
import orbitStyles from '../src/content/orbit.css';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const messages: BgRequest[] = [];
const listeners: ((message: TabMessage) => unknown)[] = [];
let calibrated = false;
let reelReaction = false;
let reelLine = 'That turned out beautifully.';
let failObservation = true;
const notify = (message: TabMessage) => listeners.forEach((listener) => listener(message));
let spoken: SpeechSynthesisUtterance | null = null;
let microphoneDenied = false;
Object.defineProperty(window, 'speechSynthesis', { value: {
  getVoices: () => [], cancel: () => { spoken = null; },
  speak: (utterance: SpeechSynthesisUtterance) => { spoken = utterance; utterance.onstart?.(new Event('start') as SpeechSynthesisEvent); },
} });
Object.defineProperty(window, 'chrome', { value: {
  storage: { local: {
    get: async (keys: string | string[]) => Array.isArray(keys)
      ? { 'scrollmate.settings': { ...DEFAULT_SETTINGS, enabled: false }, 'scrollmate.position.youtube': { fx: .78, fy: .22 } }
      : calibrated ? { [keys]: { error: .1 } } : {},
    set: async () => {},
  } },
  runtime: { lastError: null, onMessage: { addListener: (listener: (message: TabMessage) => unknown) => listeners.push(listener) },
    sendMessage: (message: BgRequest, reply: (value: unknown) => void) => {
      messages.push(message);
      if (message.type === 'TALK_START') {
        setTimeout(() => notify({ type: 'TALK_EVENT', requestId: message.context.requestId,
          event: { type: 'status', state: microphoneDenied ? 'needs_permission' : 'listening', error: microphoneDenied ? 'Allow microphone access in the setup tab.' : undefined } }), 20);
      }
      if (message.type === 'CAMERA_START') setTimeout(() => notify({ type: 'CAMERA_STATUS', state: 'on' }), 20);
      if (message.type === 'CAPTURE_FRAME') { reply({ ok: true, data: 'stubbed-local-frame' }); return; }
      if (message.type === 'OBSERVE' && reelReaction) {
        if (failObservation) {
          failObservation = false;
          reply({ error: 'Temporary model failure', emotion: null, reactions: [], nextCaptureAt: null, final: false });
          return;
        }
        reply({ emotion: 'impressed', level: 2, change: 'major', final: true, nextCaptureAt: null, reactions: [{
          text: reelLine, importance: 0.85, targetVideoId: message.videoId,
          preferredTiming: 'now', requiresQuietMoment: false, expiresAfterSeconds: 8, isCallback: false,
        }] });
        return;
      }
      reply(message.type === 'GET_MEMORY' ? { memory: [] } : { ok: true });
    },
  },
} });
document.body.innerHTML = '<style>body{margin:0;background:#17131f;font:16px system-ui;color:white}video{position:fixed;left:14%;top:10%;height:80vh;width:35vw;background:#30263d;border-radius:22px}#test-results{display:none}</style><ytd-reel-video-renderer is-active><h2 hidden>Menu test</h2><video></video></ytd-reel-video-renderer><pre id="test-results">RUNNING</pre>';
const host = document.createElement('div'); host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000';
const shadow = host.attachShadow({ mode: 'open' });
const sheet = document.createElement('style'); sheet.textContent = `${styles}\n${orbitStyles}`; shadow.append(sheet);
const root = document.createElement('div'); shadow.append(root); document.body.append(host);
const ctl = new Controller('youtube', host);
createRoot(root).render(createElement(App, { ctl }));
const button = (selector: string) => shadow.querySelector<HTMLButtonElement>(selector)!;
const featureKeys = ['voice', 'commentReactions', 'userCam', 'eyeTrack'] as const;
function checkFeatures(on: boolean) {
  assert(ctl.state.settings.enabled === on, 'master power must match');
  for (const key of featureKeys) assert(ctl.state.settings[key] === on, `${key} must follow master power`);
}
async function tapBuddy() { button('.sm-char-btn').click(); await wait(100); }
async function closeRing() {
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
  await wait(80);
}
function fits() {
  const ring = shadow.querySelector<HTMLElement>('.sm-orbit-menu')!.getBoundingClientRect();
  const buddy = button('.sm-char-btn').getBoundingClientRect();
  assert(ring.left >= 0 && ring.right <= innerWidth + 1, 'ring must fit horizontally');
  assert(ring.top >= 0 && ring.bottom <= innerHeight + 1, 'ring must fit vertically');
  assert(ring.width <= 321, 'ring should remain compact at no more than 320px');
  assert(Math.abs(ring.left + ring.width / 2 - buddy.left - buddy.width / 2) < 1, 'ring must surround the real buddy horizontally');
  assert(Math.abs(ring.top + ring.height / 2 - buddy.top - buddy.height / 2) < 1, 'ring must surround the real buddy vertically');
  assert(getComputedStyle(shadow.querySelector('.sm-orbit-menu')!).backgroundColor === 'rgba(0, 0, 0, 0)', 'ring must have no rectangular card background');
  assert(shadow.querySelectorAll('.sm-char-btn').length === 1, 'only one main buddy should exist');
  for (const target of shadow.querySelectorAll<HTMLButtonElement>('.sm-char-btn, .sm-ring-choice, .sm-orbit-avatar, .sm-orbit-close, .sm-orbit-calibrate, .sm-talk-launch:not(:disabled)')) {
    const rect = target.getBoundingClientRect();
    const hit = shadow.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    assert(hit?.closest('button') === target, `${target.getAttribute('aria-label') ?? target.textContent} must be reachable with a real pointer`);
  }
  assert(!shadow.querySelector('.sm-popover, .sm-orbit-features, .sm-orbit-steps, details'), 'extra menu and bottom controls must be removed');
}

async function run() {
  await ctl.init(); await wait(150); checkFeatures(false);
  assert(!shadow.querySelector('.sm-orbit-menu'), 'ring starts closed');
  const home = { ...ctl.state.position! };
  await tapBuddy(); fits();
  assert(shadow.querySelectorAll('.sm-orbit-avatar').length === 6, 'six avatars should be selectable');
  button('[aria-label="Personality"] button:nth-child(2)').click(); await wait(30);
  assert(ctl.state.settings.personality === 'hype', 'personality selection should work');
  button('[aria-label="Reaction frequency"] button:nth-child(3)').click(); await wait(30);
  assert(ctl.state.settings.frequency === 'chatty', 'frequency selection should work');
  button('[aria-label="Choose Sunny"]').click(); await wait(30);
  assert(ctl.state.settings.avatar === 'shiba' && shadow.querySelector('.sm-char-btn .sm-animal'), 'avatar selection should update the existing buddy');
  fits();
  await tapBuddy(); checkFeatures(true);
  assert(!shadow.querySelector('.sm-orbit-menu'), 'power action closes ring so comment visits can resume');
  assert(messages.some((message) => message.type === 'CAMERA_START' && message.gaze), 'wake must start camera with gaze enabled');
  assert(!messages.some((message) => message.type === 'OPEN_GAZE_CALIBRATION'), 'wake must not open calibration and camera permission tabs together');
  assert(!ctl.state.settings.demo, 'wake must use the live feed');
  await tapBuddy(); fits();
  button('.sm-orbit-calibrate').click(); await wait(30);
  assert(messages.some((message) => message.type === 'OPEN_GAZE_CALIBRATION'), 'calibration must stay accessible on the ring');
  await closeRing(); checkFeatures(true);
  assert(!shadow.querySelector('.sm-orbit-menu'), 'outside click closes ring without disabling features');
  for (const position of [{ fx: 0, fy: 0 }, { fx: .99, fy: 0 }, { fx: 0, fy: .99 }, { fx: .99, fy: .99 }]) {
    ctl.savePosition(position); await wait(700); await tapBuddy(); fits();
    assert(ctl.state.position?.fx === position.fx && ctl.state.position?.fy === position.fy, 'opening ring must preserve saved position');
    button('.sm-orbit-close').click(); await wait(700);
    checkFeatures(true);
  }
  ctl.savePosition(home); await wait(700);
  await tapBuddy(); await tapBuddy(); checkFeatures(false);
  assert(messages.some((message) => message.type === 'CAMERA_STOP'), 'sleep must stop camera');
  assert(messages.some((message) => message.type === 'CANCEL_ALL'), 'sleep must cancel pending reactions');
  assert(ctl.state.camera === 'off', 'camera state must be off while asleep');
  await tapBuddy(); await tapBuddy(); checkFeatures(true);
  await ctl.updateSettings({ voice: false, eyeTrack: false, userCam: false, commentReactions: false }); checkFeatures(true);
  await ctl.updateSettings({ avatar: 'cat', personality: 'hype', frequency: 'balanced' });
  notify({ type: 'GAZE', x: -3, y: -3 }); await wait(350);
  notify({ type: 'GAZE', x: -3, y: -3 });
  assert(!ctl.state.gaze.zone && !ctl.snapshot().userAway, 'uncalibrated gaze cannot suppress reel reactions');
  calibrated = true; notify({ type: 'GAZE_CALIBRATED' }); await wait(80);

  const user = { present: true, lookingAway: false, expression: 'neutral' as const, strength: 0, at: Date.now() };
  notify({ type: 'USER_SIGNAL', signal: user });
  const gaze = () => notify({ type: 'GAZE', x: -3, y: -3 });
  gaze(); await wait(350); gaze();
  assert(ctl.state.gaze.zone === 'off_screen', 'fixture must reproduce an off-screen gaze estimate');
  assert(!ctl.snapshot().userAway && ctl.snapshot().userEyesElsewhere, 'gaze must not overrule a present viewer facing the screen');
  notify({ type: 'USER_SIGNAL', signal: { ...user, lookingAway: true } });
  assert(ctl.snapshot().userAway, 'confirmed head turn must still defer reactions');
  notify({ type: 'USER_SIGNAL', signal: user });

  // Run the actual playback -> capture -> observation -> timing -> bubble path with a stubbed model.
  reelReaction = true;
  const video = document.querySelector('video')!;
  for (const [key, value] of Object.entries({ currentTime: 5, duration: 30, paused: false, ended: false })) {
    Object.defineProperty(video, key, { value, configurable: true, writable: true });
  }
  const gazeTimer = window.setInterval(gaze, 200);
  video.dispatchEvent(new Event('timeupdate')); await wait(500);
  assert(messages.some((message) => message.type === 'OBSERVE'), `playing reel must reach frame observation (snapshot=${JSON.stringify(ctl.snapshot())}, last messages=${messages.slice(-8).map(message => message.type).join(',')})`);
  video.currentTime = 9;
  video.dispatchEvent(new Event('timeupdate')); await wait(500);
  assert(messages.filter((message) => message.type === 'OBSERVE').length >= 2, 'a failed observation must retry on the same reel');
  assert(!ctl.state.bubble, 'gaze briefly defers the reel comment');
  await wait(2000); window.clearInterval(gazeTimer);
  assert(ctl.state.bubble?.text === 'That turned out beautifully.', 'reel comment must appear despite continuous drifting gaze');
  assert(ctl.state.mood === 'amused', 'reel delivery must update the buddy expression');
  ctl.hideBubble();
  await wait(1700);
  assert(!ctl.gazePoint && !ctl.state.gaze.zone && !ctl.state.gaze.look, 'stale gaze points must stop steering the buddy');
  await tapBuddy(); fits();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(50);
  assert(!shadow.querySelector('.sm-orbit-menu'), 'Escape must close ring'); checkFeatures(true);
  await tapBuddy(); fits();
  let pauses = 0, resumes = 0;
  video.pause = () => { pauses++; Object.defineProperty(video, 'paused', { value: true, configurable: true }); video.dispatchEvent(new Event('pause')); };
  video.play = async () => { resumes++; Object.defineProperty(video, 'paused', { value: false, configurable: true }); video.dispatchEvent(new Event('play')); };
  button('.sm-talk-launch').click(); await wait(80);
  assert(ctl.state.talk.active && ctl.state.talk.phase === 'listening' && !shadow.querySelector('.sm-orbit-menu'), 'one ring mic tap starts listening immediately');
  assert(!shadow.querySelector('.sm-talk-controls, .sm-talk-quick, .sm-talk-input, .sm-talk-record'), 'there is no chat panel, separate launcher or recording form');
  assert(pauses === 0 && !video.paused, 'the reel keeps playing during Talk');
  const micButton = button('.sm-talk-toggle');
  assert(micButton.getAttribute('aria-pressed') === 'true' && micButton.getBoundingClientRect().height >= 44, 'the avatar microphone exposes its state and has a large target');
  const micRect = micButton.getBoundingClientRect();
  assert(shadow.elementFromPoint(micRect.x + micRect.width / 2, micRect.y + micRect.height / 2)?.closest('button') === micButton, 'the microphone can be reached by a real pointer');
  const micBefore = micButton.getBoundingClientRect();
  const dragBuddy = button('.sm-char-btn');
  const buddyBefore = dragBuddy.getBoundingClientRect();
  const dx = buddyBefore.x > innerWidth / 2 ? -60 : 60;
  dragBuddy.setPointerCapture = () => {};
  dragBuddy.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, button: 0, clientX: buddyBefore.x + 15, clientY: buddyBefore.y + 15 }));
  await wait(30);
  dragBuddy.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 9, clientX: buddyBefore.x + 15 + dx, clientY: buddyBefore.y + 15 }));
  await wait(30);
  dragBuddy.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 })); await wait(700);
  const micAfter = micButton.getBoundingClientRect();
  assert(micAfter.x !== micBefore.x || micAfter.y !== micBefore.y, 'the microphone travels with the avatar');
  const countBeforeTalk = messages.filter((message) => message.type === 'OBSERVE').length;
  reelLine = 'The tiny detail makes it.';
  history.pushState({}, '', '/shorts/liveTalk01'); await wait(1400);
  assert(ctl.state.talk.active, 'Talk stays open across reel changes');
  assert(messages.filter((message) => message.type === 'OBSERVE').length > countBeforeTalk, 'reel analysis remains live during Talk');
  ctl.hideBubble();
  await ctl.updateSettings({ frequency: 'rare' });
  notify({ type: 'USER_SIGNAL', signal: { ...user, expression: 'surprised' } }); await wait(20);
  assert(ctl.state.mood === 'surprised', 'camera expressions remain live while listening');
  const latestSession = () => messages.filter((message): message is Extract<BgRequest, { type: 'TALK_START' }> => message.type === 'TALK_START').at(-1)!;
  const voice = (event: Extract<TabMessage, { type: 'TALK_EVENT' }>['event'], requestId = latestSession().context.requestId) => notify({ type: 'TALK_EVENT', requestId, event });
  const session = latestSession();
  voice({ type: 'caption', role: 'user', text: 'What do you think of the cake?' });
  voice({ type: 'status', state: 'thinking' });
  voice({ type: 'caption', role: 'assistant', text: 'I like the purple' }); await wait(30);
  assert(shadow.querySelector('.sm-bubble')?.textContent === 'I like the purple', 'partial live captions use the existing buddy bubble');
  voice({ type: 'caption', role: 'assistant', text: 'I like the purple frosting.' });
  voice({ type: 'status', state: 'speaking' }); await wait(40);
  assert(ctl.state.talk.phase === 'speaking' && ctl.state.mood === 'speaking', 'live playback animates the avatar');
  assert(!spoken, 'live replies do not invoke another speech synthesizer in the page');
  const startCount = messages.filter((message) => message.type === 'TALK_START').length;
  voice({ type: 'interrupted' }); await wait(30);
  assert(ctl.state.talk.phase === 'listening' && !ctl.state.talk.reply, 'speaking over the buddy clears its old reply and restores Listening');
  voice({ type: 'caption', role: 'assistant', text: 'Tell me more.' }); voice({ type: 'status', state: 'speaking' });
  voice({ type: 'status', state: 'listening' }); await wait(30);
  assert(messages.filter((message) => message.type === 'TALK_START').length === startCount, 'follow-up conversation uses the same continuous microphone session');
  const updated = messages.filter((message): message is Extract<BgRequest, { type: 'TALK_CONTEXT' }> => message.type === 'TALK_CONTEXT').at(-1)!;
  assert(updated.context.videoId === 'liveTalk01' && updated.context.requestId === session.context.requestId, 'swiping updates context inside the current voice session');
  button('.sm-talk-toggle').click();
  voice({ type: 'caption', role: 'assistant', text: 'Late answer' }, session.context.requestId); await wait(50);
  assert(!ctl.state.talk.active && !ctl.state.talk.reply, 'one microphone tap ends the session and ignores late captions');
  assert(!messages.some((message) => message.type === 'TELEMETRY' && JSON.stringify(message.event).includes('What do you think of the cake?')), 'conversation text stays out of telemetry');
  microphoneDenied = true;
  button('.sm-talk-toggle').click(); await wait(60);
  assert(!ctl.state.talk.active && ctl.state.talk.error?.includes('microphone'), 'permission errors stop the session and explain recovery');
  microphoneDenied = false;
  button('.sm-talk-toggle').click(); await wait(60);
  assert(ctl.state.talk.phase === 'listening', 'a tap retries after permission is granted');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(50);
  assert(!ctl.state.talk.active, 'Escape ends the live session');
  button('.sm-talk-toggle').click(); await wait(60);
  voice({ type: 'status', state: 'error', error: 'Live voice connection failed. Tap to reconnect.' }); await wait(30);
  assert(!ctl.state.talk.active && ctl.state.bubble?.text.includes('connection'), 'a lost connection stops the microphone session with a visible recovery message');
  ctl.hideBubble(); button('.sm-talk-toggle').click(); await wait(60);
  await ctl.updateSettings({ enabled: false }); await wait(50);
  assert(!ctl.state.talk.active && !shadow.querySelector('.sm-talk-toggle'), 'Sleep stops live Talk and removes the microphone');
  await ctl.updateSettings({ enabled: true, frequency: 'balanced' }); await wait(100);
  assert(pauses === 0 && resumes === 0, 'live Talk never alters reel playback');

  await tapBuddy(); fits();
  document.getElementById('test-results')!.textContent = 'PASS: compact ring, live reel reactions, one-tap streaming Talk, partial captions, voice animation, interruption, continuous follow-up, current reel context, permission recovery, connection and sleep cleanup.';
}
run().catch((error) => { ctl.destroy(); document.getElementById('test-results')!.textContent = `FAIL: ${error.stack ?? error}`; });
