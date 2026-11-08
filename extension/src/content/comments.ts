import type { Rect } from '../shared/types';

export const COMMENT_DWELL_MS = 250; // brief pause on a comment = "I mean this one" (skimming past still does nothing)
export const COMMENT_TRAVEL_MS = 650;
export const companionSize = (width: number) => Math.round(Math.min(110, Math.max(80, width * 0.065)));

export interface CommentTarget {
  id: string;
  text: string;
  rect: Rect;
  panelRect: Rect;
}
export type CommentSelection = { accepted: true } | { accepted: false; retryAfterMs?: number; hint: string };

/** Only use a lane outside the panel. If neither side fits, stay home instead of covering text. */
export function commentPosition(target: CommentTarget, width: number, height: number) {
  const size = companionSize(width);
  const gap = 14;
  const left = target.panelRect.x - size - gap;
  const right = target.panelRect.x + target.panelRect.width + gap;
  const side = left >= 8 ? 'left' : right + size <= width - 8 ? 'right' : null;
  if (!side || height < size + 24) return null;
  return {
    x: side === 'left' ? left : right,
    y: Math.max(12, Math.min(height - size - 12, target.rect.y + target.rect.height / 2 - size * 0.43)),
    side,
  };
}

const TEXT = '#content-text, .yt-core-attributed-string#content-text';
const COMMENT = 'ytd-comment-view-model, ytd-comment-renderer';
export const PANEL = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"], ytd-comments';
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

function commentTextAt(el: Element | null): HTMLElement | null {
  const text = el?.closest<HTMLElement>(TEXT) ?? null;
  const comment = text?.closest(COMMENT);
  return text && comment && !comment.closest('ytd-comment-replies-renderer, #replies') &&
    text.closest(PANEL) && !el?.closest('button, a, input, textarea, [contenteditable="true"]') ? text : null;
}

/** display:contents hosts have no box of their own even though their text is painted. */
function renderedBox(el: HTMLElement) {
  const box = el.getBoundingClientRect();
  if (box.width > 0 && box.height > 0) return box;
  const range = document.createRange();
  range.selectNodeContents(el);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left)), top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right)), bottom = Math.max(...rects.map((r) => r.bottom));
  return { left, top, right, bottom };
}

/** Ask the renderer instead of guessing which ancestors clip a floating/fixed panel. */
function visibleRect(el: HTMLElement, anchor?: { x: number; y: number }): Rect | null {
  if (!el.isConnected) return null;
  const box = renderedBox(el);
  if (!box) return null;
  const left = Math.max(0, box.left), top = Math.max(0, box.top);
  const right = Math.min(window.innerWidth, box.right), bottom = Math.min(window.innerHeight, box.bottom);
  if (right <= left || bottom <= top) return null;
  const points = anchor ? [anchor] : [];
  for (const fx of [0.5, 0.05, 0.95]) {
    for (const fy of [0.5, 0.05, 0.95])
      points.push({ x: left + (right - left) * fx, y: top + (bottom - top) * fy });
  }
  const visible = points.some(({ x, y }) => {
    if (x < left || x >= right || y < top || y >= bottom) return false;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !el.contains(hit)) return false;
    // Hit testing handles real clipping/occlusion; native visibility also excludes transparent content.
    // Check the painted descendant, since a display:contents host intentionally has no box.
    if (typeof hit.checkVisibility === 'function')
      return hit.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const css = getComputedStyle(hit);
    return css.display !== 'none' && css.visibility !== 'hidden' && css.opacity !== '0';
  });
  return visible ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** Local pointer intent only. No page reads are sent until onSelect accepts a deliberate dwell. */
export class CommentsWatcher {
  private candidate: HTMLElement | null = null;
  private focused: HTMLElement | null = null;
  private active: { element: HTMLElement; target: CommentTarget } | null = null;
  private dwell: number | undefined;
  private poll: number | undefined;
  private origin = { x: 0, y: 0 };
  private pointer = { x: -1, y: -1 };
  private ids = new WeakMap<HTMLElement, string>();
  private sequence = 0;
  private readFailure: string | null = null;
  private failedReads = 0;

  constructor(private cb: {
    enabled(): boolean;
    onSelect(target: CommentTarget): CommentSelection;
    onFocus?(target: CommentTarget): void;
    onCancel(): void;
    onHint(message: string | null): void;
  }) {}

