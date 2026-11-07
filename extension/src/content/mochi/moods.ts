/**
 * ScrollMate moods -> Mochi looks.
 *
 * Faces, sprout poses, blush, effects and body motions are taken from the Companio landing page
 * (scrollmateWeb/companio-landing/src/companion/emotions.ts). The landing page animates them with the
 * `motion` library; the extension may not use an animation framework, so `motionCss()` turns the same
 * keyframe tracks into plain CSS @keyframes.
 */
import type { Mood } from '../controller';
import type { FaceSpec } from './faceParts';

export type EffectKind = 'sparkles' | 'notes' | 'question' | 'hearts' | 'burst' | 'sweat' | 'tears' | 'haha' | 'zzz';

type Track = number[];
export interface BodyMotion {
  x?: Track;
  y?: Track;
  rotate?: Track;
  scaleX?: Track;
  scaleY?: Track;
  duration: number;
  times?: number[];
  ease?: 'easeInOut' | 'easeOut' | 'linear';
  repeatDelay?: number;
}

export interface Look {
  face: FaceSpec;
  sprout: number; // degrees: 0 perky, 75 flopped
  blush: number; // 0..1
  look?: [number, number];
  effects: EffectKind[];
  motion: BodyMotion;
  /** Animate the mouth like talking. */
  talk?: boolean;
}

// ---- Mochi's eight landing-page emotions (verbatim values) ----
const excited: Look = {
  face: { eyes: 'star', mouth: 'grin', brows: 'raised' },
  sprout: 0,
  blush: 1,
  effects: ['sparkles'],
  motion: {
    y: [0, 4, -34, 0, 0],
    scaleY: [1, 0.86, 1.1, 0.9, 1],
    scaleX: [1, 1.12, 0.93, 1.08, 1],
    rotate: [0, 0, -4, 2, 0],
    times: [0, 0.18, 0.5, 0.78, 1],
    duration: 0.85,
    ease: 'easeInOut',
    repeatDelay: 0.1,
  },
};
const happy: Look = {
  face: { eyes: 'arc', mouth: 'smile' },
  sprout: 12,
  blush: 0.9,
  effects: ['notes'],
  motion: { y: [0, -12, 0], scaleY: [1, 1.03, 1], scaleX: [1, 0.98, 1], rotate: [-4, 4, -4], duration: 1.1, ease: 'easeInOut' },
};
const curious: Look = {
  face: { eyes: ['round', 'round'], eyeScale: [0.78, 1.22], mouth: 'smallO', mouthDx: 9, brows: 'oneUp' },
  sprout: 28,
  blush: 0.3,
  look: [4, -2],
  effects: ['question'],
  motion: { rotate: [-10, -12, -10, -8, -10], y: [0, -3, 0, -2, 0], x: [0, 2, 0, -1, 0], duration: 3.2, ease: 'easeInOut' },
};
const supportive: Look = {
  face: { eyes: 'soft', mouth: 'softSmile' },
  sprout: 16,
  blush: 1,
  effects: ['hearts'],
  motion: { y: [0, -8, 0], scaleX: [1, 1.03, 1], scaleY: [1, 1.03, 1], rotate: [4, -2, 4], duration: 2.6, ease: 'easeInOut' },
};
const surprised: Look = {
  face: { eyes: 'wide', mouth: 'bigO', brows: 'raised' },
  sprout: -4,
  blush: 0.15,
  effects: ['burst'],
  motion: {
    y: [0, -18, -10, -12, -10],
    scaleY: [1, 1.14, 1.06, 1.08, 1.06],
    scaleX: [1, 0.9, 0.95, 0.94, 0.95],
    x: [0, 0, 1.5, -1.5, 0],
    times: [0, 0.15, 0.4, 0.7, 1],
    duration: 1.6,
    ease: 'easeOut',
  },
};
const concerned: Look = {
  face: { eyes: 'glossy', mouth: 'wobble', brows: 'worried' },
  sprout: 55,
  blush: 0.3,
  look: [0, 2],
  effects: ['sweat'],
  motion: { y: [4, 6, 4], rotate: [-2.5, 2.5, -2.5], scaleY: [0.94, 0.92, 0.94], scaleX: [1.04, 1.05, 1.04], duration: 3, ease: 'easeInOut' },
};
const amused: Look = {
  face: { eyes: 'squeeze', mouth: 'laugh', brows: 'worried' },
  sprout: -22,
  blush: 1,
  effects: ['tears', 'haha'],
  motion: { x: [0, -3, 3, -3, 3, 0], rotate: [6, 3, 9, 3, 9, 6], y: [0, -4, 0, -4, 0, 0], scaleY: [1, 0.96, 1.02, 0.96, 1.02, 1], duration: 0.7, ease: 'linear' },
};
const sleepy: Look = {
  face: { eyes: 'closed', mouth: 'sleep' },
  sprout: 75,
  blush: 0.5,
  effects: ['zzz'],
  motion: { scaleY: [0.9, 0.86, 0.9], scaleX: [1.08, 1.12, 1.08], y: [6, 8, 6], rotate: [4, 5, 4], duration: 3.4, ease: 'easeInOut' },
};

