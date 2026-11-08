/**
 * Turns MediaPipe Face Landmarker output (52 blendshape scores, 478 landmarks incl. irises, head pose)
 * into the few signals ScrollMate uses. Pure and deterministic so it can be unit-tested without a camera.
 * Shared by the extension's camera page and the backend's /ui/face test page (compiled by `npm run build`).
 *
 * Runs on-device only: these labels are the only thing that leaves the camera page, and they
 * stay inside the extension (never sent to the backend).
 */
export type UserExpression = 'neutral' | 'happy' | 'laughing' | 'surprised' | 'sad' | 'disgusted' | 'scared' | 'angry' | 'confused';

export interface UserSignal {
  present: boolean; // a face is in view
  lookingAway: boolean; // head turned well away from the screen
  expression: UserExpression;
  /** 0..1 strength of the current expression (for the face's intensity). */
  strength: number;
  at: number; // ms
}

export interface FaceFrame {
  blendshapes: Record<string, number> | null; // null = no face this frame
  yawDeg?: number; // head turn left/right
  pitchDeg?: number; // head tilt up/down
}

// ---------------------------------------------------------------------------------------------
// Expressions, measured against YOUR resting face
// ---------------------------------------------------------------------------------------------

/** The combined scores the rules look at (each averaged over left/right where MediaPipe splits them). */
export const FEATURES = {
  smile: ['mouthSmileLeft', 'mouthSmileRight'],
  jaw: ['jawOpen'],
  browInner: ['browInnerUp'],
  browOuter: ['browOuterUpLeft', 'browOuterUpRight'],
  wide: ['eyeWideLeft', 'eyeWideRight'],
  squint: ['eyeSquintLeft', 'eyeSquintRight'],
  frown: ['mouthFrownLeft', 'mouthFrownRight'],
  sneer: ['noseSneerLeft', 'noseSneerRight'], // nose wrinkle (disgust)
  upperLip: ['mouthUpperUpLeft', 'mouthUpperUpRight'], // upper lip raised (disgust)
  browDown: ['browDownLeft', 'browDownRight'], // brows lowered / pulled together (anger)
  press: ['mouthPressLeft', 'mouthPressRight'], // lips pressed (anger)
  stretch: ['mouthStretchLeft', 'mouthStretchRight'], // mouth pulled sideways (fear)
  browAsym: [], // one brow up, the other not (confusion): computed specially in features()
} as const;
export type Feature = keyof typeof FEATURES;
export type FeatureValues = Record<Feature, number>;

/**
 * Thresholds on the CHANGE from your resting face (score minus baseline).
 * Everyone's neutral face differs: e.g. many people's resting mouth already reads ~0.3 "frown".
 */
export const THRESHOLDS = {
  laughSmile: 0.42, // smile, plus open jaw or squinting eyes
  laughJaw: 0.18,
  laughSquint: 0.3,
  happySmile: 0.32,
  surpriseJaw: 0.3, // open jaw, plus raised brows or wide eyes, not smiling
  surpriseBrows: 0.22,
  surpriseWide: 0.18,
  surpriseMaxSmile: 0.2,
  sadFrown: 0.18, // frown, plus raised inner brows... or a clearly stronger frown on its own
  sadBrows: 0.12,
  sadStrongFrown: 0.3,
  sadMaxSmile: 0.08,
  // Added from FER's emotion set (angry, disgust, fear) + confused, using MediaPipe's own muscles.
  // Starting points: tune them on /ui/face, where each bar shows its trigger mark.
  disgustSneer: 0.25, // nose wrinkle... or raised upper lip with a squint
  disgustUpperLip: 0.25,
  disgustSquint: 0.12,
  disgustMaxSmile: 0.3,
  fearBrows: 0.22, // inner brows up + eyes wide + mouth stretched sideways
  fearWide: 0.12,
  fearStretch: 0.15,
  fearMaxSmile: 0.15,
  angryBrowDown: 0.3, // brows down, plus pressed lips, a squint or a sneer
  angryPress: 0.15,
  angrySquint: 0.2,
  angrySneer: 0.15,
  angryMaxSmile: 0.15,
  confusedAsym: 0.25, // one brow clearly higher than the other
  confusedMaxSmile: 0.25,
  confusedMaxJaw: 0.3,
} as const;

const mean = (b: Record<string, number>, keys: readonly string[]) => keys.reduce((s, k) => s + (b[k] ?? 0), 0) / keys.length;

export function features(b: Record<string, number>): FeatureValues {
  const out = {} as FeatureValues;
  for (const f of Object.keys(FEATURES) as Feature[]) out[f] = FEATURES[f].length ? mean(b, FEATURES[f]) : 0;
  // one brow up and the other not: the bigger left/right difference of "brow up" or "brow down"
  out.browAsym = Math.max(
    Math.abs((b.browOuterUpLeft ?? 0) - (b.browOuterUpRight ?? 0)),
    Math.abs((b.browDownLeft ?? 0) - (b.browDownRight ?? 0)),
  );
  return out;
}

