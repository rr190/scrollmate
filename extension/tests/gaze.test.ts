import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BlinkDetector,
  denseTargets,
  GAZE_LANDMARKS,
  gazeFeatureVector,
  KalmanGaze,
  ninePointTargets,
  RidgeGaze,
  fineTuneTargets,
  varianceOf,
  EYETRAX_LEFT_EYE,
  EYETRAX_RIGHT_EYE,
  EYETRAX_MUTUAL,
  gazeFeatureVectorPlus,
  isRealBlink,
  bottomHeavyTargets,
  type Pt3,
} from '../src/shared/faceSignals';

// deterministic pseudo-random
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function face(): Pt3[] {
  const lm: Pt3[] = Array.from({ length: 478 }, () => ({ x: 0.3 + rnd() * 0.4, y: 0.3 + rnd() * 0.4, z: (rnd() - 0.5) * 0.05 }));
  lm[33] = { x: 0.4, y: 0.45, z: 0 };
  lm[263] = { x: 0.6, y: 0.45, z: 0 };
  lm[10] = { x: 0.5, y: 0.2, z: 0 };
  return lm;
}

test('gaze features: same face moved and resized in the image gives the same features', () => {
  const a = face();
  const b = a.map((p) => ({ x: 0.1 + p.x * 0.6, y: 0.2 + p.y * 0.6, z: (p.z ?? 0) * 0.6 })); // move + shrink (further away)
  const fa = gazeFeatureVector(a, 1)!, fb = gazeFeatureVector(b, 1)!;
  assert.equal(fa.length, GAZE_LANDMARKS.length * 3 + 3);
  const maxDiff = Math.max(...fa.map((v, i) => Math.abs(v - fb[i])));
  assert.ok(maxDiff < 1e-9, `max difference ${maxDiff}`);
});

test('ridge: learns a linear map at EyeTrax size (486 features, ~270 frames = 9 dots at 30 fps)', () => {
  const d = GAZE_LANDMARKS.length * 3 + 3;
  const wx = Array.from({ length: d }, () => rnd() - 0.5), wy = Array.from({ length: d }, () => rnd() - 0.5);
  const sample = () => {
    const x = Array.from({ length: d }, () => rnd());
    return { x, y: { x: 800 + x.reduce((s, v, i) => s + v * wx[i], 0) * 40, y: 450 + x.reduce((s, v, i) => s + v * wy[i], 0) * 40 } };
  };
  const train = Array.from({ length: 270 }, sample), test2 = Array.from({ length: 40 }, sample);
  const m = new RidgeGaze();
  const t0 = performance.now();
  assert.ok(m.fit(train.map((s) => s.x), train.map((s) => s.y), 1.0));
  const ms = performance.now() - t0;
  const errTrain = train.reduce((s, p) => { const q = m.predict(p.x)!; return s + Math.hypot(q.x - p.y.x, q.y - p.y.y); }, 0) / train.length;
  assert.ok(errTrain < 5, `training error ${errTrain.toFixed(2)} px`);
  assert.ok(ms < 1500, `fit took ${ms.toFixed(0)} ms`);
  void test2;
});

test('kalman: smooths a jittery fixation once tuned with the calibration error', () => {
  const k = new KalmanGaze(50, 0.2, 0.25);
  k.setMeasurementNoise(60 ** 2, 60 ** 2); // ~60 px of noise, as estimated from calibration
  const raw: number[] = [], out: number[] = [];
  for (let i = 0; i < 200; i++) {
    const m = { x: 500 + (rnd() - 0.5) * 200, y: 300 };
    raw.push(m.x);
    out.push(k.step(m).x);
  }
  const sd = (a: number[]) => { const tail = a.slice(50); const mu = tail.reduce((s, v) => s + v, 0) / tail.length; return Math.sqrt(tail.reduce((s, v) => s + (v - mu) ** 2, 0) / tail.length); };
  assert.ok(sd(out) < sd(raw) * 0.6, `smoothed sd ${sd(out).toFixed(1)} vs raw ${sd(raw).toFixed(1)}`);
});

test('blink detector: an eye closing below 80% of the recent average is a blink', () => {
  const b = new BlinkDetector();
  for (let i = 0; i < 20; i++) assert.equal(b.update(0.3), false);
  assert.equal(b.update(0.1), true);
  assert.equal(b.update(0.3), false);
});

test('calibration layouts: 9 points centre-first at 10/90 %, 25 dense points', () => {
  const p = ninePointTargets();
  assert.deepEqual(p[0], { x: 0.5, y: 0.5 });
  assert.equal(p.length, 9);
  assert.ok(p.every((q) => q.x >= 0.1 && q.x <= 0.9 && q.y >= 0.1 && q.y <= 0.9));
  assert.equal(denseTargets().length, 25);
});

test('exact EyeTrax landmark sets: 76 + 76 + 9 = 161 landmarks -> 486 features', () => {
  assert.equal(EYETRAX_LEFT_EYE.length, 76);
  assert.equal(EYETRAX_RIGHT_EYE.length, 76);
  assert.deepEqual([...EYETRAX_MUTUAL], [4, 10, 151, 9, 152, 234, 454, 58, 288]);
  assert.equal(GAZE_LANDMARKS.length, 161);
  assert.equal(GAZE_LANDMARKS.length * 3 + 3, 486);
  assert.ok(EYETRAX_LEFT_EYE.includes(468) && EYETRAX_RIGHT_EYE.includes(473), 'irises included');
});

test('EyeTrax tune: targets at (W/2, H/4), (W/4, 3H/4), (3W/4, 3H/4); variance per axis, zeros -> 1e-4', () => {
  assert.deepEqual(fineTuneTargets(1920, 1080), [{ x: 960, y: 270 }, { x: 480, y: 810 }, { x: 1440, y: 810 }]);
  assert.deepEqual(varianceOf([{ x: 0, y: 5 }, { x: 10, y: 5 }]), { x: 25, y: 1e-4 });
  assert.equal(varianceOf([{ x: 1, y: 1 }]), null);
});

test('bottom boost: looking down (low EAR, eyelids open) is not a blink; real blink still is', () => {
  assert.equal(isRealBlink(true, { eyeBlinkLeft: 0.2, eyeBlinkRight: 0.25, eyeLookDownLeft: 0.7 }), false);
  assert.equal(isRealBlink(true, { eyeBlinkLeft: 0.8, eyeBlinkRight: 0.9 }), true);
  assert.equal(isRealBlink(false, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }), false);
  assert.equal(isRealBlink(true, null), true);
});

test('bottom boost: 498 features (486 + 12 eye blendshapes) and 3 extra low calibration dots', () => {
  const f = gazeFeatureVectorPlus(face(), { eyeLookDownLeft: 0.6 }, 1)!;
  assert.equal(f.length, 498);
  assert.equal(f[486], 0.6);
  const t = bottomHeavyTargets();
  assert.equal(t.length, 12);
  assert.equal(t.filter((p) => p.y >= 0.7).length, 6);
});
