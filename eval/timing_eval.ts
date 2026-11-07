/**
 * Timing evaluation: replay scripted viewing sessions through two policies.
 *
 *   Naive      deliver every reaction the moment it is generated
 *   ScrollMate the timing engine from extension/src/shared/timing.ts (same code the extension runs)
 *
 * Run from extension/:   npm run eval
 *   options:  --seed 7  --shorts 20  --sessions 100  --dump session.json  --session session.json
 *
 * The reaction *generation* pipeline is simulated identically for both policies
 * (frames at 10%/50%/85% of the first pass, analysis latency 2.5-5 s, LLM sometimes
 * repeating itself), so only the delivery policy differs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { TimingEngine, normalizeText, type Candidate, type PlaybackSnapshot } from '../extension/src/shared/timing.ts';
import type { Frequency } from '../extension/src/shared/types.ts';

// ---------- seeded RNG ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- session model ----------
type Behaviour = 'full' | 'partial' | 'skip' | 'pause';
interface SessionShort {
  videoId: string;
  topic: string;
  duration: number; // s
  behaviour: Behaviour;
  start: number; // ms wall
  watchMs: number; // playback ms (excluding pause)
  pauseAt: number | null; // playback ms
  pauseMs: number;
}
interface GenEvent {
  at: number; // ms wall
  candidate: Candidate;
}
interface Session {
  shorts: SessionShort[];
  events: GenEvent[];
  endAt: number;
}

const TOPICS = ['baking', 'pets', 'fitness', 'gaming', 'diy'];
const LINES = ['That escalated quickly.', 'Plot twist nobody asked for.', 'The confidence was unmatched.', 'Speedrun of bad decisions.', 'Ten out of ten commitment.', 'Physics had other plans.'];

function wallAt(s: SessionShort, playbackMs: number): number {
  return s.start + playbackMs + (s.pauseAt !== null && playbackMs > s.pauseAt ? s.pauseMs : 0);
}

function generateSession(seed: number, n: number): Session {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const shorts: SessionShort[] = [];
  let t = 0;
  let topic = pick(TOPICS);
  for (let i = 0; i < n; i++) {
    if (rnd() > 0.45) topic = pick(TOPICS);
    const duration = Math.round(12 + rnd() * 33);
    const r = rnd();
    const behaviour: Behaviour = r < 0.45 ? 'full' : r < 0.65 ? 'partial' : r < 0.9 ? 'skip' : 'pause';
    const dMs = duration * 1000;
    const watchMs =
      behaviour === 'skip' ? 1000 + rnd() * 2000 : behaviour === 'partial' ? dMs * (0.4 + rnd() * 0.35) : dMs * (1.2 + rnd() * 1.0);
    const pauseAt = behaviour === 'pause' ? dMs * 0.5 : null;
    const pauseMs = behaviour === 'pause' ? 3000 + rnd() * 3000 : 0;
    shorts.push({ videoId: `s${String(i + 1).padStart(2, '0')}`, topic, duration, behaviour, start: t, watchMs, pauseAt, pauseMs });
    t += watchMs + pauseMs + 300; // swipe
  }

  // Reaction generation, identical for both policies.
  const events: GenEvent[] = [];
  const pastTexts: string[] = [];
  let seq = 0;
  let prevWatched: SessionShort | null = null;
  for (const s of shorts) {
    const dMs = s.duration * 1000;
    const frameAt = [Math.min(1500, dMs * 0.1), dMs * 0.5, dMs * 0.85];
    const framesTaken = frameAt.filter((f) => f <= s.watchMs).length;
    let analysisStart: number | null = null;
    if (framesTaken === 3) analysisStart = wallAt(s, frameAt[2]);
    else if (s.watchMs >= 4000 && framesTaken > 0) analysisStart = wallAt(s, s.watchMs); // analysed on leaving
    if (analysisStart === null) continue; // skipped quickly: nothing analysed
    const ready = analysisStart + 2500 + rnd() * 2500;
    const mk = (text: string, importance: number, isCallback: boolean, now: boolean): GenEvent => ({
      at: ready,
      candidate: {
        id: `c${++seq}`,
        text,
        importance,
        targetVideoId: s.videoId,
        preferredTiming: now ? 'now' : 'after_video',
        expiresAfterSeconds: isCallback ? 60 : now ? 12 : 25,
        requiresQuietMoment: !now || rnd() < 0.5,
        isCallback,
        createdAt: ready,
      },
    });
    if (rnd() < 0.75) {
      const dup = pastTexts.length > 0 && rnd() < 0.12;
      const text = dup ? pick(pastTexts) : `${pick(LINES)} (${s.topic} #${s.videoId})`;
      pastTexts.push(text);
      events.push(mk(text, 0.3 + rnd() * 0.7, false, rnd() < 0.15));
    }
    if (prevWatched && prevWatched.topic === s.topic) {
      const text = `Callback: ${s.topic} again, ${prevWatched.videoId} -> ${s.videoId}`;
      events.push(mk(text, 0.8 + rnd() * 0.2, true, false));
    }
    if (s.behaviour !== 'skip') prevWatched = s;
  }
  events.sort((a, b) => a.at - b.at);
  const last = shorts[shorts.length - 1];
  return { shorts, events, endAt: last.start + last.watchMs + last.pauseMs + 15_000 };
}

// ---------- playback state at wall time T ----------
function snapshotAt(sess: Session, T: number): PlaybackSnapshot & { idx: number } {
  let idx = -1;
  for (let i = 0; i < sess.shorts.length; i++) if (sess.shorts[i].start <= T) idx = i;
  const navTimes = sess.shorts.filter((s) => s.start <= T && T - s.start < 30_000).map((s) => s.start);
  const s = sess.shorts[idx];
  const endOfShort = s.start + s.watchMs + s.pauseMs;
  const lastShortOver = idx === sess.shorts.length - 1 && T > endOfShort; // user stopped watching: video paused
  const inPause = s.pauseAt !== null && T >= s.start + s.pauseAt && T < s.start + s.pauseAt + s.pauseMs;
  const playback = Math.min(T, endOfShort) - s.start - (s.pauseAt !== null && T >= s.start + s.pauseAt ? Math.min(s.pauseMs, T - s.start - s.pauseAt) : 0);
  const dMs = s.duration * 1000;
  const loops = Math.floor(playback / dMs);
  return {
    idx,
    enabled: true,
    videoId: s.videoId,
    playing: !inPause && !lastShortOver,
    paused: inPause || lastShortOver,
    ended: false,
    currentTime: (playback % dMs) / 1000,
    duration: s.duration,
    lastLoopAt: loops > 0 ? wallAt(s, loops * dMs) : null,
    muted: false,
    audioQuiet: null,
    navTimes,
  };
}

/** Objective definition, independent of the engine: playing and not at start/end/just after a loop. */
function isMidPlayback(snap: PlaybackSnapshot, T: number): boolean {
  if (!snap.playing) return false;
  if (snap.lastLoopAt !== null && T - snap.lastLoopAt < 2500) return false;
  return snap.currentTime >= 0.5 && snap.duration - snap.currentTime >= 1.2;
}

