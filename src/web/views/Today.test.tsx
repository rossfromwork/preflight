import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Today, computeModelHealth } from './Today';
import { useLiveStore } from '../store/liveStore';

function renderToday(qc?: QueryClient) {
  const client =
    qc ??
    new QueryClient({
      defaultOptions: { queries: { retry: 0 } },
    });
  return render(
    <QueryClientProvider client={client}>
      <Today />
    </QueryClientProvider>,
  );
}

function resetStore(): void {
  useLiveStore.setState({
    connected: true,
    recentToolCalls: [
      { id: 'a', tool: 'Read', durationMs: 120, costUsd: 0.001, ts: 1 },
      { id: 'b', tool: 'Edit', durationMs: 85, costUsd: 0.002, ts: 2 },
    ],
    cost: { sessionTotalUsd: 3.42, todayTotalUsd: 12.17, forecastEodUsd: 18.4 },
    antiPatterns: [{ type: 'thrashing', target: 'auth.ts', count: 4 }],
    firingAlerts: new Map(),
    dismissedAlerts: new Set(),
  });
}

describe('Today view', () => {
  beforeEach(() => {
    resetStore();
    // Default: stub fetch with an empty alerts array so the panel doesn't
    // throw a network error during the basic-render assertions below.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the four KPI labels', () => {
    renderToday();
    expect(screen.getByText('spend today')).toBeInTheDocument();
    expect(screen.getByText('tool calls')).toBeInTheDocument();
    expect(screen.getByText('efficiency')).toBeInTheDocument();
    expect(screen.getByText('flags')).toBeInTheDocument();
  });

  it('renders today total cost in the spend KPI', () => {
    renderToday();
    expect(screen.getByText('$12.17')).toBeInTheDocument();
  });

  it('renders the efficiency score KPI', () => {
    renderToday();
    expect(screen.getByText('efficiency')).toBeInTheDocument();
  });

  it('renders an anti-pattern banner when patterns exist', () => {
    renderToday();
    expect(screen.getByText(/thrashing/i)).toBeInTheDocument();
    expect(screen.getByText(/auth\.ts/)).toBeInTheDocument();
  });

  it('hides the banner when no anti-patterns', () => {
    useLiveStore.setState({ antiPatterns: [] });
    renderToday();
    expect(screen.queryByText(/thrashing/i)).toBeNull();
  });

  it('renders the forecast-EOD card with the projected end-of-day spend', () => {
    renderToday();
    expect(screen.getByText(/forecast/i)).toBeInTheDocument();
    expect(screen.getByText('$18.40')).toBeInTheDocument();
  });

  it('shows the delta from current spend to forecast', () => {
    // todayTotal=12.17, forecastEodUsd=18.4 → delta=6.23
    renderToday();
    expect(screen.getByText(/\+\$6\.23/)).toBeInTheDocument();
  });

  // After 45b17db the forecast is clamped to at least todayTotal (you can't
  // un-spend money), so a raw forecast below current spend renders the
  // clamped value with an "on pace" annotation (delta ≤ 0 branch in
  // ForecastEodCard) — never a negative delta.
  it('clamps forecast to todayTotal when raw forecast is lower (F-017)', () => {
    useLiveStore.setState({
      cost: { sessionTotalUsd: 3.42, todayTotalUsd: 10, forecastEodUsd: 8 },
    });
    renderToday();
    // Clamped forecast = todayTotal = 10, delta is zero → "on pace"
    expect(screen.getByText(/on pace/)).toBeInTheDocument();
    // Legacy bug substrings must never appear
    expect(screen.queryByText(/\+\$-2\.00/)).toBeNull();
    expect(screen.queryByText(/\+\$0\.00/)).toBeNull();
    // Raw (uncramped) forecast value must not surface either
    expect(screen.queryByText(/\$8\.00/)).toBeNull();
  });

  it('still renders a positive delta with "+$" (F-017 regression guard)', () => {
    useLiveStore.setState({
      cost: { sessionTotalUsd: 3.42, todayTotalUsd: 10, forecastEodUsd: 12 },
    });
    renderToday();
    expect(screen.getByText(/\+\$2\.00/)).toBeInTheDocument();
  });

  it('shows an "insufficient data" message when forecast is null', () => {
    useLiveStore.setState({
      cost: { sessionTotalUsd: 3.42, todayTotalUsd: 12.17, forecastEodUsd: null },
    });
    renderToday();
    expect(screen.getByText(/insufficient data/i)).toBeInTheDocument();
    // Should not display a dollar value for the forecast.
    expect(screen.queryByText(/\$18\.40/)).toBeNull();
  });

  it('shows insufficient-data when cost has not loaded', () => {
    useLiveStore.setState({ cost: null });
    renderToday();
    expect(screen.getByText(/insufficient data/i)).toBeInTheDocument();
  });
});

