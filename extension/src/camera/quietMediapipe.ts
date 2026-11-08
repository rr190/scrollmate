/**
 * MediaPipe's WebAssembly runtime prints its native start-up logs through console.error / console.warn
 * ("INFO: Created TensorFlow Lite XNNPACK delegate for CPU.", "W1108 07:20:27.89 … gl_context.cc:1135] …").
 * Chrome lists every console error or warning from an extension page under the extension's "Errors" button,
 * so each camera start looked like a failure. Route those informational lines to console.debug; real native
 * errors (E…/F… lines) and everything else keep their original level.
 * Must be imported before MediaPipe loads, because its runtime binds the console functions when it starts.
 */
const NATIVE_INFO = /^(INFO: |[IW]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+ [\w./-]+:\d+\] )/;

export function isMediapipeInfo(args: unknown[]): boolean {
  return typeof args[0] === 'string' && NATIVE_INFO.test(args[0]);
}

for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => (isMediapipeInfo(args) ? console.debug(...args) : original(...args));
}
