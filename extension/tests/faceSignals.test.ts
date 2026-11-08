import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, FaceSignalTracker, headAngles } from '../src/shared/faceSignals';

const face = (o: Record<string, number>) => ({ blendshapes: o });

test('classify: laugh, smile, surprise, sad, neutral', () => {
  assert.equal(classify({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8, jawOpen: 0.4 }).expression, 'laughing');
  assert.equal(classify({ mouthSmileLeft: 0.6, mouthSmileRight: 0.6, jawOpen: 0.05 }).expression, 'happy');
  assert.equal(classify({ jawOpen: 0.6, browInnerUp: 0.6 }).expression, 'surprised');
  assert.equal(classify({ mouthFrownLeft: 0.5, mouthFrownRight: 0.5, browInnerUp: 0.5 }).expression, 'sad');
  assert.equal(classify({ jawOpen: 0.1 }).expression, 'neutral');
});

test('tracker: an expression must hold briefly before it is reported (no flicker)', () => {
  const t = new FaceSignalTracker(250, 1200);
  const laugh = face({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8, jawOpen: 0.4 });
  assert.equal(t.update(face({}), 0)?.present, true); // face appears
  assert.equal(t.update(laugh, 100), null); // too soon
  assert.equal(t.update(laugh, 400)?.expression, 'laughing'); // held 300 ms
  assert.equal(t.update(laugh, 500), null); // no change -> no event
});

test('tracker: away only after the face is missing or turned for a while', () => {
  const t = new FaceSignalTracker(250, 1200);
  t.update(face({}), 0);
  assert.equal(t.update({ blendshapes: null }, 500), null); // brief dropout ignored
  assert.equal(t.update({ blendshapes: null }, 1800)?.lookingAway, true);
  assert.equal(t.update(face({}), 1900)?.lookingAway, false); // back
  t.update({ blendshapes: {}, yawDeg: 45 }, 2000);
  assert.equal(t.update({ blendshapes: {}, yawDeg: 45 }, 3300)?.lookingAway, true); // head turned away
});

test('tracker: no face from the start is never reported as present', () => {
  const t = new FaceSignalTracker(250, 1200);
  for (const now of [0, 500, 2000]) {
    const sig = t.update({ blendshapes: null }, now);
    if (sig) assert.equal(sig.present, false); // may report "away", never "present"
  }
  assert.equal(t.current.present, false);
  assert.equal(t.current.lookingAway, true); // nobody watching -> comments are held
});

test('headAngles: identity matrix is straight ahead', () => {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const a = headAngles(id);
  assert.ok(Math.abs(a.yawDeg) < 1e-9 && Math.abs(a.pitchDeg) < 1e-9);
});

// ---- personal baseline (your resting face) ----
import { classify as classify2, FaceBaseline, GazeCalibrator, irisPosition, solveLeastSquares, uncalibratedGaze } from '../src/shared/faceSignals';

test('baseline: a resting frown is not "sad"; a real frown on top of it is', () => {
  const rest = { mouthFrownLeft: 0.32, mouthFrownRight: 0.32 }; // many people look like this at rest
  const b = new FaceBaseline(5);
  for (let i = 0; i < 5; i++) b.observe(rest, 'neutral');
  assert.equal(b.ready, true);
  assert.equal(classify2(rest, b.value).expression, 'neutral');
  assert.equal(classify2({ mouthFrownLeft: 0.68, mouthFrownRight: 0.68 }, b.value).expression, 'sad'); // clearly stronger frown
  assert.equal(classify2({ mouthFrownLeft: 0.55, mouthFrownRight: 0.55, browInnerUp: 0.3 }, b.value).expression, 'sad'); // frown + raised inner brows
});

test('baseline: only adapts while the face is neutral, and caps at 0.5', () => {
  const b = new FaceBaseline(1, 0.5);
  b.observe({ mouthSmileLeft: 0.9, mouthSmileRight: 0.9 }, 'neutral');
  assert.equal(b.value.smile, 0.5); // a grin at the start can't become "rest"
  b.observe({ mouthSmileLeft: 0.0, mouthSmileRight: 0.0 }, 'happy');
  assert.equal(b.value.smile, 0.5); // not neutral -> no learning
});

// ---- eye tracking ----
test('least squares recovers a known linear map', () => {
  const X = [[1, 0, 1], [0, 1, 1], [1, 1, 1], [2, 1, 1], [0, 2, 1]];
  const y = X.map(([a, b]) => 3 * a - 2 * b + 0.5);
  const w = solveLeastSquares(X, y)!;
  assert.ok(Math.abs(w[0] - 3) < 1e-6 && Math.abs(w[1] + 2) < 1e-6 && Math.abs(w[2] - 0.5) < 1e-6);
});

test('gaze calibrator fits 9 targets and predicts a new point', () => {
  const c = new GazeCalibrator();
  const featuresFor = (sx: number, sy: number) => [(0.5 - sx) / 4, (sy - 0.45) / 3, 0, 0, 1]; // a synthetic "eye"
  for (const sx of [0.1, 0.5, 0.9]) for (const sy of [0.1, 0.5, 0.9]) c.add(featuresFor(sx, sy), { x: sx, y: sy });
  // Head angle columns are all zero here (no head movement): the default ridge keeps the fit solvable.
  const err = c.fit()!;
  assert.ok(err !== null && err < 0.02, `calibration error ${err}`);
  const p = c.predict(featuresFor(0.3, 0.7))!;
  assert.ok(Math.abs(p.x - 0.3) < 0.02 && Math.abs(p.y - 0.7) < 0.02);
});

test('iris position: centred iris -> 0.5, 0.5; uncalibrated gaze -> screen centre', () => {
  const lm = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  const eye = (a: number, b: number, t: number, d: number, i: number, x0: number) => {
    lm[a] = { x: x0, y: 0.5 }; lm[b] = { x: x0 + 0.1, y: 0.5 }; lm[t] = { x: x0 + 0.05, y: 0.48 }; lm[d] = { x: x0 + 0.05, y: 0.52 }; lm[i] = { x: x0 + 0.05, y: 0.5 };
  };
  eye(33, 133, 159, 145, 468, 0.3);
  eye(362, 263, 386, 374, 473, 0.6);
  const p = irisPosition(lm)!;
  assert.ok(Math.abs(p.x - 0.5) < 1e-9 && Math.abs(p.y - 0.5) < 1e-9);
  const g = uncalibratedGaze(p, 0, 0);
  assert.ok(Math.abs(g.x - 0.5) < 1e-9);
});
