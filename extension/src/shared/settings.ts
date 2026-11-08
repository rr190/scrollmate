import type { Settings } from './types';

/** Every live capability follows the buddy's single power switch. */
export function applySettings(current: Settings, patch: Partial<Settings>): Settings {
  const next = { ...current, ...patch };
  return { ...next, voice: next.enabled, commentReactions: next.enabled, userCam: next.enabled, eyeTrack: next.enabled };
}
