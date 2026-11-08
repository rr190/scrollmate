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
