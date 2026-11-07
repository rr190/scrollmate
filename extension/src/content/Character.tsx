import { useEffect, useRef, type ReactNode } from 'react';
import type { Mood } from './controller';

/**
 * Original SVG mochi creature: cream body, rounded ears, purple headphones.
 *
 * Every eye / mouth / brow / extra variant is always drawn, stacked, and only the active
 * ones are visible. Switching mood crossfades the parts (CSS transitions) and gives the
 * body a small squash-and-bounce, so emotions change seamlessly instead of snapping.
 */
type Eyes = 'dot' | 'big' | 'up' | 'happy' | 'closed' | 'wide' | 'star' | 'squint' | 'heart';
type Mouth = 'cat' | 'flat' | 'smile' | 'laugh' | 'talk' | 'o' | 'oSmall' | 'wavy' | 'grimace' | 'frown';
type Brows = 'none' | 'up' | 'worried' | 'flat';
type Extra = 'sparkles' | 'thought' | 'zzz' | 'exclaim' | 'sweat' | 'hearts' | 'tear' | 'blush';

interface Face {
  eyes: Eyes;
  mouth: Mouth;
  brows: Brows;
  extras: Extra[];
}

const FACES: Record<Mood, Face> = {
  idle: { eyes: 'dot', mouth: 'cat', brows: 'none', extras: [] },
  watching: { eyes: 'big', mouth: 'cat', brows: 'none', extras: [] },
  thinking: { eyes: 'up', mouth: 'flat', brows: 'none', extras: ['thought'] },
  amused: { eyes: 'happy', mouth: 'smile', brows: 'none', extras: ['sparkles', 'blush'] },
  speaking: { eyes: 'dot', mouth: 'talk', brows: 'none', extras: ['sparkles'] },
  sleeping: { eyes: 'closed', mouth: 'oSmall', brows: 'none', extras: ['zzz'] },
  surprised: { eyes: 'wide', mouth: 'o', brows: 'up', extras: ['exclaim'] },
  laughing: { eyes: 'happy', mouth: 'laugh', brows: 'none', extras: ['sparkles', 'blush'] },
  impressed: { eyes: 'star', mouth: 'smile', brows: 'up', extras: ['sparkles'] },
  worried: { eyes: 'dot', mouth: 'wavy', brows: 'worried', extras: ['sweat'] },
  cringe: { eyes: 'squint', mouth: 'grimace', brows: 'flat', extras: ['sweat'] },
  love: { eyes: 'heart', mouth: 'smile', brows: 'none', extras: ['hearts', 'blush'] },
  sad: { eyes: 'dot', mouth: 'frown', brows: 'worried', extras: ['tear'] },
};

/** Mood changes that deserve a bigger bounce (reactions to the video). */
const BIG = new Set<Mood>(['surprised', 'laughing', 'impressed', 'cringe', 'love']);

function L({ on, children, className = '' }: { on: boolean; children: ReactNode; className?: string }) {
  return <g className={`sm-l ${on ? 'sm-on' : ''} ${className}`}>{children}</g>;
}

const star = (cx: number, cy: number, r: number) => {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
};
const heart = (cx: number, cy: number, s: number) =>
  `M${cx} ${cy + 5 * s} C${cx - 9 * s} ${cy - 1 * s} ${cx - 5 * s} ${cy - 8 * s} ${cx} ${cy - 3 * s} C${cx + 5 * s} ${cy - 8 * s} ${cx + 9 * s} ${cy - 1 * s} ${cx} ${cy + 5 * s} Z`;

