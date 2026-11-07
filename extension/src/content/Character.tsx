import type { Mood } from './controller';

/** Original SVG mochi creature: cream body, rounded ears, purple headphones. */
export function Character({ mood }: { mood: Mood }) {
  const closed = mood === 'sleeping';
  const happy = mood === 'amused';
  return (
    <svg className={`sm-char sm-mood-${mood}`} viewBox="0 0 140 120" aria-hidden="true">
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

      {/* sparkles (amused / speaking) */}
      <g className="sm-sparkles">
        <path d="M14 30 L24 36" />
        <path d="M22 16 L28 27" />
        <path d="M36 10 L37 22" />
      </g>

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
        {/* lavender hair tuft */}
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

      {/* cheeks */}
      <ellipse cx="44" cy="80" rx="7" ry="4.5" fill="#ffb3c4" opacity="0.65" />
      <ellipse cx="96" cy="80" rx="7" ry="4.5" fill="#ffb3c4" opacity="0.65" />

      {/* eyes */}
      <g className="sm-eyes">
        {closed ? (
          <>
            <path d="M50 70 Q56 75 62 70" className="sm-line" />
            <path d="M78 70 Q84 75 90 70" className="sm-line" />
          </>
        ) : happy ? (
          <>
            <path d="M50 72 Q56 63 62 72" className="sm-line" />
            <path d="M78 72 Q84 63 90 72" className="sm-line" />
          </>
        ) : (
          <>
            <ellipse cx="56" cy="69" rx={mood === 'watching' ? 6 : 5.5} ry={mood === 'watching' ? 7.5 : 6.5} fill="#3a2d4d" />
            <ellipse cx="84" cy="69" rx={mood === 'watching' ? 6 : 5.5} ry={mood === 'watching' ? 7.5 : 6.5} fill="#3a2d4d" />
            <g className={mood === 'thinking' ? 'sm-look-up' : ''}>
              <circle cx="58" cy="66" r="2.2" fill="#fff" />
              <circle cx="86" cy="66" r="2.2" fill="#fff" />
              {mood === 'watching' && (
                <>
                  <circle cx="54" cy="72" r="1.1" fill="#fff" />
                  <circle cx="82" cy="72" r="1.1" fill="#fff" />
                </>
              )}
            </g>
          </>
        )}
      </g>

      {/* mouth */}
      {mood === 'speaking' ? (
        <ellipse className="sm-talk" cx="70" cy="84" rx="5" ry="4" fill="#7a3550" />
      ) : happy ? (
        <path d="M62 80 Q70 92 78 80 Z" fill="#7a3550" stroke="#7a3550" strokeWidth="1.5" strokeLinejoin="round" />
      ) : closed ? (
        <ellipse cx="70" cy="83" rx="2.4" ry="2" fill="#7a3550" opacity="0.8" />
      ) : mood === 'thinking' ? (
        <path d="M65 84 Q70 82 75 84" className="sm-line sm-thin" />
      ) : (
        <path d="M63 81 Q66.5 85 70 81 Q73.5 85 77 81" className="sm-line sm-thin" />
      )}

      {/* thought dots */}
      {mood === 'thinking' && (
        <g className="sm-thought">
          <circle cx="116" cy="28" r="3" />
          <circle cx="124" cy="18" r="4" />
          <circle cx="134" cy="7" r="5" />
        </g>
      )}

      {/* zzz */}
      {closed && (
        <g className="sm-zzz">
          <text x="110" y="30">z</text>
          <text x="120" y="18">z</text>
        </g>
      )}
    </svg>
  );
}