describe('Today header timestamp', () => {
  beforeEach(() => {
    useLiveStore.setState({
      connected: true,
      recentToolCalls: [],
      cost: { sessionTotalUsd: 0, todayTotalUsd: 0, forecastEodUsd: null },
      antiPatterns: [],
      firingAlerts: new Map(),
      dismissedAlerts: new Set(),
    });
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;
    vi.useFakeTimers();
    // 2026-05-29 14:00 local-ish — exact zone doesn't matter; the
    // assertion below only checks the value is stable across
    // re-renders, not what the formatted string contains.
    vi.setSystemTime(new Date('2026-05-29T18:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('memoizes the header timestamp across re-renders', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 0 } } });
    const { rerender, container } = render(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );

    const headerSpan = container.querySelector('header span')!;
    const before = headerSpan.textContent;
    expect(before).toBeTruthy();

    // Advance the system clock far enough that an unmemoized
    // timestamp would format to a different minute, then trigger
    // a re-render via a store update.
    vi.setSystemTime(new Date('2026-05-29T19:30:00Z'));
    act(() => {
      useLiveStore.setState({ antiPatterns: [{ type: 'flag', target: 'x', count: 1 }] });
    });
    rerender(
      <QueryClientProvider client={qc}>
        <Today />
      </QueryClientProvider>,
    );

    const after = container.querySelector('header span')!.textContent;
    expect(after).toBe(before);
  });
});

describe('Today view — Recent alerts panel', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /api/alerts/recent and renders an empty state when the log is empty', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    renderToday();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/api/alerts/recent'))).toBe(true);

    expect(await screen.findByText(/No alerts in recent history/i)).toBeInTheDocument();
  });

  it('renders rows from a non-empty response', async () => {
    const now = Date.now();
    const fakeAlerts = [
      {
        id: 'rule-cost',
        state: 'firing',
        severity: 'warning',
        title: 'Cost spike',
        description: 'desc',
        value: 12.5,
        threshold: 10,
        firedAt: now - 5 * 60_000,
      },
      {
        id: 'rule-stuck',
        state: 'cleared',
        severity: 'critical',
        title: 'Stuck loop',
        description: 'desc',
        value: 2,
        threshold: 3,
        firedAt: now - 60 * 60_000,
      },
    ];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(fakeAlerts), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    renderToday();

    expect(await screen.findByText('Cost spike')).toBeInTheDocument();
    expect(screen.getByText('Stuck loop')).toBeInTheDocument();
    // value/threshold formatted column.
    expect(screen.getByText(/12\.50 \/ 10/)).toBeInTheDocument();
    // state column shows firing vs cleared.
    expect(screen.getByText('firing')).toBeInTheDocument();
    expect(screen.getByText('cleared')).toBeInTheDocument();
  });

  it('shows an error message when the request fails', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('boom', {
          status: 500,
          statusText: 'Internal',
        }),
    ) as typeof fetch;

    renderToday();

    expect(await screen.findByText(/Error loading recent alerts/i)).toBeInTheDocument();
  });

  // Regression for F-007: in cloud mode the alert engine isn't constructed
  // and /api/alerts/recent returns 404. The panel must render nothing —
  // not a permanent red error banner. Without this fix users running the
  // dashboard in cloud mode see "Error loading recent alerts" indefinitely.
  //
  // IMPORTANT: this test uses a QueryClient with default retries (3) so the
  // suppression must come from the component's own `retry: false`, not the
  // test harness's `retry: 0` default. Without this distinction, removing
  // `retry: false` from Today.tsx would still pass with the default helper.
  it('renders nothing (no error banner) when /api/alerts/recent returns 404', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response('{"error":"not_found"}', {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    // Default QueryClient — would retry 3× on a thrown error if the
    // component itself didn't set `retry: false` on the alerts query.
    renderToday(new QueryClient());

    // Wait long enough that React Query's retry timers (~1s exponential
    // backoff) would have fired if `retry: false` weren't honored.
    await new Promise((r) => setTimeout(r, 100));

    expect(screen.queryByText(/Error loading recent alerts/i)).toBeNull();
    expect(screen.queryByText(/recent alerts/i)).toBeNull();
    expect(screen.queryByText(/No alerts in recent history/i)).toBeNull();
    // Only one fetch call — the component's retry: false suppressed retries.
    // (Plus other queries the Today view fires; we only count alerts/recent.)
    const alertsCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/api/alerts/recent'),
    );
    expect(alertsCalls).toHaveLength(1);
  });

  // Regression for F-016: AlertLog.readRecent returns the file's last N
  // lines in append (chronological) order — oldest-first within the slice.
  // The panel must sort descending by firedAt so the most-recent firing
  // sits at the top.
  it('orders rows by firedAt descending (most recent first — F-016)', async () => {
    const oldAlert = {
      id: 'rule-old',
      state: 'firing' as const,
      severity: 'warning' as const,
      title: 'Old alert',
      description: 'd',
      value: 1,
      threshold: 0,
      firedAt: 1000,
    };
    const middleAlert = {
      id: 'rule-mid',
      state: 'firing' as const,
      severity: 'warning' as const,
      title: 'Middle alert',
      description: 'd',
      value: 1,
      threshold: 0,
      firedAt: 2000,
    };
    const newAlert = {
      id: 'rule-new',
      state: 'firing' as const,
      severity: 'warning' as const,
      title: 'New alert',
      description: 'd',
      value: 1,
      threshold: 0,
      firedAt: 3000,
    };
    // Server returns in append order (oldest first); UI must reverse.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([oldAlert, middleAlert, newAlert]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof fetch;

    renderToday();

    await screen.findByText('New alert');
    const titles = screen.getAllByText(/(?:Old|Middle|New) alert/);
    expect(titles.map((el) => el.textContent)).toEqual(['New alert', 'Middle alert', 'Old alert']);
  });
});