  start() {
    document.addEventListener('pointermove', this.onMove, true);
    document.addEventListener('pointerout', this.onOut, true);
    document.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onScroll);
    window.addEventListener('blur', this.onScroll);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.poll = window.setInterval(() => this.validate(), 200);
  }

  stop() {
    this.reset();
    document.removeEventListener('pointermove', this.onMove, true);
    document.removeEventListener('pointerout', this.onOut, true);
    document.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
    window.removeEventListener('blur', this.onScroll);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.clearInterval(this.poll);
  }

  reset() {
    window.clearTimeout(this.dwell);
    this.candidate = null;
    this.focused = null;
    this.failedReads = 0;
    this.cb.onHint(null);
    if (this.active) { this.active = null; this.cb.onCancel(); }
  }

  private onVisibility = () => { if (document.hidden) this.reset(); };
  private onScroll = () => this.reset(); // no chasing a scrolling comment
  private onOut = (ev: PointerEvent) => { if (!ev.relatedTarget) this.reset(); };

  private onMove = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch') return;
    this.pointer = { x: ev.clientX, y: ev.clientY };
    if (!this.cb.enabled()) { this.reset(); return; }
    const el = ev.target instanceof Element ? ev.target : null;
    // A visit stays put when the pointer leaves. A new deliberate selection can replace it later.
    const eligible = commentTextAt(el);
    if (eligible === this.active?.element && eligible === this.focused) return;
    if (eligible === this.candidate && Math.hypot(ev.clientX - this.origin.x, ev.clientY - this.origin.y) < 8) return;
    window.clearTimeout(this.dwell);
    this.candidate = eligible;
    this.failedReads = 0;
    this.origin = this.pointer;
    this.cb.onHint(eligible ? 'Hold still for a second…' : null);
    if (eligible) this.dwell = window.setTimeout(() => this.select(eligible), COMMENT_DWELL_MS);
  };

  private read(element: HTMLElement): CommentTarget | null {
    const rect = visibleRect(element, this.pointer);
    // Some Shorts layouts use a viewport-wide engagement wrapper around a narrow comment column.
    const panel = element.closest<HTMLElement>('ytd-comments') ?? element.closest<HTMLElement>('ytd-engagement-panel-section-list-renderer');
    const panelRect = panel && visibleRect(panel, this.pointer);
    const text = normalize(element.innerText);
    this.readFailure = !rect ? 'Comment text has no visible area.'
      : !panelRect ? 'The comment panel is not visible yet.'
      : !text ? 'This comment has no readable text.'
      : text.length > 1200 ? 'This comment is too long; try a shorter one.' : null;
    if (!rect || !panelRect || this.readFailure) return null;
    let id = this.ids.get(element);
    if (!id) { id = `comment-${++this.sequence}`; this.ids.set(element, id); }
    return { id, text, rect, panelRect };
  }

  private select(element: HTMLElement) {
    if (!this.cb.enabled() || this.candidate !== element || document.hidden) return;
    const underPointer = document.elementFromPoint(this.pointer.x, this.pointer.y);
    const pointed = commentTextAt(underPointer);
    if (!pointed) {
      this.candidate = null;
      this.cb.onHint('Move over the comment text to read it.');
      return;
    }
    if (pointed !== element) {
      // YouTube can replace a row while the pointer is stationary. Reconfirm the new row for a full dwell.
      this.candidate = pointed;
      this.failedReads = 0;
      this.dwell = window.setTimeout(() => this.select(pointed), COMMENT_DWELL_MS);
      return;
    }
    const target = this.read(element);
    if (!target) {
      this.cb.onHint(this.readFailure ?? 'Comment changed. Hover over its text again.');
      console.debug('[ScrollMate] comment hover visibility:', this.readFailure);
      if (++this.failedReads <= 3)
        this.dwell = window.setTimeout(() => this.select(element), 300);
      return;
    }
    const previous = this.active;
    this.active = { element, target };
    this.focused = element;
    // Discussion intent is independent of cooldowns, prior reactions and room to move.
    this.cb.onFocus?.(target);
    const result = this.cb.onSelect(target);
    if (!result.accepted) {
      this.active = previous;
      this.cb.onHint(result.hint);
      if (result.retryAfterMs && this.candidate === element)
        this.dwell = window.setTimeout(() => this.select(element), Math.max(250, Math.min(1000, result.retryAfterMs)));
    } else this.cb.onHint(null);
  }

  discussionContext(): { commentsOpen: boolean; visibleComments: string[] } {
    const visibleComments: string[] = [];
    if (document.hidden) return { commentsOpen: false, visibleComments };
    for (const el of document.querySelectorAll<HTMLElement>(TEXT)) {
      if (!el.closest(COMMENT) || el.closest('ytd-comment-replies-renderer, #replies') || !el.closest(PANEL)) continue;
      if (!visibleRect(el)) continue;
      const text = normalize(el.innerText).slice(0, 500);
      if (text) visibleComments.push(text);
      if (visibleComments.length === 6) break;
    }
    const commentsOpen = visibleComments.length > 0 || Array.from(document.querySelectorAll<HTMLElement>(PANEL)).some((el) => !!visibleRect(el));
    return { commentsOpen, visibleComments };
  }

  diagnostics() {
    const texts = Array.from(document.querySelectorAll<HTMLElement>(TEXT));
    const visible = texts.filter((el) => el.closest(COMMENT) && !el.closest('ytd-comment-replies-renderer, #replies') && el.closest(PANEL))
      .map((el) => this.read(el)).filter((target): target is CommentTarget => !!target);
    return {
      textNodes: texts.length,
      commentRows: document.querySelectorAll(COMMENT).length,
      panels: document.querySelectorAll(PANEL).length,
      visible: visible.length,
      room: visible.some((target) => !!commentPosition(target, innerWidth, innerHeight)),
      lastReadFailure: this.readFailure,
    };
  }

  selectionValid(id: string): boolean {
    if (!this.active || this.active.target.id !== id || document.hidden) return false;
    const target = this.read(this.active.element);
    const before = this.active.target;
    return !!target && target.text === before.text &&
      Math.abs(target.rect.x - before.rect.x) < 4 && Math.abs(target.rect.y - before.rect.y) < 4 &&
      Math.abs(target.rect.width - before.rect.width) < 4 && Math.abs(target.rect.height - before.rect.height) < 4;
  }

  private validate() {
    if (!this.cb.enabled()) { this.reset(); return; }
    if (!this.active) return;
    if (!this.selectionValid(this.active.target.id)) this.reset();
  }
}
