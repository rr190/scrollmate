import type { AvatarKind } from '../shared/types';
import { ScrollMateCharacter } from './avatars/ScrollMateCharacter';
import { Character as MochiCharacter } from './Character';
import type { Mood } from './controller';
import { AnimalCharacter } from './avatars/AnimalCharacter';

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

/** Optional facing direction for the walking animation, -1..1 per axis. */
export function Avatar({ kind, mood, look = null }: { kind: AvatarKind; mood: Mood; look?: { x: number; y: number } | null }) {
  if (kind !== 'mochi' && kind !== 'scrollmate') return <span className="sm-look" style={look ? { transform: `translate(${look.x * 3}px, ${look.y * 2}px)` } : undefined}><AnimalCharacter kind={kind} mood={mood} /></span>;
  if (kind === 'scrollmate')
    return (
      <span className="sm-look" style={look ? { transform: `translate(${look.x * 3}px, ${look.y * 2}px)` } : undefined}>
        <ScrollMateCharacter mood={mood} />
      </span>
    );
  return <MochiCharacter mood={mood} look={look} />;
}
