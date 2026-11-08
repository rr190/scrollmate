/**
 * Eye-tracking calibration page (EyeTrax method + the bottom-of-screen boost from /ui/face).
 *
 * Runs fullscreen on the screen the viewer watches Shorts on. Webcam frames stay in this page; only the
 * fitted personal model (numbers) is saved to chrome.storage.local, and the background passes it to the
 * hidden camera page.
 */
import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import {
  BlinkDetector, bottomHeavyTargets, denseTargets, eyeAspectRatio, gazeFeatureVectorPlus, isRealBlink, KalmanGaze, RidgeGaze,
  GAZE_MODEL_KEY, type GazeModelData, type Pt,
} from '../shared/faceSignals';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = $('msg'), stage = $('stage'), dot = $('dot'), smsg = $('smsg'), gz = $('gz');

let landmarker: FaceLandmarker | null = null;
let video: HTMLVideoElement | null = null;
let stream: MediaStream | null = null;
const blink = new BlinkDetector();
/** Latest frame: features (null = no face) and whether it's a blink. */
let frame: { fv: number[] | null; blink: boolean } = { fv: null, blink: false };
let onFrame: ((f: typeof frame) => void) | null = null;

async function setup() {
  if (landmarker) return;
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 30 }, audio: false });
  video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  const files = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('mediapipe/wasm'));
  const make = (delegate: 'GPU' | 'CPU') =>
    FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: chrome.runtime.getURL('mediapipe/face_landmarker.task'), delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
  landmarker = await make('GPU').catch(() => make('CPU'));
  setInterval(step, 33); // ~30 fps, like EyeTrax
}

function step() {
  if (!landmarker || !video || video.readyState < 2) return;
  let res: FaceLandmarkerResult;
  try {
    res = landmarker.detectForVideo(video, performance.now());
  } catch {
    return;
  }
  const cats = res.faceBlendshapes?.[0]?.categories;
  const b = cats?.length ? Object.fromEntries(cats.map((c) => [c.categoryName, c.score])) : null;
  const lm = res.faceLandmarks?.[0];
  const fv = gazeFeatureVectorPlus(lm, b, 1);
  const ear = eyeAspectRatio(lm, 1);
  const earBlink = ear !== null && blink.update(ear);
  frame = { fv, blink: isRealBlink(earBlink, b) };
  onFrame?.(frame);
}

function place(p: Pt) {
  dot.style.left = `${p.x}px`;
  dot.style.top = `${p.y}px`;
}

async function calibrate(): Promise<void> {
  const dense = $<HTMLSelectElement>('mode').value === '25';
  const targets = dense ? denseTargets(5, 0.1) : bottomHeavyTargets(0.1);
  const pulseMs = dense ? 900 : 1000, captureMs = dense ? 900 : 1000;
  let cancelled = false;
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelled = true; };
  window.addEventListener('keydown', onKey);
  stage.style.display = 'block';
  dot.style.display = 'block';
  gz.style.display = 'none';
  try { await document.documentElement.requestFullscreen(); } catch { /* still works in a maximised window */ }
  await wait(400);
  const W = window.innerWidth, H = window.innerHeight;
  const X: number[][] = [], Y: Pt[] = [], dotOf: number[] = [];
  try {
    // steady face for 2 s
    place({ x: W / 2, y: H / 2 });
    dot.className = 'dot';
    let steadySince = 0;
    while (!cancelled) {
      const ok = !!frame.fv && !frame.blink;
      smsg.textContent = ok ? 'Hold still…' : 'Face the camera so it can see your eyes (Esc to cancel)';
      if (ok) { steadySince ||= performance.now(); if (performance.now() - steadySince > 2000) break; } else steadySince = 0;
      await wait(50);
    }
    smsg.textContent = 'Follow the dot with your eyes, keep your head still';
    for (let i = 0; i < targets.length && !cancelled; i++) {
      const p = { x: targets[i].x * W, y: targets[i].y * H };
      place(p);
      dot.className = 'dot pulse';
      await wait(pulseMs);
      dot.className = 'dot collect';
      onFrame = (f) => { if (f.fv && !f.blink) { X.push(f.fv); Y.push(p); dotOf.push(i); } };
      await wait(captureMs);
      onFrame = null;
    }
  } finally {
    onFrame = null;
    window.removeEventListener('keydown', onKey);
  }
  if (cancelled) return finish('Calibration cancelled.', 'meh');
  if (X.length < targets.length * 8) return finish('Too few clear frames (face lost or eyes closed). Try again with more light.', 'meh');

  smsg.textContent = 'Checking accuracy…';
  dot.style.display = 'none';
  await wait(30);
  // honest error: leave each dot out, predict it from the others
  const diag = Math.hypot(W, H);
  let errSum = 0, errN = 0;
  for (let i = 0; i < targets.length; i++) {
    const tr = X.map((_, k) => k).filter((k) => dotOf[k] !== i), te = X.map((_, k) => k).filter((k) => dotOf[k] === i);
    if (!te.length) continue;
    const m = new RidgeGaze();
    if (!m.fit(tr.map((k) => X[k]), tr.map((k) => Y[k]), 1)) continue;
    const preds = te.map((k) => m.predict(X[k])!);
    const mean = { x: preds.reduce((s, q) => s + q.x, 0) / preds.length, y: preds.reduce((s, q) => s + q.y, 0) / preds.length };
    errSum += Math.hypot(mean.x - Y[te[0]].x, mean.y - Y[te[0]].y);
    errN++;
    await wait(0);
  }
  const model = new RidgeGaze();
  if (!model.fit(X, Y, 1)) return finish('Could not fit the model. Try again.', 'meh');
  // measurement noise = jitter of predictions around each dot's mean (what EyeTrax's tune() measures)
  let vx = 0, vy = 0;
  for (let i = 0; i < targets.length; i++) {
    const ps = X.filter((_, k) => dotOf[k] === i).map((x) => model.predict(x)!);
    if (ps.length < 2) continue;
    const mx = ps.reduce((s, q) => s + q.x, 0) / ps.length, my = ps.reduce((s, q) => s + q.y, 0) / ps.length;
    vx += ps.reduce((s, q) => s + (q.x - mx) ** 2, 0) / X.length;
    vy += ps.reduce((s, q) => s + (q.y - my) ** 2, 0) / X.length;
  }
  const error = errN ? errSum / errN / diag : 1;
  const data: GazeModelData = {
    version: 1,
    features: 'eyetrax+blendshapes',
    ridge: model.toJSON()!,
    screen: { w: W, h: H },
    noise: { x: Math.max(vx, 25), y: Math.max(vy, 25) },
    error,
    dots: targets.length,
    savedAt: Date.now(),
  };
  await chrome.storage.local.set({ [GAZE_MODEL_KEY]: data });
  await chrome.runtime.sendMessage({ type: 'GAZE_MODEL_SAVED' }).catch(() => undefined);
  testModel = { model, kalman: new KalmanGaze(50, 0.2, 0.25), W, H };
  testModel.kalman.setMeasurementNoise(data.noise.x, data.noise.y);
  const pct = (error * 100).toFixed(1);
  if (error < 0.1) finish(`Saved ✓ Accuracy: about ${pct}% of the screen. Good enough to tell the video from the comments.`, 'good');
  else finish(`Saved, but accuracy is only about ${pct}% of the screen (aim for under 10%). Try again with even light and a still head, or use 25 dots.`, 'meh');
}