const ZERO = Object.fromEntries(Object.keys(FEATURES).map((k) => [k, 0])) as FeatureValues;

/** Change from the resting face, never negative. */
export function deltas(b: Record<string, number>, base: FeatureValues = ZERO): FeatureValues {
  const f = features(b);
  const out = {} as FeatureValues;
  for (const k of Object.keys(f) as Feature[]) out[k] = Math.max(0, f[k] - base[k]);
  return out;
}

/** One frame -> raw expression + strength (before smoothing). `base` = the person's resting face. */
export function classify(b: Record<string, number>, base: FeatureValues = ZERO): { expression: UserExpression; strength: number } {
  const d = deltas(b, base);
  const T = THRESHOLDS;
  const brows = Math.max(d.browInner, d.browOuter);
  if (d.smile > T.laughSmile && (d.jaw > T.laughJaw || d.squint > T.laughSquint))
    return { expression: 'laughing', strength: Math.min(1, (d.smile + d.jaw) / 1.2) };
  // fear before surprise: both raise the brows, fear also pulls the mouth sideways
  if (d.browInner > T.fearBrows && d.wide > T.fearWide && d.stretch > T.fearStretch && d.smile < T.fearMaxSmile)
    return { expression: 'scared', strength: Math.min(1, d.browInner + d.stretch + d.wide) };
  if (d.jaw > T.surpriseJaw && (brows > T.surpriseBrows || d.wide > T.surpriseWide) && d.smile < T.surpriseMaxSmile)
    return { expression: 'surprised', strength: Math.min(1, (d.jaw + brows) / 1.1) };
  if (d.smile > T.happySmile) return { expression: 'happy', strength: Math.min(1, d.smile * 1.2) };
  if (d.smile < T.disgustMaxSmile && (d.sneer > T.disgustSneer || (d.upperLip > T.disgustUpperLip && d.squint > T.disgustSquint)))
    return { expression: 'disgusted', strength: Math.min(1, (d.sneer + d.upperLip) * 1.2) };
  if (d.smile < T.angryMaxSmile && d.browDown > T.angryBrowDown && (d.press > T.angryPress || d.squint > T.angrySquint || d.sneer > T.angrySneer))
    return { expression: 'angry', strength: Math.min(1, d.browDown + Math.max(d.press, d.squint, d.sneer)) };
  if (d.smile < T.sadMaxSmile && ((d.frown > T.sadFrown && d.browInner > T.sadBrows) || d.frown > T.sadStrongFrown))
    return { expression: 'sad', strength: Math.min(1, d.frown * 2 + d.browInner) };
  if (d.browAsym > T.confusedAsym && d.smile < T.confusedMaxSmile && d.jaw < T.confusedMaxJaw)
    return { expression: 'confused', strength: Math.min(1, d.browAsym * 2) };
  return { expression: 'neutral', strength: 0 };
}

/**
 * Learns the person's resting face: the first ~2 s with a face set it (median), then it keeps adapting
 * slowly (only while the face reads neutral), so a resting frown or permanent half-smile isn't mistaken
 * for an emotion. `reset()` re-learns it (e.g. a "look neutral" button).
 */
export class FaceBaseline {
  private samples: FeatureValues[] = [];
  value: FeatureValues = { ...ZERO };
  ready = false;

  constructor(
    private warmupFrames = 20,
    private rate = 0.01, // slow drift (~10 s at 10 fps)
  ) {}

  observe(b: Record<string, number>, rawExpression: UserExpression) {
    const f = features(b);
    if (!this.ready) {
      this.samples.push(f);
      if (this.samples.length >= this.warmupFrames) {
        for (const k of Object.keys(f) as Feature[]) {
          const s = this.samples.map((x) => x[k]).sort((a, z) => a - z);
          this.value[k] = Math.min(0.5, s[Math.floor(s.length / 2)]); // a big grin at start can't become "rest"
        }
        this.ready = true;
        this.samples = [];
      }
      return;
    }
    if (rawExpression !== 'neutral') return; // only learn from resting moments
    for (const k of Object.keys(f) as Feature[]) this.value[k] = Math.min(0.5, this.value[k] + this.rate * (f[k] - this.value[k]));
  }

  reset() {
    this.samples = [];
    this.value = { ...ZERO };
    this.ready = false;
  }
}

/**
 * Smooths frame-by-frame noise: an expression must hold for `holdMs` before it's reported,
 * and the face must be missing / turned away for `awayMs` before "away" is reported.
 */
