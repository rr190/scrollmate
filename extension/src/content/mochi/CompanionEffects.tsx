// Ported from scrollmateWeb/companio-landing/src/companion/CompanionEffects.tsx (Companio website). Keep in sync.
import type { ReactNode } from 'react'
import { AnimatePresence, motion, type Transition } from 'motion/react'
import type { EffectKind } from './moods'
import { HEART } from './faceParts'

const STAR = 'M0 -9 C1 -2.5 2.5 -1 9 0 C2.5 1 1 2.5 0 9 C-1 2.5 -2.5 1 -9 0 C-2.5 -1 -1 -2.5 0 -9 Z'
const DROP = 'M0 -8 C3 -3 5 0 5 3 C5 6 2.8 8 0 8 C-2.8 8 -5 6 -5 3 C-5 0 -3 -3 0 -8 Z'
const FONT = { fontFamily: 'Geist, Inter, sans-serif', fontWeight: 800 }

const loop = (duration: number, delay = 0, extra: Transition = {}): Transition => ({
  duration,
  delay,
  repeat: Infinity,
  ease: 'easeInOut',
  ...extra,
})

interface Props {
  effects: EffectKind[]
  reduced: boolean
  /** Colour for marks that sit on the page background. */
  color: string
}

/** Small contextual flourishes around the mascot for each emotion. */
export function CompanionEffects({ effects, reduced, color }: Props) {
  return (
    <AnimatePresence>
      {effects.map((effect) => (
        <motion.g
          key={effect}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={{ duration: 0.3, delay: 0.15 }}
        >
          {render(effect, reduced, color)}
        </motion.g>
      ))}
    </AnimatePresence>
  )
}

