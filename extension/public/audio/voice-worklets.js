// Independently implemented PCM capture/playback pipeline inspired by RealtimeVoiceChat.
// Runs on the audio thread: camera inference and page rendering cannot stall capture.
class ScrollMateCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new ArrayBuffer(1280); // 40 ms, PCM16, 16 kHz, mono
    this.view = new DataView(this.frame);
    this.offset = 0;
  }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0); // Never monitor the mic through speakers.
    const samples = inputs[0]?.[0];
    if (samples) for (const value of samples) {
      const clipped = Math.max(-1, Math.min(1, value));
      this.view.setInt16(this.offset, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
      this.offset += 2;
      if (this.offset === this.frame.byteLength) {
        this.port.postMessage(this.frame, [this.frame]);
        this.frame = new ArrayBuffer(1280); this.view = new DataView(this.frame); this.offset = 0;
      }
    }
    return true;
  }
}

class ScrollMatePlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = []; this.offset = 0; this.remaining = 0; this.playing = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'clear') {
        this.queue = []; this.offset = 0; this.remaining = 0;
        if (this.playing) this.port.postMessage({ type: 'stopped' });
        this.playing = false;
      } else if (data instanceof ArrayBuffer && data.byteLength % 2 === 0) {
        if (this.remaining + data.byteLength / 2 > sampleRate * 12) {
          this.port.postMessage({ type: 'overflow' }); return;
        }
        const view = new DataView(data), samples = new Float32Array(data.byteLength / 2);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        this.queue.push(samples); this.remaining += samples.length;
      }
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0][0]; output.fill(0);
    if (this.remaining && !this.playing) { this.playing = true; this.port.postMessage({ type: 'started' }); }
    let index = 0;
    while (index < output.length && this.queue.length) {
      const head = this.queue[0];
      const count = Math.min(output.length - index, head.length - this.offset);
      output.set(head.subarray(this.offset, this.offset + count), index);
      index += count; this.offset += count; this.remaining -= count;
      if (this.offset === head.length) { this.queue.shift(); this.offset = 0; }
    }
    if (!this.remaining && this.playing) { this.playing = false; this.port.postMessage({ type: 'stopped' }); }
    return true;
  }
}

registerProcessor('scrollmate-capture', ScrollMateCapture);
registerProcessor('scrollmate-playback', ScrollMatePlayback);
