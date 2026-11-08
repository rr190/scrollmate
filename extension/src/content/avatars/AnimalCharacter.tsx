import { useId } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Mood } from '../controller';
import type { AvatarKind } from '../../shared/types';
import { Brow, Eye, Mouth, type EyeType } from '../mochi/faceParts';
import { LOOKS } from '../mochi/moods';
import { useRandomBlink } from './AvatarMotion';

/** Already closed or squinting: no blinking. */
const NO_BLINK: EyeType[] = ['arc', 'squeeze', 'closed'];
const swapIn = { type: 'spring', stiffness: 520, damping: 24, delay: 0.07 } as const;

export function AnimalCharacter({ kind, mood }: { kind: AvatarKind; mood: Mood }) {
  const id = useId().replace(/:/g, '');
  const look = LOOKS[mood] ?? LOOKS.idle;
  const face = look.face;
  const [left, right] = Array.isArray(face.eyes) ? face.eyes : [face.eyes, face.eyes];
  const blink = useRandomBlink(!NO_BLINK.includes(left));
  const fk = JSON.stringify(face); // same face = no swap
  const coat = kind === 'shiba' ? '#ffc86c' : kind === 'cat' ? '#c5b0e0' : '#fffaf3';
  return <svg className={`sm-char sm-animal sm-mood-${mood}`} viewBox="0 0 200 190" aria-hidden="true">
    <defs><radialGradient id={`coat-${id}`} cx="38%" cy="25%" r="85%"><stop stopColor="#fffdf8" /><stop offset="1" stopColor={coat} /></radialGradient></defs>
    <ellipse cx="100" cy="174" rx="55" ry="8" fill="#70539e" opacity=".12" />
    {kind === 'bunny' ? <g stroke="#eaddec" strokeWidth="2">
      <ellipse cx="66" cy="47" rx="17" ry="39" fill="#fffaf6" transform="rotate(-13 66 47)" />
      <ellipse cx="134" cy="47" rx="17" ry="39" fill="#fffaf6" transform="rotate(13 134 47)" />
      <ellipse cx="66" cy="44" rx="7" ry="26" fill="#ffb7cf" transform="rotate(-13 66 44)" stroke="none" />
      <ellipse cx="134" cy="44" rx="7" ry="26" fill="#ffb7cf" transform="rotate(13 134 44)" stroke="none" />
    </g> : kind === 'panda' ? <g fill="#665571"><circle cx="52" cy="55" r="24" /><circle cx="148" cy="55" r="24" /></g> :
      <g fill={coat} stroke="#b99bba" strokeWidth="2"><path d="M40 78 L39 23 Q60 19 78 62Z" /><path d="M122 62 Q140 19 161 23 L160 78Z" />
        <path d="M48 62 L48 36 L67 61Z M133 61 L152 36 L152 62Z" fill="#f6a9b9" stroke="none" /></g>}
    <path d="M25 112 C25 65 55 48 100 48 C145 48 175 65 175 112 C175 153 150 172 100 172 C50 172 25 153 25 112Z" fill={`url(#coat-${id})`} stroke="#cbb8d0" strokeWidth="1.5" />
    {(kind === 'cat' || kind === 'shiba') && <path d="M53 70 Q60 97 100 107 Q140 97 147 70 C169 96 167 136 143 152 Q100 179 57 152 C33 136 31 96 53 70Z" fill="#fff9ed" />}
    {kind === 'panda' && <g fill="#716079"><ellipse cx="71" cy="105" rx="22" ry="27" transform="rotate(20 71 105)" /><ellipse cx="129" cy="105" rx="22" ry="27" transform="rotate(-20 129 105)" /></g>}
    <motion.ellipse cx="47" cy="129" rx="12" ry="7" fill="#ff99be" animate={{ opacity: look.blush * .85 }} transition={{ duration: 0.4 }} />
    <motion.ellipse cx="153" cy="129" rx="12" ry="7" fill="#ff99be" animate={{ opacity: look.blush * .85 }} transition={{ duration: 0.4 }} />
    {/* face parts cross-fade with a squash on mood change (reads like a blink), like the website's Mochi */}
    <AnimatePresence initial={false}>
      <motion.g key={`brows-${fk}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -2, transition: { duration: 0.12 } }} transition={swapIn}>
        <Brow type={face.brows ?? 'none'} x={72} y={86} side={-1} /><Brow type={face.brows ?? 'none'} x={128} y={86} side={1} />
      </motion.g>
    </AnimatePresence>
    <motion.g className="sm-animal-eyes" style={{ scaleY: blink, originY: 0.5 }}>
      <AnimatePresence initial={false}>
        <motion.g key={`eyes-${fk}`} initial={{ scaleY: 0.05, scaleX: 1.2, opacity: 0 }} animate={{ scaleY: 1, scaleX: 1, opacity: 1 }}
          exit={{ scaleY: 0.05, scaleX: 1.15, opacity: 0, transition: { duration: 0.1, ease: 'easeIn' } }} transition={swapIn}>
          <Eye type={left} x={72} y={108} side={-1} s={.9} /><Eye type={right} x={128} y={108} side={1} s={.9} />
        </motion.g>
      </AnimatePresence>
    </motion.g>
    <path d="M95 124 Q100 120 105 124 Q100 130 95 124" fill="#dc8fa7" />
    <AnimatePresence initial={false}>
      <motion.g key={`mouth-${fk}`} initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.4, opacity: 0, transition: { duration: 0.1 } }} transition={swapIn}>
        <Mouth type={face.mouth} x={100} y={139} />
      </motion.g>
    </AnimatePresence>
    {kind === 'cat' && <g stroke="#a592b4" strokeWidth="2" strokeLinecap="round"><path d="M34 119l-14 -3 M34 126l-15 3 M166 119l14 -3 M166 126l15 3" /></g>}
    <ellipse cx="67" cy="167" rx="16" ry="8" fill="#fff9ee" /><ellipse cx="133" cy="167" rx="16" ry="8" fill="#fff9ee" />
  </svg>;
}
