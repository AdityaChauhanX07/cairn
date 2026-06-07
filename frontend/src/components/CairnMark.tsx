// Stacked river stones — the cairn. Two modes, one component:
//   • Phase-stacking (explore): pass `stacked` 0–4 and stones light up as the
//     agentic loop advances. Unlit stones sit faint until their phase lands.
//   • Decorative (wordmark / hero / chat): omit `stacked` (all stones lit) and
//     optionally pass `animate` for the gentle float and `tone` for the colour.
interface CairnMarkProps {
  stacked?: number; // 0–4 lit; omit to light all stones
  size?: number; // px (width); height scales with the viewBox
  animate?: boolean; // gentle float-stone animation
  tone?: string; // lit-stone colour (defaults to the ember accent)
  className?: string;
}

// Four stones, bottom-largest to top-smallest, on a 100×100 grid so the stack
// reads as hand-balanced rather than a tidy column.
const STONES = [
  { cx: 50, cy: 80, rx: 26, ry: 11, o: 1 },
  { cx: 50, cy: 60, rx: 21, ry: 9.5, o: 0.92 },
  { cx: 50, cy: 43, rx: 15, ry: 8, o: 0.82 },
  { cx: 50, cy: 29, rx: 9.5, ry: 6, o: 0.7 },
] as const;

export default function CairnMark({
  stacked,
  size = 28,
  animate = false,
  tone = 'var(--ember)',
  className,
}: CairnMarkProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      style={{ display: 'block', overflow: 'visible' }}
      role="img"
      aria-label={
        stacked === undefined ? 'cairn' : `cairn — ${stacked} of 4 stones stacked`
      }
    >
      {STONES.map((s, i) => {
        const lit = stacked === undefined || stacked >= i + 1;
        return (
          <ellipse
            key={i}
            cx={s.cx}
            cy={s.cy}
            rx={s.rx}
            ry={s.ry}
            fill={lit ? tone : 'var(--text-4)'}
            opacity={lit ? s.o : 0.2}
            style={{
              transition: 'fill .4s ease, opacity .4s ease',
              ...(animate && lit
                ? { animation: `float-stone 3.4s ease-in-out ${i * 0.22}s infinite` }
                : null),
            }}
          />
        );
      })}
    </svg>
  );
}
