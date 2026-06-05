import { useState } from 'react';

interface GanttTimelineEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly filePath?: string;
  readonly command?: string;
}

interface GanttSegment {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly severity: 'warning' | 'critical';
}

interface GanttTimelineProps {
  readonly entries: GanttTimelineEntry[];
  readonly segments: GanttSegment[];
}

function getBarColor(toolName: string): string {
  if (toolName === 'Read') return 'bg-accent-blue';
  if (toolName === 'Edit' || toolName === 'Write') return 'bg-accent-green';
  if (toolName === 'Bash') return 'bg-accent-purple';
  if (toolName === 'Agent') return 'bg-accent-teal';
  return 'bg-ink-subtle';
}

const SEGMENT_LABELS: Record<string, string> = {
  thrashing: 'Edit/Test Thrashing',
  stuck_loop: 'Stuck Loop',
  blind_editing: 'Blind Editing',
  re_reading: 'Repeated Reads',
};

function fmtTickLabel(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function GanttTimeline({ entries, segments }: GanttTimelineProps): JSX.Element {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (entries.length === 0) {
    return <div className="text-ink-muted text-xs">No tool calls recorded.</div>;
  }

  const firstTs = entries[0]!.timestamp;
  const lastEntry = entries[entries.length - 1]!;
  const lastEnd = lastEntry.timestamp + (lastEntry.durationMs ?? 50);
  const totalDuration = Math.max(lastEnd - firstTs, 1);

  // Compute tick interval — target ~8 visible labels max
  const MAX_TICKS = 8;
  const candidates = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];
  let tickIntervalMs = candidates[candidates.length - 1]!;
  for (const c of candidates) {
    if (totalDuration / c <= MAX_TICKS) {
      tickIntervalMs = c;
      break;
    }
  }

  const ticks: number[] = [];
  for (let t = tickIntervalMs; t < totalDuration; t += tickIntervalMs) {
    ticks.push(t);
  }

  // Build per-row segment lookup for left-border indicators
  const segmentAt: (GanttSegment | null)[] = new Array(entries.length).fill(null);
  for (const seg of segments) {
    for (let i = seg.startIndex; i <= Math.min(seg.endIndex, entries.length - 1); i++) {
      if (segmentAt[i] === null || seg.severity === 'critical') {
        segmentAt[i] = seg;
      }
    }
  }

  const maxStaggerMs = 800;
  const perBarDelay = Math.min(30, maxStaggerMs / Math.max(entries.length, 1));

  return (
    <div className="p-2 overflow-x-hidden">
      {/* Time axis */}
      <div className="flex">
        <div className="w-20 shrink-0" />
        <div className="relative flex-1 h-5 border-b border-bg-line overflow-x-auto">
          {ticks.map((t) => {
            const leftPct = (t / totalDuration) * 100;
            return (
              <span
                key={t}
                className="absolute top-0 text-[9px] text-ink-muted tabular-nums -translate-x-1/2"
                style={{ left: `${leftPct}%` }}
              >
                {fmtTickLabel(t)}
              </span>
            );
          })}
        </div>
      </div>

      {/* Rows */}
      <div className="mt-1">
        {entries.map((entry, idx) => {
          const offsetMs = entry.timestamp - firstTs;
          const duration = entry.durationMs ?? 50;
          const leftPct = (offsetMs / totalDuration) * 100;
          const widthPct = (duration / totalDuration) * 100;
          const seg = segmentAt[idx];
          const borderClass = seg
            ? seg.severity === 'critical'
              ? 'border-l-2 border-l-accent-red'
              : 'border-l-2 border-l-accent-amber'
            : 'border-l-2 border-l-transparent';

          return (
            <div
              key={`${idx}-${entry.timestamp}`}
              className={`flex items-center h-7 ${borderClass}`}
            >
              <div className="w-20 shrink-0 truncate text-[11px] text-ink-subtle pr-2 text-right">
                {entry.toolName}
              </div>
              <div className="relative flex-1 h-full flex items-center">
                <div
                  className={`gantt-bar absolute h-5 rounded-sm opacity-80 ${getBarColor(entry.toolName)} ${!entry.success ? 'ring-1 ring-accent-red/60' : ''}`}
                  style={{
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    minWidth: '4px',
                    animationDelay: `${Math.round(idx * perBarDelay)}ms`,
                  }}
                  onMouseEnter={() => setHoveredIndex(idx)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
                {/* Tooltip */}
                {hoveredIndex === idx && (
                  <div
                    className={`absolute z-50 px-2 py-1.5 rounded-lg bg-bg-elevated border border-bg-line text-[11px] text-ink-base shadow-lg whitespace-nowrap pointer-events-none ${idx > entries.length - 4 ? 'bottom-full mb-1' : 'top-full mt-1'}`}
                    style={
                      leftPct > 60
                        ? { right: `${100 - leftPct - widthPct}%` }
                        : { left: `${leftPct}%` }
                    }
                  >
                    <div className="font-medium">{entry.toolName}</div>
                    {(entry.filePath ?? entry.command) && (
                      <div className="text-ink-subtle truncate max-w-[200px]">
                        {entry.filePath ?? entry.command}
                      </div>
                    )}
                    <div className="text-ink-muted">
                      {entry.durationMs != null ? `${entry.durationMs}ms` : 'unknown'} &middot;{' '}
                      {entry.success ? 'success' : 'failed'}
                    </div>
                    {seg && (
                      <div
                        className={`mt-0.5 font-medium ${seg.severity === 'critical' ? 'text-accent-red' : 'text-accent-amber'}`}
                      >
                        {SEGMENT_LABELS[seg.type] ?? seg.type}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
