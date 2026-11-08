import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEELING_RULES, FeelingNoticer, type FeelingInput } from '../src/shared/feelings';

const base = (over: Partial<FeelingInput> = {}): FeelingInput => ({
  now: 0, enabled: true, videoId: 'v1', shortStartedAt: -10_000, present: true, lookingAway: false,
  expression: 'happy', strength: 0.8, busy: false, ...over,
});

/** Hold one expression from `from` to `to` ms, ticking every 150 ms like the controller. Returns the first notice. */
function hold(n: FeelingNoticer, from: number, to: number, over: Partial<FeelingInput> = {}) {
  for (let t = from; t <= to; t += 150) {
    const r = n.update(base({ now: t, ...over }));
    if (r) return { r, t };
  }
  return null;
}

test('notices a feeling held for 1.2 s, not a 0.5 s flash', () => {
  const n = new FeelingNoticer();
  n.update(base({ now: 0, expression: 'neutral' }));
  assert.equal(hold(n, 150, 650), null, 'brief smile');
  n.update(base({ now: 800, expression: 'neutral' }));
  const hit = hold(n, 950, 3000);
  assert.equal(hit?.r, 'happy');
  assert.ok(hit!.t - 950 >= FEELING_RULES.holdMs);
});

test('never notices neutral or a weak expression', () => {
  assert.equal(hold(new FeelingNoticer(), 0, 5000, { expression: 'neutral' }), null);
  assert.equal(hold(new FeelingNoticer(), 0, 5000, { strength: 0.3 }), null);
});

test('waits for a good moment: no bubble, no visit, child present, Short settled', () => {
  for (const over of [{ busy: true }, { lookingAway: true }, { present: false }, { enabled: false }, { videoId: null }]) {
    assert.equal(hold(new FeelingNoticer(), 0, 5000, over), null, JSON.stringify(over));
  }
  const n = new FeelingNoticer();
  const hit = hold(n, 0, 8000, { shortStartedAt: 0 });
  assert.ok(hit && hit.t >= FEELING_RULES.afterSwipeMs, 'not in the first 4 s of a Short');
});

test('rare: one per Short, 90 s between notices, 4 min before the same feeling', () => {
  const n = new FeelingNoticer();
  assert.ok(hold(n, 0, 2000));
  n.done();
  assert.equal(hold(n, 2000, 30_000, { expression: 'surprised' }), null, 'one per Short');
  assert.equal(hold(n, 30_000, 60_000, { videoId: 'v2', expression: 'surprised' }), null, 'within 90 s');
  const second = hold(n, 95_000, 99_000, { videoId: 'v3', expression: 'surprised' });
  assert.equal(second?.r, 'surprised', 'a different feeling after 90 s');
  n.done();
  assert.equal(hold(n, 200_000, 205_000, { videoId: 'v4', expression: 'happy' }), null, 'same feeling within 4 min');
  assert.equal(hold(n, 250_000, 255_000, { videoId: 'v5', expression: 'happy' })?.r, 'happy');
});

test('no second request while one is in flight', () => {
  const n = new FeelingNoticer();
  assert.ok(hold(n, 0, 2000));
  assert.equal(n.pending, true);
  assert.equal(hold(n, 100_000, 105_000, { videoId: 'v2', expression: 'sad' }), null, 'still waiting for the first line');
  n.done();
  assert.equal(hold(n, 105_000, 110_000, { videoId: 'v2', expression: 'sad' })?.r, 'sad');
});

test('a reel comment that already blended the feeling counts as this Short\'s notice', () => {
  const n = new FeelingNoticer();
  n.markNoticed('v1', 'laughing', 0);
  assert.equal(hold(n, 0, 10_000, { expression: 'laughing' }), null, 'no separate "noticed" line on that Short');
  assert.equal(hold(n, 10_000, 60_000, { videoId: 'v2', expression: 'happy' }), null, 'the 90 s gap started');
  assert.equal(hold(n, 95_000, 99_000, { videoId: 'v3', expression: 'happy' })?.r, 'happy');
});

test('demo mode: noticed sooner (0.8 s), over a speech bubble, every 30 s', () => {
  const n = new FeelingNoticer();
  n.demo = true;
  const hit = hold(n, 0, 3000, { busy: true });
  assert.equal(hit?.r, 'happy', 'a bubble on screen does not block it in demo mode');
  assert.ok(hit!.t < FEELING_RULES.holdMs, `noticed after ${hit!.t} ms`);
  n.done();
  assert.equal(hold(n, 3000, 20_000, { videoId: 'v2', expression: 'surprised' }), null, 'still a short gap');
  assert.equal(hold(n, 31_000, 35_000, { videoId: 'v3', expression: 'surprised' })?.r, 'surprised');
});

test('mirror pop: every noticeable feeling has a short "I see you" text', async () => {
  const { MIRROR_POP, NOTICEABLE } = await import('../src/shared/feelings');
  for (const f of NOTICEABLE) assert.ok(MIRROR_POP[f], f);
  assert.equal(MIRROR_POP.neutral, undefined);
});
