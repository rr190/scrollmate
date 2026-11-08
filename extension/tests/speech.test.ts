import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Speaker } from '../src/content/speech';

function audioFixture(t: any, delayed = false) {
  let started = 0, stopped = 0, gainValue = 0;
  let completeDecode!: (buffer: { duration: number }) => void;
  let ended: (() => void) | null = null;
  class Context {
    destination = {};
    resume = async () => {};
    decodeAudioData = async () => delayed ? new Promise((resolve) => { completeDecode = resolve; }) : { duration: 1 };
    createGain() { return { gain: { get value() { return gainValue; }, set value(value) { gainValue = value; } }, connect() {}, disconnect() {} }; }
    createBufferSource() { return { buffer: null, connect() {}, disconnect() {},
      set onended(value: (() => void) | null) { ended = value; }, start() { started++; }, stop() { stopped++; ended?.(); } }; }
  }
  for (const [name, value] of Object.entries({ AudioContext: Context, window: { setTimeout, clearTimeout } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete (globalThis as any)[name]; });
  }
  return { get started() { return started; }, get stopped() { return stopped; }, get volume() { return gainValue; },
    end: () => ended?.(), decoded: () => completeDecode({ duration: 1 }) };
}

test('generated AI audio plays with volume control and ends once', async (t) => {
  const f = audioFixture(t);
  const speaker = new Speaker(); let starts = 0, ends = 0;
  speaker.unlock(); speaker.setVolume(.4);
  speaker.speak('Hello', () => starts++, () => ends++, 'YXVkaW8=');
  await new Promise(setImmediate);
  assert.equal(f.started, 1); assert.equal(starts, 1); assert.equal(f.volume, .4);
  speaker.setVolume(.2); assert.equal(f.volume, .2);
  speaker.cancel(); f.end(); assert.equal(ends, 1); assert.equal(f.stopped, 1);
});

test('cancelling while AI audio decodes cannot play a late reply', async (t) => {
  const f = audioFixture(t, true);
  const speaker = new Speaker(); let ends = 0;
  speaker.speak('Hello', () => {}, () => ends++, 'YXVkaW8=');
  await new Promise(setImmediate);
  speaker.cancel(); f.decoded(); await new Promise(setImmediate);
  assert.equal(f.started, 0); assert.equal(ends, 1);
});
