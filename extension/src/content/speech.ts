/** speechSynthesis with a queue, cancellation and no overlapping speech. */
interface Item {
  text: string;
  onStart: () => void;
  onEnd: () => void;
}

export class Speaker {
  private queue: Item[] = [];
  private busy = false;
  private safety: number | undefined;
  private current: Item | null = null;

  get available(): boolean {
    return typeof speechSynthesis !== 'undefined';
  }

  speak(text: string, onStart: () => void, onEnd: () => void) {
    if (!this.available) {
      onEnd();
      return;
    }
    this.queue.push({ text, onStart, onEnd });
    this.pump();
  }

  cancel() {
    const cur = this.current;
    this.queue = [];
    this.current = null;
    this.busy = false;
    window.clearTimeout(this.safety);
    if (this.available) speechSynthesis.cancel();
    cur?.onEnd();
  }

  private pickVoice(): SpeechSynthesisVoice | undefined {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    return voices.find((v) => /female|samantha|zira|google uk english female|aria|jenny/i.test(v.name)) ?? voices[0];
  }

  private pump() {
    if (this.busy) return;
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    this.current = item;
    const u = new SpeechSynthesisUtterance(item.text);
    u.rate = 1.05;
    u.pitch = 1.35;
    u.volume = 0.9;
    const voice = this.pickVoice();
    if (voice) u.voice = voice;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(this.safety);
      if (this.current === item) this.current = null;
      this.busy = false;
      item.onEnd();
      this.pump();
    };
    u.onstart = () => item.onStart();
    u.onend = finish;
    u.onerror = finish;
    // Some voices never fire onend: don't get stuck.
    this.safety = window.setTimeout(finish, 2500 + item.text.length * 110);
    speechSynthesis.speak(u);
  }
}
