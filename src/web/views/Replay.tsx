import { useQuery } from '@tanstack/react-query';
import { useParams } from 'wouter';
import { fetchSessionReplay, fetchSessionCurrent, qk } from '../api/client';
import { shortToolName } from '../lib/format';

interface TimelineEntry {
  readonly timestamp: number;
  readonly toolName: string;
  readonly durationMs: number | null;
  readonly success: boolean;
  readonly filePath?: string;
  readonly command?: string;
  readonly isTestCommand?: boolean;
  readonly isBuildCommand?: boolean;
  readonly isLintCommand?: boolean;
  readonly errorType?: string;
}

interface Segment {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly iterations: number;
  readonly target: string;
  readonly severity: 'warning' | 'critical';
}

interface ReplayData {
  readonly sessionId: string;
  readonly timeline: TimelineEntry[];
  readonly segments: Segment[];
  readonly worstSegment: Segment | null;
}

const SEGMENT_LABELS: Record<string, string> = {
  thrashing: 'Edit/Test Thrashing',
  stuck_loop: 'Stuck Loop',
  blind_editing: 'Blind Editing',
  re_reading: 'Repeated Reads',
};

const TOOL_ICONS: Record<string, string> = {
  Read: '📄',
  Edit: '✏️',
  Write: '📝',
  Bash: '⚡',
  Agent: '🤖',
  AskUserQuestion: '💬',
  TaskCreate: '📋',
  TaskUpdate: '✅',
};

const LIVE_REFETCH_MS = 3_000;

