const FEATURES = {
  smile: ["mouthSmileLeft", "mouthSmileRight"],
  jaw: ["jawOpen"],
  browInner: ["browInnerUp"],
  browOuter: ["browOuterUpLeft", "browOuterUpRight"],
  wide: ["eyeWideLeft", "eyeWideRight"],
  squint: ["eyeSquintLeft", "eyeSquintRight"],
  frown: ["mouthFrownLeft", "mouthFrownRight"],
  sneer: ["noseSneerLeft", "noseSneerRight"],
  // nose wrinkle (disgust)
  upperLip: ["mouthUpperUpLeft", "mouthUpperUpRight"],
  // upper lip raised (disgust)
  browDown: ["browDownLeft", "browDownRight"],
  // brows lowered / pulled together (anger)
  press: ["mouthPressLeft", "mouthPressRight"],
  // lips pressed (anger)
  stretch: ["mouthStretchLeft", "mouthStretchRight"],
  // mouth pulled sideways (fear)
  browAsym: []
  // one brow up, the other not (confusion): computed specially in features()
};
const THRESHOLDS = {
  laughSmile: 0.42,
  // smile, plus open jaw or squinting eyes
  laughJaw: 0.18,
  laughSquint: 0.3,
  happySmile: 0.32,
  surpriseJaw: 0.3,
  // open jaw, plus raised brows or wide eyes, not smiling
  surpriseBrows: 0.22,
  surpriseWide: 0.18,
  surpriseMaxSmile: 0.2,
  sadFrown: 0.18,
  // frown, plus raised inner brows... or a clearly stronger frown on its own
  sadBrows: 0.12,
  sadStrongFrown: 0.3,
  sadMaxSmile: 0.08,
  // Added from FER's emotion set (angry, disgust, fear) + confused, using MediaPipe's own muscles.
  // Starting points: tune them on /ui/face, where each bar shows its trigger mark.
  disgustSneer: 0.25,
  // nose wrinkle... or raised upper lip with a squint
  disgustUpperLip: 0.25,
  disgustSquint: 0.12,
  disgustMaxSmile: 0.3,
  fearBrows: 0.22,
  // inner brows up + eyes wide + mouth stretched sideways
  fearWide: 0.12,
  fearStretch: 0.15,
  fearMaxSmile: 0.15,
  angryBrowDown: 0.3,
  // brows down, plus pressed lips, a squint or a sneer
  angryPress: 0.15,
  angrySquint: 0.2,
  angrySneer: 0.15,
  angryMaxSmile: 0.15,
  confusedAsym: 0.25,
  // one brow clearly higher than the other
  confusedMaxSmile: 0.25,
  confusedMaxJaw: 0.3
};
const mean = (b, keys) => keys.reduce((s, k) => s + (b[k] ?? 0), 0) / keys.length;
function features(b) {
  const out = {};
  for (const f of Object.keys(FEATURES)) out[f] = FEATURES[f].length ? mean(b, FEATURES[f]) : 0;
  out.browAsym = Math.max(
    Math.abs((b.browOuterUpLeft ?? 0) - (b.browOuterUpRight ?? 0)),
    Math.abs((b.browDownLeft ?? 0) - (b.browDownRight ?? 0))
  );
  return out;
}
const ZERO = Object.fromEntries(Object.keys(FEATURES).map((k) => [k, 0]));
function deltas(b, base = ZERO) {
  const f = features(b);
  const out = {};
  for (const k of Object.keys(f)) out[k] = Math.max(0, f[k] - base[k]);
  return out;
}
function classify(b, base = ZERO) {
  const d = deltas(b, base);
  const T = THRESHOLDS;
  const brows = Math.max(d.browInner, d.browOuter);
  if (d.smile > T.laughSmile && (d.jaw > T.laughJaw || d.squint > T.laughSquint))
    return { expression: "laughing", strength: Math.min(1, (d.smile + d.jaw) / 1.2) };
  if (d.browInner > T.fearBrows && d.wide > T.fearWide && d.stretch > T.fearStretch && d.smile < T.fearMaxSmile)
    return { expression: "scared", strength: Math.min(1, d.browInner + d.stretch + d.wide) };
  if (d.jaw > T.surpriseJaw && (brows > T.surpriseBrows || d.wide > T.surpriseWide) && d.smile < T.surpriseMaxSmile)
    return { expression: "surprised", strength: Math.min(1, (d.jaw + brows) / 1.1) };
  if (d.smile > T.happySmile) return { expression: "happy", strength: Math.min(1, d.smile * 1.2) };
  if (d.smile < T.disgustMaxSmile && (d.sneer > T.disgustSneer || d.upperLip > T.disgustUpperLip && d.squint > T.disgustSquint))
    return { expression: "disgusted", strength: Math.min(1, (d.sneer + d.upperLip) * 1.2) };
  if (d.smile < T.angryMaxSmile && d.browDown > T.angryBrowDown && (d.press > T.angryPress || d.squint > T.angrySquint || d.sneer > T.angrySneer))
    return { expression: "angry", strength: Math.min(1, d.browDown + Math.max(d.press, d.squint, d.sneer)) };
  if (d.smile < T.sadMaxSmile && (d.frown > T.sadFrown && d.browInner > T.sadBrows || d.frown > T.sadStrongFrown))
    return { expression: "sad", strength: Math.min(1, d.frown * 2 + d.browInner) };
  if (d.browAsym > T.confusedAsym && d.smile < T.confusedMaxSmile && d.jaw < T.confusedMaxJaw)
    return { expression: "confused", strength: Math.min(1, d.browAsym * 2) };
  return { expression: "neutral", strength: 0 };
}
class FaceBaseline {
  constructor(warmupFrames = 20, rate = 0.01) {
    this.warmupFrames = warmupFrames;
    this.rate = rate;
  }
  samples = [];
  value = { ...ZERO };
  ready = false;
  observe(b, rawExpression) {
    const f = features(b);
    if (!this.ready) {
      this.samples.push(f);
      if (this.samples.length >= this.warmupFrames) {
        for (const k of Object.keys(f)) {
          const s = this.samples.map((x) => x[k]).sort((a, z) => a - z);
          this.value[k] = Math.min(0.5, s[Math.floor(s.length / 2)]);
        }
        this.ready = true;
        this.samples = [];
      }
      return;
    }
    if (rawExpression !== "neutral") return;
    for (const k of Object.keys(f)) this.value[k] = Math.min(0.5, this.value[k] + this.rate * (f[k] - this.value[k]));
  }
  reset() {
    this.samples = [];
    this.value = { ...ZERO };
    this.ready = false;
  }
}
class FaceSignalTracker {
  constructor(holdMs = 250, awayMs = 1200, yawLimitDeg = 28) {
    this.holdMs = holdMs;
    this.awayMs = awayMs;
    this.yawLimitDeg = yawLimitDeg;
  }
  candidate = { expression: "neutral", since: 0, strength: 0 };
  missingSince = null;
  turnedSince = null;
  everSeen = false;
  // never claim 'present' before a face has actually been seen
  baseline = new FaceBaseline();
  current = { present: false, lookingAway: false, expression: "neutral", strength: 0, at: 0 };
  /** The last frame's unsmoothed result (for debugging / the test page). */
  lastRaw = null;
  /** Feed one frame; returns the new signal only when something changed (else null). */
  update(f, now) {
    const prev = this.current;
    let present = true;
    let lookingAway = false;
    let expression = prev.expression;
    let strength = prev.strength;
    if (!f.blendshapes) {
      this.lastRaw = null;
      this.missingSince ??= now;
      present = this.everSeen && now - this.missingSince < this.awayMs;
      lookingAway = !present;
      if (!present) {
        expression = "neutral";
        strength = 0;
      }
    } else {
      this.missingSince = null;
      this.everSeen = true;
      const turned = Math.abs(f.yawDeg ?? 0) > this.yawLimitDeg || (f.pitchDeg ?? 0) > this.yawLimitDeg;
      this.turnedSince = turned ? this.turnedSince ?? now : null;
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
function headAngles(m) {
  if (!m || m.length < 16) return { yawDeg: 0, pitchDeg: 0 };
  const yaw = Math.atan2(m[8], m[10]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[9])));
  return { yawDeg: yaw * 180 / Math.PI, pitchDeg: pitch * 180 / Math.PI };
}
export {
  FEATURES,
  FaceBaseline,
  FaceSignalTracker,
  THRESHOLDS,
  classify,
  deltas,
  features,
  headAngles
};
