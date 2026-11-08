/** One output channel for generated AI audio and the browser-voice fallback. */
interface Item {
  text: string;
  audio?: string;
  onStart: () => void;
  onEnd: () => void;
  onError?: () => void;
}

export class Speaker {
  private queue: Item[] = [];
  private current: Item | null = null;
  private safety: number | undefined;
  private complete: (() => void) | null = null;
  private generation = 0;
  private audioContext: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private volume = .8;

  get available() { return typeof speechSynthesis !== 'undefined' || typeof AudioContext !== 'undefined'; }

  /** Called from a user click so later generated audio can play without another gesture. */
  unlock() {
    if (typeof AudioContext === 'undefined') return;
    try {
      this.audioContext ??= new AudioContext();
      void this.audioContext.resume().catch(() => undefined);
    } catch { /* captions and the browser voice remain available */ }
  }

  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  speak(text: string, onStart: () => void, onEnd: () => void, audio?: string, onError?: () => void) {
    this.queue.push({ text, onStart, onEnd, audio, onError });
    this.pump();
  }

  cancel() {
    this.queue = [];
    this.generation++;
    const finish = this.complete;
    try { this.source?.stop(); } catch { /* already ended */ }
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    finish?.();
  }

  private pump() {
    if (this.current) return;
    const item = this.queue.shift();
    if (!item) return;
    this.current = item;
    const token = ++this.generation;
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      if (this.current !== item) return;
      window.clearTimeout(this.safety);
      this.source?.disconnect(); this.source = null;
      this.gain?.disconnect(); this.gain = null;
      this.current = null; this.complete = null;
      item.onEnd();
      this.pump();
    };
    this.complete = finish;
    if (item.audio) {
      void (async () => {
        try {
          this.unlock();
          if (!this.audioContext) throw new Error('Audio unavailable');
          await this.audioContext.resume();
          const bytes = Uint8Array.from(atob(item.audio!), (char) => char.charCodeAt(0));
          const buffer = await this.audioContext.decodeAudioData(bytes.buffer);
          if (token !== this.generation || this.current !== item) return;
          const gain = this.gain = this.audioContext.createGain(); gain.gain.value = this.volume;
          gain.connect(this.audioContext.destination);
          const source = this.source = this.audioContext.createBufferSource(); source.buffer = buffer;
          source.connect(gain); source.onended = finish;
          source.start(); item.onStart();
          this.safety = window.setTimeout(() => { try { source.stop(); } catch {} finish(); }, (buffer.duration + 2) * 1000);
        } catch {
          if (token !== this.generation || this.current !== item) return;
          item.onError?.(); this.browserSpeak(item, finish);
        }
      })();
    } else this.browserSpeak(item, finish);
  }

  private browserSpeak(item: Item, finish: () => void) {
    if (typeof speechSynthesis === 'undefined') { finish(); return; }
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.rate = 1.02; utterance.pitch = 1.3; utterance.volume = this.volume;
    const voices = speechSynthesis.getVoices().filter((voice) => voice.lang.startsWith('en'));
    const voice = voices.find((candidate) => /female|samantha|zira|aria|jenny/i.test(candidate.name)) ?? voices[0];
    if (voice) utterance.voice = voice;
    utterance.onstart = item.onStart; utterance.onend = finish; utterance.onerror = finish;
    this.safety = window.setTimeout(finish, 2500 + item.text.length * 110);
    speechSynthesis.speak(utterance);
  }
}