interface Metrics {
  generated: number;
  delivered: number;
  interruptions: number;
  stale: number;
  duplicates: number;
  callbacksDelivered: number;
}

function score(sess: Session, deliveries: { at: number; c: Candidate }[], generated: number): Metrics {
  const m: Metrics = { generated, delivered: 0, interruptions: 0, stale: 0, duplicates: 0, callbacksDelivered: 0 };
  const seen = new Set<string>();
  for (const d of deliveries) {
    const snap = snapshotAt(sess, d.at);
    m.delivered++;
    if (isMidPlayback(snap, d.at)) m.interruptions++;
    if (!d.c.isCallback && snap.videoId !== d.c.targetVideoId) m.stale++;
    const key = normalizeText(d.c.text);
    if (seen.has(key)) m.duplicates++;
    seen.add(key);
    if (d.c.isCallback) m.callbacksDelivered++;
  }
  return m;
}

function runNaive(sess: Session): Metrics {
  return score(sess, sess.events.map((e) => ({ at: e.at, c: e.candidate })), sess.events.length);
}

function runScrollMate(sess: Session, frequency: Frequency): Metrics {
  const engine = new TimingEngine({ frequency, voiceEnabled: false });
  const out: { at: number; c: Candidate }[] = [];
  let ei = 0;
  for (let T = 0; T <= sess.endAt; T += 300) {
    const snap = snapshotAt(sess, T);
    while (ei < sess.events.length && sess.events[ei].at <= T) {
      const d = engine.propose({ ...sess.events[ei].candidate }, snap, T);
      if (d) out.push({ at: T, c: d.candidate });
      ei++;
    }
    const d = engine.tick(snap, T);
    if (d) out.push({ at: T, c: d.candidate });
  }
  return score(sess, out, sess.events.length);
}

