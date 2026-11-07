import type { AvatarKind } from '../shared/types';
import { ScrollMateCharacter } from './avatars/ScrollMateCharacter';
import { Character as MochiCharacter } from './Character';
import type { Mood } from './controller';

/** Which drawing to use for the companion. Both react to the same moods. */
export const AVATARS: { id: AvatarKind; label: string; hint: string; aspect: number }[] = [
  { id: 'mochi', label: 'Companio', hint: 'Mochi with a sprout', aspect: 0.91 }, // viewBox 260x236
  { id: 'scrollmate', label: 'ScrollMate', hint: 'Original, with headphones', aspect: 0.86 }, // viewBox 140x120
];

export function avatarAspect(kind: AvatarKind): number {
  return AVATARS.find((a) => a.id === kind)?.aspect ?? 0.91;
}

export function Avatar({ kind, mood }: { kind: AvatarKind; mood: Mood }) {
  return kind === 'scrollmate' ? <ScrollMateCharacter mood={mood} /> : <MochiCharacter mood={mood} />;
}
