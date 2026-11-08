import type { LiveVoiceEvent, TalkContext } from '../shared/messages';
import { BrowserDuplexAudio, type DuplexAudio } from './duplexAudio';

type Session = { id: string; context: TalkContext; audio: DuplexAudio; socket?: WebSocket; ready: boolean;
  timer?: ReturnType<typeof setTimeout>; beat?: ReturnType<typeof setInterval>; lastMessage: number;
  generation: number; minimumGeneration: number; complete: boolean; pendingAudio: boolean;
  phase: 'listening' | 'thinking' | 'speaking' };

/** Duplex websocket transport with generation cancellation, matching RealtimeVoiceChat's flow. */
export class RealtimeVoiceClient {
  private current: Session | null = null;
  constructor(private emit: (requestId: string, event: LiveVoiceEvent) => void,
    private makeAudio: () => DuplexAudio = () => new BrowserDuplexAudio(),
    private makeSocket: (url: string) => WebSocket = (url) => new WebSocket(url)) {}

  async start(url: string, context: TalkContext) {
    this.cancel();
    const session: Session = { id: context.requestId, context, audio: this.makeAudio(), ready: false, lastMessage: Date.now(),
      generation: 0, minimumGeneration: 0, complete: true, pendingAudio: false, phase: 'listening' };
    this.current = session;
    session.timer = setTimeout(() => this.fail(session, 'Voice connection timed out. Tap the microphone to reconnect.'), 25_000);
    try {
      await session.audio.open((pcm) => {
        if (this.current !== session || !session.ready) return;
        if (session.socket?.readyState !== 1 || session.socket.bufferedAmount > 64_000) {
          this.fail(session, 'Voice connection fell behind. Tap the microphone to reconnect.'); return;
        }
        session.socket.send(pcm);
      }, (playing) => {
        if (this.current !== session) return;
        session.pendingAudio = playing;
        if (playing) this.status(session, 'speaking');
        else if (session.complete) this.status(session, 'listening');
      }, (error) => this.fail(session, error));
      if (this.current !== session) return;
      const socket = session.socket = this.makeSocket(url);
      socket.onopen = () => {
        if (this.current === session) socket.send(JSON.stringify({ type: 'start', context: session.context }));
      };
      socket.onmessage = (message) => {
        if (this.current !== session) return;
        try { this.message(session, JSON.parse(message.data)); }
        catch { this.fail(session, 'Invalid live voice data. Tap the microphone to reconnect.'); }
      };
      socket.onerror = () => this.fail(session, 'Live voice connection failed. Check the backend, then tap the microphone again.');
      socket.onclose = () => this.fail(session, 'Voice connection closed. Tap the microphone to reconnect.');
    } catch (error) {
      if (this.current !== session) return;
      const permission = ['NotAllowedError', 'SecurityError'].includes((error as Error).name);
      this.fail(session, permission ? 'Allow microphone access in the setup tab, then tap the microphone again.'
        : 'Microphone or audio unavailable. Check your device and reload the extension.', permission);
    }
  }

  update(context: TalkContext) {
    const session = this.current;
    if (!session || session.id !== context.requestId) return;
    session.context = context;
    if (session.ready && session.socket?.readyState === 1) session.socket.send(JSON.stringify({ type: 'context', context }));
  }

  cancel(id?: string) {
    const session = this.current;
    if (!session || (id && id !== session.id)) return;
    this.current = null;
    clearTimeout(session.timer); clearInterval(session.beat);
    session.audio.close();
    if (session.socket) {
      session.socket.onopen = session.socket.onmessage = session.socket.onerror = session.socket.onclose = null;
      session.socket.close();
    }
  }

  private status(session: Session, state: Session['phase']) {
    session.phase = state;
    this.emit(session.id, { type: 'status', state });
  }

  private fail(session: Session, error: string, permission = false) {
    if (this.current !== session) return;
    this.cancel(session.id);
    this.emit(session.id, { type: 'status', state: permission ? 'needs_permission' : 'error', error });
  }

  private message(session: Session, message: any) {
    session.lastMessage = Date.now();
    if (message.type === 'ready') {
      session.ready = true; clearTimeout(session.timer);
      // Context may have changed after hello was sent but before the provider connected.
      session.socket?.send(JSON.stringify({ type: 'context', context: session.context }));
      this.status(session, 'listening');
      session.beat = setInterval(() => {
        if (Date.now() - session.lastMessage > 35_000) { this.fail(session, 'Voice connection stopped responding. Tap the microphone to reconnect.'); return; }
        if (session.socket?.readyState === 1) session.socket.send(JSON.stringify({ type: 'ping' }));
        this.status(session, session.phase); // Keeps the owning service worker and avatar state alive.
      }, 10_000);
      return;
    }
    if (message.type === 'pong') return;
    if (message.type === 'error') { this.fail(session, String(message.error || 'Live voice unavailable.')); return; }
    if (!Number.isInteger(message.generation) || message.generation < 0) throw new Error('Invalid generation');
    if (message.type === 'interrupt') {
      session.minimumGeneration = Math.max(session.minimumGeneration, message.generation + 1);
      session.complete = true; session.pendingAudio = false; session.audio.clear();
      this.emit(session.id, { type: 'interrupted' }); this.status(session, 'listening');
      return;
    }
    if (message.type === 'caption' && message.role === 'user') {
      this.emit(session.id, { type: 'caption', role: 'user', text: String(message.text).slice(0, 1600) });
      return;
    }
    if (message.generation < session.minimumGeneration || message.generation < session.generation) return;
    if (message.type === 'response') {
      if (session.pendingAudio) session.audio.clear();
      session.generation = message.generation; session.complete = false; session.pendingAudio = false;
      this.emit(session.id, { type: 'caption', role: 'assistant', text: '' }); this.status(session, 'thinking');
    } else if (message.type === 'caption' && message.role === 'assistant') {
      this.emit(session.id, { type: 'caption', role: 'assistant', text: String(message.text).slice(0, 2400) });
    } else if (message.type === 'audio') {
      if (message.rate !== 24000 || typeof message.data !== 'string' || message.data.length > 700_000) throw new Error('Unsupported audio');
      const bytes = Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0));
      if (!bytes.length || bytes.length % 2) throw new Error('Invalid PCM');
      session.pendingAudio = true; session.audio.push(bytes.buffer);
    } else if (message.type === 'complete') {
      session.complete = true;
      if (!session.pendingAudio) this.status(session, 'listening');
    } else throw new Error('Unknown voice event');
  }
}
