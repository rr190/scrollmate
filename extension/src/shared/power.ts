/**
 * One-click power switch (the toolbar icon). "Hidden" = ScrollMate is completely off: no buddy on the page,
 * no camera, nothing watched, analysed or sent. Stored in chrome.storage.local so it survives tabs and restarts.
 */
export const HIDDEN_KEY = 'scrollmate.hidden';

/** Badge shown on the toolbar icon for each state. */
export function badgeFor(hidden: boolean): { text: string; color: string; title: string } {
  return hidden
    ? { text: 'OFF', color: '#6b7280', title: 'ScrollMate is off. Click to turn it on.' }
    : { text: '', color: '#7c5ce0', title: 'ScrollMate is on. Click to turn it off completely.' };
}