let testModel: { model: RidgeGaze; kalman: KalmanGaze; W: number; H: number } | null = null;

function finish(text: string, cls: 'good' | 'meh') {
  stage.style.display = 'none';
  if (document.fullscreenElement) void document.exitFullscreen();
  msg.textContent = text;
  msg.className = cls;
  $('start').textContent = 'Calibrate again';
  $<HTMLButtonElement>('start').disabled = false;
  $('after').hidden = !testModel;
}

/** 10 s check: the half you look at lights up. */
async function testLeftRight() {
  if (!testModel) return;
  const t = testModel;
  stage.style.display = 'block';
  dot.style.display = 'none';
  gz.style.display = 'block';
  $('hl').style.display = $('hr').style.display = 'flex';
  try { await document.documentElement.requestFullscreen(); } catch { /* fine */ }
  smsg.textContent = 'Look at the left half, then the right half (10 s)';
  t.kalman.reset();
  let hits = 0, total = 0;
  onFrame = (f) => {
    if (!f.fv || f.blink) return;
    const raw = t.model.predict(f.fv);
    if (!raw) return;
    const g = t.kalman.step(raw);
    const x = (g.x / t.W) * window.innerWidth, y = (g.y / t.H) * window.innerHeight;
    gz.style.left = `${Math.max(0, Math.min(window.innerWidth, x))}px`;
    gz.style.top = `${Math.max(0, Math.min(window.innerHeight, y))}px`;
    $('hl').classList.toggle('on', x < window.innerWidth / 2);
    $('hr').classList.toggle('on', x >= window.innerWidth / 2);
    total++;
    if (x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight) hits++;
  };
  await wait(10_000);
  onFrame = null;
  $('hl').style.display = $('hr').style.display = 'none';
  $('hl').classList.remove('on');
  $('hr').classList.remove('on');
  gz.style.display = 'none';
  stage.style.display = 'none';
  if (document.fullscreenElement) void document.exitFullscreen();
  msg.textContent = `Test done: your gaze stayed on the screen ${total ? Math.round((hits / total) * 100) : 0}% of the time. If the right half lit up when you looked right, you're set.`;
}

$('start').onclick = async () => {
  const btn = $<HTMLButtonElement>('start');
  btn.disabled = true;
  msg.className = '';
  msg.textContent = 'Starting the camera…';
  try {
    await setup();
  } catch (e) {
    msg.textContent = `Camera unavailable (${(e as Error).name}). Allow the camera for ScrollMate and try again.`;
    btn.disabled = false;
    return;
  }
  msg.textContent = '';
  await calibrate();
};
$('test').onclick = () => void testLeftRight();
$('close').onclick = () => {
  stream?.getTracks().forEach((t) => t.stop());
  window.close();
};
window.addEventListener('beforeunload', () => stream?.getTracks().forEach((t) => t.stop()));
