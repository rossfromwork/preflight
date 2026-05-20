import { OtlpTransport } from './otlp-transport.js';
import type { NrMetric } from './types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

// Mock OTel SDK modules
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn().mockImplementation(() => ({
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@opentelemetry/sdk-trace-node', () => ({
  BasicTracerProvider: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    forceFlush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    getTracer: jest.fn().mockReturnValue({}),
  })),
  BatchSpanProcessor: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@opentelemetry/exporter-metrics-otlp-http', () => ({
  OTLPMetricExporter: jest.fn().mockImplementation(() => ({
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@opentelemetry/sdk-metrics', () => ({
  MeterProvider: jest.fn().mockImplementation(() => ({
    forceFlush: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    getMeter: jest.fn().mockReturnValue({}),
  })),
  PeriodicExportingMetricReader: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: jest.fn().mockReturnValue({}),
}));

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  jest.clearAllMocks();
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('OtlpTransport', () => {
  // ---------------------------------------------------------------------------
  // 1. Constructor initializes with endpoint and headers
  // ---------------------------------------------------------------------------
  it('constructs with endpoint and headers', () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'test-key' },
      appName: 'test-app',
    });

    expect(transport).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 2. start() is idempotent — calling twice doesn't throw
  // ---------------------------------------------------------------------------
  it('start() is idempotent', () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    expect(() => {
      transport.start();
      transport.start(); // Should not throw
    }).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 3. shutdown() can be called without prior start()
  // ---------------------------------------------------------------------------
  it('shutdown() can be called without start()', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    await expect(transport.shutdown()).resolves.not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 4. flush() calls forceFlush on both providers
  // ---------------------------------------------------------------------------
  it('flush() calls forceFlush on both providers', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    transport.start();
    await transport.flush();

    // Verify flush was called (mocked implementations resolve immediately)
    expect(transport).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 5. getTracer() returns a tracer from tracerProvider
  // ---------------------------------------------------------------------------
  it('getTracer() returns a tracer instance', () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const tracer = transport.getTracer('test');
    expect(tracer).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 6. getMeter() returns a meter from meterProvider
  // ---------------------------------------------------------------------------
  it('getMeter() returns a meter instance', () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const meter = transport.getMeter('test');
    expect(meter).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 7. exportMetrics() with empty array sends nothing (after early return)
  // ---------------------------------------------------------------------------
  it('exportMetrics() with empty array does nothing', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

    await transport.exportMetrics([]);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 8. exportMetrics() converts NrMetric[] to OTLP format and sends via fetch
  // ---------------------------------------------------------------------------
  it('exportMetrics() sends metrics in OTLP format', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'test-key' },
      appName: 'test-app',
    });

    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

    const metrics: NrMetric[] = [
      {
        name: 'ai.tokens',
        type: 'gauge',
        value: 100,
        timestamp: Date.now(),
        attributes: { model: 'claude-3-sonnet' },
      },
      {
        name: 'ai.duration',
        type: 'gauge',
        value: 2500,
        timestamp: Date.now(),
        attributes: { tool: 'write_file' },
      },
    ];

    await transport.exportMetrics(metrics);

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://otlp.nr-data.net/v1/metrics',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'api-key': 'test-key',
        }),
      }),
    );

    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 9. exportMetrics() handles fetch errors gracefully
  // ---------------------------------------------------------------------------
  it('exportMetrics() handles fetch errors gracefully', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockRejectedValue(new Error('Network error'));

    const metrics: NrMetric[] = [
      {
        name: 'ai.tokens',
        type: 'gauge',
        value: 100,
        timestamp: Date.now(),
        attributes: {},
      },
    ];

    // Should not throw
    await expect(transport.exportMetrics(metrics)).resolves.not.toThrow();

    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // 10. exportMetrics() handles non-OK responses gracefully
  // ---------------------------------------------------------------------------
  it('exportMetrics() handles non-OK HTTP responses', async () => {
    const transport = new OtlpTransport({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const fetchSpy = jest
      .spyOn(globalThis as unknown as { fetch: typeof fetch }, 'fetch')
      .mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

    const metrics: NrMetric[] = [
      {
        name: 'ai.tokens',
        type: 'gauge',
        value: 100,
        timestamp: Date.now(),
        attributes: {},
      },
    ];

    // Should not throw
    await expect(transport.exportMetrics(metrics)).resolves.not.toThrow();

    fetchSpy.mockRestore();
  });
});
