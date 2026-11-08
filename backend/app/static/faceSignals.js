const FEATURES = {
  smile: ["mouthSmileLeft", "mouthSmileRight"],
  jaw: ["jawOpen"],
  browInner: ["browInnerUp"],
  browOuter: ["browOuterUpLeft", "browOuterUpRight"],
  wide: ["eyeWideLeft", "eyeWideRight"],
  squint: ["eyeSquintLeft", "eyeSquintRight"],
  frown: ["mouthFrownLeft", "mouthFrownRight"]
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
  sadMaxSmile: 0.08
};
const mean = (b, keys) => keys.reduce((s, k) => s + (b[k] ?? 0), 0) / keys.length;
function features(b) {
  const out = {};
  for (const f of Object.keys(FEATURES)) out[f] = mean(b, FEATURES[f]);
  return out;
}
const ZERO = { smile: 0, jaw: 0, browInner: 0, browOuter: 0, wide: 0, squint: 0, frown: 0 };
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
  if (d.jaw > T.surpriseJaw && (brows > T.surpriseBrows || d.wide > T.surpriseWide) && d.smile < T.surpriseMaxSmile)
    return { expression: "surprised", strength: Math.min(1, (d.jaw + brows) / 1.1) };
  if (d.smile > T.happySmile) return { expression: "happy", strength: Math.min(1, d.smile * 1.2) };
  if (d.smile < T.sadMaxSmile && (d.frown > T.sadFrown && d.browInner > T.sadBrows || d.frown > T.sadStrongFrown))
    return { expression: "sad", strength: Math.min(1, d.frown * 2 + d.browInner) };
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
const EYE = {
  right: { iris: 468, a: 33, b: 133, top: 159, bottom: 145 },
  // a = outer corner, b = inner corner
  left: { iris: 473, a: 362, b: 263, top: 386, bottom: 374 }
  // a = inner corner, b = outer corner
};
function irisPosition(lm) {
  if (!lm || lm.length < 478) return null;
  const one = (e) => {
    const a = lm[e.a], b = lm[e.b], i = lm[e.iris], t = lm[e.top], d = lm[e.bottom];
    const w = b.x - a.x, h = d.y - t.y;
    if (Math.abs(w) < 1e-6 || Math.abs(h) < 1e-6) return null;
    return { x: (i.x - a.x) / w, y: (i.y - t.y) / h };
  };
  const r = one(EYE.right), l = one(EYE.left);
  if (!r || !l) return r ?? l;
  return { x: (r.x + l.x) / 2, y: (r.y + l.y) / 2 };
}
function gazeFeatures(iris, yawDeg, pitchDeg) {
  return [iris.x - 0.5, iris.y - 0.5, yawDeg / 30, pitchDeg / 30, 1];
}
function uncalibratedGaze(iris, yawDeg, pitchDeg) {
  const clamp = (v) => Math.max(0, Math.min(1, v));
  return {
    // looking to your left moves the iris toward the image's right -> screen x decreases
    x: clamp(0.5 - (iris.x - 0.5) * 4 - yawDeg / 50),
    y: clamp(0.45 + (iris.y - 0.5) * 3 + pitchDeg / 40)
  };
}
class GazeCalibrator {
  xs = [];
  tx = [];
  ty = [];
  wx = null;
  wy = null;
  get calibrated() {
    return this.wx !== null;
  }
  add(features2, target) {
    this.xs.push(features2);
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
  fit(ridge = 1e-3) {
    if (this.xs.length < 6) return null;
    this.wx = solveLeastSquares(this.xs, this.tx, ridge);
    this.wy = solveLeastSquares(this.xs, this.ty, ridge);
    if (!this.wx || !this.wy) {
      this.wx = this.wy = null;
      return null;
    }
    let err = 0;
    this.xs.forEach((f, i) => {
      const p = this.predict(f);
      err += Math.hypot(p.x - this.tx[i], p.y - this.ty[i]);
    });
    return err / this.xs.length;
  }
  predict(features2) {
    if (!this.wx || !this.wy) return null;
    const dot = (w) => w.reduce((s, wi, i) => s + wi * features2[i], 0);
    const clamp = (v) => Math.max(-0.1, Math.min(1.1, v));
    return { x: clamp(dot(this.wx)), y: clamp(dot(this.wy)) };
  }
}
function solveLeastSquares(X, y, ridge = 0) {
  const n = X[0]?.length ?? 0;
  if (!n) return null;
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  X.forEach((row, r) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += row[i] * row[j];
      A[i][n] += row[i] * y[r];
    }
  });
  for (let i = 0; i < n - 1; i++) A[i][i] += ridge;
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
class GazeSmoother {
  constructor(alpha = 0.35) {
    this.alpha = alpha;
  }
  p = null;
  push(q) {
    this.p = this.p ? { x: this.p.x + this.alpha * (q.x - this.p.x), y: this.p.y + this.alpha * (q.y - this.p.y) } : q;
    return this.p;
  }
  reset() {
    this.p = null;
  }
}
const EYETRAX_LEFT_EYE = [
  107,
  66,
  105,
  63,
  70,
  55,
  65,
  52,
  53,
  46,
  468,
  469,
  470,
  471,
  472,
  133,
  33,
  173,
  157,
  158,
  159,
  160,
  161,
  246,
  155,
  154,
  153,
  145,
  144,
  163,
  7,
  243,
  190,
  56,
  28,
  27,
  29,
  30,
  247,
  130,
  25,
  110,
  24,
  23,
  22,
  26,
  112,
  244,
  189,
  221,
  222,
  223,
  224,
  225,
  113,
  226,
  31,
  228,
  229,
  230,
  231,
  232,
  233,
  193,
  245,
  128,
  121,
  120,
  119,
  118,
  117,
  111,
  35,
  124,
  143,
  156
];
const EYETRAX_RIGHT_EYE = [
  336,
  296,
  334,
  293,
  300,
  285,
  295,
  282,
  283,
  276,
  473,
  476,
  475,
  474,
  477,
  362,
  263,
  398,
  384,
  385,
  386,
  387,
  388,
  466,
  382,
  381,
  380,
  374,
  373,
  390,
  249,
  463,
  414,
  286,
  258,
  257,
  259,
  260,
  467,
  359,
  255,
  339,
  254,
  253,
  252,
  256,
  341,
  464,
  413,
  441,
  442,
  443,
  444,
  445,
  342,
  446,
  261,
  448,
  449,
  450,
  451,
  452,
  453,
  417,
  465,
  357,
  350,
  349,
  348,
  347,
  346,
  340,
  265,
  353,
  372,
  383
];
const EYETRAX_MUTUAL = [4, 10, 151, 9, 152, 234, 454, 58, 288];
const GAZE_LANDMARKS = [...EYETRAX_LEFT_EYE, ...EYETRAX_RIGHT_EYE, ...EYETRAX_MUTUAL];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a) => Math.hypot(a[0], a[1], a[2]);
const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function gazeFeatureVector(lm, aspect = 1) {
  if (!lm || lm.length < 478) return null;
  const P = (i) => [lm[i].x * aspect, lm[i].y, (lm[i].z ?? 0) * aspect];
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
  const out = [];
  for (const i of GAZE_LANDMARKS) {
    const p = sub3(P(i), center);
    out.push(dot3(p, xAxis) / eyeDist, dot3(p, yAxis) / eyeDist, dot3(p, zAxis) / eyeDist);
  }
  const yaw = Math.atan2(xAxis[1], xAxis[0]);
  const pitch = Math.atan2(-xAxis[2], Math.hypot(yAxis[2], zAxis[2]));
  const roll = Math.atan2(yAxis[2], zAxis[2]);
  out.push(yaw, pitch, roll);
  return out;
}
function eyeAspectRatio(lm, aspect = 1) {
  if (!lm || lm.length < 478) return null;
  const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);
  const left = d(159, 145) / (d(33, 133) + 1e-9);
  const right = d(386, 374) / (d(362, 263) + 1e-9);
  return (left + right) / 2;
}
class BlinkDetector {
  constructor(ratio = 0.8, historyLen = 50, minHistory = 15, fallback = 0.2) {
    this.ratio = ratio;
    this.historyLen = historyLen;
    this.minHistory = minHistory;
    this.fallback = fallback;
  }
  history = [];
  update(ear) {
    this.history.push(ear);
    if (this.history.length > this.historyLen) this.history.shift();
    const thr = this.history.length >= this.minHistory ? this.history.reduce((s, v) => s + v, 0) / this.history.length * this.ratio : this.fallback;
    return ear < thr;
  }
}
class RidgeGaze {
  mean = [];
  std = [];
  w = null;
  // [feature][output]
  b = [0, 0];
  get trained() {
    return this.w !== null;
  }
  fit(X, Y, alpha = 1) {
    const n = X.length, d = X[0]?.length ?? 0;
    if (n < 10 || !d) return false;
    this.mean = new Array(d).fill(0);
    this.std = new Array(d).fill(0);
    for (const row of X) row.forEach((v, j) => this.mean[j] += v / n);
    for (const row of X) row.forEach((v, j) => this.std[j] += (v - this.mean[j]) ** 2 / n);
    this.std = this.std.map((v) => v > 1e-12 ? Math.sqrt(v) : 1);
    const Z = X.map((row) => row.map((v, j) => (v - this.mean[j]) / this.std[j]));
    this.b = [Y.reduce((s, p) => s + p.x, 0) / n, Y.reduce((s, p) => s + p.y, 0) / n];
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
      for (let j = 0; j < i; j++) A[i][j] = A[j][i];
      A[i][i] += alpha;
    }
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
  predict(x) {
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
  toJSON() {
    return this.w ? { mean: this.mean, std: this.std, w: this.w, b: this.b } : null;
  }
  static fromJSON(d) {
    const m = new RidgeGaze();
    if (d && Array.isArray(d.w) && d.w.length === d.mean.length && d.mean.length === d.std.length) {
      m.mean = d.mean;
      m.std = d.std;
      m.w = d.w;
      m.b = d.b;
    }
    return m;
  }
}
class KalmanGaze {
  constructor(q = 50, r = 0.2, emaAlpha = 0.25) {
    this.q = q;
    this.emaAlpha = emaAlpha;
    this.R = [r, r];
  }
  s = null;
  // [px, py, vx, vy]
  P = [];
  R;
  ema = null;
  setMeasurementNoise(rx, ry) {
    this.R = [Math.max(1e-4, rx), Math.max(1e-4, ry)];
  }
  reset() {
    this.s = null;
    this.ema = null;
  }
  step(m) {
    if (!this.s) {
      this.s = [m.x, m.y, 0, 0];
      this.P = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => i === j ? 1e3 : 0));
      this.ema = { ...m };
      return { ...m };
    }
    const [px, py, vx, vy] = this.s;
    this.s = [px + vx, py + vy, vx, vy];
    const P = this.P;
    const FP = [
      [P[0][0] + P[2][0], P[0][1] + P[2][1], P[0][2] + P[2][2], P[0][3] + P[2][3]],
      [P[1][0] + P[3][0], P[1][1] + P[3][1], P[1][2] + P[3][2], P[1][3] + P[3][3]],
      [...P[2]],
      [...P[3]]
    ];
    this.P = FP.map((row) => [row[0] + row[2], row[1] + row[3], row[2], row[3]]);
    for (let i = 0; i < 4; i++) this.P[i][i] += this.q;
    const pred = { x: this.s[0], y: this.s[1] };
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
function ninePointTargets(margin = 0.1) {
  const v = [margin, 0.5, 1 - margin];
  const order = [[1, 1], [0, 0], [2, 0], [0, 2], [2, 2], [1, 0], [0, 1], [2, 1], [1, 2]];
  return order.map(([row, col]) => ({ x: v[col], y: v[row] }));
}
function denseTargets(n = 5, margin = 0.1) {
  const out = [];
  for (let r = 0; r < n; r++) {
    const cols = Array.from({ length: n }, (_, c) => c);
    if (r % 2) cols.reverse();
    for (const c of cols) out.push({ x: margin + (1 - 2 * margin) * c / (n - 1), y: margin + (1 - 2 * margin) * r / (n - 1) });
  }
  return out;
}
function fineTuneTargets(w, h) {
  return [
    { x: Math.floor(w / 2), y: Math.floor(h / 4) },
    { x: Math.floor(w / 4), y: Math.floor(3 * h / 4) },
    { x: Math.floor(3 * w / 4), y: Math.floor(3 * h / 4) }
  ];
}
const FINE_TUNE = { proximityOfWidth: 1 / 5, initialDelayMs: 500, collectMs: 500 };
function varianceOf(points) {
  if (points.length < 2) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length, my = points.reduce((s, p) => s + p.y, 0) / points.length;
  const vx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0) / points.length;
  const vy = points.reduce((s, p) => s + (p.y - my) ** 2, 0) / points.length;
  return { x: vx || 1e-4, y: vy || 1e-4 };
}
const EYE_DIRECTION_BLENDSHAPES = [
  "eyeLookDownLeft",
  "eyeLookDownRight",
  "eyeLookUpLeft",
  "eyeLookUpRight",
  "eyeLookInLeft",
  "eyeLookInRight",
  "eyeLookOutLeft",
  "eyeLookOutRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeSquintLeft",
  "eyeSquintRight"
];
function gazeFeatureVectorPlus(lm, blendshapes, aspect = 1) {
  const base = gazeFeatureVector(lm, aspect);
  if (!base) return null;
  return [...base, ...EYE_DIRECTION_BLENDSHAPES.map((k) => blendshapes?.[k] ?? 0)];
}
function isRealBlink(earSaysBlink, blendshapes, minBlinkScore = 0.5) {
  if (!earSaysBlink) return false;
  if (!blendshapes) return true;
  const blinkScore = ((blendshapes.eyeBlinkLeft ?? 0) + (blendshapes.eyeBlinkRight ?? 0)) / 2;
  return blinkScore >= minBlinkScore;
}
function bottomHeavyTargets(margin = 0.1) {
  return [...ninePointTargets(margin), { x: 0.3, y: 1 - margin }, { x: 0.7, y: 1 - margin }, { x: 0.5, y: 0.72 }];
}
const GAZE_MODEL_KEY = "scrollmate.gazeModel";
const inside = (p, r, pad) => !!r && p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y - pad && p.y <= r.y + r.height + pad;
function gazeZone(p, rects, viewport, current = null, stickyPx = 60) {
  const extra = (z) => z === current ? stickyPx : 0;
  const offPad = 0.08 * Math.max(viewport.w, viewport.h) + extra("off_screen") * -1;
  if (p.x < -offPad || p.y < -offPad || p.x > viewport.w + offPad || p.y > viewport.h + offPad) return "off_screen";
  if (inside(p, rects.mochi, 50 + extra("mochi"))) return "mochi";
  if (inside(p, rects.comments, extra("comments"))) return "comments";
  if (inside(p, rects.video, extra("video"))) return "video";
  return "elsewhere";
}
class ZoneDwell {
  constructor(dwellMs = 300) {
    this.dwellMs = dwellMs;
  }
  zone = null;
  since = 0;
  candidate = null;
  candidateAt = 0;
  /** Returns the new zone when it changes, else null. */
  update(raw, now) {
    if (raw === this.zone) {
      this.candidate = null;
      return null;
    }
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.candidateAt = now;
    }
    if (now - this.candidateAt < this.dwellMs) return null;
    this.zone = raw;
    this.since = now;
    this.candidate = null;
    return raw;
  }
  reset() {
    this.zone = null;
    this.candidate = null;
  }
}
function screenToViewport(g, win, scr) {
  const border = Math.max(0, (win.outerWidth - win.innerWidth) / 2);
  const top = Math.max(0, win.outerHeight - win.innerHeight - border);
  return {
    x: g.x * scr.width + (scr.left ?? 0) - win.screenX - border,
    y: g.y * scr.height + (scr.top ?? 0) - win.screenY - top
  };
}
export {
  BlinkDetector,
  EYETRAX_LEFT_EYE,
  EYETRAX_MUTUAL,
  EYETRAX_RIGHT_EYE,
  EYE_DIRECTION_BLENDSHAPES,
  FEATURES,
  FINE_TUNE,
  FaceBaseline,
  FaceSignalTracker,
  GAZE_LANDMARKS,
  GAZE_MODEL_KEY,
  GazeCalibrator,
  GazeSmoother,
  KalmanGaze,
  RidgeGaze,
  THRESHOLDS,
  ZoneDwell,
  bottomHeavyTargets,
  classify,
  deltas,
  denseTargets,
  eyeAspectRatio,
  features,
  fineTuneTargets,
  gazeFeatureVector,
  gazeFeatureVectorPlus,
  gazeFeatures,
  gazeZone,
  headAngles,
  irisPosition,
  isRealBlink,
  ninePointTargets,
  screenToViewport,
  solveLeastSquares,
  uncalibratedGaze,
  varianceOf
};
