/**
 * Mochi, animated exactly like the Companio website (scrollmateWeb/companio-landing/src/companion/AnimatedCompanion.tsx),
 * using the same `motion` library: a jelly outline that wobbles every frame, body loops that ease into each mood with a
 * little overshoot, face parts that cross-fade with a squash (reads like a blink), random blinks, springy gaze, sprout
 * and blush. Driven by the extension's moods (LOOKS), which hold the website's values.
 */
import { useEffect, useId, useRef } from 'react';
import {
  AnimatePresence,
  animate,
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type AnimationPlaybackControls,
} from 'motion/react';
import type { Mood } from '../controller';
import { CompanionEffects } from './CompanionEffects';
import { Brow, Eye, Mouth, type EyeType, type FaceSpec } from './faceParts';
import { bodyPath, sproutPaths } from './geometry';
import { LOOKS } from './moods';

const BODY_KEYS = ['x', 'y', 'rotate', 'scaleX', 'scaleY'] as const;
const NEUTRAL = { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1 };
const EYE_L = 75;
const EYE_R = 125;
const EYE_Y = 116;
const MOUTH_Y = 140;
const EFFECT_COLOR = '#8B6CEF';
/** Eye shapes that are already closed or squinting: no blinking. */
const NO_BLINK: EyeType[] = ['arc', 'squeeze', 'closed'];
const swapIn = { type: 'spring', stiffness: 520, damping: 24, delay: 0.07 } as const;

/** Same face = same key, so moods that share a face don't swap it for nothing. */
const faceKey = (f: FaceSpec) => JSON.stringify(f);

