export const VERSION = '0.1.0';
export { createLogger } from './logger.js';
export type { Logger, LogLevel } from './logger.js';
export { loadConfig } from './config.js';
export type { AgentConfig } from './config.js';
export {
  createAiRequest,
  createAiResponse,
  createAiMessage,
  aiRequestToNrEvent,
  aiResponseToNrEvent,
  aiMessageToNrEvent,
  aiAgentTaskSummaryToNrEvent,
  aiAntiPatternToNrEvent,
  aiAgentMessageToNrEvent,
  aiContextResetToNrEvent,
} from './events/index.js';
export type {
  AiProvider,
  AiRequestMethod,
  AiRequest,
  AiResponse,
  AiMessageRole,
  AiMessage,
  NrEventData,
  SpanType,
  SpanAttributes,
  AiAgentTaskSummary,
  AntiPatternType,
  AiAntiPattern,
  AiAgentMessage,
  AiContextReset,
  CreateAiRequestParams,
  CreateAiResponseParams,
  CreateAiMessageParams,
} from './events/index.js';
export {
  extractAnthropicTokens,
  extractGeminiTokens,
  extractStreamTokens,
  TokenAccumulator,
} from './tokens.js';
export type { TokenUsage } from './tokens.js';
export { calculateCost, resolveModelPricing, initPricing } from './pricing.js';
export { DEFAULT_PRICING_TABLE } from './pricing-data.js';
export type { ModelPricing, CostBreakdown } from './pricing.js';
export { RequestTimer } from './timing.js';
export type { RequestTimerMetrics } from './timing.js';
export { sendEvents, sendMetrics, sendLogs, OtlpTransport, OtlpEventBridge } from './transport/index.js';
export type { NrMetric, NrLogEntry, TransportOptions, TransportResult, OtlpTransportOptions, OtlpEventBridgeOptions } from './transport/index.js';
export { EventBuffer, MetricAggregator, HarvestScheduler } from './harvest/index.js';
export type {
  EventBufferOptions,
  MetricAccumulator,
  HarvestSchedulerOptions,
} from './harvest/index.js';
export {
  AiErrorClassification,
  classifyError,
  isRetryable,
  extractRateLimitHeaders,
  truncateErrorMessage,
} from './errors.js';
export type { RateLimitInfo } from './errors.js';
