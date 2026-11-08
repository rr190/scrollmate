import { useEffect, useState } from 'react';
import type { AvatarKind } from '../shared/types';
import { ScrollMateCharacter } from './avatars/ScrollMateCharacter';
import { MochiAnimated } from './mochi/MochiAnimated';
import type { Mood } from './controller';
import { AnimalCharacter } from './avatars/AnimalCharacter';
import { AvatarMotion } from './avatars/AvatarMotion';

/** Which drawing to use for the companion. Both react to the same moods. */
export const AVATARS: { id: AvatarKind; label: string; hint: string; aspect: number }[] = [
  { id: 'mochi', label: 'Companio', hint: 'A round friend with a sprout', aspect: 0.91 }, // viewBox 260x236
  { id: 'scrollmate', label: 'ScrollMate', hint: 'A buddy with headphones', aspect: 0.86 }, // viewBox 140x120
  { id: 'cat', label: 'Miso', hint: 'A little cat', aspect: 0.95 },
  { id: 'bunny', label: 'Clover', hint: 'A little bunny', aspect: 0.95 },
  { id: 'panda', label: 'Bao', hint: 'A little panda', aspect: 0.95 },
  { id: 'shiba', label: 'Sunny', hint: 'A little shiba', aspect: 0.95 },
];

export function avatarAspect(kind: AvatarKind): number {
  return AVATARS.find((a) => a.id === kind)?.aspect ?? 0.91;
}

/** Background states that can flicker; emotions and speaking always show at once. */
const STATE_MOODS = new Set<Mood>(['idle', 'watching', 'thinking', 'amused']);
export const STEADY_MS = 350;

/**
 * Between background states (idle / watching / thinking / amused), a new state must stay requested for STEADY_MS
 * before it's shown, so quick watching -> thinking -> watching flips never swap the face at all.
 * Reactions (emotions) and speaking are never delayed.
 */
export function useSteadyMood(mood: Mood): Mood {
  const [shown, setShown] = useState(mood);
  useEffect(() => {
    if (mood === shown) return;
    if (!(STATE_MOODS.has(mood) && STATE_MOODS.has(shown))) {
      setShown(mood);
      return;
    }
    const t = setTimeout(() => setShown(mood), STEADY_MS);
    return () => clearTimeout(t); // the request changed again before it settled: don't show it
  }, [mood, shown]);
  return shown;
}

/** Optional facing direction for the walking animation, -1..1 per axis. */
export function Avatar({ kind, mood: rawMood, look = null }: { kind: AvatarKind; mood: Mood; look?: { x: number; y: number } | null }) {
  const mood = useSteadyMood(rawMood);
  if (kind === 'mochi') return <MochiAnimated mood={mood} look={look} />;
  return (
    <AvatarMotion mood={mood} look={look}>
      {kind === 'scrollmate' ? <ScrollMateCharacter mood={mood} /> : <AnimalCharacter kind={kind} mood={mood} />}
    </AvatarMotion>
  );
}