export class FaceSignalTracker {
  private candidate: { expression: UserExpression; since: number; strength: number } = { expression: 'neutral', since: 0, strength: 0 };
  private missingSince: number | null = null;
  private turnedSince: number | null = null;
  private everSeen = false; // never claim 'present' before a face has actually been seen
  readonly baseline = new FaceBaseline();
  current: UserSignal = { present: false, lookingAway: false, expression: 'neutral', strength: 0, at: 0 };
  /** The last frame's unsmoothed result (for debugging / the test page). */
  lastRaw: { expression: UserExpression; strength: number } | null = null;

  constructor(
    private holdMs = 250,
    private awayMs = 1200,
    private yawLimitDeg = 28,
  ) {}

  /** Feed one frame; returns the new signal only when something changed (else null). */
  update(f: FaceFrame, now: number): UserSignal | null {
    const prev = this.current;
    let present = true;
    let lookingAway = false;
    let expression: UserExpression = prev.expression;
    let strength = prev.strength;

    if (!f.blendshapes) {
      this.lastRaw = null;
      this.missingSince ??= now;
      present = this.everSeen && now - this.missingSince < this.awayMs;
      lookingAway = !present;
      if (!present) {
        expression = 'neutral';
        strength = 0;
      }
    } else {
      this.missingSince = null;
      this.everSeen = true;
      const turned = Math.abs(f.yawDeg ?? 0) > this.yawLimitDeg || (f.pitchDeg ?? 0) > this.yawLimitDeg; // looking down at a phone
      this.turnedSince = turned ? (this.turnedSince ?? now) : null;
      lookingAway = this.turnedSince !== null && now - this.turnedSince >= this.awayMs;

      const raw = classify(f.blendshapes, this.baseline.value);
      this.lastRaw = raw;
      this.baseline.observe(f.blendshapes, raw.expression);
      if (raw.expression !== this.candidate.expression) this.candidate = { ...raw, since: now };
      else this.candidate.strength = raw.strength;
      if (now - this.candidate.since >= this.holdMs) {
        expression = this.candidate.expression;
        strength = this.candidate.strength;
      }
    }

    const changed = present !== prev.present || lookingAway !== prev.lookingAway || expression !== prev.expression;
    this.current = { present, lookingAway, expression, strength, at: now };
    return changed ? this.current : null;
  }
}

/** Yaw / pitch in degrees from MediaPipe's 4x4 facial transformation matrix (column-major). */
export function headAngles(m: ArrayLike<number> | undefined): { yawDeg: number; pitchDeg: number } {
  if (!m || m.length < 16) return { yawDeg: 0, pitchDeg: 0 };
  // rotation part: r02 = m[8], r12 = m[9], r22 = m[10] (column-major)
  const yaw = Math.atan2(m[8], m[10]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[9])));
  return { yawDeg: (yaw * 180) / Math.PI, pitchDeg: (pitch * 180) / Math.PI };
}

// ---------------------------------------------------------------------------------------------
// Eye tracking (gaze) from the iris landmarks + head pose
// ---------------------------------------------------------------------------------------------

export interface Pt {
  x: number;
  y: number;
}

/** MediaPipe face mesh indices (478-point model with irises). "Right/left" = the person's own eyes. */
const EYE = {
  right: { iris: 468, a: 33, b: 133, top: 159, bottom: 145 }, // a = outer corner, b = inner corner
  left: { iris: 473, a: 362, b: 263, top: 386, bottom: 374 }, // a = inner corner, b = outer corner
} as const;

/**
 * Where each iris sits inside its eye, as 0..1 (0.5 = centred), averaged over both eyes.
 * x grows towards the image's right (the person's LEFT); y grows downward.
 */
export function irisPosition(lm: readonly Pt[] | undefined): Pt | null {
  if (!lm || lm.length < 478) return null;
  const one = (e: (typeof EYE)['right']) => {
    const a = lm[e.a], b = lm[e.b], i = lm[e.iris], t = lm[e.top], d = lm[e.bottom];
    const w = b.x - a.x, h = d.y - t.y;
    if (Math.abs(w) < 1e-6 || Math.abs(h) < 1e-6) return null;
    return { x: (i.x - a.x) / w, y: (i.y - t.y) / h };
  };
  const r = one(EYE.right), l = one(EYE.left as unknown as (typeof EYE)['right']);
  if (!r || !l) return r ?? l;
  return { x: (r.x + l.x) / 2, y: (r.y + l.y) / 2 };
}

/** The numbers the gaze model uses: iris offsets from centre + head angles (scaled to similar ranges). */
export function gazeFeatures(iris: Pt, yawDeg: number, pitchDeg: number): number[] {
  return [iris.x - 0.5, iris.y - 0.5, yawDeg / 30, pitchDeg / 30, 1];
}

/**
 * Rough screen point (0..1, 0,0 = top-left) without calibration. Directions are a reasonable default
 * for a laptop webcam above the screen; calibrate for real accuracy.
 */