describe('computeModelHealth', () => {
  const makeSessions = (model: string, rates: number[]) =>
    rates.map((r, i) => ({
      sessionId: `s${i}`,
      startTime: Date.now() - i * 3600_000,
      model,
      toolSuccessRate: r,
    }));

  it('returns unknown when model is null', () => {
    const result = computeModelHealth(null, 0.95, 0, []);
    expect(result.status).toBe('unknown');
  });

  it('returns unknown when success rate is null', () => {
    const result = computeModelHealth('claude-opus-4-6', null, 0, []);
    expect(result.status).toBe('unknown');
  });

  it('returns healthy when no baseline exists (fewer than 3 sessions)', () => {
    const sessions = makeSessions('claude-opus-4-6', [0.95, 0.92]);
    const result = computeModelHealth('claude-opus-4-6', 0.9, 0, sessions);
    expect(result.status).toBe('healthy');
    expect(result.baseline).toBeNull();
  });

  it('returns healthy when current rate is close to baseline', () => {
    const sessions = makeSessions('claude-opus-4-6', [0.95, 0.93, 0.96]);
    const result = computeModelHealth('claude-opus-4-6', 0.92, 0, sessions);
    expect(result.status).toBe('healthy');
    expect(result.baseline).toBeCloseTo(0.9467, 2);
  });

  it('returns degraded when gap exceeds 10 points', () => {
    const sessions = makeSessions('claude-opus-4-6', [0.95, 0.94, 0.96]);
    const result = computeModelHealth('claude-opus-4-6', 0.82, 1, sessions);
    expect(result.status).toBe('degraded');
    expect(result.message).toContain('may be throttled');
  });

  it('returns poor when gap exceeds 20 points', () => {
    const sessions = makeSessions('claude-opus-4-6', [0.95, 0.94, 0.96]);
    const result = computeModelHealth('claude-opus-4-6', 0.7, 2, sessions);
    expect(result.status).toBe('poor');
    expect(result.message).toContain('consider switching');
  });

  it('returns poor when error count exceeds threshold regardless of rate', () => {
    const sessions = makeSessions('claude-opus-4-6', [0.95, 0.94, 0.96]);
    const result = computeModelHealth('claude-opus-4-6', 0.9, 6, sessions);
    expect(result.status).toBe('poor');
  });

  it('only compares sessions for the same model', () => {
    const sessions = [
      ...makeSessions('claude-opus-4-6', [0.95, 0.94, 0.96]),
      ...makeSessions('claude-sonnet-4-6', [0.6, 0.65, 0.62]),
    ];
    const result = computeModelHealth('claude-opus-4-6', 0.92, 0, sessions);
    expect(result.status).toBe('healthy');
  });
});
