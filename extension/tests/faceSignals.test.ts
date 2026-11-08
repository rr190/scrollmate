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
import { classify as classify2, FaceBaseline } from '../src/shared/faceSignals';

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

// ---- more expressions ----
test('classify: new expressions from face muscles (disgusted, scared, angry, confused)', () => {
  assert.equal(classify({ noseSneerLeft: 0.5, noseSneerRight: 0.5 }).expression, 'disgusted');
  assert.equal(classify({ mouthUpperUpLeft: 0.4, mouthUpperUpRight: 0.4, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 }).expression, 'disgusted');
  assert.equal(
    classify({ browInnerUp: 0.5, eyeWideLeft: 0.4, eyeWideRight: 0.4, mouthStretchLeft: 0.4, mouthStretchRight: 0.4, jawOpen: 0.4 }).expression,
    'scared',
    'fear beats surprise when the mouth is pulled sideways',
  );
  assert.equal(classify({ browDownLeft: 0.6, browDownRight: 0.6, mouthPressLeft: 0.4, mouthPressRight: 0.4 }).expression, 'angry');
  assert.equal(classify({ browOuterUpLeft: 0.6, browOuterUpRight: 0.05 }).expression, 'confused');
});

test('classify: the new rules do not steal the old expressions', () => {
  // smiling with a little nose wrinkle is still happy, not disgust
  assert.equal(classify({ mouthSmileLeft: 0.6, mouthSmileRight: 0.6, noseSneerLeft: 0.3, noseSneerRight: 0.3 }).expression, 'happy');
  // concentrating (brows down alone) is not anger
  assert.equal(classify({ browDownLeft: 0.6, browDownRight: 0.6 }).expression, 'neutral');
  // both brows up with an open jaw is still surprise
  assert.equal(classify({ jawOpen: 0.6, browOuterUpLeft: 0.5, browOuterUpRight: 0.5 }).expression, 'surprised');
});