export function uncalibratedGaze(iris: Pt, yawDeg: number, pitchDeg: number): Pt {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return {
    // looking to your left moves the iris toward the image's right -> screen x decreases
    x: clamp(0.5 - (iris.x - 0.5) * 4 - yawDeg / 50),
    y: clamp(0.45 + (iris.y - 0.5) * 3 + pitchDeg / 40),
  };
}

/**
 * Personal gaze model: least-squares fit from gaze features to screen points, using samples collected
 * while the person looks at known targets (e.g. a 9-dot calibration). A little ridge keeps it stable.
 */
export class GazeCalibrator {
  private xs: number[][] = [];
  private tx: number[] = [];
  private ty: number[] = [];
  private wx: number[] | null = null;
  private wy: number[] | null = null;

  get calibrated(): boolean {
    return this.wx !== null;
  }

  add(features: number[], target: Pt) {
    this.xs.push(features);
    this.tx.push(target.x);
    this.ty.push(target.y);
  }

  clear() {
    this.xs = [];
    this.tx = [];
    this.ty = [];
    this.wx = this.wy = null;
  }

  /** Fit the model; returns the mean error on the calibration samples (fraction of the screen), or null. */
  fit(ridge = 1e-3): number | null {
    if (this.xs.length < 6) return null;
    this.wx = solveLeastSquares(this.xs, this.tx, ridge);
    this.wy = solveLeastSquares(this.xs, this.ty, ridge);
    if (!this.wx || !this.wy) {
      this.wx = this.wy = null;
      return null;
    }
    let err = 0;
    this.xs.forEach((f, i) => {
      const p = this.predict(f)!;
      err += Math.hypot(p.x - this.tx[i], p.y - this.ty[i]);
    });
    return err / this.xs.length;
  }

  predict(features: number[]): Pt | null {
    if (!this.wx || !this.wy) return null;
    const dot = (w: number[]) => w.reduce((s, wi, i) => s + wi * features[i], 0);
    const clamp = (v: number) => Math.max(-0.1, Math.min(1.1, v));
    return { x: clamp(dot(this.wx)), y: clamp(dot(this.wy)) };
  }
}

/** Ridge least squares via the normal equations (tiny systems: 5 unknowns). */
export function solveLeastSquares(X: number[][], y: number[], ridge = 0): number[] | null {
  const n = X[0]?.length ?? 0;
  if (!n) return null;
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  X.forEach((row, r) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += row[i] * row[j];
      A[i][n] += row[i] * y[r];
    }
  });
  for (let i = 0; i < n - 1; i++) A[i][i] += ridge; // don't shrink the bias term
  // Gauss-Jordan with partial pivoting
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

