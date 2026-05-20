import { HarvestScheduler } from './harvest-scheduler.js';
import type { HarvestSchedulerOptions } from './harvest-scheduler.js';
import type { TransportResult, NrMetric } from '../transport/types.js';
import type { NrEventData } from '../events/types.js';
import type { OtlpEventBridge } from '../transport/otlp-event-bridge.js';
import type { OtlpTransport } from '../transport/otlp-transport.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

const successResult: TransportResult = { success: true, statusCode: 200, retryCount: 0 };
const failureResult: TransportResult = {
  success: false,
  statusCode: 500,
  retryCount: 3,
  error: 'server error',
};

function makeScheduler(
  overrides: Partial<HarvestSchedulerOptions> = {},
): {
  scheduler: HarvestScheduler;
  sendEventsFn: jest.Mock;
  sendMetricsFn: jest.Mock;
} {
  const sendEventsFn = jest.fn<Promise<TransportResult>, unknown[]>().mockResolvedValue(successResult);
  const sendMetricsFn = jest.fn<Promise<TransportResult>, unknown[]>().mockResolvedValue(successResult);

  const scheduler = new HarvestScheduler({
    licenseKey: 'testkey123',
    transportOptions: { accountId: '12345' },
    eventHarvestIntervalMs: 5_000,
    metricHarvestIntervalMs: 60_000,
    sendEventsFn,
    sendMetricsFn,
    ...overrides,
  });

  return { scheduler, sendEventsFn, sendMetricsFn };
}

beforeEach(() => {
  jest.useFakeTimers();
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  jest.useRealTimers();
  stderrSpy.mockRestore();
});

