import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
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
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly appName: string;
  private started = false;

  constructor(options: OtlpTransportOptions) {
    const resource = resourceFromAttributes({ 'service.name': options.appName });

    this.endpoint = options.endpoint;
    this.headers = options.headers ?? {};
    this.appName = options.appName;

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

  async exportMetrics(metrics: NrMetric[]): Promise<void> {
    if (metrics.length === 0) return;
    const payload = {
      resourceMetrics: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: this.appName } }] },
        scopeMetrics: [{
          scope: { name: 'nr-ai-observatory' },
          metrics: metrics.map(m => ({
            name: m.name,
            gauge: {
              dataPoints: [{
                timeUnixNano: m.timestamp * 1_000_000,
                asDouble: m.value,
                attributes: Object.entries(m.attributes ?? {}).map(([key, value]) => ({
                  key,
                  value: typeof value === 'number' ? { doubleValue: value } : { stringValue: String(value) },
                })),
              }],
            },
          })),
        }],
      }],
    };
    try {
      const response = await fetch(`${this.endpoint}/v1/metrics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        logger.warn('OTLP metric export failed', { status: response.status });
      }
    } catch (err) {
      logger.warn('OTLP metric export error', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
