// Ported from scrollmateWeb/companio-landing/src/companion (Companio landing page). Keep in sync.
/* Building blocks for mascot drafts: distinct eye / mouth / brow / extra types. */

export const INK = '#2A1F4A'
const MOUTH_FILL = '#3A2366'
const TONGUE = '#FF7FA6'

export type EyeType =
  | 'round'
  | 'sparkle'
  | 'star'
  | 'heart'
  | 'arc'
  | 'squeeze'
  | 'closed'
  | 'soft'
  | 'wide'
  | 'glossy'
  | 'dot'

export type MouthType = 'grin' | 'smile' | 'softSmile' | 'smallO' | 'bigO' | 'wobble' | 'laugh' | 'sleep' | 'cat'
export type BrowType = 'none' | 'raised' | 'worried' | 'oneUp' | 'soft'

const STAR5 = (r: number, ir: number) => {
  let d = ''
  for (let i = 0; i < 10; i++) {
    const rad = ((i * 36 - 90) * Math.PI) / 180
    const rr = i % 2 === 0 ? r : ir
    d += `${i === 0 ? 'M' : 'L'} ${(Math.cos(rad) * rr).toFixed(2)} ${(Math.sin(rad) * rr).toFixed(2)} `
  }
  return d + 'Z'
}

export const HEART = 'M0 6 C-11 -1 -11 -12 -3.5 -12.5 C-1.2 -12.6 0 -10.5 0 -9 C0 -10.5 1.2 -12.6 3.5 -12.5 C11 -12 11 -1 0 6 Z'

