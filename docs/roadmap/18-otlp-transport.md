# Implementation Plan: OTLP Transport Option

**Roadmap item:** [18 — OTLP Transport Option](../../ROADMAP.md#18-otlp-transport-option)
**Effort estimate:** ~2 days
**Prerequisites:** Read `packages/shared/src/transport/`, `packages/shared/src/harvest/harvest-scheduler.ts`, and `packages/shared/src/config.ts` before starting. Item 17 (GenAI semantic convention mapping) should be complete first so OTLP spans carry standardized attribute names.

---

## Goal

Add an OTLP/HTTP transport as an optional alternative (or complement) to the current New Relic Events API + Metric API transports. When `otlpEndpoint` is configured, the project can send telemetry to any OpenTelemetry-compatible backend — Datadog, Honeycomb, Grafana Cloud, a self-hosted OpenTelemetry Collector, or New Relic's own OTLP ingest endpoint — without being coupled to the NR proprietary APIs. The NR Events API path remains the default; OTLP is additive.

---

## Background reading

Before starting, read these files end-to-end:

- `packages/shared/src/transport/events-api.ts` — the existing NR transport to mirror
- `packages/shared/src/transport/metric-api.ts` — metric transport
- `packages/shared/src/transport/types.ts` — `TransportOptions`, `TransportResult`, `NrMetric`
- `packages/shared/src/harvest/harvest-scheduler.ts` — how the scheduler drives flushes
- `packages/shared/src/config.ts` — `AgentConfig` interface to extend
- `packages/nr-ai-mcp-server/src/config.ts` — `McpServerConfig` interface to extend

---

## Step 1 — Add OTLP config fields

### 1a — `AgentConfig` (`packages/shared/src/config.ts`)

Add to the `AgentConfig` interface:

```typescript
/** OTLP/HTTP endpoint URL. When set, telemetry is also exported via OTLP. */
readonly otlpEndpoint: string | null;
/** Additional HTTP headers for the OTLP exporter (e.g. authentication). */
readonly otlpHeaders: Readonly<Record<string, string>>;
/**
 * Transport mode.
 * - 'nr-events-api' (default): NR Events API + Metric API only
 * - 'otlp': OTLP/HTTP only (requires otlpEndpoint)
 * - 'both': NR Events API + OTLP simultaneously
 */
readonly transport: 'nr-events-api' | 'otlp' | 'both';
```

Defaults in `loadConfig()`:
- `otlpEndpoint`: `process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null`
- `otlpHeaders`: parsed from `process.env.OTEL_EXPORTER_OTLP_HEADERS` (comma-separated `key=value` pairs, empty object if unset)
- `transport`: `'nr-events-api'`

### 1b — `McpServerConfig` (`packages/nr-ai-mcp-server/src/config.ts`)

Add the same three fields to `McpServerConfig` with the same defaults. Wire them from env vars and config file in `loadMcpServerConfig()`.

---

## Step 2 — Add OTLP npm dependencies

In `packages/shared/package.json`, add to `dependencies`:

```json
"@opentelemetry/api": "^1.9.0",
"@opentelemetry/sdk-trace-node": "^1.25.0",
"@opentelemetry/exporter-trace-otlp-http": "^0.52.0",
"@opentelemetry/exporter-metrics-otlp-http": "^0.52.0",
"@opentelemetry/sdk-metrics": "^1.25.0"
```

Run `npm install` from the repo root after editing.

---

## Step 3 — Create `OtlpTransport`

Create `packages/shared/src/transport/otlp-transport.ts`.

This module wraps the OTel SDK's OTLP exporters and provides the same fire-and-forget interface as `sendEvents()` and `sendMetrics()`.

```typescript
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { createLogger } from '../logger.js';
import type { NrMetric } from './types.js';

const logger = createLogger('otlp-transport');

export interface OtlpTransportOptions {
  endpoint: string;
  headers?: Record<string, string>;
  appName: string;
}

export class OtlpTransport {
  private readonly traceExporter: OTLPTraceExporter;
  private readonly metricExporter: OTLPMetricExporter;
  private readonly tracerProvider: BasicTracerProvider;
  private readonly meterProvider: MeterProvider;
  private started = false;

  constructor(options: OtlpTransportOptions) {
    const resource = new Resource({ 'service.name': options.appName });

    this.traceExporter = new OTLPTraceExporter({
      url: `${options.endpoint}/v1/traces`,
      headers: options.headers ?? {},
    });

    this.metricExporter = new OTLPMetricExporter({
      url: `${options.endpoint}/v1/metrics`,
      headers: options.headers ?? {},
    });

    this.tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(this.traceExporter)],
    });

    this.meterProvider = new MeterProvider({
      resource,
      readers: [new PeriodicExportingMetricReader({ exporter: this.metricExporter, exportIntervalMillis: 60_000 })],
    });
  }

  start(): void {
    if (this.started) return;
    this.tracerProvider.register();
    this.started = true;
    logger.info('OTLP transport started');
  }

  async flush(): Promise<void> {
    await this.tracerProvider.forceFlush();
    await this.meterProvider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.tracerProvider.shutdown();
    await this.meterProvider.shutdown();
  }

  getTracer(name: string) {
    return this.tracerProvider.getTracer(name);
  }

  getMeter(name: string) {
    return this.meterProvider.getMeter(name);
  }
}
```

---

## Step 4 — Create `OtlpEventBridge`

The existing `HarvestScheduler` sends `NrEventData[]` to the NR Events API. For OTLP, we need to convert `NrEventData` objects into OTel log records (the closest analog to NR custom events in OTLP). Create `packages/shared/src/transport/otlp-event-bridge.ts`:

```typescript
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { Resource } from '@opentelemetry/resources';
import type { NrEventData } from '../events/types.js';
import { createLogger } from '../logger.js';

const logger = createLogger('otlp-event-bridge');

export interface OtlpEventBridgeOptions {
  endpoint: string;
  headers?: Record<string, string>;
  appName: string;
}

export class OtlpEventBridge {
  private readonly loggerProvider: LoggerProvider;
  private readonly otelLogger: ReturnType<LoggerProvider['getLogger']>;

  constructor(options: OtlpEventBridgeOptions) {
    const exporter = new OTLPLogExporter({
      url: `${options.endpoint}/v1/logs`,
      headers: options.headers ?? {},
    });

    this.loggerProvider = new LoggerProvider({
      resource: new Resource({ 'service.name': options.appName }),
      processors: [new BatchLogRecordProcessor(exporter)],
    });

    this.otelLogger = this.loggerProvider.getLogger('nr-ai-observatory');
  }

  sendEvents(events: NrEventData[]): void {
    for (const event of events) {
      this.otelLogger.emit({
        severityText: 'INFO',
        body: event['eventType'] as string ?? 'AiEvent',
        attributes: event as Record<string, string | number | boolean>,
        timestamp: typeof event.timestamp === 'number' ? event.timestamp : Date.now(),
      });
    }
  }

  async flush(): Promise<void> {
    await this.loggerProvider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.loggerProvider.shutdown();
  }
}
```

Add `@opentelemetry/exporter-logs-otlp-http` and `@opentelemetry/sdk-logs` to the dependencies in `packages/shared/package.json`.

---

## Step 5 — Integrate into `HarvestScheduler`

In `packages/shared/src/harvest/harvest-scheduler.ts`, update `HarvestSchedulerOptions` to accept optional OTLP bridge instances:

```typescript
import type { OtlpEventBridge } from '../transport/otlp-event-bridge.js';
import type { OtlpTransport } from '../transport/otlp-transport.js';

export interface HarvestSchedulerOptions {
  // ... existing fields ...
  otlpEventBridge?: OtlpEventBridge;
  otlpTransport?: OtlpTransport;
  transport?: 'nr-events-api' | 'otlp' | 'both';
}
```

In the flush methods, route based on the `transport` config:

- `'nr-events-api'` (default): existing behavior unchanged
- `'otlp'`: skip NR Events/Metric API calls; use `otlpEventBridge.sendEvents()` instead
- `'both'`: call both paths concurrently (`Promise.all`)

---

## Step 6 — Wire up in `NrAiAgent` (`packages/nr-ai-agent/src/agent.ts`)

When `config.otlpEndpoint` is set, create an `OtlpTransport` and `OtlpEventBridge` and pass them to `HarvestScheduler`. Add `otlpTransport.start()` after creation and `await otlpTransport.shutdown()` in the agent teardown.

---

## Step 7 — Wire up in `NrIngestManager` (`packages/nr-ai-mcp-server/src/transport/nr-ingest.ts`)

Same wiring as Step 6, driven by `McpServerConfig.otlpEndpoint` and `McpServerConfig.transport`.

---

## Step 8 — New Relic OTLP endpoint

When users want to use OTLP to reach New Relic instead of the proprietary Events API:
- EU: `https://otlp.eu01.nr-data.net`
- US: `https://otlp.nr-data.net`

Document both endpoints in the config file example and README.

For the `otlpHeaders` when targeting NR, the user sets:
```json
{ "api-key": "<NR_LICENSE_KEY>" }
```

---

## Step 9 — Write tests

Create `packages/shared/src/transport/otlp-transport.test.ts` and `packages/shared/src/transport/otlp-event-bridge.test.ts`.

Key test cases:

- `OtlpTransport` — `start()` is idempotent (calling twice doesn't throw)
- `OtlpTransport` — `shutdown()` can be called without prior `start()`
- `OtlpEventBridge.sendEvents()` — calls `otelLogger.emit()` once per event
- `OtlpEventBridge.sendEvents()` — empty array emits nothing
- `OtlpEventBridge.flush()` — calls `loggerProvider.forceFlush()`

Mock the OTel SDK classes using `jest.mock('@opentelemetry/...')` — do not make real network calls in tests.

Also update `harvest-scheduler.test.ts` to assert that when `transport: 'otlp'` is configured and `otlpEventBridge` is provided, the NR `sendEvents` function is NOT called and `otlpEventBridge.sendEvents()` IS called.

---

## Acceptance criteria

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] When `transport: 'nr-events-api'` (default), behavior is identical to before this change
- [ ] When `transport: 'otlp'` and `otlpEndpoint` is set, `HarvestScheduler` routes events/metrics through `OtlpEventBridge` / `OtlpTransport` and does NOT call the NR Events API
- [ ] When `transport: 'both'`, both transport paths are called concurrently
- [ ] `otlpEndpoint` can be set via `OTEL_EXPORTER_OTLP_ENDPOINT` env var
- [ ] `otlpHeaders` parsed from `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated `key=value`)
- [ ] `OtlpTransport.shutdown()` is awaited on agent / server shutdown
- [ ] `npm run lint` passes

---

## File checklist

Files to **create**:

```
packages/shared/src/transport/otlp-transport.ts
packages/shared/src/transport/otlp-transport.test.ts
packages/shared/src/transport/otlp-event-bridge.ts
packages/shared/src/transport/otlp-event-bridge.test.ts
```

Files to **modify**:

```
packages/shared/src/config.ts                           — add otlpEndpoint, otlpHeaders, transport fields
packages/shared/src/harvest/harvest-scheduler.ts        — route based on transport config
packages/shared/src/harvest/harvest-scheduler.test.ts   — assert OTLP routing
packages/shared/package.json                            — add OTel dependencies
packages/nr-ai-agent/src/agent.ts                       — wire OtlpTransport when configured
packages/nr-ai-mcp-server/src/config.ts                 — add same three config fields
packages/nr-ai-mcp-server/src/transport/nr-ingest.ts    — wire OtlpTransport when configured
```
