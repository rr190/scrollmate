/**
 * Mochi's contextual flourishes (sparkles, ?, hearts, burst, sweat, tears, HA, zzz, notes).
 * Positions and timings ported from the landing page's CompanionEffects.tsx; the `motion`
 * animations are re-expressed as CSS keyframes (see styles.css, `.sm-fx-*`).
 */
import type { CSSProperties, ReactNode } from 'react';
import { HEART } from './faceParts';
import type { EffectKind } from './moods';

const STAR = 'M0 -9 C1 -2.5 2.5 -1 9 0 C2.5 1 1 2.5 0 9 C-1 2.5 -2.5 1 -9 0 C-2.5 -1 -1 -2.5 0 -9 Z';
const DROP = 'M0 -8 C3 -3 5 0 5 3 C5 6 2.8 8 0 8 C-2.8 8 -5 6 -5 3 C-5 0 -3 -3 0 -8 Z';
const FONT = { fontFamily: 'Geist, Inter, ui-rounded, system-ui, sans-serif', fontWeight: 800 };

const At = ({ x, y, children }: { x: number; y: number; children: ReactNode }) => <g transform={`translate(${x} ${y})`}>{children}</g>;
const v = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;

function one(effect: EffectKind, color: string): ReactNode {
  switch (effect) {
    case 'sparkles':
      return [
        { x: 14, y: 62, s: 1.2, c: '#FFD23F', d: 0 },
        { x: 186, y: 50, s: 1.4, c: color, d: 0.25 },
        { x: 200, y: 128, s: 0.9, c: '#FFD23F', d: 0.5 },
        { x: 2, y: 140, s: 0.9, c: color, d: 0.7 },
        { x: 160, y: 18, s: 0.7, c: '#FFD23F', d: 0.4 },
      ].map((st, i) => (
        <At key={i} x={st.x} y={st.y}>
          <path d={STAR} fill={st.c} className="sm-fx sm-fx-spark" style={v({ '--s': st.s, animationDelay: `${st.d}s` })} />
        </At>
      ));
    case 'notes':
      return [
        { x: 176, y: 70, t: '♪', s: 28, d: 0 },
        { x: 14, y: 96, t: '♫', s: 22, d: 0.8 },
        { x: 190, y: 120, t: '♪', s: 18, d: 1.4 },
      ].map((n, i) => (
        <At key={i} x={n.x} y={n.y}>
          <text fontSize={n.s} fill={color} {...FONT} className="sm-fx sm-fx-note" style={{ animationDelay: `${n.d}s` }}>
            {n.t}
          </text>
        </At>
      ));
    case 'question':
      return (
        <At x={180} y={52}>
          <text textAnchor="middle" dominantBaseline="middle" fontSize={40} fill={color} {...FONT} className="sm-fx sm-fx-question">
            ?
          </text>
        </At>
      );
    case 'hearts':
      return [
        { x: 172, y: 88, s: 1.4, d: 0 },
        { x: 28, y: 100, s: 1.1, d: 0.9 },
        { x: 152, y: 46, s: 0.9, d: 1.6 },
      ].map((h, i) => (
        <At key={i} x={h.x} y={h.y}>
          <path d={HEART} fill="#FF4D8D" stroke="#fff" strokeWidth={1.4} className="sm-fx sm-fx-heart" style={v({ '--s': h.s, animationDelay: `${h.d}s` })} />
        </At>
      ));
    case 'burst':
      return [
        { x: 36, y: 46, r: -35 },
        { x: 22, y: 66, r: -62 },
        { x: 164, y: 46, r: 35 },
        { x: 178, y: 66, r: 62 },
        { x: 100, y: 14, r: 0 },
      ].map((l, i) => (
        <At key={i} x={l.x} y={l.y}>
          <g transform={`rotate(${l.r})`}>
            <line x1={0} y1={-7} x2={0} y2={7} stroke={color} strokeWidth={4.5} strokeLinecap="round" className="sm-fx sm-fx-burst" style={{ animationDelay: `${i * 0.04}s` }} />
          </g>
        </At>
      ));
    case 'sweat':
      return (
        <At x={168} y={78}>
          <path d={DROP} fill="#8FD3FF" stroke="#fff" strokeWidth={1.2} className="sm-fx sm-fx-sweat" />
        </At>
      );
    case 'tears':
      return [
        { x: 62, y: 114, dx: -24, d: 0 },
        { x: 138, y: 114, dx: 24, d: 0.15 },
        { x: 62, y: 114, dx: -15, d: 0.38 },
        { x: 138, y: 114, dx: 15, d: 0.52 },
      ].map((t, i) => (
        <At key={i} x={t.x} y={t.y}>
          <path d={DROP} fill="#8FD3FF" className="sm-fx sm-fx-tear" style={v({ '--dx': `${t.dx}px`, animationDelay: `${t.d}s` })} />
        </At>
      ));
    case 'haha':
      return [
        { x: 152, y: 46, r: 14, s: 24, d: 0 },
        { x: 6, y: 64, r: -14, s: 19, d: 0.35 },
      ].map((h, i) => (
        <At key={i} x={h.x} y={h.y}>
          <g transform={`rotate(${h.r})`}>
            <text fontSize={h.s} fill={color} {...FONT} className="sm-fx sm-fx-haha" style={{ animationDelay: `${h.d}s` }}>
              HA
            </text>
          </g>
        </At>
      ));
    case 'zzz':
      return [
        { s: 18, d: 0 },
        { s: 24, d: 1 },
        { s: 30, d: 2 },
      ].map((z, i) => (
        <At key={i} x={150} y={64}>
          <text fontSize={z.s} fill={color} {...FONT} className="sm-fx sm-fx-zzz" style={{ animationDelay: `${z.d}s` }}>
            z
          </text>
        </At>
      ));
  }
}

export function MochiEffects({ effects, color }: { effects: EffectKind[]; color: string }) {
  return (
    <g className="sm-fx-layer">
      {effects.map((e) => (
        <g key={e}>{one(e, color)}</g>
      ))}
    </g>
  );
}