/** Smooths a jittery gaze point (exponential moving average). */
export class GazeSmoother {
  private p: Pt | null = null;
  constructor(private alpha = 0.35) {}
  push(q: Pt): Pt {
    this.p = this.p ? { x: this.p.x + this.alpha * (q.x - this.p.x), y: this.p.y + this.alpha * (q.y - this.p.y) } : q;
    return this.p;
  }
  reset() {
    this.p = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Accurate gaze, after EyeTrax (github.com/ck-zhang/EyeTrax, MIT): eye-region landmarks in a
// head-centred frame + standardised ridge regression + Kalman smoothing + blink rejection.
// ---------------------------------------------------------------------------------------------

export interface Pt3 {
  x: number;
  y: number;
  z?: number;
}

/** EyeTrax's exact landmark sets (src/eyetrax/constants.py, MIT): dense rings around each eye incl. irises + face anchors. */
export const EYETRAX_LEFT_EYE: readonly number[] = [
  107, 66, 105, 63, 70, 55, 65, 52, 53, 46, 468, 469, 470, 471, 472, 133, 33, 173, 157, 158, 159, 160, 161,
  246, 155, 154, 153, 145, 144, 163, 7, 243, 190, 56, 28, 27, 29, 30, 247, 130, 25, 110, 24, 23, 22, 26, 112,
  244, 189, 221, 222, 223, 224, 225, 113, 226, 31, 228, 229, 230, 231, 232, 233, 193, 245, 128, 121, 120,
  119, 118, 117, 111, 35, 124, 143, 156,
];
export const EYETRAX_RIGHT_EYE: readonly number[] = [
  336, 296, 334, 293, 300, 285, 295, 282, 283, 276, 473, 476, 475, 474, 477, 362, 263, 398, 384, 385, 386,
  387, 388, 466, 382, 381, 380, 374, 373, 390, 249, 463, 414, 286, 258, 257, 259, 260, 467, 359, 255, 339,
  254, 253, 252, 256, 341, 464, 413, 441, 442, 443, 444, 445, 342, 446, 261, 448, 449, 450, 451, 452, 453,
  417, 465, 357, 350, 349, 348, 347, 346, 340, 265, 353, 372, 383,
];
/** Nose, very top, forehead, between brows, chin, very left, very right, left jaw, right jaw. */
export const EYETRAX_MUTUAL: readonly number[] = [4, 10, 151, 9, 152, 234, 454, 58, 288];
/** 161 landmarks -> 161 * 3 + 3 = 486 features, in EyeTrax's order. */
export const GAZE_LANDMARKS: readonly number[] = [...EYETRAX_LEFT_EYE, ...EYETRAX_RIGHT_EYE, ...EYETRAX_MUTUAL];

const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const scale3 = (a: number[], k: number) => [a[0] * k, a[1] * k, a[2] * k];
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * EyeTrax-style feature vector: landmarks re-expressed in the head's own frame (origin = between the eye
 * corners 33/263, x = corner-to-corner, y = towards the top of the head (10), z = cross) and divided by
 * the eye-corner distance, so moving/turning the head or sitting closer changes them far less.
 * `aspect` = 1 matches EyeTrax exactly (MediaPipe's normalised x, y, z as-is). Passing video width / height
 * corrects for MediaPipe normalising x and y separately: an optional extra, not in EyeTrax.
 * Appends yaw, pitch, roll of that frame. Length = GAZE_LANDMARKS.length * 3 + 3.
 */
export function gazeFeatureVector(lm: readonly Pt3[] | undefined, aspect = 1): number[] | null {
  if (!lm || lm.length < 478) return null;
  const P = (i: number) => [lm[i].x * aspect, lm[i].y, (lm[i].z ?? 0) * aspect];
  const l = P(33), r = P(263), top = P(10);
  const center = scale3([l[0] + r[0], l[1] + r[1], l[2] + r[2]], 0.5);
  const xr = sub3(r, l);
  const eyeDist = norm3(xr);
  if (eyeDist < 1e-7) return null;
  const xAxis = scale3(xr, 1 / eyeDist);
  const yApprox = sub3(top, center);
  const yOrth = sub3(yApprox, scale3(xAxis, dot3(yApprox, xAxis)));
  const yn = norm3(yOrth);
  if (yn < 1e-7) return null;
  const yAxis = scale3(yOrth, 1 / yn);
  const zAxis = cross3(xAxis, yAxis);
  const out: number[] = [];
  for (const i of GAZE_LANDMARKS) {
    const p = sub3(P(i), center);
    out.push(dot3(p, xAxis) / eyeDist, dot3(p, yAxis) / eyeDist, dot3(p, zAxis) / eyeDist);
  }
  // R = [x y z] as columns: same Euler convention as EyeTrax.
  const yaw = Math.atan2(xAxis[1], xAxis[0]);
  const pitch = Math.atan2(-xAxis[2], Math.hypot(yAxis[2], zAxis[2]));
  const roll = Math.atan2(yAxis[2], zAxis[2]);
  out.push(yaw, pitch, roll);
  return out;
}

/** Eye aspect ratio: eyelid gap / eye width, averaged over both eyes (drops sharply in a blink). */
export function eyeAspectRatio(lm: readonly Pt3[] | undefined, aspect = 1): number | null {
  if (!lm || lm.length < 478) return null;
  const d = (a: number, b: number) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);
  const left = d(159, 145) / (d(33, 133) + 1e-9);
  const right = d(386, 374) / (d(362, 263) + 1e-9);
  return (left + right) / 2;
}

/** EyeTrax blink rule: blink when EAR < 0.8 x the recent average (fixed 0.2 until 15 samples). */
export class BlinkDetector {
  private history: number[] = [];
  constructor(
    private ratio = 0.8,
    private historyLen = 50,
    private minHistory = 15,
    private fallback = 0.2,
  ) {}
  update(ear: number): boolean {
    this.history.push(ear);
    if (this.history.length > this.historyLen) this.history.shift();
    const thr =
      this.history.length >= this.minHistory ? (this.history.reduce((s, v) => s + v, 0) / this.history.length) * this.ratio : this.fallback;
    return ear < thr;
  }
}

/** Standardise features, then ridge regression to (x, y) (EyeTrax default: StandardScaler + Ridge(alpha=1)). */
export class RidgeGaze {
  private mean: number[] = [];
  private std: number[] = [];
  private w: number[][] | null = null; // [feature][output]
  private b: number[] = [0, 0];

  get trained(): boolean {
    return this.w !== null;
  }

