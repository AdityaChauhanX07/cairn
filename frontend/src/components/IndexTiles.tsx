interface IndexTile {
  name: string;
  eventCount: number;
  category: 'security' | 'application' | 'infrastructure' | 'deployment' | 'other';
  sourcetype?: string;
}

interface IndexTilesProps {
  indexes: IndexTile[];
}

const CATEGORY_COLORS: Record<IndexTile['category'], { bg: string; border: string; text: string }> = {
  security: { bg: 'rgba(248, 113, 113, 0.12)', border: 'rgba(248, 113, 113, 0.3)', text: '#f87171' },
  application: { bg: 'rgba(96, 165, 250, 0.12)', border: 'rgba(96, 165, 250, 0.3)', text: '#60a5fa' },
  infrastructure: { bg: 'rgba(52, 211, 153, 0.12)', border: 'rgba(52, 211, 153, 0.3)', text: '#34d399' },
  deployment: { bg: 'rgba(251, 191, 36, 0.12)', border: 'rgba(251, 191, 36, 0.3)', text: '#fbbf24' },
  other: { bg: 'rgba(160, 160, 176, 0.08)', border: 'rgba(160, 160, 176, 0.2)', text: '#a0a0b0' },
};

const MIN_W = 100;
const MIN_H = 80;
const MAX_W = 200;
const MAX_H = 120;

// Compact, human counts: 12400 -> 12.4k, 2_300_000 -> 2.3M.
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export default function IndexTiles({ indexes }: IndexTilesProps) {
  if (indexes.length === 0) return null;

  const maxCount = Math.max(1, ...indexes.map((i) => i.eventCount));

  return (
    <div className="index-tiles">
      {indexes.map((idx) => {
        const c = CATEGORY_COLORS[idx.category];
        // Area ∝ event volume: scale both dimensions linearly between min/max.
        const ratio = Math.min(1, idx.eventCount / maxCount);
        const width = MIN_W + (MAX_W - MIN_W) * ratio;
        const height = MIN_H + (MAX_H - MIN_H) * ratio;
        return (
          <div
            key={idx.name}
            className="index-tile"
            style={{
              width,
              height,
              background: c.bg,
              borderTopColor: c.border,
            }}
            title={`${idx.name} · ${idx.eventCount.toLocaleString()} events`}
          >
            <div className="index-tile-name">{idx.name}</div>
            <div className="index-tile-count" style={{ color: c.text }}>
              {formatCount(idx.eventCount)}
            </div>
            <div className="index-tile-meta">{idx.category}</div>
            {idx.sourcetype && <div className="index-tile-meta">{idx.sourcetype}</div>}
          </div>
        );
      })}
    </div>
  );
}

// Bucket an index into a category by its name. Falls back to "other".
function categorize(name: string): IndexTile['category'] {
  if (['auth_events', 'firewall_logs'].includes(name)) return 'security';
  if (['web_logs', 'app_metrics'].includes(name)) return 'application';
  if (['deploy_logs'].includes(name)) return 'deployment';
  return 'other';
}

export { categorize };
export type { IndexTile };
