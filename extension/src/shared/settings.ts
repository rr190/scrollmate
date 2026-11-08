import { DEFAULT_SETTINGS, type Settings } from './types';

/** Every live capability follows the buddy's single power switch. */
export function applySettings(current: Settings, patch: Partial<Settings>): Settings {
  const values = { ...DEFAULT_SETTINGS, ...current, ...patch };
  const next = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [key, values[key as keyof Settings]])) as unknown as Settings;
  return { ...next, voice: next.enabled, commentReactions: next.enabled, userCam: next.enabled };
}