export function Character({ mood }: { mood: Mood }) {
  const f = FACES[mood] ?? FACES.idle;
  const svgRef = useRef<SVGSVGElement>(null);
  const prevMood = useRef<Mood>(mood);

  // Squash-and-bounce on every mood change (skipped for reduced motion).
  useEffect(() => {
    if (prevMood.current === mood) return;
    prevMood.current = mood;
    const el = svgRef.current;
    if (!el || typeof el.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const k = BIG.has(mood) ? 1 : 0.5;
    el.animate(
      [
        { transform: 'translateY(0) scale(1, 1)' },
        { transform: `translateY(${2 * k}px) scale(${1 + 0.07 * k}, ${1 - 0.08 * k})` },
        { transform: `translateY(${-5 * k}px) scale(${1 - 0.04 * k}, ${1 + 0.05 * k})` },
        { transform: 'translateY(0) scale(1, 1)' },
      ],
      { duration: BIG.has(mood) ? 420 : 300, easing: 'cubic-bezier(.3,1.4,.5,1)' },
    );
  }, [mood]);

  const ex = (e: Extra) => f.extras.includes(e);
  const ink = '#3a2d4d';
  const mouthInk = '#7a3550';

  return (
    <svg ref={svgRef} className={`sm-char sm-mood-${mood}`} viewBox="0 0 140 120" aria-hidden="true">
      <defs>
        <radialGradient id="smBody" cx="45%" cy="35%" r="75%">
          <stop offset="0%" stopColor="#fffaf1" />
          <stop offset="70%" stopColor="#fff1dc" />
          <stop offset="100%" stopColor="#f6dfc0" />
        </radialGradient>
        <linearGradient id="smCup" x1="0" x2="1">
          <stop offset="0%" stopColor="#b79cff" />
          <stop offset="100%" stopColor="#7d5ce0" />
        </linearGradient>
        <filter id="smGlow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#7d5ce0" floodOpacity="0.28" />
        </filter>
      </defs>

      {/* ---- extras behind the head ---- */}
      <L on={ex('sparkles')} className="sm-sparkles">
        <path d="M14 30 L24 36" />
        <path d="M22 16 L28 27" />
        <path d="M36 10 L37 22" />
      </L>
      <L on={ex('hearts')} className="sm-hearts">
        <path d={heart(20, 30, 0.9)} />
        <path d={heart(118, 22, 0.7)} />
        <path d={heart(30, 12, 0.55)} />
      </L>

      <g filter="url(#smGlow)">
        {/* ears */}
        <ellipse cx="46" cy="34" rx="13" ry="12" fill="url(#smBody)" stroke="#ecd6b8" strokeWidth="1.5" />
        <ellipse cx="94" cy="34" rx="13" ry="12" fill="url(#smBody)" stroke="#ecd6b8" strokeWidth="1.5" />
        <ellipse cx="94" cy="35" rx="6" ry="5" fill="#ffd3dc" opacity="0.7" />
        <ellipse cx="46" cy="35" rx="6" ry="5" fill="#ffd3dc" opacity="0.7" />
        {/* body */}
        <path
          d="M24 74 C22 46 44 30 70 30 C96 30 118 46 116 74 C115 96 98 106 70 106 C42 106 25 96 24 74 Z"
          fill="url(#smBody)"
          stroke="#ecd6b8"
          strokeWidth="1.5"
        />
        <path d="M76 32 C86 32 96 38 100 46 C92 44 84 42 78 44 Z" fill="#cbb8f5" opacity="0.8" />
        {/* headphones */}
        <path d="M27 70 C24 26 116 26 113 70" fill="none" stroke="#8a6ae6" strokeWidth="7" strokeLinecap="round" />
        <rect x="14" y="56" width="20" height="30" rx="10" fill="url(#smCup)" />
        <rect x="19" y="62" width="8" height="18" rx="4" fill="#e3d8ff" opacity="0.7" />
        <rect x="106" y="56" width="20" height="30" rx="10" fill="url(#smCup)" />
        <rect x="113" y="62" width="8" height="18" rx="4" fill="#e3d8ff" opacity="0.7" />
        {/* paws */}
        <ellipse cx="52" cy="104" rx="11" ry="7" fill="#fff6e8" stroke="#ecd6b8" strokeWidth="1.5" />
        <ellipse cx="88" cy="104" rx="11" ry="7" fill="#fff6e8" stroke="#ecd6b8" strokeWidth="1.5" />
      </g>

      {/* cheeks (stronger when blushing) */}
      <g className={`sm-cheeks ${ex('blush') ? 'sm-blush' : ''}`}>
        <ellipse cx="44" cy="80" rx="7" ry="4.5" fill="#ffb3c4" />
        <ellipse cx="96" cy="80" rx="7" ry="4.5" fill="#ffb3c4" />
      </g>

      {/* ---- brows ---- */}
      <L on={f.brows === 'up'}>
        <path d="M49 56 Q55 51 61 55" className="sm-line sm-thin" />
        <path d="M79 55 Q85 51 91 56" className="sm-line sm-thin" />
      </L>
      <L on={f.brows === 'worried'}>
        <path d="M49 60 Q55 59 61 55" className="sm-line sm-thin" />
        <path d="M79 55 Q85 59 91 60" className="sm-line sm-thin" />
      </L>
      <L on={f.brows === 'flat'}>
        <path d="M49 58 L61 59" className="sm-line sm-thin" />
        <path d="M79 59 L91 58" className="sm-line sm-thin" />
      </L>

      {/* ---- eyes ---- */}
      <L on={f.eyes === 'dot'} className="sm-blinker">
        <ellipse cx="56" cy="69" rx="5.5" ry="6.5" fill={ink} />
        <ellipse cx="84" cy="69" rx="5.5" ry="6.5" fill={ink} />
        <circle cx="58" cy="66" r="2.2" fill="#fff" />
        <circle cx="86" cy="66" r="2.2" fill="#fff" />
      </L>
      <L on={f.eyes === 'big'} className="sm-blinker">
        <ellipse cx="56" cy="69" rx="6" ry="7.5" fill={ink} />
        <ellipse cx="84" cy="69" rx="6" ry="7.5" fill={ink} />
        <circle cx="58" cy="66" r="2.3" fill="#fff" />
        <circle cx="86" cy="66" r="2.3" fill="#fff" />
        <circle cx="54" cy="72" r="1.1" fill="#fff" />
        <circle cx="82" cy="72" r="1.1" fill="#fff" />
      </L>
      <L on={f.eyes === 'up'} className="sm-blinker">
        <ellipse cx="57" cy="68" rx="5.5" ry="6.5" fill={ink} />
        <ellipse cx="85" cy="68" rx="5.5" ry="6.5" fill={ink} />
        <circle cx="59.5" cy="64" r="2.2" fill="#fff" />
        <circle cx="87.5" cy="64" r="2.2" fill="#fff" />
      </L>
      <L on={f.eyes === 'happy'}>
        <path d="M50 72 Q56 63 62 72" className="sm-line" />
        <path d="M78 72 Q84 63 90 72" className="sm-line" />
      </L>
      <L on={f.eyes === 'closed'}>
        <path d="M50 70 Q56 75 62 70" className="sm-line" />
        <path d="M78 70 Q84 75 90 70" className="sm-line" />
      </L>
      <L on={f.eyes === 'wide'} className="sm-blinker">
        <circle cx="56" cy="68" r="8" fill="#fff" stroke={ink} strokeWidth="2" />
        <circle cx="84" cy="68" r="8" fill="#fff" stroke={ink} strokeWidth="2" />
        <circle cx="56" cy="68" r="3" fill={ink} />
        <circle cx="84" cy="68" r="3" fill={ink} />
      </L>
      <L on={f.eyes === 'star'} className="sm-stars">
        <polygon points={star(56, 69, 8)} fill="#ffc23d" stroke={ink} strokeWidth="1.5" strokeLinejoin="round" />
        <polygon points={star(84, 69, 8)} fill="#ffc23d" stroke={ink} strokeWidth="1.5" strokeLinejoin="round" />
      </L>
      <L on={f.eyes === 'squint'}>
        <path d="M51 64 L60 69 L51 74" className="sm-line" />
        <path d="M89 64 L80 69 L89 74" className="sm-line" />
      </L>
      <L on={f.eyes === 'heart'} className="sm-heart-eyes">
        <path d={heart(56, 69, 0.95)} fill="#ff4f7b" />
        <path d={heart(84, 69, 0.95)} fill="#ff4f7b" />
      </L>

      {/* ---- mouths ---- */}
      <L on={f.mouth === 'cat'}>
        <path d="M63 81 Q66.5 85 70 81 Q73.5 85 77 81" className="sm-line sm-thin" />
      </L>
      <L on={f.mouth === 'flat'}>
        <path d="M65 84 Q70 82 75 84" className="sm-line sm-thin" />
      </L>
      <L on={f.mouth === 'smile'}>
        <path d="M62 80 Q70 92 78 80 Z" fill={mouthInk} stroke={mouthInk} strokeWidth="1.5" strokeLinejoin="round" />
      </L>
      <L on={f.mouth === 'laugh'} className="sm-laugh">
        <path d="M59 79 Q70 99 81 79 Z" fill={mouthInk} stroke={mouthInk} strokeWidth="1.5" strokeLinejoin="round" />
        <ellipse cx="70" cy="89" rx="5" ry="3" fill="#ff8fa8" />
      </L>
      <L on={f.mouth === 'talk'}>
        <ellipse className="sm-talk" cx="70" cy="84" rx="5" ry="4" fill={mouthInk} />
      </L>
      <L on={f.mouth === 'o'}>
        <ellipse cx="70" cy="85" rx="4.5" ry="5.5" fill={mouthInk} />
      </L>
      <L on={f.mouth === 'oSmall'}>
        <ellipse cx="70" cy="83" rx="2.4" ry="2" fill={mouthInk} opacity="0.8" />
      </L>
      <L on={f.mouth === 'wavy'}>
        <path d="M61 85 Q64 82 67 85 Q70 88 73 85 Q76 82 79 85" className="sm-line sm-thin" />
      </L>
      <L on={f.mouth === 'grimace'}>
        <rect x="60" y="80" width="20" height="8" rx="3" fill="#fff" stroke={ink} strokeWidth="1.8" />
        <path d="M60 84 H80 M66.5 80 V88 M73.5 80 V88" stroke={ink} strokeWidth="1.2" />
      </L>
      <L on={f.mouth === 'frown'}>
        <path d="M63 87 Q70 80 77 87" className="sm-line sm-thin" />
      </L>

      {/* ---- extras in front ---- */}
      <L on={ex('thought')} className="sm-thought">
        <circle cx="116" cy="28" r="3" />
        <circle cx="124" cy="18" r="4" />
        <circle cx="134" cy="7" r="5" />
      </L>
      <L on={ex('zzz')} className="sm-zzz">
        <text x="110" y="30">z</text>
        <text x="120" y="18">z</text>
      </L>
      <L on={ex('exclaim')} className="sm-exclaim">
        <path d="M120 10 L118 30" />
        <circle cx="117.3" cy="37" r="2.6" />
      </L>
      <L on={ex('sweat')} className="sm-sweat">
        <path d="M104 44 C100 51 100 55 104 56 C108 55 108 51 104 44 Z" />
      </L>
      <L on={ex('tear')} className="sm-tear">
        <path d="M51 76 C48 82 48 85 51 86 C54 85 54 82 51 76 Z" />
      </L>
    </svg>
  );
}
