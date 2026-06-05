import type { CSSProperties } from 'react';

interface SkeletonProps {
  width?: string; // CSS width, default '100%'
  height?: string; // CSS height, default '16px'
  radius?: string; // border-radius, default '4px'
  className?: string;
  style?: CSSProperties; // extra overrides (e.g. margins), merged last
}

export function Skeleton({
  width = '100%',
  height = '16px',
  radius = '4px',
  className,
  style,
}: SkeletonProps) {
  return (
    <div
      className={`skeleton ${className || ''}`}
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

// Pre-built patterns ────────────────────────────────────────────────────────

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-text">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height="12px"
          width={i === lines - 1 ? '60%' : '100%'} // last line shorter
        />
      ))}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <Skeleton height="20px" width="40%" />
      <SkeletonText lines={3} />
    </div>
  );
}

export function SkeletonGuide() {
  return (
    <div className="skeleton-guide">
      <Skeleton height="28px" width="50%" style={{ marginBottom: '24px' }} />
      {Array.from({ length: 5 }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
