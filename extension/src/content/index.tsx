import { mountScrollMate } from './mount';

// Injected on youtube.com so SPA navigation into /shorts/ is caught; it stays dormant elsewhere.
declare global {
  interface Window {
    __scrollmate?: boolean;
  }
}

if (!window.__scrollmate && window.top === window) {
  window.__scrollmate = true;
  mountScrollMate('youtube');
  console.log('[ScrollMate] content script loaded');
}