// ---------- CLI ----------
const args = process.argv.slice(2);
const arg = (k: string, dflt: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const seed = Number(arg('seed', '7'));
const nShorts = Number(arg('shorts', '20'));
const nSessions = Number(arg('sessions', '100'));
const frequency = arg('frequency', 'balanced') as Frequency;

const session: Session = args.includes('--session') ? JSON.parse(readFileSync(arg('session', ''), 'utf8')) : generateSession(seed, nShorts);
if (args.includes('--dump')) writeFileSync(arg('dump', 'session.json'), JSON.stringify(session, null, 2));

const row = (name: string, m: Metrics) =>
  `${name.padEnd(12)} ${String(m.delivered).padStart(9)} ${String(m.interruptions).padStart(13)} ${String(m.stale).padStart(6)} ${String(m.duplicates).padStart(10)} ${String(m.callbacksDelivered).padStart(10)}`;
const header = `${'policy'.padEnd(12)} ${'delivered'.padStart(9)} ${'interruptions'.padStart(13)} ${'stale'.padStart(6)} ${'duplicates'.padStart(10)} ${'callbacks'.padStart(10)}`;

const naive = runNaive(session);
const smart = runScrollMate(session, frequency);
const behaviours = session.shorts.reduce<Record<string, number>>((a, s) => ((a[s.behaviour] = (a[s.behaviour] ?? 0) + 1), a), {});

console.log(`\nScrollMate timing evaluation (frequency=${frequency})`);
console.log(`Session: ${session.shorts.length} Shorts, seed ${seed}, behaviours ${JSON.stringify(behaviours)}, ${naive.generated} reactions generated\n`);
console.log(header);
console.log(row('Naive', naive));
console.log(row('ScrollMate', smart));

// Aggregate over many sessions so one lucky seed can't carry the pitch.
const agg = { naive: { delivered: 0, interruptions: 0, stale: 0, duplicates: 0 }, smart: { delivered: 0, interruptions: 0, stale: 0, duplicates: 0 } };
for (let k = 0; k < nSessions; k++) {
  const s = generateSession(1000 + k, nShorts);
  const a = runNaive(s);
  const b = runScrollMate(s, frequency);
  for (const key of ['delivered', 'interruptions', 'stale', 'duplicates'] as const) {
    agg.naive[key] += a[key];
    agg.smart[key] += b[key];
  }
}
const avg = (x: number) => (x / nSessions).toFixed(1);
console.log(`\nAverage over ${nSessions} sessions of ${nShorts} Shorts:`);
console.log(`${'policy'.padEnd(12)} ${'delivered'.padStart(9)} ${'interruptions'.padStart(13)} ${'stale'.padStart(6)} ${'duplicates'.padStart(10)}`);
for (const [name, m] of [['Naive', agg.naive], ['ScrollMate', agg.smart]] as const)
  console.log(`${name.padEnd(12)} ${avg(m.delivered).padStart(9)} ${avg(m.interruptions).padStart(13)} ${avg(m.stale).padStart(6)} ${avg(m.duplicates).padStart(10)}`);

console.log(
  `\nHeadline: "Reacting to everything interrupted the video ${naive.interruptions} times in ${session.shorts.length} Shorts. ` +
    `ScrollMate interrupted it ${smart.interruptions} times, and testers rated X% of its reactions funny."`,
);
console.log('  (X comes from eval/rating_sheet.md once 5 testers have filled it in.)\n');
