/**
 * Instant, rule-based moment prediction from a Short's title (< 1 ms, no network).
 *
 * The AI swipe step (~0.6 s) and frame analysis (~1-2 s) confirm or overrule this.
 * It only ever produces a *non-specific* face, never a claim about content not yet seen.
 */
import type { Emotion } from './emotions';

export type MomentType = 'attempt' | 'reveal' | 'pov' | 'surprise' | 'tutorial' | 'continuation' | 'reaction' | 'other';

interface Rule {
  re: RegExp;
  moment: MomentType;
  emotion: Emotion;
}

// Order matters: first match wins.
const RULES: Rule[] = [
  { re: /\b(wait (for it|till|until)|watch (till|until) the end|the ending|end(ing)? (is|got)|last (one|part))\b/i, moment: 'reveal', emotion: 'curious' },
  { re: /\b(no ?one|nobody) (expected|saw)|\bplot twist\b|\bunexpected\b|\bdidn'?t expect\b/i, moment: 'surprise', emotion: 'surprised' },
  { re: /^\s*pov\b|\bpov:/i, moment: 'pov', emotion: 'laughing' },
  { re: /\b(i|we) tried\b|\btrying\b|\battempt(ing|ed)?\b|\bchallenge\b|\bcan (i|we|you)\b|\bwill it\b|\bdoes it work\b/i, moment: 'attempt', emotion: 'curious' },
  { re: /\bpart\s*\d+\b|\bpt\.?\s*\d+\b|\bep(isode)?\.?\s*\d+\b|\bday\s*\d+\b/i, moment: 'continuation', emotion: 'curious' },
  { re: /\bhow to\b|\btutorial\b|\brecipe\b|\btips?\b|\bhack\b|\bstep[- ]by[- ]step\b|\bdiy\b/i, moment: 'tutorial', emotion: 'curious' },
  { re: /\breact(s|ing|ion)?\b/i, moment: 'reaction', emotion: 'curious' },
  { re: /💀|😭|😂|🤣|\bfail(s|ed)?\b|\bgone wrong\b|\bdisaster\b|\boops\b/i, moment: 'attempt', emotion: 'cringe' },
  { re: /😍|🥰|❤️|\bcute\b|\badorable\b|\bwholesome\b|\bpuppy\b|\bkitten\b/i, moment: 'other', emotion: 'love' },
  { re: /\bsatisfying\b|\bperfect\b|\binsane\b|\bincredible\b|\bmasterpiece\b|✨/i, moment: 'other', emotion: 'impressed' },
];

export function predictMoment(title: string): { moment: MomentType; emotion: Emotion | null; rule: string | null } {
  for (const r of RULES) {
    if (r.re.test(title)) return { moment: r.moment, emotion: r.emotion, rule: r.re.source.slice(0, 40) };
  }
  return { moment: 'other', emotion: null, rule: null };
}
