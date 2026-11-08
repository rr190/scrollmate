import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimingEngine, type Candidate, type PlaybackSnapshot } from '../src/shared/timing';

const snap = (over: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({
  enabled: true, videoId: 'reel', playing: false, paused: true, ended: false, currentTime: 5, duration: 20,
  lastLoopAt: null, muted: false, audioQuiet: null, navTimes: [], ...over,
});
let n = 0;
const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: `c${++n}`, text: `line ${n}`, importance: 0.9, targetVideoId: 'reel', preferredTiming: 'after_video',
  expiresAfterSeconds: 30, requiresQuietMoment: false, isCallback: false, createdAt: 0, ...over,
});

test('a visible bubble holds the next video reaction until it is gone', () => {
  const e = new TimingEngine({ frequency: 'chatty', voiceEnabled: false });
  assert.equal(e.propose(cand(), snap({ bubbleVisible: true }), 1000), null);
  assert.equal(e.log.at(-1)?.reason.startsWith('previous line still on screen'), true);
  assert.ok(e.tick(snap({ bubbleVisible: false }), 1200), 'delivered once the bubble is gone');
});

test('a selected comment is not held by an older bubble', () => {
  const e = new TimingEngine({ frequency: 'balanced', voiceEnabled: false });
  const d = e.propose(cand({ targetCommentId: 'x', commentRequestId: 'r1' }), snap({ bubbleVisible: true, commentRequestId: 'r1', commentReady: true }), 0);
  assert.equal(d?.reason, 'reacting beside the visible selected comment');
});

test('at most one delivery per tick; the rest are kept, never marked delivered unseen', () => {
  const e = new TimingEngine({ frequency: 'chatty', voiceEnabled: false });
  e.queue.push(cand({ text: 'a', importance: 0.9 }), cand({ text: 'b', importance: 0.8, isCallback: true, targetVideoId: 'old' }));
  const d = e.tick(snap(), 0);
  assert.equal(d?.candidate.text, 'a');
  assert.equal(e.queue.length, 1);
  assert.ok(e.tick(snap(), 10_000), 'the second line is still deliverable after the reading gap');
});

test('the log total keeps counting after the log is trimmed or cleared', () => {
  const e = new TimingEngine({ frequency: 'balanced', voiceEnabled: false });
  for (let i = 0; i < 1100; i++) e.propose(cand({ importance: 0.01 }), snap(), i);
  assert.equal(e.log.length, 1000);
  assert.equal(e.logTotal, 1100);
  e.clear();
  e.propose(cand({ importance: 0.01 }), snap(), 0);
  assert.equal(e.logTotal, 1101);
});
