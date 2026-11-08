// Copies MediaPipe's wasm runtime from node_modules and downloads the Face Landmarker model into
// public/mediapipe/ (bundled into the extension: MV3 extensions can't load code or models from the web).
// Run once after `npm install`:  npm run setup:mediapipe
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const out = join(root, 'public', 'mediapipe');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

mkdirSync(join(out, 'wasm'), { recursive: true });
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  copyFileSync(join(src, f), join(out, 'wasm', f));
}
console.log('copied MediaPipe wasm runtime');

const model = join(out, 'face_landmarker.task');
if (existsSync(model) && statSync(model).size > 1_000_000) {
  console.log('face_landmarker.task already present');
} else {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  writeFileSync(model, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded face_landmarker.task (${statSync(model).size} bytes)`);
}