  fit(X: number[][], Y: Pt[], alpha = 1.0): boolean {
    const n = X.length, d = X[0]?.length ?? 0;
    if (n < 10 || !d) return false;
    this.mean = new Array(d).fill(0);
    this.std = new Array(d).fill(0);
    for (const row of X) row.forEach((v, j) => (this.mean[j] += v / n));
    for (const row of X) row.forEach((v, j) => (this.std[j] += (v - this.mean[j]) ** 2 / n));
    this.std = this.std.map((v) => (v > 1e-12 ? Math.sqrt(v) : 1));
    const Z = X.map((row) => row.map((v, j) => (v - this.mean[j]) / this.std[j]));
    this.b = [Y.reduce((s, p) => s + p.x, 0) / n, Y.reduce((s, p) => s + p.y, 0) / n];
    // (Z'Z + alpha I) W = Z'(Y - mean), solved once for both outputs
    const A = Array.from({ length: d }, () => new Array(d + 2).fill(0));
    for (let r = 0; r < n; r++) {
      const z = Z[r], tx = Y[r].x - this.b[0], ty = Y[r].y - this.b[1];
      for (let i = 0; i < d; i++) {
        const zi = z[i];
        if (zi === 0) continue;
        const Ai = A[i];
        for (let j = i; j < d; j++) Ai[j] += zi * z[j];
        Ai[d] += zi * tx;
        Ai[d + 1] += zi * ty;
      }
    }
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < i; j++) A[i][j] = A[j][i]; // mirror the upper triangle
      A[i][i] += alpha;
    }
    // Gaussian elimination (symmetric positive definite after the ridge: no pivoting needed)
    for (let c = 0; c < d; c++) {
      const piv = A[c][c];
      if (Math.abs(piv) < 1e-12) return false;
      for (let r = c + 1; r < d; r++) {
        const k = A[r][c] / piv;
        if (k === 0) continue;
        for (let j = c; j < d + 2; j++) A[r][j] -= k * A[c][j];
      }
    }
    const W = Array.from({ length: d }, () => [0, 0]);
    for (let i = d - 1; i >= 0; i--) {
      for (let o = 0; o < 2; o++) {
        let s = A[i][d + o];
        for (let j = i + 1; j < d; j++) s -= A[i][j] * W[j][o];
        W[i][o] = s / A[i][i];
      }
    }
    this.w = W;
    return true;
  }

  predict(x: number[]): Pt | null {
    if (!this.w) return null;
    let px = this.b[0], py = this.b[1];
    for (let j = 0; j < x.length; j++) {
      const z = (x[j] - this.mean[j]) / this.std[j];
      px += z * this.w[j][0];
      py += z * this.w[j][1];
    }
    return { x: px, y: py };
  }

  clear() {
    this.w = null;
  }

  /** Plain numbers for chrome.storage (the personal model stays on this computer). */
  toJSON(): RidgeData | null {
    return this.w ? { mean: this.mean, std: this.std, w: this.w, b: this.b } : null;
  }

  static fromJSON(d: RidgeData | null | undefined): RidgeGaze {
    const m = new RidgeGaze();
    if (d && Array.isArray(d.w) && d.w.length === d.mean.length && d.mean.length === d.std.length) {
      m.mean = d.mean; m.std = d.std; m.w = d.w; m.b = d.b;
    }
    return m;
  }
}

export interface RidgeData { mean: number[]; std: number[]; w: number[][]; b: number[] }

/**
 * Constant-velocity Kalman filter on screen pixels (EyeTrax: state [x, y, vx, vy], dt = 1 frame,
 * process noise 50, measurement noise 0.2), optionally followed by an EMA (EyeTrax kalman_ema, 0.25).
 * EyeTrax's `tune()` (fineTuneTargets + varianceOf) sets the measurement noise for real smoothing.
 */
export class KalmanGaze {
  private s: number[] | null = null; // [px, py, vx, vy]
  private P: number[][] = [];
  private R: [number, number];
  private ema: Pt | null = null;

  constructor(
    private q = 50,
    r = 0.2,
    private emaAlpha = 0.25,
  ) {
    this.R = [r, r];
  }

  setMeasurementNoise(rx: number, ry: number) {
    this.R = [Math.max(1e-4, rx), Math.max(1e-4, ry)];
  }

  reset() {
    this.s = null;
    this.ema = null;
  }

