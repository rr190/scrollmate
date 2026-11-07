/**
 * YouTube Shorts navigation + playback detection.
 *
 * YouTube is a SPA, so we combine several signals rather than trusting one:
 *  - `yt-navigate-finish` (fires on most in-app navigations)
 *  - `popstate`
 *  - polling `location.href` every 500 ms (fallback)
 *  - a MutationObserver that re-finds the active <video> element
 * Navigation is debounced and the same Short is never processed twice in a row.
 */
const LOG = '[ScrollMate]';

export interface ShortInfo {
  videoId: string;
  startedAt: number;
}

export interface LeftInfo {
  videoId: string;
  secondsWatched: number;
  duration: number;
  looped: boolean;
  skipped: boolean;
}

export type PlaybackEvent = 'play' | 'pause' | 'ended' | 'loop' | 'time' | 'metadata';

export interface WatcherCallbacks {
  onShortChange(info: ShortInfo, prev: LeftInfo | null): void;
  onLeaveShorts(prev: LeftInfo | null): void;
  onPlayback(ev: PlaybackEvent, video: HTMLVideoElement): void;
}

export function videoIdFromUrl(href: string): string | null {
  const m = /\/shorts\/([A-Za-z0-9_-]{6,})/.exec(new URL(href).pathname);
  return m ? m[1] : null;
}

export class ShortsWatcher {
  currentId: string | null = null;
  video: HTMLVideoElement | null = null;
  lastLoopAt: number | null = null;
  private watched = 0;
  private looped = false;
  private lastTime = 0;
  private debounce: number | undefined;
  private poll: number | undefined;
  private observer: MutationObserver | null = null;
  private moThrottle = 0;
  private detach: (() => void) | null = null;

  constructor(private cb: WatcherCallbacks) {}

  start() {
    document.addEventListener('yt-navigate-finish', this.schedule);
    window.addEventListener('popstate', this.schedule);
    this.poll = window.setInterval(this.checkUrl, 500);
    this.observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - this.moThrottle < 300) return;
      this.moThrottle = now;
      this.bindVideo();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.checkUrl();
  }

  stop() {
    document.removeEventListener('yt-navigate-finish', this.schedule);
    window.removeEventListener('popstate', this.schedule);
    window.clearInterval(this.poll);
    window.clearTimeout(this.debounce);
    this.observer?.disconnect();
    this.detach?.();
    this.detach = null;
    this.video = null;
  }

  private schedule = () => {
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(this.checkUrl, 250);
  };

  private checkUrl = () => {
    const id = videoIdFromUrl(location.href);
    if (id === this.currentId) return;
    const prev = this.leftInfo();
    if (!id) {
      this.currentId = null;
      console.log(LOG, 'left Shorts', prev);
      this.cb.onLeaveShorts(prev);
      return;
    }
    this.currentId = id;
    this.watched = 0;
    this.looped = false;
    this.lastLoopAt = null;
    this.lastTime = 0;
    console.log(LOG, 'new Short', id, prev ? `(prev ${prev.videoId}: watched ${prev.secondsWatched.toFixed(1)}s${prev.skipped ? ', skipped' : ''})` : '');
    this.bindVideo(true);
    this.cb.onShortChange({ videoId: id, startedAt: Date.now() }, prev);
  };

  private leftInfo(): LeftInfo | null {
    if (!this.currentId) return null;
    const duration = this.video && isFinite(this.video.duration) ? this.video.duration : 0;
    const reachedEnd = this.looped || (duration > 0 && this.watched >= duration * 0.8);
    return {
      videoId: this.currentId,
      secondsWatched: this.watched,
      duration,
      looped: this.looped,
      skipped: !reachedEnd,
    };
  }

  /** Find the <video> for the active Short without relying on a single selector. */
  findActiveVideo(): HTMLVideoElement | null {
    const set = new Set<HTMLVideoElement>();
    for (const sel of [
      'ytd-reel-video-renderer[is-active] video',
      'ytd-shorts [is-active] video',
      '#shorts-player video',
      'ytd-shorts video',
      'video',
    ]) {
      document.querySelectorAll<HTMLVideoElement>(sel).forEach((v) => set.add(v));
    }
    let best: HTMLVideoElement | null = null;
    let bestScore = 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const v of set) {
      const r = v.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      let score = w * h;
      if (score === 0) continue;
      if (!v.paused) score *= 2;
      if (v.closest('[is-active]')) score *= 2;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  private bindVideo(force = false) {
    if (!this.currentId) return;
    const v = this.findActiveVideo();
    if (!v || (v === this.video && !force)) return;
    if (v === this.video) return;
    this.detach?.();
    this.video = v;
    const on = (ev: string, fn: () => void) => {
      v.addEventListener(ev, fn);
      return () => v.removeEventListener(ev, fn);
    };
    const offs = [
      on('play', () => this.emit('play')),
      on('playing', () => this.emit('play')),
      on('pause', () => this.emit('pause')),
      on('ended', () => this.emit('ended')),
      on('loadedmetadata', () => this.emit('metadata')),
      on('timeupdate', this.onTime),
    ];
    this.detach = () => offs.forEach((f) => f());
    console.log(LOG, 'bound active <video>', { duration: v.duration, paused: v.paused });
  }

  private onTime = () => {
    const v = this.video;
    if (!v) return;
    const t = v.currentTime;
    const d = isFinite(v.duration) ? v.duration : 0;
    const delta = t - this.lastTime;
    if (delta > 0 && delta < 1.5) this.watched += delta;
    // Shorts use <video loop>, so 'ended' rarely fires: detect the wrap-around instead.
    if (d > 0 && this.lastTime > d - 1.5 && t < 1) {
      this.looped = true;
      this.lastLoopAt = Date.now();
      console.log(LOG, 'loop', this.currentId);
      this.emit('loop');
    }
    this.lastTime = t;
    this.emit('time');
  };

  private emit(ev: PlaybackEvent) {
    if (!this.video) return;
    if (ev !== 'time') console.log(LOG, ev, this.currentId, this.video.currentTime.toFixed(1));
    this.cb.onPlayback(ev, this.video);
  }

  get secondsWatched() {
    return this.watched;
  }
}

/** Title, channel and visible captions only. Nothing hidden, nothing fetched. */
export function readPageText(): { title: string; channel: string; captions: string[] } {
  const pick = (sels: string[]) => {
    for (const s of sels) {
      const el = document.querySelector<HTMLElement>(s);
      const txt = el?.innerText?.trim();
      if (txt) return txt;
    }
    return '';
  };
  let title = pick([
    'ytd-reel-video-renderer[is-active] h2',
    'ytd-reel-video-renderer[is-active] yt-shorts-video-title-view-model',
    'ytd-reel-video-renderer[is-active] .ytShortsVideoTitleViewModelShortsVideoTitle',
    '[is-active] h2.title',
  ]);
  if (!title) title = document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
  const channel = pick([
    'ytd-reel-video-renderer[is-active] ytd-channel-name a',
    'ytd-reel-video-renderer[is-active] .ytReelChannelBarViewModelChannelName a',
    'ytd-reel-video-renderer[is-active] a[href^="/@"]',
  ]);
  const captions = Array.from(document.querySelectorAll<HTMLElement>('.ytp-caption-segment'))
    .map((e) => e.innerText.trim())
    .filter(Boolean);
  return { title: title.slice(0, 200), channel: channel.slice(0, 80), captions };
}
