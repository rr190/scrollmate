export interface DuplexAudio {
  open(onFrame: (pcm: ArrayBuffer) => void, onPlayback: (playing: boolean) => void, onError: (error: string) => void): Promise<void>;
  push(pcm: ArrayBuffer): void;
  clear(): void;
  close(): void;
}

/** Microphone and streamed reply playback stay open together, allowing interruptions. */
export class BrowserDuplexAudio implements DuplexAudio {
  private stream: MediaStream | null = null;
  private input: AudioContext | null = null;
  private output: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private capture: AudioWorkletNode | null = null;
  private playback: AudioWorkletNode | null = null;
  private closed = false;

  constructor(private moduleUrl = chrome.runtime.getURL('audio/voice-worklets.js')) {}

  async open(onFrame: (pcm: ArrayBuffer) => void, onPlayback: (playing: boolean) => void, onError: (error: string) => void) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: false,
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (this.closed) { stream.getTracks().forEach((track) => track.stop()); return; }
    this.stream = stream;
    const input = this.input = new AudioContext({ sampleRate: 16000 });
    const output = this.output = new AudioContext({ sampleRate: 24000 });
    await Promise.all([input.audioWorklet.addModule(this.moduleUrl), output.audioWorklet.addModule(this.moduleUrl), input.resume(), output.resume()]);
    if (this.closed) return;
    if (input.sampleRate !== 16000 || output.sampleRate !== 24000) throw new Error('Unsupported audio sample rate');
    const capture = this.capture = new AudioWorkletNode(input, 'scrollmate-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => { if (!this.closed) onFrame(event.data); };
    capture.onprocessorerror = () => onError('Microphone processing stopped. Tap the microphone to reconnect.');
    this.source = input.createMediaStreamSource(stream); this.source.connect(capture); capture.connect(input.destination);
    const playback = this.playback = new AudioWorkletNode(output, 'scrollmate-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    playback.port.onmessage = ({ data }) => {
      if (this.closed) return;
      if (data.type === 'overflow') onError('Voice playback fell behind. Tap the microphone to reconnect.');
      else onPlayback(data.type === 'started');
    };
    playback.onprocessorerror = () => onError('Voice playback stopped. Tap the microphone to reconnect.');
    playback.connect(output.destination);
    for (const track of stream.getAudioTracks()) track.onended = () => {
      if (!this.closed) onError('Microphone disconnected. Tap the microphone to reconnect.');
    };
  }

  push(pcm: ArrayBuffer) { if (!this.closed) this.playback?.port.postMessage(pcm, [pcm]); }
  clear() { if (!this.closed) this.playback?.port.postMessage({ type: 'clear' }); }
  close() {
    this.closed = true;
    this.stream?.getTracks().forEach((track) => track.stop()); this.stream = null;
    this.source?.disconnect(); this.capture?.disconnect(); this.playback?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    if (this.playback) this.playback.port.onmessage = null;
    void this.input?.close().catch(() => undefined); void this.output?.close().catch(() => undefined);
    this.input = this.output = null;
  }
}