export function Eye({ type, x, y, side, s = 1 }: { type: EyeType; x: number; y: number; side: -1 | 1; s?: number }) {
  const t = `translate(${x} ${y}) scale(${s})`
  const stroke = { stroke: INK, strokeWidth: 4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  switch (type) {
    case 'round':
      return (
        <g transform={t}>
          <ellipse rx={7} ry={9} fill={INK} />
          <circle cx={-2.4} cy={-3.4} r={2.6} fill="#fff" />
          <circle cx={2.2} cy={3} r={1.2} fill="#fff" />
        </g>
      )
    case 'sparkle':
      return (
        <g transform={t}>
          <ellipse rx={9} ry={11.5} fill={INK} />
          <circle cx={-3} cy={-4.5} r={3.8} fill="#fff" />
          <circle cx={3.2} cy={3.6} r={2} fill="#fff" />
          <circle cx={-3.5} cy={4.5} r={1} fill="#fff" />
        </g>
      )
    case 'star':
      return (
        <g transform={t}>
          <path d={STAR5(12, 5.4)} fill="#FFD23F" stroke={INK} strokeWidth={2.6} strokeLinejoin="round" />
          <circle cx={-2.5} cy={-3} r={1.6} fill="#fff" />
        </g>
      )
    case 'heart':
      return (
        <g transform={`${t} translate(0 3)`}>
          <path d={HEART} fill="#FF4D8D" stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
          <circle cx={-4} cy={-7} r={1.8} fill="#fff" />
        </g>
      )
    case 'arc':
      return (
        <g transform={t}>
          <path d="M-8 3 Q0 -10 8 3" {...stroke} />
        </g>
      )
    case 'squeeze':
      return (
        <g transform={`${t} scale(${side === -1 ? 1 : -1} 1)`}>
          <path d="M-6 -7 L6 0 L-6 7" {...stroke} />
        </g>
      )
    case 'closed':
      return (
        <g transform={t}>
          <path d="M-8 -1 Q0 6 8 -1" {...stroke} />
        </g>
      )
    case 'soft':
      return (
        <g transform={t}>
          <path d="M-8.5 0 Q0 -9 8.5 0 C8.5 11 -8.5 11 -8.5 0 Z" fill={INK} stroke={INK} strokeWidth={2} strokeLinejoin="round" />
          <circle cx={-2.6} cy={0.5} r={2.8} fill="#fff" />
          <circle cx={2.8} cy={4.2} r={1.4} fill="#fff" />
        </g>
      )
    case 'wide':
      return (
        <g transform={t}>
          <circle r={11.5} fill="#fff" stroke={INK} strokeWidth={3} />
          <circle r={4} fill={INK} />
        </g>
      )
    case 'glossy':
      return (
        <g transform={t}>
          <ellipse rx={7.5} ry={9} fill={INK} />
          <circle cx={-2.2} cy={-3} r={3.6} fill="#fff" />
          <circle cx={2.8} cy={2.6} r={1.8} fill="#fff" />
          <path d="M-6 8 Q0 11 6 8" stroke="#8FD3FF" strokeWidth={2.4} strokeLinecap="round" fill="none" />
        </g>
      )
    case 'dot':
      return <circle cx={x} cy={y} r={4.2 * s} fill={INK} />
  }
}

export function Mouth({ type, x, y, s = 1 }: { type: MouthType; x: number; y: number; s?: number }) {
  const t = `translate(${x} ${y}) scale(${s})`
  const line = { stroke: INK, strokeWidth: 3.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  const filled = { fill: MOUTH_FILL, stroke: INK, strokeWidth: 3, strokeLinejoin: 'round' as const }
  switch (type) {
    case 'grin':
      return (
        <g transform={t}>
          <path d="M-16 -4 Q0 -7 16 -4 Q14 21 0 21 Q-14 21 -16 -4 Z" {...filled} />
          <path d="M-8 15 Q0 8 8 15 Q6 19.5 0 19.5 Q-6 19.5 -8 15 Z" fill={TONGUE} />
        </g>
      )
    case 'smile':
      return (
        <g transform={t}>
          <path d="M-11 -2 Q0 -3 11 -2 Q9 12 0 12 Q-9 12 -11 -2 Z" {...filled} />
          <path d="M-5 9 Q0 5 5 9 Q3.5 11 0 11 Q-3.5 11 -5 9 Z" fill={TONGUE} />
        </g>
      )
    case 'softSmile':
      return (
        <g transform={t}>
          <path d="M-9 0 Q0 8 9 0" {...line} />
        </g>
      )
    case 'smallO':
      return (
        <g transform={t}>
          <ellipse rx={4} ry={4.6} {...filled} strokeWidth={2.6} />
        </g>
      )
    case 'cat':
      return (
        <g transform={t}>
          <path d="M-9 -1 Q-4.5 5 0 0 Q4.5 5 9 -1" {...line} />
        </g>
      )
    case 'bigO':
      return (
        <g transform={t}>
          <ellipse rx={7.5} ry={11} {...filled} />
          <ellipse cy={6} rx={4} ry={3} fill={TONGUE} />
        </g>
      )
    case 'wobble':
      return (
        <g transform={t}>
          <path d="M-11 4 Q-5.5 -3 0 2 Q5.5 7 11 0" {...line} />
        </g>
      )
    case 'laugh':
      return (
        <g transform={t}>
          <path d="M-19 -6 Q0 -2 19 -6 Q16 20 0 20 Q-16 20 -19 -6 Z" {...filled} />
          <path d="M-14 -3.6 Q0 -0.5 14 -3.6 L13 1 Q0 3.5 -13 1 Z" fill="#fff" />
          <path d="M-9 14 Q0 7 9 14 Q6 18.5 0 18.5 Q-6 18.5 -9 14 Z" fill={TONGUE} />
        </g>
      )
    case 'sleep':
      return (
        <g transform={t}>
          <ellipse rx={3.2} ry={3.8} {...filled} strokeWidth={2.4} />
          <circle cx={14} cy={-4} r={6.5} fill="#CFEFFF" stroke="#8FD3FF" strokeWidth={1.5} opacity={0.9} />
          <circle cx={12} cy={-6.5} r={1.8} fill="#fff" />
        </g>
      )
  }
}

export function Brow({ type, x, y, side }: { type: BrowType; x: number; y: number; side: -1 | 1 }) {
  if (type === 'none') return null
  const p = { stroke: INK, strokeWidth: 3.4, strokeLinecap: 'round' as const, fill: 'none' }
  // side -1 = left eye; "inner" end points toward the face centre (+x for left)
  const o = side === -1 ? -1 : 1
  const outerX = x + o * 8
  const innerX = x - o * 7
  let outerY = y
  let innerY = y
  if (type === 'raised') {
    outerY = y - 2
    innerY = y - 3
  }
  if (type === 'worried') {
    outerY = y + 2
    innerY = y - 6
  }
  if (type === 'soft') {
    outerY = y + 1
    innerY = y - 2
  }
  if (type === 'oneUp') {
    const lift = side === -1 ? -7 : 1
    outerY = y + lift
    innerY = y + lift + (side === -1 ? 2 : 0)
  }
  const midX = (outerX + innerX) / 2
  const midY = Math.min(outerY, innerY) - 3
  return <path d={`M ${outerX} ${outerY} Q ${midX} ${midY} ${innerX} ${innerY}`} {...p} />
}

export interface FaceSpec {
  eyes: EyeType | [EyeType, EyeType]
  eyeScale?: number | [number, number]
  mouth: MouthType
  mouthDx?: number
  brows?: BrowType
  blush?: number
  tears?: boolean
}

export function Face({
  spec,
  cx = 100,
  eyeY,
  eyeDx,
  mouthY,
  scale = 1,
  blushColor = '#FF8FB8',
}: {
  spec: FaceSpec
  cx?: number
  eyeY: number
  eyeDx: number
  mouthY: number
  scale?: number
  blushColor?: string
}) {
  const [le, re] = Array.isArray(spec.eyes) ? spec.eyes : [spec.eyes, spec.eyes]
  const [ls, rs] = Array.isArray(spec.eyeScale) ? spec.eyeScale : [spec.eyeScale ?? 1, spec.eyeScale ?? 1]
  const blush = spec.blush ?? 0.6
  return (
    <g>
      <ellipse cx={cx - eyeDx - 13} cy={eyeY + 17} rx={10} ry={6} fill={blushColor} opacity={blush * 0.8} />
      <ellipse cx={cx + eyeDx + 13} cy={eyeY + 17} rx={10} ry={6} fill={blushColor} opacity={blush * 0.8} />
      {spec.tears && (
        <g fill="#8FD3FF">
          <path d={`M ${cx - eyeDx - 9} ${eyeY + 2} q -10 6 -14 18 q 8 -2 12 -10 z`} />
          <path d={`M ${cx + eyeDx + 9} ${eyeY + 2} q 10 6 14 18 q -8 -2 -12 -10 z`} />
        </g>
      )}
      <Brow type={spec.brows ?? 'none'} x={cx - eyeDx} y={eyeY - 18} side={-1} />
      <Brow type={spec.brows ?? 'none'} x={cx + eyeDx} y={eyeY - 18} side={1} />
      <Eye type={le} x={cx - eyeDx} y={eyeY} side={-1} s={ls * scale} />
      <Eye type={re} x={cx + eyeDx} y={eyeY} side={1} s={rs * scale} />
      <Mouth type={spec.mouth} x={cx + (spec.mouthDx ?? 0)} y={mouthY} s={scale} />
    </g>
  )
}

/* ---------------- floating extras ---------------- */

const SPARK = 'M0 -9 C1 -2.5 2.5 -1 9 0 C2.5 1 1 2.5 0 9 C-1 2.5 -2.5 1 -9 0 C-2.5 -1 -1 -2.5 0 -9 Z'
const DROP = 'M0 -8 C3 -3 5 0 5 3 C5 6 2.8 8 0 8 C-2.8 8 -5 6 -5 3 C-5 0 -3 -3 0 -8 Z'

export type ExtraType = 'sparkles' | 'notes' | 'question' | 'hearts' | 'exclaim' | 'sweat' | 'haha' | 'zzz' | 'none'

export function Extras({ type, color = '#fff' }: { type: ExtraType; color?: string }) {
  const text = { fontFamily: 'Geist, Inter, sans-serif', fontWeight: 800 }
  switch (type) {
    case 'sparkles':
      return (
        <g>
          <path d={SPARK} transform="translate(22 62) scale(1.3)" fill="#FFD23F" />
          <path d={SPARK} transform="translate(182 48) scale(1.5)" fill={color} />
          <path d={SPARK} transform="translate(192 130) scale(0.9)" fill="#FFD23F" />
          <path d={SPARK} transform="translate(8 138) scale(0.8)" fill={color} />
        </g>
      )
    case 'notes':
      return (
        <g fill={color}>
          <text x={168} y={66} fontSize={26} {...text}>♪</text>
          <text x={16} y={92} fontSize={20} {...text}>♫</text>
        </g>
      )
    case 'question':
      return (
        <text x={168} y={60} fontSize={40} fill={color} transform="rotate(12 178 46)" {...text}>
          ?
        </text>
      )
    case 'hearts':
      return (
        <g fill="#FF4D8D" stroke="#fff" strokeWidth={1.5}>
          <path d={HEART} transform="translate(176 70) scale(1.3)" />
          <path d={HEART} transform="translate(26 88) scale(1)" />
          <path d={HEART} transform="translate(160 34) scale(0.8)" />
        </g>
      )
    case 'exclaim':
      return (
        <g stroke={color} strokeWidth={4.5} strokeLinecap="round">
          <line x1={34} y1={44} x2={42} y2={56} />
          <line x1={22} y1={64} x2={34} y2={70} />
          <line x1={166} y1={44} x2={158} y2={56} />
          <line x1={178} y1={64} x2={166} y2={70} />
          <line x1={100} y1={8} x2={100} y2={22} />
        </g>
      )
    case 'sweat':
      return <path d={DROP} transform="translate(166 78) scale(1.4)" fill="#8FD3FF" stroke="#fff" strokeWidth={1.2} />
    case 'haha':
      return (
        <g fill={color} {...text}>
          <text x={150} y={50} fontSize={22} transform="rotate(14 160 44)">HA</text>
          <text x={14} y={66} fontSize={18} transform="rotate(-14 24 60)">HA</text>
        </g>
      )
    case 'zzz':
      return (
        <g fill={color} {...text}>
          <text x={146} y={70} fontSize={18}>z</text>
          <text x={160} y={50} fontSize={24}>z</text>
          <text x={178} y={26} fontSize={30}>Z</text>
        </g>
      )
    default:
      return null
  }
}
