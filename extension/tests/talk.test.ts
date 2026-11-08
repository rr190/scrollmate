import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RealtimeVoiceClient } from '../src/audio/realtimeVoice';
import type { LiveVoiceEvent, TalkContext } from '../src/shared/messages';

const context: TalkContext = { requestId: 'session-1', videoId: 'reel-1', title: 'Cake', selectedComment: '', personality: 'chill' };
function fixture(t: any, openAudio?: () => Promise<void>) {
  const events: { id: string; event: LiveVoiceEvent }[] = [], sockets: any[] = [], audios: any[] = [];
  let frame!: (pcm: ArrayBuffer) => void, playing!: (value: boolean) => void;
  const client = new RealtimeVoiceClient((id, event) => events.push({ id, event }), () => {
    const audio = { chunks: [] as ArrayBuffer[], cleared: 0, closed: false,
      async open(onFrame: typeof frame, onPlayback: typeof playing) { frame = onFrame; playing = onPlayback; await openAudio?.(); },
      push(pcm: ArrayBuffer) { this.chunks.push(pcm); }, clear() { this.cleared++; this.chunks = []; }, close() { this.closed = true; } };
    audios.push(audio); return audio;
  }, (url) => {
    const socket = { url, readyState: 0, bufferedAmount: 0, sent: [] as any[], onopen: null as any,
      onmessage: null as any, onerror: null as any, onclose: null as any,
      send(value: unknown) { this.sent.push(value); }, close() { this.readyState = 3; },
      open() { this.readyState = 1; this.onopen?.(); },
      receive(value: any) { this.onmessage?.({ data: JSON.stringify(value) }); } };
    sockets.push(socket); return socket as unknown as WebSocket;
  });
  t.after(() => client.cancel());
  const start = async () => {
    await client.start('ws://localhost/scrollmate/talk/live', context);
    sockets.at(-1).open(); sockets.at(-1).receive({ type: 'ready' });
  };
  return { client, events, sockets, audios, start, frame: (pcm = new ArrayBuffer(1280)) => frame(pcm), playing: (value: boolean) => playing(value) };
}

test('one session streams microphone PCM even while streamed replies are playing', async (t) => {
  const f = fixture(t); await f.start();
  const socket = f.sockets[0];
  assert.equal(JSON.parse(socket.sent[0]).type, 'start');
  f.frame();
  socket.receive({ type: 'response', generation: 1 });
  socket.receive({ type: 'audio', generation: 1, rate: 24000, data: 'AAEAAQ==' });
  f.playing(true); f.frame();
  assert.equal(f.audios[0].chunks.length, 1);
  assert.equal(socket.sent.filter((value: any) => value instanceof ArrayBuffer).length, 2);
  assert.equal(f.sockets.length, 1);
  assert(f.events.some(({ event }) => event.type === 'status' && event.state === 'speaking'));
});

test('generation completion waits for playback to drain before showing Listening', async (t) => {
  const f = fixture(t); await f.start(); const socket = f.sockets[0];
  socket.receive({ type: 'response', generation: 1 });
  socket.receive({ type: 'audio', generation: 1, rate: 24000, data: 'AAE=' });
  f.playing(true); socket.receive({ type: 'complete', generation: 1 });
  assert.equal((f.events.at(-1)!.event as any).state, 'speaking');
  f.playing(false);
  assert.equal((f.events.at(-1)!.event as any).state, 'listening');
});

test('interruptions clear playback and reject late audio from the cancelled generation', async (t) => {
  const f = fixture(t); await f.start(); const socket = f.sockets[0];
  socket.receive({ type: 'response', generation: 1 });
  socket.receive({ type: 'audio', generation: 1, rate: 24000, data: 'AAE=' });
  socket.receive({ type: 'interrupt', generation: 1 });
  socket.receive({ type: 'audio', generation: 1, rate: 24000, data: 'AAE=' });
  assert.equal(f.audios[0].cleared, 1); assert.equal(f.audios[0].chunks.length, 0);
  socket.receive({ type: 'response', generation: 2 });
  socket.receive({ type: 'audio', generation: 2, rate: 24000, data: 'AAE=' });
  assert.equal(f.audios[0].chunks.length, 1);
  assert(f.events.some(({ event }) => event.type === 'interrupted'));
});

test('captions and current reel context update without creating another voice session', async (t) => {
  const f = fixture(t); await f.start(); const socket = f.sockets[0];
  f.client.update({ ...context, videoId: 'reel-2', videoSummary: 'A dog with a stick.' });
  assert.equal(JSON.parse(socket.sent.at(-1)).context.videoId, 'reel-2');
  socket.receive({ type: 'caption', role: 'user', generation: 0, text: 'What happened?' });
  socket.receive({ type: 'response', generation: 1 });
  socket.receive({ type: 'caption', role: 'assistant', generation: 1, text: 'The dog' });
  socket.receive({ type: 'caption', role: 'assistant', generation: 1, text: 'The dog found a stick.' });
  assert.equal((f.events.at(-1)!.event as any).text, 'The dog found a stick.');
  assert.equal(f.sockets.length, 1);
});

test('comments opened during the provider handshake are sent once the live session is ready', async (t) => {
  const f = fixture(t);
  await f.client.start('ws://localhost/scrollmate/talk/live', context);
  const socket = f.sockets[0]; socket.open();
  f.client.update({ ...context, commentsOpen: true, visibleComments: ['A great point.'], selectedComment: 'A great point.' });
  assert.equal(socket.sent.length, 1, 'context waits while the provider connects');
  socket.receive({ type: 'ready' });
  const update = JSON.parse(socket.sent.at(-1));
  assert.equal(update.type, 'context'); assert.equal(update.context.selectedComment, 'A great point.');
  assert.deepEqual(update.context.visibleComments, ['A great point.']);
});

test('stop and replacement close audio and socket, and stale callbacks cannot revive them', async (t) => {
  const f = fixture(t); await f.start();
  const old = f.sockets[0], staleMessage = old.onmessage;
  f.client.cancel('foreign'); assert(!f.audios[0].closed);
  f.client.cancel(); const count = f.events.length;
  staleMessage({ data: JSON.stringify({ type: 'ready' }) }); f.frame();
  assert.equal(f.events.length, count); assert(f.audios[0].closed); assert.equal(old.readyState, 3);
  await f.start(); assert.equal(f.sockets.length, 2);
});

test('cancel during permission setup cannot open a late socket', async (t) => {
  let resolve!: () => void;
  const f = fixture(t, () => new Promise<void>((done) => { resolve = done; }));
  const pending = f.client.start('ws://localhost', context);
  f.client.cancel(); resolve(); await pending;
  assert(f.audios[0].closed); assert.equal(f.sockets.length, 0);
});

test('permission denial is distinct from a connection error and releases audio', async (t) => {
  const f = fixture(t, async () => { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; });
  await f.client.start('ws://localhost', context);
  assert.equal((f.events.at(-1)!.event as any).state, 'needs_permission');
  assert(f.audios[0].closed); assert.equal(f.sockets.length, 0);
});

test('network backpressure and provider errors stop capture instead of buffering stale speech', async (t) => {
  const f = fixture(t); await f.start(); f.sockets[0].bufferedAmount = 65_000; f.frame();
  assert(f.audios[0].closed); assert.equal((f.events.at(-1)!.event as any).state, 'error');
  await f.start(); f.sockets[1].receive({ type: 'error', error: 'No live model access.' });
  assert(f.audios[1].closed); assert.equal((f.events.at(-1)!.event as any).error, 'No live model access.');
});