  step(m: Pt): Pt {
    if (!this.s) {
      this.s = [m.x, m.y, 0, 0];
      this.P = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1000 : 0)));
      this.ema = { ...m };
      return { ...m };
    }
    // predict: s = F s, P = F P F' + Q with F = [[1,0,1,0],[0,1,0,1],[0,0,1,0],[0,0,0,1]]
    const [px, py, vx, vy] = this.s;
    this.s = [px + vx, py + vy, vx, vy];
    const P = this.P;
    const FP = [
      [P[0][0] + P[2][0], P[0][1] + P[2][1], P[0][2] + P[2][2], P[0][3] + P[2][3]],
      [P[1][0] + P[3][0], P[1][1] + P[3][1], P[1][2] + P[3][2], P[1][3] + P[3][3]],
      [...P[2]],
      [...P[3]],
    ];
    this.P = FP.map((row) => [row[0] + row[2], row[1] + row[3], row[2], row[3]]);
    for (let i = 0; i < 4; i++) this.P[i][i] += this.q;
    const pred = { x: this.s[0], y: this.s[1] }; // EyeTrax returns the prior (one-step) prediction
    // correct with H = [[1,0,0,0],[0,1,0,0]], one axis at a time (measurement noise is diagonal)
    for (const axis of [0, 1]) {
      const S = this.P[axis][axis] + this.R[axis];
      const K = this.P.map((row) => row[axis] / S);
      const innov = (axis === 0 ? m.x : m.y) - this.s[axis];
      for (let i = 0; i < 4; i++) this.s[i] += K[i] * innov;
      const rowA = [...this.P[axis]];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) this.P[i][j] -= K[i] * rowA[j];
    }
    if (this.emaAlpha <= 0 || !this.ema) return pred;
    const a = this.emaAlpha;
    this.ema = { x: a * this.ema.x + (1 - a) * pred.x, y: a * this.ema.y + (1 - a) * pred.y };
    return { ...this.ema };
  }
}

/** EyeTrax 9-point layout: 10% / 50% / 90% margins, centre first, then corners, then edge midpoints. */
export function ninePointTargets(margin = 0.1): Pt[] {
  const v = [margin, 0.5, 1 - margin];
  const order: [number, number][] = [[1, 1], [0, 0], [2, 0], [0, 2], [2, 2], [1, 0], [0, 1], [2, 1], [1, 2]];
  return order.map(([row, col]) => ({ x: v[col], y: v[row] }));
}

/** Denser 5x5 grid in serpentine order (EyeTrax "dense"): slower, but more accurate. */
export function denseTargets(n = 5, margin = 0.1): Pt[] {
  const out: Pt[] = [];
  for (let r = 0; r < n; r++) {
    const cols = Array.from({ length: n }, (_, c) => c);
    if (r % 2) cols.reverse();
    for (const c of cols) out.push({ x: margin + ((1 - 2 * margin) * c) / (n - 1), y: margin + ((1 - 2 * margin) * r) / (n - 1) });
  }
  return out;
}

/** EyeTrax KalmanSmoother.tune: 3 targets at (W/2, H/4), (W/4, 3H/4), (3W/4, 3H/4) in pixels. */
export function fineTuneTargets(w: number, h: number): Pt[] {
  return [
    { x: Math.floor(w / 2), y: Math.floor(h / 4) },
    { x: Math.floor(w / 4), y: Math.floor((3 * h) / 4) },
    { x: Math.floor((3 * w) / 4), y: Math.floor((3 * h) / 4) },
  ];
}

/** EyeTrax tune timings: gaze within W/5 of a target, 0.5 s before collecting, then 0.5 s of collection. */
export const FINE_TUNE = { proximityOfWidth: 1 / 5, initialDelayMs: 500, collectMs: 500 } as const;

/** Per-axis population variance of collected gaze points (np.var, axis=0); zeros -> 1e-4 like EyeTrax. */
export function varianceOf(points: Pt[]): { x: number; y: number } | null {
  if (points.length < 2) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length, my = points.reduce((s, p) => s + p.y, 0) / points.length;
  const vx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0) / points.length;
  const vy = points.reduce((s, p) => s + (p.y - my) ** 2, 0) / points.length;
  return { x: vx || 1e-4, y: vy || 1e-4 };
}

// ---------------------------------------------------------------------------------------------
// Looking DOWN (bottom of the screen) — extras beyond EyeTrax. Lowered eyelids make EyeTrax's EAR blink
// rule throw away bottom-of-screen frames, and partly hide the iris. MediaPipe's own eye blendshapes
// separate "looking down" from "blinking" and measure gaze direction directly.
// ---------------------------------------------------------------------------------------------

/** MediaPipe blendshapes that describe where the eyes point (robust when the eyelids droop). */
export const EYE_DIRECTION_BLENDSHAPES = [
  'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookUpLeft', 'eyeLookUpRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight',
] as const;

/** EyeTrax features + the 12 eye-direction blendshape scores (486 + 12 = 498 values). */
export function gazeFeatureVectorPlus(
  lm: readonly Pt3[] | undefined,
  blendshapes: Record<string, number> | null,
  aspect = 1,
): number[] | null {
  const base = gazeFeatureVector(lm, aspect);
  if (!base) return null;
  return [...base, ...EYE_DIRECTION_BLENDSHAPES.map((k) => blendshapes?.[k] ?? 0)];
}

/**
 * Blink that doesn't fire when you merely look down: EyeTrax's EAR rule must agree with MediaPipe's
 * eyeBlink score (looking down lowers EAR, but eyeBlink stays low until the lids actually close).
 */