describe('HarvestScheduler', () => {
  // ---------------------------------------------------------------------------
  // 1. Events harvest fires at 5s, metrics at 60s
  // ---------------------------------------------------------------------------
  it('fires events harvest at 5s intervals and metrics at 60s', async () => {
    const { scheduler, sendEventsFn, sendMetricsFn } = makeScheduler();

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.recordMetric('ai.duration', 100);
    scheduler.start();

    // Advance 5s — events should fire, metrics should not
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect(sendMetricsFn).toHaveBeenCalledTimes(0);

    // Advance to 55s — no new events, so sendEventsFn is not called again
    // but the timer is still firing (just skipping empty buffers)
    await jest.advanceTimersByTimeAsync(50_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1); // no new data

    // Add event and advance to 60s — both should fire
    scheduler.addEvent({ eventType: 'Test', value: 2 });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 2. stop() triggers final flush
  // ---------------------------------------------------------------------------
  it('stop triggers final flush of both buffers', async () => {
    const { scheduler, sendEventsFn, sendMetricsFn } = makeScheduler();

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.recordMetric('ai.tokens', 500);
    scheduler.start();

    // Stop immediately — no intervals should have fired yet
    await scheduler.stop();

    // Final flush should have sent both
    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);

    // Verify the events were sent
    const sentEvents = sendEventsFn.mock.calls[0][0] as NrEventData[];
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].eventType).toBe('Test');

    // Verify metrics were sent (4 gauges: count, sum, min, max)
    const sentMetrics = sendMetricsFn.mock.calls[0][0] as NrMetric[];
    expect(sentMetrics).toHaveLength(4);
  });

  // ---------------------------------------------------------------------------
  // 3. Atomic snapshot — events added during send appear in next harvest
  // ---------------------------------------------------------------------------
  it('events added during send are captured in next harvest', async () => {
    let addDuringSend: (() => void) | null = null;

    const sendEventsFn = jest.fn<Promise<TransportResult>, unknown[]>().mockImplementation(async () => {
      // Simulate adding an event while the send is in-flight
      if (addDuringSend) {
        addDuringSend();
        addDuringSend = null;
      }
      return successResult;
    });

    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'Original', seq: 1 });
    scheduler.addEvent({ eventType: 'Original', seq: 2 });
    scheduler.addEvent({ eventType: 'Original', seq: 3 });

    // On first send, add 2 new events
    addDuringSend = () => {
      scheduler.addEvent({ eventType: 'DuringSend', seq: 10 });
      scheduler.addEvent({ eventType: 'DuringSend', seq: 11 });
    };

    scheduler.start();

    // First harvest at 5s
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // First harvest should have received the 3 original events
    const firstBatch = sendEventsFn.mock.calls[0][0] as NrEventData[];
    expect(firstBatch).toHaveLength(3);

    // Second harvest at 10s should pick up the 2 events added during first send
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);

    const secondBatch = sendEventsFn.mock.calls[1][0] as NrEventData[];
    expect(secondBatch).toHaveLength(2);
    expect(secondBatch[0].eventType).toBe('DuringSend');

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 4. Send failure → re-queued and retried on next harvest
  // ---------------------------------------------------------------------------
  it('re-queues events on send failure and retries on next harvest', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValueOnce(failureResult)
      .mockResolvedValue(successResult);

    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // First harvest — fails, events re-queued
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    const logOutput = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(logOutput).toContain('re-queuing batch for retry');

    // Second harvest — retry succeeds, includes the re-queued event
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    const retryBatch = sendEventsFn.mock.calls[1][0] as NrEventData[];
    expect(retryBatch).toHaveLength(1);
    expect(retryBatch[0].value).toBe(1);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 5. Re-queued events are combined with new events on retry
  // ---------------------------------------------------------------------------
  it('combines re-queued events with new events on next harvest', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValueOnce(failureResult)
      .mockResolvedValue(successResult);

    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'Original', seq: 1 });
    scheduler.start();

    // First harvest — fails
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // Add new event before next harvest
    scheduler.addEvent({ eventType: 'New', seq: 2 });

    // Second harvest — should include both re-queued and new events
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    const retryBatch = sendEventsFn.mock.calls[1][0] as NrEventData[];
    expect(retryBatch).toHaveLength(2);
    expect(retryBatch[0].seq).toBe(1); // re-queued event first
    expect(retryBatch[1].seq).toBe(2); // new event second

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 6. Re-queued events are capped to prevent unbounded growth
  // ---------------------------------------------------------------------------
  it('caps re-queued events to maxEventBufferSize, keeping newest', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(failureResult);

    const { scheduler } = makeScheduler({
      sendEventsFn,
      maxEventBufferSize: 5,
    });

    // Add 5 events (seq 0-4) and fail
    for (let i = 0; i < 5; i++) {
      scheduler.addEvent({ eventType: 'Test', seq: i });
    }
    scheduler.start();

    // First harvest — fails, 5 events re-queued (at capacity)
    await jest.advanceTimersByTimeAsync(5_000);

    // Add 3 newer events (seq 10-12)
    for (let i = 10; i < 13; i++) {
      scheduler.addEvent({ eventType: 'Test', seq: i });
    }

    // Second harvest — 5 retry + 3 new = 8, sent and fails again, capped to 5
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    const logOutput = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(logOutput).toContain('overflow');

    // Third harvest — the retry buffer should contain the 5 newest events.
    // Newest are the 3 fresh (seq 10,11,12) plus the last 2 old retries (seq 3,4).
    // The oldest retries (seq 0,1,2) should have been dropped.
    // We can't swap the fn mid-test, but we can check the 3rd call's batch
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(3);
    const thirdBatch = sendEventsFn.mock.calls[2][0] as Array<NrEventData & { seq: number }>;
    expect(thirdBatch).toHaveLength(5);
    // Should contain seq 3,4,10,11,12 (newest 5) — not seq 0,1,2 (oldest 3)
    const seqs = thirdBatch.map((e) => e.seq);
    expect(seqs).not.toContain(0);
    expect(seqs).not.toContain(1);
    expect(seqs).not.toContain(2);
    expect(seqs).toContain(10);
    expect(seqs).toContain(11);
    expect(seqs).toContain(12);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 7. Metrics are re-queued on send failure and retried
  // ---------------------------------------------------------------------------
  it('re-queues metrics on send failure and retries on next harvest', async () => {
    const sendMetricsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValueOnce(failureResult)
      .mockResolvedValue(successResult);

    const { scheduler } = makeScheduler({ sendMetricsFn });

    scheduler.recordMetric('ai.duration', 100);
    scheduler.start();

    // First metric harvest at 60s — fails
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);
    const firstBatch = sendMetricsFn.mock.calls[0][0] as NrMetric[];
    expect(firstBatch.length).toBeGreaterThan(0);

    // Second metric harvest at 120s — retry succeeds with re-queued metrics
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sendMetricsFn).toHaveBeenCalledTimes(2);
    const retryBatch = sendMetricsFn.mock.calls[1][0] as NrMetric[];
    expect(retryBatch.length).toBeGreaterThanOrEqual(firstBatch.length);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 8. Re-queued metrics are capped to prevent unbounded growth (B-01)
  // ---------------------------------------------------------------------------
  it('caps re-queued metrics to maxRetryMetrics (500), keeping newest', async () => {
    const sendMetricsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockResolvedValue(failureResult);

    const { scheduler } = makeScheduler({ sendMetricsFn });
    scheduler.start();

    // Record 130 unique metric names → 130 × 4 = 520 NrMetric entries (exceeds cap of 500)
    for (let i = 0; i < 130; i++) {
      scheduler.recordMetric(`metric.b01.${i}`, i);
    }

    // First harvest at 60s — batch of 520, fails, capped to 500
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);
    const logOutput = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string).join('');
    expect(logOutput).toContain('overflow');

    // Second harvest — retry batch (500 entries) is sent; verify size is capped
    await jest.advanceTimersByTimeAsync(60_000);
    expect(sendMetricsFn).toHaveBeenCalledTimes(2);
    const retryBatch = sendMetricsFn.mock.calls[1][0] as Array<{ name: string }>;
    expect(retryBatch).toHaveLength(500);

    // Oldest 5 metric names (metric.b01.0 – metric.b01.4, = first 20 NrMetric entries)
    // should have been dropped; the newest (metric.b01.125 – metric.b01.129) should survive
    const retryNames = new Set(retryBatch.map((m) => m.name));
    expect(retryNames.has('metric.b01.0.count')).toBe(false);
    expect(retryNames.has('metric.b01.4.count')).toBe(false);
    expect(retryNames.has('metric.b01.125.count')).toBe(true);
    expect(retryNames.has('metric.b01.129.count')).toBe(true);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 9. Concurrent stop() calls await the same flush (no short-circuit)
  // ---------------------------------------------------------------------------
  it('concurrent stop() calls share the same flush promise', async () => {
    const sendEventsFn = jest.fn<Promise<TransportResult>, unknown[]>().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(successResult), 100)),
    );
    const sendMetricsFn = jest.fn<Promise<TransportResult>, unknown[]>().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(successResult), 100)),
    );

    const { scheduler } = makeScheduler({ sendEventsFn, sendMetricsFn });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.recordMetric('ai.duration', 42);
    scheduler.start();

    // Call stop() twice concurrently (simulates SIGTERM handler + main shutdown)
    const p1 = scheduler.stop();
    const p2 = scheduler.stop();

    // Advance timers to let the mocked send promises resolve
    await jest.advanceTimersByTimeAsync(200);
    await Promise.all([p1, p2]);

    // Final flush should have fired exactly once
    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // 9. Restart+stop flushes data from second session (stopPromise cleared)
  // ---------------------------------------------------------------------------
  it('flushes data from second session after restart', async () => {
    const { scheduler, sendEventsFn, sendMetricsFn } = makeScheduler();

    // First session
    scheduler.addEvent({ eventType: 'Session1', seq: 1 });
    scheduler.recordMetric('ai.duration', 100);
    scheduler.start();
    await scheduler.stop();

    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect((sendEventsFn.mock.calls[0][0] as NrEventData[])[0].eventType).toBe('Session1');
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);

    // Second session — start again, add new data, stop
    scheduler.addEvent({ eventType: 'Session2', seq: 2 });
    scheduler.recordMetric('ai.duration', 200);
    scheduler.start();
    await scheduler.stop();

    // Second stop must trigger its own final flush
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    expect((sendEventsFn.mock.calls[1][0] as NrEventData[])[0].eventType).toBe('Session2');
    expect(sendMetricsFn).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // 10. Events re-queued on thrown exception
  // ---------------------------------------------------------------------------
  it('re-queues events when sendEventsFn throws', async () => {
    const sendEventsFn = jest
      .fn<Promise<TransportResult>, unknown[]>()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValue(successResult);

    const { scheduler } = makeScheduler({ sendEventsFn });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // First harvest — throws, events re-queued
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // Second harvest — retry succeeds
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sendEventsFn).toHaveBeenCalledTimes(2);
    const retryBatch = sendEventsFn.mock.calls[1][0] as NrEventData[];
    expect(retryBatch).toHaveLength(1);
    expect(retryBatch[0].value).toBe(1);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 11. OTLP routing — 'otlp' mode calls otlpEventBridge.sendEvents, not NR API
  // ---------------------------------------------------------------------------
  it("transport: 'otlp' routes events to otlpEventBridge.sendEvents, not NR API", async () => {
    const sendEventsFn = jest.fn<Promise<TransportResult>, unknown[]>().mockResolvedValue(successResult);
    const otlpEventBridgeSendFn = jest.fn<void, [NrEventData[]]>();
    const otlpEventBridge = {
      sendEvents: otlpEventBridgeSendFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as OtlpEventBridge;

    const { scheduler } = makeScheduler({
      sendEventsFn,
      otlpEventBridge,
      transport: 'otlp',
    });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // Advance to first harvest at 5s
    await jest.advanceTimersByTimeAsync(5_000);

    // NR sendEventsFn should NOT have been called
    expect(sendEventsFn).not.toHaveBeenCalled();

    // OTLP bridge's sendEvents should have been called once
    expect(otlpEventBridgeSendFn).toHaveBeenCalledTimes(1);
    const sentEvents = otlpEventBridgeSendFn.mock.calls[0][0] as NrEventData[];
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].eventType).toBe('Test');

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 12. OTLP routing — 'otlp' mode calls otlpTransport.exportMetrics, not NR API
  // ---------------------------------------------------------------------------
  it("transport: 'otlp' routes metrics to otlpTransport.exportMetrics, not NR API", async () => {
    const sendMetricsFn = jest.fn<Promise<TransportResult>, unknown[]>().mockResolvedValue(successResult);
    const otlpTransportExportFn = jest.fn<Promise<void>, [NrMetric[]]>();
    const otlpTransport = {
      start: jest.fn(),
      exportMetrics: otlpTransportExportFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      getTracer: jest.fn(),
      getMeter: jest.fn(),
    } as unknown as OtlpTransport;

    const { scheduler } = makeScheduler({
      sendMetricsFn,
      otlpTransport,
      transport: 'otlp',
    });

    scheduler.recordMetric('ai.duration', 100);
    scheduler.start();

    // Advance to first metric harvest at 60s
    await jest.advanceTimersByTimeAsync(60_000);

    // NR sendMetricsFn should NOT have been called
    expect(sendMetricsFn).not.toHaveBeenCalled();

    // OTLP transport's exportMetrics should have been called once
    expect(otlpTransportExportFn).toHaveBeenCalledTimes(1);
    const sentMetrics = otlpTransportExportFn.mock.calls[0][0] as NrMetric[];
    expect(sentMetrics.length).toBeGreaterThan(0);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 13. OTLP routing — 'both' mode calls both NR API and OTLP concurrently
  // ---------------------------------------------------------------------------
  it("transport: 'both' calls both NR API and OTLP concurrently for events", async () => {
    const sendEventsFn = jest.fn<Promise<TransportResult>, unknown[]>().mockResolvedValue(successResult);
    const otlpEventBridgeSendFn = jest.fn<void, [NrEventData[]]>();
    const otlpEventBridge = {
      sendEvents: otlpEventBridgeSendFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as OtlpEventBridge;

    const { scheduler } = makeScheduler({
      sendEventsFn,
      otlpEventBridge,
      transport: 'both',
    });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // Advance to first harvest at 5s
    await jest.advanceTimersByTimeAsync(5_000);

    // Both NR and OTLP should have been called
    expect(sendEventsFn).toHaveBeenCalledTimes(1);
    expect(otlpEventBridgeSendFn).toHaveBeenCalledTimes(1);

    // Both should receive the same events
    const nrEvents = sendEventsFn.mock.calls[0][0] as NrEventData[];
    const otlpEvents = otlpEventBridgeSendFn.mock.calls[0][0] as NrEventData[];
    expect(nrEvents).toHaveLength(1);
    expect(otlpEvents).toHaveLength(1);
    expect(nrEvents[0].eventType).toBe('Test');
    expect(otlpEvents[0].eventType).toBe('Test');

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 14. OTLP routing — 'both' mode calls both NR API and OTLP for metrics
  // ---------------------------------------------------------------------------
  it("transport: 'both' calls both NR API and OTLP concurrently for metrics", async () => {
    const sendMetricsFn = jest.fn<Promise<TransportResult>, unknown[]>().mockResolvedValue(successResult);
    const otlpTransportExportFn = jest.fn<Promise<void>, [NrMetric[]]>();
    const otlpTransport = {
      start: jest.fn(),
      exportMetrics: otlpTransportExportFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
      getTracer: jest.fn(),
      getMeter: jest.fn(),
    } as unknown as OtlpTransport;

    const { scheduler } = makeScheduler({
      sendMetricsFn,
      otlpTransport,
      transport: 'both',
    });

    scheduler.recordMetric('ai.duration', 100);
    scheduler.start();

    // Advance to first metric harvest at 60s
    await jest.advanceTimersByTimeAsync(60_000);

    // Both NR and OTLP should have been called
    expect(sendMetricsFn).toHaveBeenCalledTimes(1);
    expect(otlpTransportExportFn).toHaveBeenCalledTimes(1);

    // Both should receive metrics
    const nrMetrics = sendMetricsFn.mock.calls[0][0] as NrMetric[];
    const otlpMetrics = otlpTransportExportFn.mock.calls[0][0] as NrMetric[];
    expect(nrMetrics.length).toBeGreaterThan(0);
    expect(otlpMetrics.length).toBeGreaterThan(0);

    await scheduler.stop();
  });

  // ---------------------------------------------------------------------------
  // 15. Default transport mode is 'nr-events-api'
  // ---------------------------------------------------------------------------
  it("default transport mode is 'nr-events-api'", async () => {
    const sendEventsFn = jest.fn<Promise<TransportResult>, unknown[]>().mockResolvedValue(successResult);
    const otlpEventBridgeSendFn = jest.fn<void, [NrEventData[]]>();
    const otlpEventBridge = {
      sendEvents: otlpEventBridgeSendFn,
      flush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    } as unknown as OtlpEventBridge;

    // Don't specify transport — should default to 'nr-events-api'
    const { scheduler } = makeScheduler({
      sendEventsFn,
      otlpEventBridge,
      // transport not specified
    });

    scheduler.addEvent({ eventType: 'Test', value: 1 });
    scheduler.start();

    // Advance to first harvest at 5s
    await jest.advanceTimersByTimeAsync(5_000);

    // NR API should be called (default behavior)
    expect(sendEventsFn).toHaveBeenCalledTimes(1);

    // OTLP bridge should NOT be called (default mode doesn't use it)
    expect(otlpEventBridgeSendFn).not.toHaveBeenCalled();

    await scheduler.stop();
  });
});
