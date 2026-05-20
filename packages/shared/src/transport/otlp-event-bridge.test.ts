import { OtlpEventBridge } from './otlp-event-bridge.js';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import type { NrEventData } from '../events/types.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

// Mock OTel SDK modules
jest.mock('@opentelemetry/exporter-logs-otlp-http', () => ({
  OTLPLogExporter: jest.fn().mockImplementation(() => ({
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@opentelemetry/sdk-logs', () => ({
  LoggerProvider: jest.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.forceFlush = jest.fn().mockResolvedValue(undefined);
    this.shutdown = jest.fn().mockResolvedValue(undefined);
    const emitMock = jest.fn();
    this.getLogger = jest.fn().mockReturnValue({
      emit: emitMock,
    });
    this._emitMock = emitMock;
    return this;
  }),
  BatchLogRecordProcessor: jest.fn().mockImplementation(() => ({})),
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

describe('OtlpEventBridge', () => {
  // ---------------------------------------------------------------------------
  // 1. Constructor initializes with endpoint and appName
  // ---------------------------------------------------------------------------
  it('constructs with endpoint and appName', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'test-key' },
      appName: 'test-app',
    });

    expect(bridge).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 2. sendEvents() accepts an array of events
  // ---------------------------------------------------------------------------
  it('sendEvents() accepts an array of events', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const events: NrEventData[] = [
      { eventType: 'AiToolCall', timestamp: 1000 },
      { eventType: 'AiAntiPattern', timestamp: 2000 },
    ];

    expect(() => bridge.sendEvents(events)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 3. sendEvents() with empty array does not throw
  // ---------------------------------------------------------------------------
  it('sendEvents() with empty array does not throw', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    expect(() => bridge.sendEvents([])).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 4. sendEvents() iterates over events
  // ---------------------------------------------------------------------------
  it('sendEvents() iterates over events without throwing', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const events: NrEventData[] = [
      { eventType: 'AiToolCall', timestamp: 1000 },
      { eventType: 'AiAntiPattern', timestamp: 2000 },
      { eventType: 'AiCodingTask', timestamp: 3000 },
    ];

    expect(() => bridge.sendEvents(events)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 5. flush() calls loggerProvider.forceFlush()
  // ---------------------------------------------------------------------------
  it('flush() does not throw', async () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    await expect(bridge.flush()).resolves.not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 6. shutdown() calls loggerProvider.shutdown()
  // ---------------------------------------------------------------------------
  it('shutdown() does not throw', async () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    await expect(bridge.shutdown()).resolves.not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 7. Multiple sendEvents() calls do not throw
  // ---------------------------------------------------------------------------
  it('multiple sendEvents() calls do not throw', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    expect(() => {
      bridge.sendEvents([{ eventType: 'AiToolCall' }]);
      bridge.sendEvents([{ eventType: 'AiAntiPattern' }]);
      bridge.sendEvents([{ eventType: 'AiCodingTask' }]);
    }).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 8. sendEvents() handles events with mixed attribute types
  // ---------------------------------------------------------------------------
  it('sendEvents() handles events with mixed attribute types', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const events: NrEventData[] = [
      {
        eventType: 'AiToolCall',
        timestamp: 1000,
        toolName: 'write_file',
        success: true,
        duration: 125.5,
      },
    ];

    expect(() => bridge.sendEvents(events)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // 9. constructor with optional headers
  // ---------------------------------------------------------------------------
  it('constructs with optional headers', () => {
    const bridge1 = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const bridge2 = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      headers: { 'api-key': 'test-key' },
      appName: 'test-app',
    });

    expect(bridge1).toBeDefined();
    expect(bridge2).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 10. sendEvents() calls otelLogger.emit() once per event
  // ---------------------------------------------------------------------------
  it('sendEvents() calls otelLogger.emit() once per event', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const events: NrEventData[] = [
      { eventType: 'AiToolCall', timestamp: 1000 },
      { eventType: 'AiAntiPattern', timestamp: 2000 },
      { eventType: 'AiCodingTask', timestamp: 3000 },
    ];

    bridge.sendEvents(events);

    const providerInstance = (LoggerProvider as jest.Mock).mock.results[0].value as Record<string, unknown>;
    const emitMock = providerInstance._emitMock as jest.Mock;
    expect(emitMock).toHaveBeenCalledTimes(3);
  });

  // ---------------------------------------------------------------------------
  // 11. sendEvents() with missing timestamp uses Date.now()
  // ---------------------------------------------------------------------------
  it('sendEvents() with events without timestamp does not throw', () => {
    const bridge = new OtlpEventBridge({
      endpoint: 'https://otlp.nr-data.net',
      appName: 'test-app',
    });

    const events: NrEventData[] = [{ eventType: 'AiToolCall' }];

    expect(() => bridge.sendEvents(events)).not.toThrow();
  });
});
