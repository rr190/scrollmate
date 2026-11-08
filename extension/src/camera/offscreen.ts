/**
 * Offscreen camera page: webcam -> MediaPipe Face Landmarker -> tiny signals.
 *
 * Runs in a hidden extension page (chrome.offscreen, reason USER_MEDIA), so the camera prompt and
 * indicator belong to the extension, not to youtube.com. Frames never leave this page: only labels
 * like {expression: 'laughing', lookingAway: false} are sent to the background worker.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import {
  BlinkDetector, eyeAspectRatio, FaceSignalTracker, gazeFeatureVector, gazeFeatureVectorPlus, headAngles, isRealBlink,
  KalmanGaze, RidgeGaze, type GazeModelData,
} from '../shared/faceSignals';
import type { GazeConfig, TalkContext } from '../shared/messages';
import { RealtimeVoiceClient } from '../audio/realtimeVoice';

const FRAME_MS = 100; // ~10 fps is plenty for expressions
const GAZE_FRAME_MS = 40; // ~25 fps while eye tracking (more samples = steadier gaze)
const GAZE_SEND_MS = 100; // gaze points to the tab at ~10 per second
let landmarker: FaceLandmarker | null = null;
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let timer: number | undefined;
const tracker = new FaceSignalTracker();
let frames = 0;
let lastBeat = 0;
let starting = false;

// eye tracking (opt-in): the personal model from the calibration page, run on every frame
let gaze: { model: RidgeGaze; data: GazeModelData; kalman: KalmanGaze; blink: BlinkDetector } | null = null;
let gazeOn = false;
let lastGazeSent = 0;

function applyGazeConfig(c: GazeConfig | undefined) {
  gazeOn = !!c?.enabled;
  const data = c?.model ?? null;
  if (data && data.version === 1 && data !== gaze?.data) {
    const kalman = new KalmanGaze(50, 0.2, 0.25);
    // EyeTrax's filter on screen pixels; measurement noise from this person's calibration residuals
    kalman.setMeasurementNoise(data.noise.x, data.noise.y);
    gaze = { model: RidgeGaze.fromJSON(data.ridge), data, kalman, blink: new BlinkDetector() };
  } else if (!data) gaze = null;
  restartLoop();
}

function restartLoop() {
  if (!landmarker) return;
  self.clearInterval(timer);
  timer = self.setInterval(step, gazeOn && gaze ? GAZE_FRAME_MS : FRAME_MS);
}

const send = (msg: Record<string, unknown>) => chrome.runtime.sendMessage(msg).catch(() => undefined);
const status = (state: string, detail = '') => send({ type: 'CAMERA_STATUS', state, detail });

async function createLandmarker(delegate: 'GPU' | 'CPU') {
  const files = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('mediapipe/wasm'));
  return FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: chrome.runtime.getURL('mediapipe/face_landmarker.task'), delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

async function start() {
  if (starting || stream) return;
  starting = true;
  try { await startCamera(); } finally { starting = false; }
}

async function startCamera() {
  status('starting');
  try {
    // 640x480 like the calibration page: the iris needs the pixels for eye tracking
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 30 }, audio: false });
  } catch (e) {
    const name = (e as Error).name;
    status(name === 'NotAllowedError' || name === 'SecurityError' ? 'needs_permission' : 'error', `${name}: ${(e as Error).message}`);
    return;
  }
  video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  try {
    landmarker = await createLandmarker('GPU').catch(() => createLandmarker('CPU'));
  } catch (e) {
    status('error', `model load failed: ${(e as Error).message}`);
    stop();
    return;
  }
  status('on');
  applyGazeConfig(await chrome.runtime.sendMessage({ type: 'GAZE_GET_CONFIG' }).catch(() => undefined));
  if (!timer) timer = self.setInterval(step, FRAME_MS);
}

function step() {
  if (!landmarker || !video || video.readyState < 2) return;
  const now = Date.now();
  let blendshapes: Record<string, number> | null = null;
  let angles = { yawDeg: 0, pitchDeg: 0 };
  try {
    const res = landmarker.detectForVideo(video, performance.now());
    const cats = res.faceBlendshapes?.[0]?.categories;
    if (cats?.length) {
      blendshapes = {};
      for (const c of cats) blendshapes[c.categoryName] = c.score;
      angles = headAngles(res.facialTransformationMatrixes?.[0]?.data);
    }
    if (gazeOn && gaze) stepGaze(res.faceLandmarks?.[0], blendshapes, now);
  } catch {
    return; // a bad frame: skip it
  }
  frames++;
  const sig = tracker.update({ blendshapes, ...angles }, now);
  if (sig) send({ type: 'USER_SIGNAL', signal: sig });
  if (now - lastBeat > 3000) {
    // heartbeat: lets the UI show the camera is alive (and its frame rate)
    send({ type: 'CAMERA_STATUS', state: 'on', detail: `${Math.round((frames * 1000) / (now - lastBeat || 1))} fps` });
    frames = 0;
    lastBeat = now;
  }
}

function stepGaze(lm: Parameters<typeof gazeFeatureVector>[0], blendshapes: Record<string, number> | null, now: number) {
  if (!gaze) return;
  const plus = gaze.data.features === 'eyetrax+blendshapes';
  const fv = plus ? gazeFeatureVectorPlus(lm, blendshapes, 1) : gazeFeatureVector(lm, 1);
  if (!fv) return; // no face: the expression tracker already reports "not in view"
  const ear = eyeAspectRatio(lm, 1);
  const earBlink = ear !== null && gaze.blink.update(ear);
  if (plus ? isRealBlink(earBlink, blendshapes) : earBlink) return; // hold through blinks
  const raw = gaze.model.predict(fv);
  if (!raw) return;
  const g = gaze.kalman.step(raw);
  if (now - lastGazeSent < GAZE_SEND_MS) return;
  lastGazeSent = now;
  // only two numbers leave this page: where on the screen (0..1), never a frame
  const { w, h } = gaze.data.screen;
  send({ type: 'GAZE', x: Math.round((g.x / w) * 1000) / 1000, y: Math.round((g.y / h) * 1000) / 1000, at: now });
}

function stop() {
  self.clearInterval(timer);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  landmarker?.close();
  landmarker = null;
}

const microphone = new RealtimeVoiceClient((requestId, event) => { void send({ type: 'TALK_LIVE_EVENT', requestId, event }); });

// Camera and microphone share one offscreen document but have independent tracks and lifecycles.
chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string; requestId?: string; url?: string; context?: TalkContext }, _sender, reply) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'MEDIA_PING') { reply({ ready: true }); return false; }
  if (msg.type === 'TALK_START' && msg.url && msg.context) void microphone.start(msg.url, msg.context);
  if (msg.type === 'TALK_CONTEXT' && msg.context) microphone.update(msg.context);
  if (msg.type === 'TALK_CANCEL') microphone.cancel(msg.requestId);
  if (msg.type === 'CAMERA_START') void start();
  if (msg.type === 'GAZE_CONFIG') applyGazeConfig((msg as { config?: GazeConfig }).config);
  if (msg.type === 'CAMERA_STOP') {
    stop();
    status('off');
  }
  reply({ ok: true });
  return false;
});

void chrome.runtime.sendMessage({ type: 'MEDIA_READY' }).then((state) => {
  if (state?.camera !== false) void start();
}).catch(() => undefined);
