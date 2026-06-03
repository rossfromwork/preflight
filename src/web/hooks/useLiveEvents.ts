import { useEffect } from 'react';
import { useLiveStore } from '../store/liveStore';

interface SessionCurrentResponse {
  readonly toolCallCount?: number;
  readonly toolCallTimeline?: ReadonlyArray<{
    readonly timestamp: number;
    readonly toolName: string;
    readonly durationMs: number | null;
    readonly success: boolean;
  }>;
}

function hydrateFromApi(): void {
  const store = useLiveStore.getState();

  fetch('/api/session/current')
    .then((r) => (r.ok ? (r.json() as Promise<SessionCurrentResponse>) : null))
    .then((data) => {
      if (!data?.toolCallTimeline) return;
      for (const tc of data.toolCallTimeline) {
        store.pushToolCall({
          id: `${tc.timestamp}-${tc.toolName}`,
          tool: tc.toolName,
          durationMs: tc.durationMs ?? 0,
          costUsd: 0,
          ts: tc.timestamp,
        });
      }
    })
    .catch(() => {});

  // Cost hydration intentionally skipped — the /api/cost endpoint returns
  // session-scoped values that don't reflect the daily aggregate. Setting them
  // in the store would race with SSE (which emits daily-aware totals) and cause
  // the forecast to appear less than the daily spend. The Today view's React
  // Query fallback (persistedTodaySpend + session cost) handles the pre-SSE
  // window correctly.

  fetch('/api/anti-patterns')
    .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
    .then((data) => {
      if (!Array.isArray(data)) return;
      for (const ap of data) {
        if (ap && typeof ap === 'object' && 'type' in ap) {
          store.pushAntiPattern(ap as { type: string; target: string; count: number });
        }
      }
    })
    .catch(() => {});
}

export function useLiveEvents(url: string = '/sse'): void {
  useEffect(() => {
    hydrateFromApi();

    const es = new EventSource(url);

    es.onopen = (): void => useLiveStore.getState().setConnected(true);
    es.onerror = (): void => useLiveStore.getState().setConnected(false);

    // F-019: read live state inside each callback rather than capturing
    // a one-time snapshot at effect-run time. Zustand action references
    // are stable today, but a future memoization or selector wrapper
    // would silently break the captured-snapshot pattern.
    const onToolCall = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().pushToolCall(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onCost = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().setCost(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onAnti = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().pushAntiPattern(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onAlert = (e: MessageEvent): void => {
      try {
        useLiveStore.getState().addOrUpdateAlert(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };

    es.addEventListener('tool-call', onToolCall as EventListener);
    es.addEventListener('cost-update', onCost as EventListener);
    es.addEventListener('anti-pattern', onAnti as EventListener);
    es.addEventListener('alert', onAlert as EventListener);

    return (): void => {
      es.removeEventListener('tool-call', onToolCall as EventListener);
      es.removeEventListener('cost-update', onCost as EventListener);
      es.removeEventListener('anti-pattern', onAnti as EventListener);
      es.removeEventListener('alert', onAlert as EventListener);
      es.close();
    };
  }, [url]);
}
