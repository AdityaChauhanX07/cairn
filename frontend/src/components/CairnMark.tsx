interface CairnMarkProps {
  stacked: number; // 0–4: how many stones are stacked (lit up)
  size?: number; // default 32
  className?: string;
}

// Four river stones, bottom-largest to top-smallest. Each is a slightly-rotated
// ellipse so the stack reads as natural, hand-balanced stones rather than a
// tidy column. A stone "lights up" (amber, fuller opacity) once its phase lands.
const STONES = [
  { cx: 16, cy: 35, rx: 12, ry: 5, rotate: -2, litOpacity: 0.9 }, // Orient
  { cx: 16, cy: 26, rx: 10, ry: 4.5, rotate: 3, litOpacity: 0.85 }, // Investigate
  { cx: 16, cy: 18, rx: 8, ry: 4, rotate: -4, litOpacity: 0.8 }, // Reason
  { cx: 16, cy: 11, rx: 5, ry: 3.5, rotate: 2, litOpacity: 0.75 }, // Synthesize (capstone)
] as const;

export default function CairnMark({ stacked, size = 32, className }: CairnMarkProps) {
  return (
    <svg
      viewBox="0 0 32 40"
      width={size}
      height={size * 1.25}
      className={className}
      role="img"
      aria-label={`cairn — ${stacked} of 4 stones stacked`}
    >
      {STONES.map((s, i) => {
        const lit = stacked >= i + 1;
        return (
          <ellipse
            key={i}
            cx={s.cx}
            cy={s.cy}
            rx={s.rx}
            ry={s.ry}
            fill={lit ? 'var(--accent-amber)' : 'var(--text-muted)'}
            opacity={lit ? s.litOpacity : 0.2}
            transform={`rotate(${s.rotate}, ${s.cx}, ${s.cy})`}
            style={{ transition: 'fill 400ms ease, opacity 400ms ease' }}
          />
        );
      })}
    </svg>
  );
}
