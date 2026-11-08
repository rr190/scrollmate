import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

function processor(name: string, rate: number) {
  const registered = new Map<string, any>();
  class Base { port = { messages: [] as any[], onmessage: null as any, postMessage(value: unknown) { this.messages.push(value); } }; }
  runInNewContext(readFileSync('public/audio/voice-worklets.js', 'utf8'), {
    AudioWorkletProcessor: Base, sampleRate: rate, ArrayBuffer, DataView, Float32Array,
    registerProcessor: (id: string, cls: any) => registered.set(id, cls),
  });
  return new (registered.get(name))();
}

test('capture emits little-endian PCM in 40 ms frames and never monitors microphone audio', () => {
  const capture = processor('scrollmate-capture', 16000);
  const input = new Float32Array(128); input[0] = -2; input[1] = 2; input[2] = .5;
  const output = new Float32Array(128).fill(1);
  for (let i = 0; i < 5; i++) capture.process([[input]], [[output]]);
  assert.equal(capture.port.messages.length, 1);
  const frame = new DataView(capture.port.messages[0]);
  assert.equal(frame.byteLength, 1280); assert.equal(frame.getInt16(0, true), -32768);
  assert.equal(frame.getInt16(2, true), 32767); assert.equal(frame.getInt16(4, true), 16384);
  assert(output.every((value) => value === 0));
});

test('playback starts before a whole reply arrives and clear flushes queued audio immediately', () => {
  const playback = processor('scrollmate-playback', 24000);
  const pcm = new ArrayBuffer(600); const view = new DataView(pcm);
  for (let i = 0; i < 300; i++) view.setInt16(i * 2, 16384, true);
  playback.port.onmessage({ data: pcm }); const output = new Float32Array(128);
  playback.process([], [[output]]);
  assert(output.every((value) => value === .5));
  assert.equal(playback.port.messages[0].type, 'started');
  playback.port.onmessage({ data: { type: 'clear' } }); playback.process([], [[output]]);
  assert(output.every((value) => value === 0)); assert.equal(playback.remaining, 0);
  assert.equal(playback.port.messages.at(-1).type, 'stopped');
});

test('playback queue is bounded instead of retaining an arbitrarily long backlog', () => {
  const playback = processor('scrollmate-playback', 24000);
  playback.port.onmessage({ data: new ArrayBuffer(24000 * 2 * 13) });
  assert.equal(playback.remaining, 0); assert.equal(playback.port.messages[0].type, 'overflow');
});
