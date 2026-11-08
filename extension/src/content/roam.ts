/**
 * Roaming: small idle steps left and right around the companion's spot. Pure (no DOM, injected time and
 * randomness) so it can be unit-tested. Positions are the companion's top-left corner in viewport px.
 *
 * Priority each tick: hold still (dragging, settings, comment visit, bubble, sleeping, reduced motion,
 * roam off, parked after a drag) > a small step.
 */
import type { Rect } from '../shared/types';

export interface Pt { x: number; y: number }

export const TOP_BAR = 56; // YouTube's masthead
export const EDGE = 6;
export const STEP_PX: [number, number] = [15, 40]; // one small step
export const PACE_PX = 60; // never more than this far left/right of its spot
export const STEP_PX_PER_S = 30; // slow shuffle
export const REST_MS: [number, number] = [3_000, 7_000]; // pause between steps
export const PARK_AFTER_DRAG_MS = 30_000;

export interface RoamRects {
  video?: Rect | null;
  comments?: Rect | null;
}

/** The box the companion's top-left may be in: whole viewport, below the top bar, fully on screen. */
export function roamArea(vp: { w: number; h: number }, size: number, topBar = TOP_BAR): Rect {
  const x = EDGE, y = topBar + EDGE;
  return { x, y, width: Math.max(0, vp.w - size - 2 * EDGE), height: Math.max(0, vp.h - size - y - EDGE) };
}

export const clampTo = (p: Pt, a: Rect): Pt => ({
  x: Math.min(a.x + a.width, Math.max(a.x, p.x)),
  y: Math.min(a.y + a.height, Math.max(a.y, p.y)),
});

export function walkMs(from: Pt, to: Pt, pxPerS = STEP_PX_PER_S): number {
  const ms = (Math.hypot(to.x - from.x, to.y - from.y) / pxPerS) * 1000;
  return Math.round(Math.min(3_000, Math.max(600, ms)));
}

/**
 * One small step left or right (same height), staying within PACE_PX of its spot (`anchor`).
 * Near the edge of that range it steps back toward the middle. Null ~30 % of the time: it stays put.
 */
export function pickStep(from: Pt, anchor: Pt, area: Rect, rng: () => number = Math.random): Pt | null {
  if (rng() < 0.3) return null;
  const off = from.x - anchor.x;
  const dir = off > PACE_PX / 2 ? -1 : off < -PACE_PX / 2 ? 1 : rng() < 0.5 ? -1 : 1;
  const len = STEP_PX[0] + rng() * (STEP_PX[1] - STEP_PX[0]);
  const x = Math.min(anchor.x + PACE_PX, Math.max(anchor.x - PACE_PX, from.x + dir * len));
  const p = clampTo({ x, y: from.y }, area);
  return Math.abs(p.x - from.x) < 5 ? null : p;
}

export interface RoamInput {
  now: number;
  enabled: boolean; // roam setting on, the AI on, on a Short
  reducedMotion: boolean;
  hold: boolean; // dragging / settings open / comment visit / bubble / speaking
  mood: string;
  pos: Pt; // where it is now
  rects: RoamRects;
  area: Rect;
  size: number;
}

export interface RoamStep { target: Pt; ms: number; why: 'step'; stroll: boolean }

export class RoamPlanner {
  private walkingUntil = 0;
  private restUntil = 0;
  private parkedUntil = 0;
  private anchor: Pt | null = null; // the spot it paces around

  constructor(private rng: () => number = Math.random) {}

  /** Called on drop after a drag: stay there for 30 s, then pace around the new spot. */
  park(now: number) {
    this.parkedUntil = now + PARK_AFTER_DRAG_MS;
    this.walkingUntil = 0;
    this.restUntil = now + PARK_AFTER_DRAG_MS;
    this.anchor = null;
  }

  /** Returns a new move when it should start one, else null (keep the current target). */
  tick(i: RoamInput): RoamStep | null {
    if (!i.enabled || i.reducedMotion) { this.anchor = null; return null; }
    if (i.hold || i.mood === 'sleeping' || i.now < this.parkedUntil || i.now < this.walkingUntil) return null;
    this.anchor ??= { ...i.pos };
    // far from its spot (e.g. you resized the window): adopt where it is as the new spot
    if (Math.abs(i.pos.x - this.anchor.x) > PACE_PX * 2 || Math.abs(i.pos.y - this.anchor.y) > 4) this.anchor = { ...i.pos };

    // a small step left or right after a pause
    if (i.now < this.restUntil) return null;
    const next = pickStep(i.pos, this.anchor, i.area, this.rng);
    if (!next) {
      this.restUntil = i.now + this.rest();
      return null;
    }
    return this.go(i, next, 'step', STEP_PX_PER_S);
  }

  private rest() {
    return REST_MS[0] + this.rng() * (REST_MS[1] - REST_MS[0]);
  }

  private go(i: RoamInput, target: Pt, why: RoamStep['why'], pxPerS: number): RoamStep {
    const ms = walkMs(i.pos, target, pxPerS);
    this.walkingUntil = i.now + ms;
    this.restUntil = this.walkingUntil + this.rest();
    return { target, ms, why, stroll: why === 'step' };
  }
}
