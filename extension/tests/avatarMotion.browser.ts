/**
 * The website-style animation: wobble, every mood without errors, reduced motion, and the flicker guard.
 * (Random blinks and face cross-fades need real animation frames, which headless virtual time doesn't run:
 * they're checked in a real Chrome window.)
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Avatar, STEADY_MS } from '../src/content/Avatar';
import type { Mood } from '../src/content/controller';
import type { AvatarKind } from '../src/shared/types';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
document.body.innerHTML = `<div id="a" style="width:120px;height:110px"></div><div id="b" style="width:120px;height:114px"></div>
<pre id="test-results">RUNNING</pre>`;

function mount(id: string, kind: AvatarKind, mood: Mood) {
  const root = createRoot(document.getElementById(id)!);
  const render = (m: Mood) => flushSync(() => root.render(createElement(Avatar, { kind, mood: m })));
  render(mood);
  return render;
}

(async () => {
  const out = document.getElementById('test-results')!;
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(e.message));
  try {
    const mochi = mount('a', 'mochi', 'watching');
    const cat = mount('b', 'cat', 'watching');
    const outline = () => document.querySelector('#a .sm-mochi-outline')!.getAttribute('d');

    // 1) the jelly outline wobbles every frame (and is still with reduced motion)
    const d1 = outline();
    await wait(250);
    const d2 = outline();
    if (reduced ? d1 !== d2 : d1 === d2) throw new Error(reduced ? 'outline should be still with reduced motion' : 'outline should wobble between frames');

    // 2) random blinks are checked in a real Chrome window: headless virtual time doesn't run animation frames.

    // 3) cycling through every mood never throws and settles on a single face
    const moods: Mood[] = ['idle', 'watching', 'thinking', 'amused', 'speaking', 'sleeping', 'curious', 'surprised', 'laughing',
      'impressed', 'worried', 'cringe', 'love', 'sad', 'happy', 'bored'];
    for (const m of moods) {
      mochi(m);
      cat(m);
      await wait(40);
    }
    await wait(STEADY_MS + 700);
    if (!document.querySelector('#a svg.sm-mood-bored')) throw new Error('mochi should end on the last mood');
    if (!document.querySelector('#b .sm-animal')) throw new Error('animal avatar should render');

    // 4) flicker guard: a quick watching -> thinking -> watching flip doesn't swap the face...
    mochi('watching');
    await wait(STEADY_MS + 700);
    mochi('thinking');
    await wait(120);
    mochi('watching');
    for (let i = 0; i < 12; i++) {
      await wait(50);
      if (!document.querySelector('#a svg.sm-mood-watching')) throw new Error('a quick state flip should not swap the face');
    }
    if (!document.querySelector('#a svg.sm-mood-watching')) throw new Error('should still be watching');
    // ...but a reaction shows at once
    mochi('surprised');
    await wait(30);
    if (!document.querySelector('#a svg.sm-mood-surprised')) throw new Error('an emotion should show immediately');

    if (errors.length) throw new Error(`runtime errors: ${errors.join(' | ')}`);
    out.textContent = `PASS: all browser checks (${reduced ? 'reduced motion: still outline' : 'wobble'}, every mood, flicker guard)`;
  } catch (e) {
    out.textContent = `FAIL: ${(e as Error).message}`;
  }
})();
