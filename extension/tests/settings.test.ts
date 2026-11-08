import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySettings } from '../src/shared/settings';
import { DEFAULT_SETTINGS } from '../src/shared/types';

const features = ['voice', 'commentReactions', 'userCam'] as const;
test('master wake enables every live feature without turning on demo mode', () => {
  const awake = applySettings(DEFAULT_SETTINGS, { enabled: true });
  for (const feature of features) assert.equal(awake[feature], true);
  assert.equal(awake.demo, false); assert.equal(awake.demoLive, false);
});
test('master sleep turns every live feature off and keeps personality/avatar preferences', () => {
  const awake = applySettings({ ...DEFAULT_SETTINGS, personality: 'hype', avatar: 'cat' }, { enabled: true });
  const asleep = applySettings(awake, { enabled: false });
  for (const feature of features) assert.equal(asleep[feature], false);
  assert.equal(asleep.personality, 'hype'); assert.equal(asleep.avatar, 'cat');
});
test('all features stay on while awake, including after preference changes', () => {
  const awake = applySettings(DEFAULT_SETTINGS, { enabled: true });
  const updated = applySettings(awake, { voice: false, commentReactions: false, userCam: false, personality: 'chill' });
  for (const feature of features) assert.equal(updated[feature], true);
  assert.equal(updated.personality, 'chill');
});

test('feature patches cannot start capabilities while asleep', () => {
  const asleep = applySettings(DEFAULT_SETTINGS, { voice: true, userCam: true });
  for (const feature of features) assert.equal(asleep[feature], false);
});
