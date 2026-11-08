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
let failObservation = true;
const notify = (message: TabMessage) => listeners.forEach((listener) => listener(message));
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
      if (message.type === 'CAMERA_START') setTimeout(() => notify({ type: 'CAMERA_STATUS', state: 'on' }), 20);
      if (message.type === 'CAPTURE_FRAME') { reply({ ok: true, data: 'stubbed-local-frame' }); return; }
      if (message.type === 'OBSERVE' && reelReaction) {
        if (failObservation) {
          failObservation = false;
          reply({ error: 'Temporary model failure', emotion: null, reactions: [], nextCaptureAt: null, final: false });
          return;
        }
        reply({ emotion: 'impressed', level: 2, change: 'major', final: true, nextCaptureAt: null, reactions: [{
          text: 'That turned out beautifully.', importance: 0.85, targetVideoId: message.videoId,
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
  for (const target of shadow.querySelectorAll<HTMLButtonElement>('.sm-char-btn, .sm-ring-choice, .sm-orbit-avatar, .sm-orbit-close, .sm-orbit-calibrate')) {
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
  document.getElementById('test-results')!.textContent = 'PASS: buddy-centred ring, master features, calibration, preferences, viewport fit, and reel playback -> frame observation -> reaction bubble despite drifting gaze.';
}
run().catch((error) => { ctl.destroy(); document.getElementById('test-results')!.textContent = `FAIL: ${error.stack ?? error}`; });
