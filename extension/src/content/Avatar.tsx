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

/** `look`: where the viewer is looking relative to the character, -1..1 per axis (eye tracking), or null. */
export function Avatar({ kind, mood, look = null }: { kind: AvatarKind; mood: Mood; look?: { x: number; y: number } | null }) {
  if (kind === 'scrollmate')
    return (
      <span className="sm-look" style={look ? { transform: `translate(${look.x * 3}px, ${look.y * 2}px)` } : undefined}>
        <ScrollMateCharacter mood={mood} />
      </span>
    );
  return <MochiCharacter mood={mood} look={look} />;
}
