/**
 * The same lively body motion as the Companio website's Mochi, for every other avatar (ScrollMate, cat, bunny,
 * panda, shiba): each mood's body loop (from LOOKS) eases in with a little overshoot and then loops in sync,
 * plus breathing, a springy lean toward where it's looking, and random blinks (useRandomBlink).
 */
import { useEffect, type ReactNode } from 'react';
import {
  animate,
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type AnimationPlaybackControls,
  type MotionValue,
} from 'motion/react';
import type { Mood } from '../controller';
import { LOOKS } from '../mochi/moods';

const BODY_KEYS = ['x', 'y', 'rotate', 'scaleX', 'scaleY'] as const;
const NEUTRAL = { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1 };
/** LOOKS motion is in Mochi's SVG units (236 tall): express moves as % of this avatar's own size. */
const UNIT_TO_PCT = 100 / 236;

/** Random, natural blinks (1.8-4.6 s apart, sometimes a double blink), like the website. Returns the eyes' scaleY. */
export function useRandomBlink(enabled: boolean): MotionValue<number> {
  const blink = useMotionValue(1);
  const reduced = useReducedMotion() ?? false;
  useEffect(() => {
    if (!enabled || reduced) return;
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
  }, [enabled, reduced, blink]);
  return blink;
}

export function AvatarMotion({ mood, look = null, children }: { mood: Mood; look?: { x: number; y: number } | null; children: ReactNode }) {
  const reduced = useReducedMotion() ?? false;
  const live = !reduced;
  const spec = (LOOKS[mood] ?? LOOKS.idle).motion;

  const body = {
    x: useMotionValue(0),
    y: useMotionValue(0),
    rotate: useMotionValue(0),
    scaleX: useMotionValue(1),
    scaleY: useMotionValue(1),
  };
  useEffect(() => {
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
      const intro = animate(mv, rest, { duration: 0.42, ease: [0.34, 1.5, 0.64, 1] });
      running.push(intro);
      if (track) {
        intro.then(() => {
          if (cancelled) return;
          running.push(animate(mv, track, {
            duration: spec.duration, times: spec.times, ease: spec.ease ?? 'easeInOut',
            repeat: Infinity, repeatDelay: spec.repeatDelay ?? 0,
          }));
        });
      }
    }
    return () => {
      cancelled = true;
      running.forEach((c) => c.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mood, live]);

  // breathing
  const time = useMotionValue(0);
  useAnimationFrame((t) => {
    if (live) time.set(t / 1000);
  });
  const breathe = useTransform(time, (t) => 1 + Math.sin(t * 2.1) * 0.012);

  // a springy lean toward where it's walking / looking
  const leanX = useSpring(0, { stiffness: 120, damping: 16 });
  const leanY = useSpring(0, { stiffness: 120, damping: 16 });
  useEffect(() => {
    leanX.set(live && look ? look.x * 3 : 0);
    leanY.set(live && look ? look.y * 2 : 0);
  }, [look, live, leanX, leanY]);

  const x = useTransform(() => `calc(${body.x.get() * UNIT_TO_PCT}% + ${leanX.get()}px)`);
  const y = useTransform(() => `calc(${body.y.get() * UNIT_TO_PCT}% + ${leanY.get()}px)`);
  const scaleX = useTransform(() => body.scaleX.get() * (2 - breathe.get()));
  const scaleY = useTransform(() => body.scaleY.get() * breathe.get());

  return (
    <motion.span className="sm-avatar-motion"
      style={{ display: 'block', width: '100%', height: '100%', pointerEvents: 'none', x, y, rotate: body.rotate, scaleX, scaleY, originX: 0.5, originY: 1 }}>
      {children}
    </motion.span>
  );
}
