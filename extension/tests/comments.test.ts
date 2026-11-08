import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentPosition, companionSize, type CommentTarget } from '../src/content/comments';
import { TimingEngine, type Candidate, type PlaybackSnapshot } from '../src/shared/timing';

const snapshot: PlaybackSnapshot = {
  enabled: true, videoId: 'video-1', playing: true, paused: false, ended: false,
  currentTime: 0.5, duration: 30, lastLoopAt: null, muted: false, audioQuiet: null, navTimes: [],
  commentRequestId: 'request-1', commentReady: true,
};
const comment: Candidate = {
  id: 'reaction-1', createdAt: 1000, text: 'the door disagrees.', importance: 0.8,
  targetVideoId: 'video-1', targetCommentId: 'comment-1', commentRequestId: 'request-1',
  preferredTiming: 'now', requiresQuietMoment: false, expiresAfterSeconds: 8, isCallback: false,
};
const engine = () => new TimingEngine({ frequency: 'balanced', voiceEnabled: true });

test('selected comments deliver silently even early in a playing video', () => {
  const delivery = engine().propose(comment, snapshot, 1000);
  assert.equal(delivery?.mode, 'bubble');
});
test('closing or changing comment target drops queued reactions', () => {
  for (const commentRequestId of [null, 'request-2']) {
    const e = engine();
    assert.equal(e.propose(comment, { ...snapshot, commentRequestId }, 1000), null);
    assert.equal(e.queue.length, 0);
  }
});
test('travel delays delivery; a selected comment does not wait out the reading gap', () => {
  const e = engine();
  assert.equal(e.propose(comment, { ...snapshot, commentReady: false }, 1000), null);
  assert.equal(e.tick(snapshot, 1700)?.candidate.id, comment.id);
  // Deliberately chosen comment: shows right after the previous bubble, no 5 s gap.
  assert.equal(e.propose({ ...comment, id: 'other', text: 'a second line' }, snapshot, 1800)?.candidate.id, 'other');
});

test('a video reaction still waits out the reading gap after a comment bubble', () => {
  const e = engine();
  e.propose(comment, snapshot, 1000);
  const video: Candidate = { ...comment, id: 'video', text: 'video line', targetCommentId: undefined, commentRequestId: undefined };
  const free = { ...snapshot, commentRequestId: null, commentReady: false, currentTime: 10 };
  assert.equal(e.propose(video, free, 2000), null);
  assert.equal(e.tick(free, 6500)?.candidate.id, 'video');
});

test('Talk keeps reel reactions live as bubbles while reserving spoken audio', () => {
  const video: Candidate = { ...comment, targetCommentId: undefined, commentRequestId: undefined };
  const e = engine();
  const state = { ...snapshot, commentRequestId: null, currentTime: 5, paused: true, playing: false, conversationBusy: true };
  assert.equal(e.propose(video, state, 1000)?.mode, 'bubble');
  assert.equal(engine().propose(video, { ...state, conversationBusy: false }, 1000)?.mode, 'voice');
});

test('a low-importance comment line is still shown (the user picked this comment); a low video line is not', () => {
  assert.equal(engine().propose({ ...comment, importance: 0.1 }, snapshot, 1000)?.candidate.id, comment.id);
  const video: Candidate = { ...comment, importance: 0.1, targetCommentId: undefined, commentRequestId: undefined };
  assert.equal(engine().propose(video, { ...snapshot, commentRequestId: null }, 1000), null);
});
test('video reactions wait while reading; cancelling comments preserves the video queue', () => {
  const e = engine();
  const video = { ...comment, id: 'video-line', text: 'video reaction', targetCommentId: undefined, commentRequestId: undefined };
  e.propose(video, snapshot, 1000);
  e.propose(comment, { ...snapshot, commentReady: false }, 1100);
  assert.equal(e.queue.length, 2);
  e.cancelComment('request-1', snapshot, 1200);
  assert.deepEqual(e.queue.map((c) => c.id), ['video-line']);
});
test('hover intent prevents new video bubbles from starving a waiting comment selection', () => {
  const video = { ...comment, targetCommentId: undefined, commentRequestId: undefined };
  const e = engine();
  assert.equal(e.propose(video, { ...snapshot, commentRequestId: null, readingComments: true }, 1000), null);
  assert.equal(e.tick({ ...snapshot, commentRequestId: null, readingComments: false, currentTime: 5 }, 1100)?.candidate.id, video.id);
});
test('disabled, expired and wrong-video comment reactions stay silent', () => {
  for (const [c, s, now] of [
    [comment, { ...snapshot, enabled: false }, 1000],
    [comment, snapshot, 10000],
    [comment, { ...snapshot, videoId: 'other-video' }, 1000],
  ] as const) assert.equal(engine().propose(c, s, now), null);
});
test('placement stays outside the panel and refuses a full-width panel', () => {
  const target: CommentTarget = { id: 'c', text: 'text', rect: { x: 1020, y: 250, width: 280, height: 50 }, panelRect: { x: 980, y: 0, width: 460, height: 900 } };
  const left = commentPosition(target, 1440, 900)!;
  assert.equal(left.side, 'left');
  assert.ok(left.x + companionSize(1440) < target.panelRect.x);
  const right = commentPosition({ ...target, panelRect: { x: 0, y: 0, width: 400, height: 900 } }, 1440, 900)!;
  assert.equal(right.side, 'right');
  assert.ok(right.x > 400);
  assert.equal(commentPosition({ ...target, panelRect: { x: 0, y: 0, width: 500, height: 900 } }, 500, 900), null);
});
