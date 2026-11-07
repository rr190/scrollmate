import { useEffect, useRef } from 'react';
import type { Mood } from './controller';
import { Brow, Eye, Mouth, type EyeType } from './mochi/faceParts';
import { bodyPath, sproutPaths } from './mochi/geometry';
import { MochiEffects } from './mochi/MochiEffects';
import { LOOKS, motionCss } from './mochi/moods';

/**
 * Mochi, the Companio mascot (same character as the landing page), drawn in SVG.
 *
 * Landing page -> extension differences: the `motion` library animations are plain CSS here
 * (no animation framework in the extension), the silhouette doesn't wobble per frame, and the
 * eyes don't follow the pointer (it sits over a video).
 */
const MOTION_CSS = motionCss();
const EFFECT_COLOR = '#8B6CEF';
const EYE_L = 75;
const EYE_R = 125;
const EYE_Y = 116;
const MOUTH_Y = 140;
const NO_BLINK: EyeType[] = ['arc', 'squeeze', 'closed'];
const BODY = bodyPath(0, 0);
const SPROUT = sproutPaths(0, 100, 58); // drawn upright; the pose is a CSS rotation so it can transition
/** Mood changes that deserve a bigger squash-and-bounce (reactions to the video). */
const BIG = new Set<Mood>(['surprised', 'laughing', 'impressed', 'cringe', 'love']);

export function Character({ mood }: { mood: Mood }) {
  const look = LOOKS[mood] ?? LOOKS.idle;
  const face = look.face;
  const [le, re] = Array.isArray(face.eyes) ? face.eyes : [face.eyes, face.eyes];
  const [ls, rs] = Array.isArray(face.eyeScale) ? face.eyeScale : [face.eyeScale ?? 1, face.eyeScale ?? 1];
  const canBlink = !NO_BLINK.includes(le);
  const wrapRef = useRef<SVGGElement>(null);
  const prevMood = useRef<Mood>(mood);

  // Squash-and-bounce on every mood change (the landing page's spring "intro"), skipped for reduced motion.
  useEffect(() => {
    if (prevMood.current === mood) return;
    prevMood.current = mood;
    const el = wrapRef.current;
    if (!el || typeof el.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const k = BIG.has(mood) ? 1 : 0.5;
    el.animate(
      [
        { transform: 'translateY(0) scale(1, 1)' },
        { transform: `translateY(${3 * k}px) scale(${1 + 0.08 * k}, ${1 - 0.1 * k})` },
        { transform: `translateY(${-6 * k}px) scale(${1 - 0.04 * k}, ${1 + 0.06 * k})` },
        { transform: 'translateY(0) scale(1, 1)' },
      ],
      { duration: BIG.has(mood) ? 440 : 320, easing: 'cubic-bezier(.34,1.5,.64,1)' },
    );
  }, [mood]);

  return (
    <svg className={`sm-char sm-mood-${mood}`} viewBox="-30 -24 260 236" aria-hidden="true">
      <style>{MOTION_CSS}</style>
      <defs>
        <radialGradient id="smm-body" cx="38%" cy="30%" r="80%">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.58" stopColor="#FBF5EE" />
          <stop offset="1" stopColor="#E3D5C6" />
        </radialGradient>
        <radialGradient id="smm-rim" cx="50%" cy="100%" r="62%">
          <stop offset="0" stopColor="#B49A86" stopOpacity="0.28" />
          <stop offset="1" stopColor="#B49A86" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="smm-leaf" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#A6E3A6" />
          <stop offset="1" stopColor="#6FBF80" />
        </linearGradient>
      </defs>

      <ellipse cx={100} cy={194} rx={56} ry={7} fill="#1D1830" opacity={0.2} />

      <g ref={wrapRef} className="sm-mochi-wrap">
        <g className={`sm-anim sm-mochi-body sm-body-${mood}`}>
          {/* sprout: pose = CSS rotation (transitions between moods), plus a gentle sway */}
          <g className="sm-sprout" style={{ transform: `rotate(${look.sprout}deg)` }}>
            <g className="sm-anim sm-sprout-sway">
              <path d={SPROUT.stem} stroke="#5FAE72" strokeWidth={3.4} strokeLinecap="round" fill="none" />
              <path d={SPROUT.leafL} fill="url(#smm-leaf)" />
              <path d={SPROUT.leafR} fill="url(#smm-leaf)" />
            </g>
          </g>

          {/* body */}
          <g className="sm-anim sm-breathe">
            <path d={BODY} fill="url(#smm-body)" />
            <path d={BODY} fill="url(#smm-rim)" />
            <path d={BODY} fill="none" stroke="#2A1F4A" strokeOpacity={0.06} strokeWidth={1.5} />
            <ellipse cx={70} cy={82} rx={18} ry={9} fill="#fff" opacity={0.95} transform="rotate(-24 70 82)" />
          </g>

          {/* face (gaze offset transitions between moods) */}
          <g className="sm-face" style={{ transform: `translate(${look.look?.[0] ?? 0}px, ${look.look?.[1] ?? 0}px)` }}>
            <ellipse cx={47} cy={134} rx={10} ry={6} fill="#FF8FB8" className="sm-blush" style={{ opacity: look.blush * 0.8 }} />
            <ellipse cx={153} cy={134} rx={10} ry={6} fill="#FF8FB8" className="sm-blush" style={{ opacity: look.blush * 0.8 }} />

            {/* keyed on mood: each new expression pops in (reads like a blink between faces) */}
            <g key={mood} className="sm-swap">
              {face.tears && (
                <g fill="#8FD3FF">
                  <path d={`M ${EYE_L - 9} ${EYE_Y + 2} q -10 6 -14 18 q 8 -2 12 -10 z`} />
                  <path d={`M ${EYE_R + 9} ${EYE_Y + 2} q 10 6 14 18 q -8 -2 -12 -10 z`} />
                </g>
              )}
              <Brow type={face.brows ?? 'none'} x={EYE_L} y={EYE_Y - 18} side={-1} />
              <Brow type={face.brows ?? 'none'} x={EYE_R} y={EYE_Y - 18} side={1} />
              <g className={canBlink ? 'sm-anim sm-mochi-blink' : ''}>
                <Eye type={le} x={EYE_L} y={EYE_Y} side={-1} s={ls} />
                <Eye type={re} x={EYE_R} y={EYE_Y} side={1} s={rs} />
              </g>
              <g className={look.talk ? 'sm-anim sm-mochi-talk' : ''}>
                <Mouth type={face.mouth} x={100 + (face.mouthDx ?? 0)} y={MOUTH_Y} />
              </g>
            </g>
          </g>

          <MochiEffects key={`fx-${mood}`} effects={look.effects} color={EFFECT_COLOR} />
        </g>
      </g>
    </svg>
  );
}
