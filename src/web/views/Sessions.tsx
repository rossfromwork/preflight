import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchSessionsList, fetchSessionDetail, qk } from '../api/client';

interface SessionRow {
  readonly sessionId: string;
  readonly startTime?: string;
  readonly toolCallCount?: number;
  readonly estimatedCostUsd?: number | null;
  readonly outcome?: string | null;
}

interface SessionDetail {
  readonly sessionId: string;
  readonly toolCalls: ReadonlyArray<{
    readonly toolName: string;
    readonly durationMs: number;
    readonly startTime: number;
    readonly endTime: number;
  }>;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function Sessions(): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery<SessionRow[]>({
    queryKey: qk.sessionsList(50),
    queryFn: () => fetchSessionsList(50) as Promise<SessionRow[]>,
  });

  const detail = useQuery<SessionDetail>({
    queryKey: selectedId ? qk.sessionDetail(selectedId) : ['session', 'none'],
    queryFn: () => fetchSessionDetail(selectedId!) as Promise<SessionDetail>,
    enabled: selectedId !== null,
  });

  const rows = list.data ?? [];

  return (
    <section className="grid grid-cols-[260px_1fr] gap-3 h-full">
      <aside className="bg-bg-panel border border-bg-line rounded overflow-hidden flex flex-col">
        <header className="p-2 border-b border-bg-line">
          <h2 className="text-xs uppercase tracking-wider text-ink-muted">Sessions</h2>
        </header>
        <div className="overflow-auto">
          {list.isLoading && <div className="p-3 text-ink-muted text-xs">Loading…</div>}
          {!list.isLoading && rows.length === 0 && (
            <div className="p-3 text-ink-muted text-xs">
              No sessions yet — start coding with Claude.
            </div>
          )}
          {rows.map((r) => (
            <button
              key={r.sessionId}
              type="button"
              onClick={() => setSelectedId(r.sessionId)}
              className={
                'block w-full text-left p-2 border-b border-bg-line text-xs hover:bg-bg-line ' +
                (selectedId === r.sessionId ? 'bg-bg-line' : '')
              }
            >
              <div className="flex justify-between">
                <span className="font-mono text-ink-base">{r.sessionId.slice(0, 8)}</span>
                <span className="text-ink-muted">{r.startTime ? fmtTime(r.startTime) : '—'}</span>
              </div>
              <div className="flex justify-between mt-1 text-ink-subtle text-[11px]">
                <span>{r.toolCallCount ?? 0} calls</span>
                <span>
                  {r.estimatedCostUsd != null ? `$${r.estimatedCostUsd.toFixed(2)}` : '—'}
                </span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="bg-bg-panel border border-bg-line rounded p-3 overflow-auto">
        {!selectedId && <div className="text-ink-muted text-xs">Pick a session on the left.</div>}
        {selectedId && detail.isLoading && (
          <div className="text-ink-muted text-xs">Loading detail…</div>
        )}
        {selectedId && detail.data && <SessionTimeline data={detail.data} />}
      </div>
    </section>
  );
}

function SessionTimeline({ data }: { data: SessionDetail }): JSX.Element {
  const calls = data.toolCalls;
  if (calls.length === 0) {
    return <div className="text-ink-muted text-xs">No tool calls in this session.</div>;
  }
  const first = calls[0]?.startTime ?? 0;
  const last = calls[calls.length - 1]?.endTime ?? first + 1;
  const span = Math.max(1, last - first);

  return (
    <div>
      <h2 className="text-xs uppercase tracking-wider text-ink-muted mb-2">
        {data.sessionId} · {calls.length} calls · {Math.round(span / 1000)}s
      </h2>
      <div className="flex flex-col gap-0.5">
        {calls.map((c) => {
          const left = ((c.startTime - first) / span) * 100;
          const width = Math.max(0.5, ((c.endTime - c.startTime) / span) * 100);
          return (
            <div
              key={`${c.startTime}-${c.toolName}`}
              className="flex items-center gap-2 text-[11px]"
            >
              <span className="w-20 text-ink-subtle truncate">{c.toolName}</span>
              <div className="flex-1 h-3 bg-bg-base relative rounded">
                <div
                  className="absolute top-0 h-3 bg-accent-cyan/70 rounded"
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${c.durationMs}ms`}
                />
              </div>
              <span className="w-14 text-right text-ink-muted tabular-nums">{c.durationMs}ms</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