// ---- ScrollMate-only states, built from the same parts ----
const breathe: BodyMotion = { y: [0, -3, 0], scaleY: [1, 1.015, 1], scaleX: [1, 0.99, 1], duration: 3.4, ease: 'easeInOut' };

export const LOOKS: Record<Mood, Look> = {
  idle: { face: { eyes: 'round', mouth: 'cat' }, sprout: 10, blush: 0.5, effects: [], motion: breathe },
  watching: { face: { eyes: 'sparkle', mouth: 'cat' }, sprout: 4, blush: 0.55, look: [0, -1.5], effects: [], motion: { ...breathe, duration: 2.8 } },
  thinking: { ...curious, effects: ['question'] },
  amused: happy, // a bubble is showing
  speaking: { ...happy, face: { eyes: 'arc', mouth: 'smallO' }, effects: ['notes'], talk: true },
  sleeping: sleepy,
  // AI emotions
  curious,
  surprised,
  laughing: amused,
  impressed: excited,
  worried: concerned,
  love: supportive,
  happy,
  bored: { ...sleepy, sprout: 62, blush: 0.3, effects: [] }, // sleepy face, no zzz: "this is dragging"
  sad: { ...concerned, face: { eyes: 'glossy', mouth: 'wobble', brows: 'worried', tears: true }, sprout: 65, effects: [] },
  cringe: {
    face: { eyes: 'squeeze', mouth: 'wobble', brows: 'worried' },
    sprout: 40,
    blush: 0.2,
    look: [-2, 1],
    effects: ['sweat'],
    motion: { x: [0, -1.5, 1.5, -1.5, 0], scaleY: [0.96, 0.94, 0.96, 0.94, 0.96], scaleX: [1.03, 1.05, 1.03, 1.05, 1.03], duration: 0.5, ease: 'linear' },
  },
};

const EASE: Record<NonNullable<BodyMotion['ease']>, string> = {
  easeInOut: 'cubic-bezier(0.42, 0, 0.58, 1)',
  easeOut: 'cubic-bezier(0, 0, 0.58, 1)',
  linear: 'linear',
};

/** CSS @keyframes for every mood's body motion (one string, injected once into the shadow root). */
export function motionCss(): string {
  let css = '';
  for (const [mood, look] of Object.entries(LOOKS) as [Mood, Look][]) {
    const m = look.motion;
    const tracks = (['x', 'y', 'rotate', 'scaleX', 'scaleY'] as const).filter((k) => m[k]);
    const n = Math.max(...tracks.map((k) => m[k]!.length), 2);
    const total = m.duration + (m.repeatDelay ?? 0);
    const times = m.times ?? Array.from({ length: n }, (_, i) => i / (n - 1));
    const at = (k: (typeof tracks)[number], i: number, rest: number) => m[k]?.[Math.min(i, (m[k]?.length ?? 1) - 1)] ?? rest;
    let frames = '';
    for (let i = 0; i < n; i++) {
      const pct = ((times[i] * m.duration) / total) * 100;
      frames += `${pct.toFixed(2)}%{transform:translate(${at('x', i, 0)}px,${at('y', i, 0)}px) rotate(${at('rotate', i, 0)}deg) scale(${at('scaleX', i, 1)},${at('scaleY', i, 1)})}`;
    }
    if (m.repeatDelay) {
      // hold the last pose during the repeat delay
      frames += `100%{transform:translate(${at('x', n - 1, 0)}px,${at('y', n - 1, 0)}px) rotate(${at('rotate', n - 1, 0)}deg) scale(${at('scaleX', n - 1, 1)},${at('scaleY', n - 1, 1)})}`;
    }
    css += `@keyframes sm-body-${mood}{${frames}}`;
    css += `.sm-body-${mood}{animation:sm-body-${mood} ${total}s ${EASE[m.ease ?? 'easeInOut']} infinite;}`;
  }
  return css;
}
