import { trace, type Tracer } from '@opentelemetry/api';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('agent-tracing');

const INSTRUMENTATION_SCOPE = 'nr-ai-agent';
const INSTRUMENTATION_VERSION = '1.0.0'; // keep in sync with package.json

let _tracer: Tracer | null = null;

/** Called once during NrAiAgent constructor when OTLP is configured. */
export function initTracer(): void {
  _tracer = trace.getTracer(INSTRUMENTATION_SCOPE, INSTRUMENTATION_VERSION);
  logger.debug('Agent tracer initialized');
}

/**
 * Returns the active tracer, or a no-op tracer if OTel has not been configured.
 * Individual wrappers call this — it is safe to call even when OTLP is disabled.
 */
export function getTracer(): Tracer {
  return _tracer ?? trace.getTracer(INSTRUMENTATION_SCOPE, INSTRUMENTATION_VERSION);
}