export function Replay(): JSX.Element {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId ?? '';

  const currentSession = useQuery<{ sessionId: string; liveSessions?: string[] }>({
    queryKey: qk.sessionCurrent,
    queryFn: () => fetchSessionCurrent() as Promise<{ sessionId: string; liveSessions?: string[] }>,
  });

  const isLive =
    currentSession.data?.liveSessions?.includes(sessionId) ??
    currentSession.data?.sessionId === sessionId;

  const { data, isLoading, error } = useQuery<ReplayData>({
    queryKey: qk.sessionReplay(sessionId),
    queryFn: () => fetchSessionReplay(sessionId) as Promise<ReplayData>,
    enabled: sessionId.length > 0,
    retry: false,
    refetchInterval: isLive ? LIVE_REFETCH_MS : false,
  });

  if (!sessionId) {
    return <div className="text-ink-muted text-xs">No session ID provided.</div>;
  }

  if (isLoading) {
    return <div className="text-ink-muted text-xs p-5">Loading replay…</div>;
  }

  if (error) {
    return (
      <section className="p-5">
        <h1 className="text-xl font-semibold mb-2">Session Replay</h1>
        <div className="bg-bg-panel border border-bg-line rounded p-4 text-ink-muted text-xs">
          Replay not available for this session. This session may predate the replay feature or have
          no recorded tool calls.
        </div>
      </section>
    );
  }

  if (!data) return <></>;

  return (
    <section>
      <header className="flex items-baseline justify-between mb-4">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          Session Replay
          {isLive && (
            <span className="inline-flex items-center gap-1 bg-accent-cyan/20 text-accent-cyan text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan animate-pulse" />
              live
            </span>
          )}
        </h1>
        <div className="text-right">
          <div className="text-xs text-ink-muted font-mono">{data.sessionId.slice(0, 12)}</div>
          {data.timeline.length > 0 && (
            <div className="text-[11px] text-ink-subtle">
              {new Date(data.timeline[0]!.timestamp).toLocaleString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </div>
          )}
        </div>
      </header>

      <SegmentSummary segments={data.segments} worstSegment={data.worstSegment} />

      <div className="bg-bg-panel border border-bg-line rounded p-3 mt-3">
        <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-2">
          timeline · {data.timeline.length} calls
        </div>
        <Timeline entries={data.timeline} segments={data.segments} />
      </div>
    </section>
  );
}

function SegmentSummary({
  segments,
  worstSegment,
}: {
  segments: Segment[];
  worstSegment: Segment | null;
}): JSX.Element {
  if (segments.length === 0) {
    return (
      <div className="bg-bg-panel border border-accent-green/40 rounded p-3 text-xs text-ink-subtle">
        No anti-patterns detected — clean session.
      </div>
    );
  }

  return (
    <div className="bg-bg-panel border border-accent-amber/40 rounded p-3">
      <div className="text-xs font-semibold text-accent-amber mb-2">
        {segments.length} anti-pattern{segments.length > 1 ? 's' : ''} detected
      </div>
      {worstSegment && (
        <div className="text-xs text-ink-base mb-2">
          Worst:{' '}
          <span className="font-semibold">
            {SEGMENT_LABELS[worstSegment.type] ?? worstSegment.type}
          </span>
          {' — '}
          {worstSegment.iterations}× on{' '}
          <code className="bg-bg-line px-1 rounded text-[11px]">{worstSegment.target}</code>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {segments.map((seg, i) => (
          <span
            key={`${seg.type}-${seg.startIndex}-${i}`}
            className={
              'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] ' +
              (seg.severity === 'critical'
                ? 'bg-accent-red/10 text-accent-red border border-accent-red/30'
                : 'bg-accent-amber/10 text-accent-amber border border-accent-amber/30')
            }
          >
            {SEGMENT_LABELS[seg.type] ?? seg.type}
            <span className="opacity-70">({seg.iterations}×)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function Timeline({
  entries,
  segments,
}: {
  entries: TimelineEntry[];
  segments: Segment[];
}): JSX.Element {
  if (entries.length === 0) {
    return <div className="text-ink-muted text-xs">No tool calls recorded.</div>;
  }

  const segmentAt = buildSegmentLookup(entries.length, segments);
  const firstTs = entries[0]!.timestamp;

  return (
    <div className="flex flex-col">
      {entries.map((entry, idx) => {
        const seg = segmentAt[idx];
        const borderColor = seg
          ? seg.severity === 'critical'
            ? 'border-l-accent-red'
            : 'border-l-accent-amber'
          : 'border-l-transparent';
        const bgColor = seg
          ? seg.severity === 'critical'
            ? 'bg-accent-red/5'
            : 'bg-accent-amber/5'
          : '';
        const elapsed = entry.timestamp - firstTs;

        return (
          <div
            key={`${idx}-${entry.timestamp}`}
            className={`flex items-center gap-2 px-2 py-1 border-l-2 ${borderColor} ${bgColor} text-xs`}
          >
            <span
              className="w-12 text-ink-muted tabular-nums text-[11px] shrink-0"
              title={fmtClock(entry.timestamp)}
            >
              +{fmtElapsed(elapsed)}
            </span>
            <span className="w-5 text-center" aria-hidden="true">
              {TOOL_ICONS[entry.toolName] ?? '·'}
            </span>
            <span className="w-28 truncate font-medium text-ink-base" title={entry.toolName}>
              {shortToolName(entry.toolName)}
            </span>
            <span
              className="flex-1 truncate text-ink-subtle text-[11px]"
              title={entry.filePath ?? entry.command ?? ''}
            >
              {entry.filePath ?? entry.command ?? ''}
            </span>
            <span className="w-16 text-right tabular-nums text-ink-muted">
              {entry.durationMs != null ? `${entry.durationMs}ms` : '—'}
            </span>
            <StatusBadge success={entry.success} errorType={entry.errorType} />
            {seg && idx === seg.startIndex && (
              <span
                className={
                  'ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium ' +
                  (seg.severity === 'critical'
                    ? 'bg-accent-red/20 text-accent-red'
                    : 'bg-accent-amber/20 text-accent-amber')
                }
              >
                {SEGMENT_LABELS[seg.type] ?? seg.type}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatusBadge({
  success,
  errorType,
}: {
  success: boolean;
  errorType?: string;
}): JSX.Element {
  if (success) {
    return <span className="w-4 text-center text-accent-green text-[11px]">✓</span>;
  }
  return (
    <span className="w-4 text-center text-accent-red text-[11px]" title={errorType ?? 'failed'}>
      ✗
    </span>
  );
}

function buildSegmentLookup(length: number, segments: Segment[]): (Segment | null)[] {
  const lookup: (Segment | null)[] = new Array(length).fill(null);
  for (const seg of segments) {
    for (let i = seg.startIndex; i <= Math.min(seg.endIndex, length - 1); i++) {
      if (lookup[i] === null || seg.severity === 'critical') {
        lookup[i] = seg;
      }
    }
  }
  return lookup;
}
