/**
 * HelixBackground: a fixed, non-interactive DNA double-helix rendered as SVG
 * behind all app content. Two sinusoidal strands cross over each other with
 * connecting base-pair rungs, tinted with the spectral neon palette. The whole
 * pattern is a horizontally tiling motif that drifts slowly (disabled when the
 * user prefers reduced motion, handled in CSS).
 *
 * It is purely decorative: aria-hidden, no pointer events, and it reads its
 * colours from the theme so it works in both dark and light modes.
 */

const WIDTH = 1600;
const HEIGHT = 420;
const MID = HEIGHT / 2;
const AMPLITUDE = 150;
const WAVELENGTH = 520; // horizontal period of one full turn
const RUNG_SPACING = 26;

function strandPath(phase: number): string {
  const points: string[] = [];
  for (let x = 0; x <= WIDTH; x += 8) {
    const y = MID + AMPLITUDE * Math.sin((x / WAVELENGTH) * 2 * Math.PI + phase);
    points.push(`${x === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return points.join(' ');
}

interface Rung {
  x: number;
  y1: number;
  y2: number;
  depth: number; // 0 (back) .. 1 (front), drives opacity
}

function buildRungs(): Rung[] {
  const rungs: Rung[] = [];
  for (let x = 0; x <= WIDTH; x += RUNG_SPACING) {
    const a = (x / WAVELENGTH) * 2 * Math.PI;
    const y1 = MID + AMPLITUDE * Math.sin(a);
    const y2 = MID + AMPLITUDE * Math.sin(a + Math.PI);
    // The strands cross where the sine curves meet; rungs are widest (and most
    // "in front") at the mid-crossing, so fade them by how far apart they are.
    const depth = Math.abs(Math.sin(a));
    rungs.push({ x, y1, y2, depth });
  }
  return rungs;
}

const RUNGS = buildRungs();

export function HelixBackground() {
  return (
    <div className="helix-bg" aria-hidden="true">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid slice"
        role="presentation"
      >
        <defs>
          <linearGradient id="helix-spectrum" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: 'var(--accent-quartary)' }} />
            <stop offset="30%" style={{ stopColor: 'var(--accent-primary)' }} />
            <stop offset="55%" style={{ stopColor: 'var(--accent-secondary)' }} />
            <stop offset="78%" style={{ stopColor: 'var(--accent-amber)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--accent-tertiary)' }} />
          </linearGradient>
        </defs>

        <g className="helix-strand">
          {/* Base-pair rungs, drawn first so strands sit on top */}
          {RUNGS.map((r, i) => (
            <line
              key={`r-${i}`}
              x1={r.x}
              y1={r.y1}
              x2={r.x}
              y2={r.y2}
              stroke="url(#helix-spectrum)"
              strokeWidth={1.4}
              strokeLinecap="round"
              opacity={0.12 + r.depth * 0.4}
            />
          ))}

          {/* Two strands, half a wavelength out of phase */}
          <path
            d={strandPath(0)}
            fill="none"
            stroke="url(#helix-spectrum)"
            strokeWidth={2.4}
            strokeLinecap="round"
          />
          <path
            d={strandPath(Math.PI)}
            fill="none"
            stroke="url(#helix-spectrum)"
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        </g>
      </svg>
    </div>
  );
}
