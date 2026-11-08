import { mountScrollMate, type Mounted } from './mount';
import { HIDDEN_KEY } from '../shared/power';

// Injected on youtube.com so SPA navigation into /shorts/ is caught; it stays dormant elsewhere.
declare global {
  interface Window {
    __scrollmate?: boolean;
  }
}

let mounted: Mounted | null = null;

/** The toolbar icon is a one-click off switch: when "hidden", ScrollMate is not on the page at all. */
function apply(hidden: boolean) {
  if (hidden && mounted) {
    mounted.unmount();
    mounted = null;
    console.log('[ScrollMate] switched off from the toolbar icon');
  } else if (!hidden && !mounted) {
    mounted = mountScrollMate('youtube');
    console.log('[ScrollMate] content script loaded');
  }
}

if (!window.__scrollmate && window.top === window) {
  window.__scrollmate = true;
  chrome.storage.local
    .get(HIDDEN_KEY)
    .then((r) => apply(r[HIDDEN_KEY] === true))
    .catch(() => apply(false));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && HIDDEN_KEY in changes) apply(changes[HIDDEN_KEY].newValue === true);
  });
}