function At({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return <g transform={`translate(${x} ${y})`}>{children}</g>
}

function render(effect: EffectKind, still: boolean, color: string) {
  const fade = { duration: 0.3 }
  switch (effect) {
    case 'sparkles': {
      const stars = [
        { x: 14, y: 62, s: 1.2, c: '#FFD23F', d: 0 },
        { x: 186, y: 50, s: 1.4, c: color, d: 0.25 },
        { x: 200, y: 128, s: 0.9, c: '#FFD23F', d: 0.5 },
        { x: 2, y: 140, s: 0.9, c: color, d: 0.7 },
        { x: 160, y: 18, s: 0.7, c: '#FFD23F', d: 0.4 },
      ]
      return stars.map((st, i) => (
        <At key={i} x={st.x} y={st.y}>
          <motion.path
            d={STAR}
            fill={st.c}
            initial={{ scale: 0 }}
            animate={still ? { scale: st.s } : { scale: [0, st.s, 0], rotate: [0, 90] }}
            transition={still ? fade : loop(1.1, st.d)}
          />
        </At>
      ))
    }
    case 'notes': {
      const notes = [
        { x: 176, y: 70, t: '♪', s: 28, d: 0 },
        { x: 14, y: 96, t: '♫', s: 22, d: 0.8 },
        { x: 190, y: 120, t: '♪', s: 18, d: 1.4 },
      ]
      return notes.map((n, i) => (
        <At key={i} x={n.x} y={n.y}>
          <motion.text
            fontSize={n.s}
            fill={color}
            {...FONT}
            initial={{ opacity: 0 }}
            animate={still ? { opacity: 1 } : { opacity: [0, 1, 0], y: [8, -10, -24], rotate: [-10, 10, -6] }}
            transition={still ? fade : loop(2.2, n.d, { ease: 'easeOut' })}
          >
            {n.t}
          </motion.text>
        </At>
      ))
    }
    case 'question':
      return (
        <At x={180} y={52}>
          <motion.text
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={40}
            fill={color}
            {...FONT}
            initial={{ scale: 0, rotate: -20 }}
            animate={still ? { scale: 1 } : { scale: 1, rotate: [-10, 12, -10], y: [0, -5, 0] }}
            transition={
              still ? fade : { scale: { type: 'spring', stiffness: 300, damping: 14 }, rotate: loop(2.2), y: loop(2.2) }
            }
          >
            ?
          </motion.text>
        </At>
      )
    case 'hearts': {
      const hearts = [
        { x: 172, y: 88, s: 1.4, d: 0 },
        { x: 28, y: 100, s: 1.1, d: 0.9 },
        { x: 152, y: 46, s: 0.9, d: 1.6 },
      ]
      return hearts.map((h, i) => (
        <At key={i} x={h.x} y={h.y}>
          <motion.path
            d={HEART}
            fill="#FF4D8D"
            stroke="#fff"
            strokeWidth={1.4}
            initial={{ opacity: 0, scale: 0 }}
            animate={
              still
                ? { opacity: 1, scale: h.s }
                : { opacity: [0, 1, 1, 0], scale: [0.4, h.s, h.s, h.s * 0.9], y: [6, -12, -26, -40], x: [0, 4, -3, 2] }
            }
            transition={still ? fade : loop(2.4, h.d, { ease: 'easeOut' })}
          />
        </At>
      ))
    }
    case 'burst': {
      const lines = [
        { x: 36, y: 46, r: -35 },
        { x: 22, y: 66, r: -62 },
        { x: 164, y: 46, r: 35 },
        { x: 178, y: 66, r: 62 },
        { x: 100, y: 14, r: 0 },
      ]
      return lines.map((l, i) => (
        <At key={i} x={l.x} y={l.y}>
          <g transform={`rotate(${l.r})`}>
            <motion.line
              x1={0}
              y1={-7}
              x2={0}
              y2={7}
              stroke={color}
              strokeWidth={4.5}
              strokeLinecap="round"
              initial={{ scaleY: 0, opacity: 0 }}
              animate={still ? { scaleY: 1, opacity: 1 } : { scaleY: [0, 1.25, 1, 1.2, 1], opacity: 1 }}
              transition={still ? fade : loop(1.6, i * 0.04)}
            />
          </g>
        </At>
      ))
    }
    case 'sweat':
      return (
        <At x={168} y={78}>
          <motion.path
            d={DROP}
            fill="#8FD3FF"
            stroke="#fff"
            strokeWidth={1.2}
            initial={{ opacity: 0 }}
            animate={still ? { opacity: 1, scale: 1.4 } : { opacity: [0, 1, 1, 0], y: [-6, 0, 12, 22], scale: 1.4 }}
            transition={still ? fade : loop(2.2, 0, { ease: 'easeIn', times: [0, 0.2, 0.7, 1] })}
          />
        </At>
      )
    case 'tears': {
      const drops = [
        { x: 62, y: 114, dx: -24, d: 0 },
        { x: 138, y: 114, dx: 24, d: 0.15 },
        { x: 62, y: 114, dx: -15, d: 0.38 },
        { x: 138, y: 114, dx: 15, d: 0.52 },
      ]
      return drops.map((t, i) => (
        <At key={i} x={t.x} y={t.y}>
          <motion.path
            d={DROP}
            fill="#8FD3FF"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={
              still
                ? { opacity: 1, scale: 0.8, x: t.dx * 0.6 }
                : { opacity: [0, 1, 0], x: [0, t.dx * 0.6, t.dx], y: [0, -8, 10], scale: [0.5, 0.9, 0.7] }
            }
            transition={still ? fade : loop(0.8, t.d, { ease: 'easeOut' })}
          />
        </At>
      ))
    }
    case 'haha': {
      const has = [
        { x: 152, y: 46, r: 14, s: 24, d: 0 },
        { x: 6, y: 64, r: -14, s: 19, d: 0.35 },
      ]
      return has.map((h, i) => (
        <At key={i} x={h.x} y={h.y}>
          <motion.text
            fontSize={h.s}
            fill={color}
            {...FONT}
            transform={`rotate(${h.r})`}
            initial={{ opacity: 0, scale: 0 }}
            animate={still ? { opacity: 1, scale: 1 } : { opacity: 1, scale: [0.85, 1.12, 0.85] }}
            transition={still ? fade : loop(0.7, h.d)}
          >
            HA
          </motion.text>
        </At>
      ))
    }
    case 'zzz': {
      const zs = [
        { s: 18, d: 0 },
        { s: 24, d: 1 },
        { s: 30, d: 2 },
      ]
      return zs.map((z, i) => (
        <At key={i} x={150} y={64}>
          <motion.text
            fontSize={z.s}
            fill={color}
            {...FONT}
            initial={{ opacity: 0 }}
            animate={
              still
                ? { opacity: 0.85, x: i * 14, y: -i * 16 }
                : { opacity: [0, 1, 0], x: [0, 18, 36], y: [0, -22, -48], rotate: [0, -8, 6] }
            }
            transition={still ? fade : loop(3, z.d, { ease: 'easeOut' })}
          >
            z
          </motion.text>
        </At>
      ))
    }
  }
}
