import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMediapipeInfo } from '../src/camera/quietMediapipe';

test('MediaPipe start-up lines are informational; real errors are not', () => {
  assert.ok(isMediapipeInfo(['INFO: Created TensorFlow Lite XNNPACK delegate for CPU.']));
  assert.ok(isMediapipeInfo(['W1108 07:20:27.896999 2191552 face_landmarker_graph.cc:180] Sets FaceBlendshapesGraph acceleration to xnnpack by default.']));
  assert.ok(isMediapipeInfo(['I1108 07:20:28.017999 2191552 gl_context.cc:357] GL version: 3.0']));
  assert.ok(!isMediapipeInfo(['E1108 07:20:28.017999 2191552 gl_context.cc:99] Failed to create context']));
  assert.ok(!isMediapipeInfo(['Camera failed: NotAllowedError']));
  assert.ok(!isMediapipeInfo([new Error('INFO: not a string')]));
});
