import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { NrEventData } from '../events/types.js';

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
      resource: resourceFromAttributes({ 'service.name': options.appName }),
      processors: [new BatchLogRecordProcessor(exporter)],
    });

    this.otelLogger = this.loggerProvider.getLogger('nr-ai-observatory');
  }

  sendEvents(events: NrEventData[]): void {
    for (const event of events) {
      this.otelLogger.emit({
        severityText: 'INFO',
        body: (event['eventType'] as string) ?? 'AiEvent',
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