export function MochiAnimated({ mood, look: viewerLook = null }: { mood: Mood; look?: { x: number; y: number } | null }) {
  const uid = useId().replace(/:/g, '');
  const def = LOOKS[mood] ?? LOOKS.idle;
  const reduced = useReducedMotion() ?? false;
  const live = !reduced;
  const rootRef = useRef<SVGSVGElement>(null);

  // ---------- body motion channels ----------
  const body = {
    x: useMotionValue(0),
    y: useMotionValue(0),
    rotate: useMotionValue(0),
    scaleX: useMotionValue(1),
    scaleY: useMotionValue(1),
  };

  useEffect(() => {
    const spec = def.motion;
    const running: AnimationPlaybackControls[] = [];
    let cancelled = false;
    for (const key of BODY_KEYS) {
      const mv = body[key];
      const track = spec[key];
      const rest = track ? track[0] : NEUTRAL[key];
      if (!live) {
        running.push(animate(mv, rest, { duration: 0 }));
        continue;
      }
      // All channels ease into the new loop together (with a little overshoot), then loop in sync.
      const intro = animate(mv, rest, { duration: 0.42, ease: [0.34, 1.5, 0.64, 1] });
      running.push(intro);
      if (track) {
        intro.then(() => {
          if (cancelled) return;
          running.push(
            animate(mv, track, {
              duration: spec.duration,
              times: spec.times,
              ease: spec.ease ?? 'easeInOut',
              repeat: Infinity,
              repeatDelay: spec.repeatDelay ?? 0,
            }),
          );
        });
      }
    }
    return () => {
      cancelled = true;
      running.forEach((c) => c.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood, live]);

  // ---------- idle life ----------
  const time = useMotionValue(0);
  useAnimationFrame((t) => {
    if (live) time.set(t / 1000);
  });
  const breathe = useTransform(time, (t) => 1 + Math.sin(t * 2.1) * 0.012);
  const silhouette = useTransform(time, (t) => bodyPath(t, live ? 1 : 0));

  const [leftEyeType, rightEyeType] = Array.isArray(def.face.eyes) ? def.face.eyes : [def.face.eyes, def.face.eyes];
  const canBlink = !NO_BLINK.includes(leftEyeType);
  const blink = useMotionValue(1);
  useEffect(() => {
    if (!live || !canBlink) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const schedule = () => {
      timer = setTimeout(async () => {
        await animate(blink, [1, 0.08, 1], { duration: 0.18, ease: 'easeInOut' });
        if (!stopped && Math.random() < 0.25) await animate(blink, [1, 0.08, 1], { duration: 0.16 });
        if (!stopped) schedule();
      }, 1800 + Math.random() * 2800);
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      blink.set(1);
    };
  }, [live, canBlink, blink]);

  // ---------- gaze: the mood's look + where it's walking / where the child looks, else the mouse ----------
  const lookX = useSpring(def.look?.[0] ?? 0, { stiffness: 160, damping: 18 });
  const lookY = useSpring(def.look?.[1] ?? 0, { stiffness: 160, damping: 18 });
  useEffect(() => {
    lookX.set(def.look?.[0] ?? 0);
    lookY.set(def.look?.[1] ?? 0);
  }, [def, lookX, lookY]);
  const followX = useSpring(0, { stiffness: 80, damping: 16 });
  const followY = useSpring(0, { stiffness: 80, damping: 16 });
  useEffect(() => {
    if (viewerLook) {
      followX.set(viewerLook.x * 7);
      followY.set(viewerLook.y * 5);
    }
  }, [viewerLook, followX, followY]);
  useEffect(() => {
    if (reduced || viewerLook) return;
    const onMove = (e: PointerEvent) => {
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2);
      const dy = (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2);
      followX.set(Math.max(-1, Math.min(1, dx)) * 5);
      followY.set(Math.max(-1, Math.min(1, dy)) * 3.5);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [reduced, viewerLook, followX, followY]);
  const faceX = useTransform(() => lookX.get() + followX.get());
  const faceY = useTransform(() => lookY.get() + followY.get());

  // ---------- sprout & blush ----------
  const sproutBase = useSpring(def.sprout, { stiffness: 140, damping: 11 });
  useEffect(() => sproutBase.set(def.sprout), [def.sprout, sproutBase]);
  const sproutDeg = useTransform(() => sproutBase.get() + (live ? Math.sin(time.get() * 2.4) * 5 : 0));
  const stem = useTransform(sproutDeg, (d) => sproutPaths(d, 100, 58).stem);
  const leafL = useTransform(sproutDeg, (d) => sproutPaths(d, 100, 58).leafL);
  const leafR = useTransform(sproutDeg, (d) => sproutPaths(d, 100, 58).leafR);

  const blush = useSpring(def.blush, { stiffness: 120, damping: 20 });
  useEffect(() => blush.set(def.blush), [def.blush, blush]);
  const blushOpacity = useTransform(blush, (v) => v * 0.8);

  const shadowScale = useTransform(body.y, [-40, 0, 10], [0.6, 1, 1.05]);
  const shadowOpacity = useTransform(body.y, [-40, 0], [0.1, 0.22]);
  const scaleX = useTransform(() => body.scaleX.get() * (2 - breathe.get()));
  const scaleY = useTransform(() => body.scaleY.get() * breathe.get());

  const face = def.face;
  const [ls, rs] = Array.isArray(face.eyeScale) ? face.eyeScale : [face.eyeScale ?? 1, face.eyeScale ?? 1];
  const fk = faceKey(face);

  return (
    <svg ref={rootRef} className={`sm-char sm-mood-${mood}`} viewBox="-30 -24 260 236" aria-hidden="true" style={{ overflow: 'visible', pointerEvents: 'none' }}>
      <defs>
        <radialGradient id={`body-${uid}`} cx="38%" cy="30%" r="80%">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.58" stopColor="#FBF5EE" />
          <stop offset="1" stopColor="#E3D5C6" />
        </radialGradient>
        <radialGradient id={`rim-${uid}`} cx="50%" cy="100%" r="62%">
          <stop offset="0" stopColor="#B49A86" stopOpacity="0.28" />
          <stop offset="1" stopColor="#B49A86" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`leaf-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#A6E3A6" />
          <stop offset="1" stopColor="#6FBF80" />
        </linearGradient>
      </defs>

      <motion.ellipse cx={100} cy={194} rx={56} ry={7} fill="#1D1830"
        style={{ scaleX: shadowScale, opacity: shadowOpacity, originX: 0.5, originY: 0.5 }} />

      <motion.g style={{ x: body.x, y: body.y, rotate: body.rotate, scaleX, scaleY, originX: 0.5, originY: 1 }}>
        {/* sprout */}
        <motion.path d={stem} stroke="#5FAE72" strokeWidth={3.4} strokeLinecap="round" fill="none" />
        <motion.path d={leafL} fill={`url(#leaf-${uid})`} />
        <motion.path d={leafR} fill={`url(#leaf-${uid})`} />

        {/* body: the outline wobbles a little every frame */}
        <motion.path className="sm-mochi-outline" d={silhouette} fill={`url(#body-${uid})`} />
        <motion.path d={silhouette} fill={`url(#rim-${uid})`} />
        <motion.path d={silhouette} fill="none" stroke="#2A1F4A" strokeOpacity={0.06} strokeWidth={1.5} />
        <ellipse cx={70} cy={82} rx={18} ry={9} fill="#fff" opacity={0.95} transform="rotate(-24 70 82)" />

        {/* face */}
        <motion.g style={{ x: faceX, y: faceY }}>
          <motion.ellipse cx={47} cy={134} rx={10} ry={6} fill="#FF8FB8" style={{ opacity: blushOpacity }} />
          <motion.ellipse cx={153} cy={134} rx={10} ry={6} fill="#FF8FB8" style={{ opacity: blushOpacity }} />

          <AnimatePresence initial={false}>
            <motion.g key={`brows-${fk}`} className="sm-mochi-face"
              initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -2, transition: { duration: 0.12 } }} transition={swapIn}>
              {face.tears && (
                <g fill="#8FD3FF">
                  <path d={`M ${EYE_L - 9} ${EYE_Y + 2} q -10 6 -14 18 q 8 -2 12 -10 z`} />
                  <path d={`M ${EYE_R + 9} ${EYE_Y + 2} q 10 6 14 18 q -8 -2 -12 -10 z`} />
                </g>
              )}
              <Brow type={face.brows ?? 'none'} x={EYE_L} y={EYE_Y - 18} side={-1} />
              <Brow type={face.brows ?? 'none'} x={EYE_R} y={EYE_Y - 18} side={1} />
            </motion.g>
          </AnimatePresence>

          {/* eyes: a quick squash-swap reads like a blink between expressions */}
          <motion.g className="sm-mochi-eyes" style={{ scaleY: blink, originY: 0.5 }}>
            <AnimatePresence initial={false}>
              {[
                { k: 'l', type: leftEyeType, x: EYE_L, side: -1 as const, s: ls },
                { k: 'r', type: rightEyeType, x: EYE_R, side: 1 as const, s: rs },
              ].map((e) => (
                <motion.g key={`${e.k}-${fk}`}
                  initial={{ scaleY: 0.05, scaleX: 1.2, opacity: 0 }} animate={{ scaleY: 1, scaleX: 1, opacity: 1 }}
                  exit={{ scaleY: 0.05, scaleX: 1.15, opacity: 0, transition: { duration: 0.1, ease: 'easeIn' } }}
                  transition={swapIn}>
                  <Eye type={e.type} x={e.x} y={EYE_Y} side={e.side} s={e.s} />
                </motion.g>
              ))}
            </AnimatePresence>
          </motion.g>

          <AnimatePresence initial={false}>
            <motion.g key={`mouth-${fk}-${def.talk ? 'talk' : ''}`}
              initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0, transition: { duration: 0.1 } }} transition={swapIn}>
              <g className={def.talk && live ? 'sm-anim sm-mochi-talk' : ''}>
                <Mouth type={face.mouth} x={100 + (face.mouthDx ?? 0)} y={MOUTH_Y} />
              </g>
            </motion.g>
          </AnimatePresence>
        </motion.g>

        <CompanionEffects effects={def.effects} reduced={reduced} color={EFFECT_COLOR} />
      </motion.g>
    </svg>
  );
}