export function isRealBlink(earSaysBlink: boolean, blendshapes: Record<string, number> | null, minBlinkScore = 0.5): boolean {
  if (!earSaysBlink) return false;
  if (!blendshapes) return true; // no blendshapes: fall back to EyeTrax's rule
  const blinkScore = ((blendshapes.eyeBlinkLeft ?? 0) + (blendshapes.eyeBlinkRight ?? 0)) / 2;
  return blinkScore >= minBlinkScore;
}

/** 9 EyeTrax dots + 3 more near the bottom (where webcam gaze is weakest): 12 dots. */
export function bottomHeavyTargets(margin = 0.1): Pt[] {
  return [...ninePointTargets(margin), { x: 0.3, y: 1 - margin }, { x: 0.7, y: 1 - margin }, { x: 0.5, y: 0.72 }];
}

// ---------------------------------------------------------------------------------------------
// Gaze in the extension: a saved personal model + coarse zones (video / comments / Mochi / away).
// Webcam gaze is good to ~5-10 % of the screen, so the extension only asks big-area questions.
// ---------------------------------------------------------------------------------------------

/** What the calibration page saves (chrome.storage.local, this computer only). Predicts screen pixels. */
export interface GazeModelData {
  version: 1;
  features: 'eyetrax' | 'eyetrax+blendshapes';
  ridge: RidgeData;
  /** The fullscreen calibration area in px (predictions / screen = screen fraction). */
  screen: { w: number; h: number };
  /** Kalman measurement noise in px², from the calibration residuals (EyeTrax tune()'s idea). */
  noise: { x: number; y: number };
  /** Mean calibration error as a fraction of the screen diagonal. */
  error: number;
  dots: number;
  savedAt: number;
}

export const GAZE_MODEL_KEY = 'scrollmate.gazeModel';

export type GazeZone = 'video' | 'comments' | 'mochi' | 'elsewhere' | 'off_screen';

export interface ZoneRects {
  video?: { x: number; y: number; width: number; height: number } | null;
  comments?: { x: number; y: number; width: number; height: number } | null;
  mochi?: { x: number; y: number; width: number; height: number } | null;
}

const inside = (p: Pt, r: { x: number; y: number; width: number; height: number } | null | undefined, pad: number) =>
  !!r && p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;

/**
 * Which zone a gaze point (viewport px) falls in. Mochi first (small, on top), then comments, then video.
 * `current` gets `stickyPx` of extra margin so the zone doesn't flicker at the edges (hysteresis).
 * Mochi gets a generous pad: it's small and webcam gaze is coarse.
 */
export function gazeZone(p: Pt, rects: ZoneRects, viewport: { w: number; h: number }, current: GazeZone | null = null, stickyPx = 60): GazeZone {
  const extra = (z: GazeZone) => (z === current ? stickyPx : 0);
  const offPad = 0.08 * Math.max(viewport.w, viewport.h) + extra('off_screen') * -1;
  if (p.x < -offPad || p.y < -offPad || p.x > viewport.w + offPad || p.y > viewport.h + offPad) return 'off_screen';
  if (inside(p, rects.mochi, 50 + extra('mochi'))) return 'mochi';
  if (inside(p, rects.comments, extra('comments'))) return 'comments';
  if (inside(p, rects.video, extra('video'))) return 'video';
  return 'elsewhere';
}

/**
 * Holds a zone until a new one has been seen for `dwellMs` (gaze jitters; a glance shouldn't flip it).
 */
export class ZoneDwell {
  zone: GazeZone | null = null;
  since = 0;
  private candidate: GazeZone | null = null;
  private candidateAt = 0;
  constructor(private dwellMs = 300) {}

  /** Returns the new zone when it changes, else null. */
  update(raw: GazeZone, now: number): GazeZone | null {
    if (raw === this.zone) { this.candidate = null; return null; }
    if (raw !== this.candidate) { this.candidate = raw; this.candidateAt = now; }
    if (now - this.candidateAt < this.dwellMs) return null;
    this.zone = raw;
    this.since = now;
    this.candidate = null;
    return raw;
  }

  reset() { this.zone = null; this.candidate = null; }
}

/** Screen fraction (from the calibration, done fullscreen on this screen) -> this window's viewport px. */
export function screenToViewport(
  g: Pt,
  win: { screenX: number; screenY: number; outerWidth: number; outerHeight: number; innerWidth: number; innerHeight: number },
  scr: { width: number; height: number; left?: number; top?: number },
): Pt {
  const border = Math.max(0, (win.outerWidth - win.innerWidth) / 2);
  const top = Math.max(0, win.outerHeight - win.innerHeight - border); // tabs + address bar
  return {
    x: g.x * scr.width + (scr.left ?? 0) - win.screenX - border,
    y: g.y * scr.height + (scr.top ?? 0) - win.screenY - top,
  };
}
