// Ported from scrollmateWeb/companio-landing/src/companion (Companio landing page). Keep in sync.
/** Pure path builders for the mascot. All coordinates are in the 200×200 face space. */

const f = (n: number) => n.toFixed(2)

/** Closed eye shape. Top/bottom bulges let one path cover round, crescent and closed eyes. */
export function eyePath(cx: number, cy: number, w: number, top: number, bottom: number) {
  return (
    `M ${f(cx - w)} ${f(cy)} ` +
    `C ${f(cx - w)} ${f(cy - top)} ${f(cx + w)} ${f(cy - top)} ${f(cx + w)} ${f(cy)} ` +
    `C ${f(cx + w)} ${f(cy + bottom)} ${f(cx - w)} ${f(cy + bottom)} ${f(cx - w)} ${f(cy)} Z`
  )
}

/** Closed mouth shape from two lip curves. */
export function mouthPath(cx: number, cy: number, w: number, top: number, bottom: number) {
  const k = 0.62
  return (
    `M ${f(cx - w)} ${f(cy)} ` +
    `C ${f(cx - w * k)} ${f(cy + top)} ${f(cx + w * k)} ${f(cy + top)} ${f(cx + w)} ${f(cy)} ` +
    `C ${f(cx + w * k)} ${f(cy + bottom)} ${f(cx - w * k)} ${f(cy + bottom)} ${f(cx - w)} ${f(cy)} Z`
  )
}

/** Slightly arched brow. `side` = -1 for left, 1 for right. */
export function browPath(cx: number, cy: number, tilt: number, side: -1 | 1) {
  const outerX = cx + side * 8
  const innerX = cx - side * 7
  const innerY = cy - tilt
  const midX = (outerX + innerX) / 2
  const midY = (cy + innerY) / 2 - 3
  return `M ${f(outerX)} ${f(cy)} Q ${f(midX)} ${f(midY)} ${f(innerX)} ${f(innerY)}`
}

/**
 * Soft gumdrop body as a closed Catmull-Rom spline through 10 points.
 * `wobble` adds a slow organic undulation so the silhouette always feels alive.
 */
export function bodyPath(t: number, wobble: number) {
  const cx = 100
  const cy = 120
  const rx = 76
  const ry = 66
  const n = 10
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    const s = Math.sin(a)
    const c = Math.cos(a)
    const w = 1 + wobble * Math.sin(t * 1.7 + i * 1.9) * 0.022
    // narrower, rounder top; wider, flatter bottom
    const xr = rx * (s < 0 ? 0.92 + 0.08 * (1 + s) : 1.02)
    const yr = s > 0 ? ry * 0.86 : ry
    pts.push([cx + c * xr * w, cy + s * yr * w])
  }
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])} `
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % n]
    const p3 = pts[(i + 2) % n]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += `C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])} `
  }
  return d + 'Z'
}

type Pt = [number, number]
function rot([x, y]: Pt, deg: number, ox: number, oy: number): string {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return `${f(ox + x * c - y * s)} ${f(oy + x * s + y * c)}`
}

/** Leaf sprout on top of the head, rotated around its base. */
export function sproutPaths(deg: number, ox: number, oy: number) {
  const R = (p: Pt) => rot(p, deg, ox, oy)
  const stem = `M ${R([0, 2])} Q ${R([2.5, -8])} ${R([0, -17])}`
  const leafL =
    `M ${R([0, -15])} C ${R([-4, -23])} ${R([-15, -26])} ${R([-18, -21])} ` +
    `C ${R([-14, -15])} ${R([-6, -13])} ${R([0, -15])} Z`
  const leafR =
    `M ${R([0, -17])} C ${R([3, -26])} ${R([13, -30])} ${R([17, -25])} ` +
    `C ${R([14, -19])} ${R([6, -16])} ${R([0, -17])} Z`
  return { stem, leafL, leafR }
}
