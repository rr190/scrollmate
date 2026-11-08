import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PACE_PX, PARK_AFTER_DRAG_MS, pickStep, RoamPlanner, roamArea, STEP_PX, TOP_BAR, walkMs,
  type RoamInput,
} from '../src/content/roam';

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const vp = { w: 1500, h: 900 };
const size = 96;
const area = roamArea(vp, size);
const video = { x: 520, y: 70, width: 430, height: 780 };
const comments = { x: 1000, y: 70, width: 480, height: 780 };

const base = (over: Partial<RoamInput> = {}): RoamInput => ({
  now: 0, enabled: true, reducedMotion: false, hold: false, mood: 'watching', pos: { x: 850, y: 200 },
  rects: { video, comments }, area, size, ...over,
});

test('area: on screen and below the top bar', () => {
  assert.ok(area.y >= TOP_BAR);
  assert.ok(area.x + area.width + size <= vp.w);
  assert.ok(area.y + area.height + size <= vp.h);
});

test('steps: small, left or right only, never far from its spot', () => {
  const anchor = { x: 800, y: 300 };
  let pos = { ...anchor }, moved = 0, left = 0, right = 0;
  for (let i = 0; i < 500; i++) {
    const p = pickStep(pos, anchor, area, rnd);
    if (!p) continue;
    moved++;
    assert.equal(p.y, pos.y, 'no vertical movement');
    const dx = p.x - pos.x;
    assert.ok(Math.abs(dx) <= STEP_PX[1], `step ${dx.toFixed(0)} px`);
    assert.ok(Math.abs(p.x - anchor.x) <= PACE_PX, `strayed ${(p.x - anchor.x).toFixed(0)} px`);
    if (dx < 0) left++; else right++;
    pos = p;
  }
  assert.ok(moved > 250, `moved ${moved}/500`);
  assert.ok(left > 80 && right > 80, `both directions (${left} left, ${right} right)`);
});

test('step time: a slow shuffle (~30 px/s, at least 0.6 s)', () => {
  assert.equal(walkMs({ x: 0, y: 0 }, { x: 10, y: 0 }), 600);
  assert.equal(walkMs({ x: 0, y: 0 }, { x: 30, y: 0 }), 1000);
  assert.equal(walkMs({ x: 0, y: 0 }, { x: 400, y: 0 }, 200), 2000);
});

test('planner: holds still for a bubble/drag/visit, sleep, reduced motion, roam off', () => {
  for (const over of [{ hold: true }, { mood: 'sleeping' }, { reducedMotion: true }, { enabled: false }]) {
    const pl = new RoamPlanner(() => 0.9);
    assert.equal(pl.tick(base({ ...over, now: 60_000 })), null, JSON.stringify(over));
  }
});

test('planner: parked for 30 s after a drag, then steps again', () => {
  const pl = new RoamPlanner(() => 0.9);
  pl.park(0);
  assert.equal(pl.tick(base({ now: PARK_AFTER_DRAG_MS - 1 })), null);
  const s = pl.tick(base({ now: PARK_AFTER_DRAG_MS + 1 }));
  assert.equal(s?.why, 'step');
  assert.ok(Math.abs(s!.target.x - 850) <= STEP_PX[1]);
});

test('planner: a reaction does not send it walking (small steps only)', () => {
  const pl = new RoamPlanner(() => 0.9);
  pl.park(-PARK_AFTER_DRAG_MS);
  const s = pl.tick(base({ now: 100, mood: 'laughing' }));
  assert.ok(!s || (s.why === 'step' && Math.abs(s.target.x - 850) <= STEP_PX[1]));
});

