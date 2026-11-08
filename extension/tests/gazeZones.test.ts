import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gazeZone, RidgeGaze, screenToViewport, ZoneDwell } from '../src/shared/faceSignals';
import { decide, GAZE_HOLD_MS, TimingEngine, type Candidate, type PlaybackSnapshot } from '../src/shared/timing';

const vp = { w: 1500, h: 900 };
const rects = {
  video: { x: 500, y: 60, width: 450, height: 800 },
  comments: { x: 1000, y: 60, width: 480, height: 800 },
  mochi: { x: 60, y: 700, width: 100, height: 100 },
};

test('gaze zones: video, comments, Mochi, elsewhere, off screen', () => {
  assert.equal(gazeZone({ x: 700, y: 400 }, rects, vp), 'video');
  assert.equal(gazeZone({ x: 1200, y: 400 }, rects, vp), 'comments');
  assert.equal(gazeZone({ x: 100, y: 740 }, rects, vp), 'mochi');
  assert.equal(gazeZone({ x: 30, y: 660 }, rects, vp), 'mochi', 'Mochi gets a generous margin');
  assert.equal(gazeZone({ x: 300, y: 200 }, rects, vp), 'elsewhere');
  assert.equal(gazeZone({ x: 700, y: 1300 }, rects, vp), 'off_screen');
});

test('gaze zones: the current zone is sticky at its edge (no flicker)', () => {
  const edge = { x: 970, y: 400 }; // between video and comments
  assert.equal(gazeZone(edge, rects, vp), 'elsewhere');
  assert.equal(gazeZone(edge, rects, vp, 'video'), 'video');
  assert.equal(gazeZone(edge, rects, vp, 'comments'), 'comments');
});

test('zone dwell: a quick glance does not switch the zone; holding 0.3 s does', () => {
  const d = new ZoneDwell(300);
  assert.equal(d.update('video', 0), null);
  assert.equal(d.update('video', 310), 'video');
  assert.equal(d.update('comments', 400), null);
  assert.equal(d.update('video', 500), null); // glance over
  assert.equal(d.zone, 'video');
  assert.equal(d.update('comments', 600), null);
  assert.equal(d.update('comments', 950), 'comments');
});

test('screen -> viewport: subtracts the window position and browser toolbar', () => {
  const win = { screenX: 0, screenY: 0, outerWidth: 1920, outerHeight: 1040, innerWidth: 1920, innerHeight: 920 };
  assert.deepEqual(screenToViewport({ x: 0.5, y: 0.5 }, win, { width: 1920, height: 1080 }), { x: 960, y: 420 });
});

test('saved gaze model: round-trips through JSON (chrome.storage) with the same predictions', () => {
  const m = new RidgeGaze();
  const X = Array.from({ length: 40 }, (_, i) => [i % 7, (i * 3) % 11, i % 5]);
  const Y = X.map(([a, b, c]) => ({ x: 100 + 10 * a - 3 * c, y: 50 + 7 * b }));
  assert.ok(m.fit(X, Y, 1));
  const back = RidgeGaze.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
  assert.ok(back.trained);
  assert.deepEqual(back.predict([3, 4, 2]), m.predict([3, 4, 2]));
  assert.equal(RidgeGaze.fromJSON(null).trained, false);
});

test('timing: eyes on the comments hold a video reaction', () => {
  const snap: PlaybackSnapshot = {
    enabled: true, videoId: 'v1', playing: true, paused: false, ended: false, currentTime: 5, duration: 30, lastLoopAt: null,
    muted: false, audioQuiet: true, navTimes: [], userReadingComments: true,
  };
  const cand: Candidate = {
    id: 'c1', text: 'ha', importance: 0.9, targetVideoId: 'v1', createdAt: 0, preferredTiming: 'now',
    expiresAfterSeconds: 60, requiresQuietMoment: false, isCallback: false,
  } as Candidate;
  const mem = { lastSpokeAt: null, lastSpokeVideo: null, deliveredTexts: new Set<string>(), deliveredPerVideo: new Map<string, number>() };
  const verdict = decide(cand, snap, mem, { frequency: 'balanced', voiceEnabled: false }, 1000);
  assert.equal(verdict.decision, 'WAIT');
  assert.equal(verdict.code, 'user_reading_comments');
});

const liveReaction: Candidate = {
  id: 'live', text: 'That turned out beautifully.', importance: 0.85, targetVideoId: 'v1', createdAt: 1000,
  preferredTiming: 'now', expiresAfterSeconds: 8, requiresQuietMoment: false, isCallback: false,
};
const watching: PlaybackSnapshot = {
  enabled: true, videoId: 'v1', playing: true, paused: false, ended: false, currentTime: 5,
  duration: 30, lastLoopAt: null, muted: false, audioQuiet: null, navTimes: [],
};

test('drifting gaze briefly defers a live reel comment, then shows it before expiry', () => {
  for (const attention of [{ userEyesElsewhere: true }, { userReadingComments: true }]) {
    const engine = new TimingEngine({ frequency: 'balanced', voiceEnabled: true });
    const snapshot = { ...watching, ...attention };
    assert.equal(engine.propose(liveReaction, snapshot, 1000), null);
    assert.equal(engine.tick(snapshot, 1000 + GAZE_HOLD_MS - 1), null);
    const delivered = engine.tick(snapshot, 1000 + GAZE_HOLD_MS);
    assert.equal(delivered?.candidate.id, liveReaction.id);
    assert.equal(delivered?.mode, 'bubble');
  }
});

test('uncertain gaze uses a silent bubble even when playback is paused and voice is enabled', () => {
  const engine = new TimingEngine({ frequency: 'balanced', voiceEnabled: true });
  const snapshot = { ...watching, playing: false, paused: true, userEyesElsewhere: true };
  assert.equal(engine.propose(liveReaction, snapshot, 1000), null);
  assert.equal(engine.tick(snapshot, 1000 + GAZE_HOLD_MS)?.mode, 'bubble');
});

test('confirmed absence and deliberate comment reading still hold reel reactions', () => {
  for (const attention of [{ userAway: true }, { readingComments: true }, { commentRequestId: 'selected' }]) {
    const engine = new TimingEngine({ frequency: 'balanced', voiceEnabled: true });
    const snapshot = { ...watching, ...attention };
    assert.equal(engine.propose(liveReaction, snapshot, 1000), null);
    assert.equal(engine.tick(snapshot, 1000 + GAZE_HOLD_MS + 1), null);
  }
});

test('Rare still filters ordinary lines and gaze recovery does not revive stale reel comments', () => {
  const rare = new TimingEngine({ frequency: 'rare', voiceEnabled: true });
  assert.equal(rare.propose({ ...liveReaction, importance: 0.65 }, watching, 1000), null);
  assert.equal(rare.queue.length, 0);
  const engine = new TimingEngine({ frequency: 'balanced', voiceEnabled: true });
  assert.equal(engine.propose(liveReaction, { ...watching, userEyesElsewhere: true }, 1000), null);
  assert.equal(engine.tick({ ...watching, videoId: 'next-reel' }, 1000 + GAZE_HOLD_MS), null);
  assert.equal(engine.queue.length, 0);
});
