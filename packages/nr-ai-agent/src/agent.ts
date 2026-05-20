import type Anthropic from '@anthropic-ai/sdk';
import type { GoogleGenAI } from '@google/genai';
import type OpenAI from 'openai';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { Mistral } from '@mistralai/mistralai';
import type { CohereClient } from 'cohere-ai';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  loadConfig,
  createLogger,
  initPricing,
  HarvestScheduler,
  sendEvents,
  sendMetrics,
  createAiRequest,
  createAiResponse,
  aiRequestToNrEvent,
  aiResponseToNrEvent,
  aiAgentTaskSummaryToNrEvent,
  aiAntiPatternToNrEvent,
  aiAgentMessageToNrEvent,
  aiContextResetToNrEvent,
  OtlpTransport,
  OtlpEventBridge,
} from '@nr-ai-observatory/shared';
import type { AiResponse, AiAgentTaskSummary, AiAgentMessage, AiContextReset } from '@nr-ai-observatory/shared';
import { AgenticTracer } from './agentic/tracer.js';
import type { TaskSpan } from './agentic/tracer.js';
import { AntiPatternDetector, emitAntiPatternEvent } from './agentic/anti-patterns.js';
import { TaskMetricsAggregator, TaskMetricsCalculator } from './agentic/task-metrics.js';
import type { TaskAggregateStats } from './agentic/task-metrics.js';
import { SubAgentTracker } from './agentic/sub-agent.js';
import { ContextManagementTracker } from './agentic/context-management.js';
import type { ContextResetDetails } from './agentic/context-management.js';
import { reasoningMetricsToCustomAttributes } from './metrics/reasoning.js';
import { modalityMetricsToCustomAttributes } from './metrics/multimodal.js';
import { CacheEconomicsTracker, extractCacheMetrics, cacheMetricsToCustomAttributes } from './metrics/cache-economics.js';
import { ConversationStore, conversationStateToCustomAttributes, conversationStateToNrEvent, type ConversationState } from './metrics/conversation.js';
import { QualityTracker, qualityMetricsToCustomAttributes, type QualitySignalInput } from './metrics/quality.js';
import { resolveAttribution, attributionTagsToCustomAttributes, type AttributionTags } from './metrics/cost-attribution.js';
import { ProviderComparisonAggregator, providerModelStatsToNrEvent } from './metrics/provider-comparison.js';
import { globalIntegrationRegistry } from './integrations/registry.js';
import type { IntegrationOptions } from './integrations/registry.js';
import { RecommendationEngine } from './intelligence/recommendations.js';
import type { Recommendation } from './intelligence/recommendations.js';
import { ExperimentTracker } from './intelligence/experiments.js';
import type { ExperimentConfig, ExperimentResults } from './intelligence/experiments.js';
import { SemanticDriftDetector } from './intelligence/semantic-drift.js';
import { AnomalyDetector } from './intelligence/anomaly-detection.js';
import { CostForecaster } from './intelligence/cost-forecasting.js';
import { CustomMetricsManager } from './api/custom-metrics.js';
import type { CustomSpan } from './api/custom-metrics.js';
import { OTelExporter } from './export/otel.js';
import type { AgentConfig } from '@nr-ai-observatory/shared';
import { initTracer } from './tracing.js';
import { wrapAnthropicClient as wrapAnthropic } from './wrappers/anthropic.js';
import { wrapGeminiClient as wrapGemini } from './wrappers/gemini.js';
import { wrapOpenAiClient as wrapOpenAI } from './wrappers/openai.js';
import { wrapBedrockClient as wrapBedrock } from './wrappers/bedrock.js';
import { wrapMistralClient as wrapMistral } from './wrappers/mistral.js';
import { wrapCohereClient as wrapCohere } from './wrappers/cohere.js';
import type {
  WrapperConfig,
  RecordHandler,
  EmbeddingRecordHandler,
  AiRequestRecord,
  AiEmbeddingRecord,
} from './types.js';

const logger = createLogger('agent');

const attributionStorage = new AsyncLocalStorage<AttributionTags>();

const DEFAULT_REDACTION_PATTERNS: readonly RegExp[] = [
  /\b(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|PRIVATE_KEY)\b[\s]*[=:]\s*\S+/gi,
  /(?:sk-|ghp_|gho_|github_pat_|xoxb-|xoxp-|Bearer\s+)\S+/g,
  /-----BEGIN[\s\S]{0,65536}?-----END[^\n]{0,256}-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIzaSy[0-9A-Za-z_-]{33}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bxox[a-z]-[0-9A-Za-z-]+/g,
];

export interface AgentStats {
  enabled: boolean;
  eventsBuffered: number;
  eventsSent: number;
  eventsDropped: number;
  uptimeMs: number;
}

let initPromise: Promise<NrAiAgent> | null = null;

export async function init(options?: Partial<AgentConfig>): Promise<NrAiAgent> {
  if (!initPromise) {
    const p = Promise.resolve().then(() => {
      const config = loadConfig(options);
      return new NrAiAgent(config);
    });
    // Reset on failure so callers can retry after a config error
    p.catch(() => {
      if (initPromise === p) initPromise = null;
    });
    initPromise = p;
  }
  return initPromise;
}

export class NrAiAgent {
  private readonly config: Readonly<AgentConfig>;
  private readonly scheduler: HarvestScheduler | null;
  private readonly wrapperConfig: WrapperConfig;
  private readonly startedAt: number;
  private readonly cacheTracker: CacheEconomicsTracker;
  private readonly conversationStore: ConversationStore;
  private readonly conversationIdContext: AsyncLocalStorage<string>;
  private readonly qualityTracker: QualityTracker;
  private readonly providerComparisonAggregator: ProviderComparisonAggregator;
  private readonly recentRequestIds: Map<string, number> = new Map();
  private providerComparisonIntervalId: ReturnType<typeof setInterval> | null = null;
  private taskMetricsIntervalId: ReturnType<typeof setInterval> | null = null;
  private readonly agenticTracer: AgenticTracer;
  private readonly antiPatternDetector: AntiPatternDetector;
  private readonly taskMetricsAggregator: TaskMetricsAggregator;
  private readonly subAgentTracker: SubAgentTracker;
  private readonly contextManagementTracker: ContextManagementTracker;
  private readonly recommendationEngine: RecommendationEngine;
  private readonly experimentTracker: ExperimentTracker;
  private readonly driftDetector: SemanticDriftDetector;
  private readonly anomalyDetector: AnomalyDetector;
  private readonly costForecaster: CostForecaster;
  private costForecastIntervalId: ReturnType<typeof setInterval> | null = null;
  private recommendationIntervalId: ReturnType<typeof setInterval> | null = null;
  private experimentSummaryIntervalId: ReturnType<typeof setInterval> | null = null;
  private readonly concludedExperiments = new Set<string>();
  private readonly customMetrics: CustomMetricsManager;
  private readonly otelExporter: OTelExporter;
  private readonly otlpTransport: OtlpTransport | null;
  private readonly taskSummaryListener: (e: Event) => void;
  private readonly agentMessageListener: (e: Event) => void;
  private readonly contextResetListener: (e: Event) => void;

  constructor(config: Readonly<AgentConfig>) {
    this.config = config;
    this.startedAt = Date.now();

    this.wrapperConfig = {
      enabled: config.enabled,
      recordContent: config.recordContent,
      highSecurity: config.highSecurity,
      contentMaxLength: config.contentMaxLength,
      redactionPatterns: DEFAULT_REDACTION_PATTERNS,
    };

    this.cacheTracker = new CacheEconomicsTracker(config.costTrackingEnabled ?? true);
    this.conversationStore = new ConversationStore(
      undefined,
      undefined,
      (state) => this.emitConversationSummaryEvent(state),
    );
    this.conversationIdContext = new AsyncLocalStorage<string>();
    this.qualityTracker = new QualityTracker();
    this.providerComparisonAggregator = new ProviderComparisonAggregator();

    this.agenticTracer = new AgenticTracer();
    this.antiPatternDetector = new AntiPatternDetector();
    this.taskMetricsAggregator = new TaskMetricsAggregator();
    this.subAgentTracker = new SubAgentTracker(this.agenticTracer);
    this.agenticTracer.setSubAgentTracker(this.subAgentTracker);
    this.contextManagementTracker = new ContextManagementTracker();

    this.recommendationEngine = new RecommendationEngine();
    this.experimentTracker = new ExperimentTracker();
    this.driftDetector = new SemanticDriftDetector({
      onDriftDetected: (feature, result) => {
        if (!this.scheduler) return;
        this.scheduler.recordMetric('ai.drift.score', result.similarity, { feature });
        this.scheduler.recordMetric('ai.drift.centroid_distance', result.centroidDistance, { feature });
        this.scheduler.recordMetric('ai.drift.detected', result.drifted ? 1 : 0, { feature });
      },
    });
    this.anomalyDetector = new AnomalyDetector();
    this.costForecaster = new CostForecaster({
      onAlert: (details) => {
        if (!this.scheduler) return;
        const appName = this.config.appName ?? 'nr-ai-agent';
        if (details.type === 'growth') {
          this.scheduler.addEvent({
            eventType: 'AiCostGrowthAlert',
            'nr.appName': appName,
            growthRatePercent: details.growthRatePercent ?? 0,
            growthThresholdPercent: details.growthThresholdPercent ?? 0,
            timestamp: Date.now(),
          });
        } else if (details.type === 'forecast') {
          this.scheduler.addEvent({
            eventType: 'AiCostForecastAlert',
            'nr.appName': appName,
            projectedMonthlyCostUsd: details.projectedMonthlyCostUsd ?? 0,
            monthlyBudgetUsd: details.monthlyBudgetUsd ?? 0,
            timestamp: Date.now(),
          });
        }
      },
    });
    this.customMetrics = new CustomMetricsManager(config.appName ?? 'nr-ai-agent');
    this.otelExporter = new OTelExporter();
    this.otlpTransport = null;

    this.taskSummaryListener = (e: Event) => {
      const summary = (e as CustomEvent<AiAgentTaskSummary>).detail;
      if (!this.scheduler) return;
      const appName = this.config.appName ?? 'nr-ai-agent';
      const subAgentMetrics = this.subAgentTracker.getMetrics(summary.spanId);
      const summaryWithApp = {
        ...summary,
        'nr.appName': appName,
        delegationCount: subAgentMetrics.delegationCount,
        spawnCount: subAgentMetrics.spawnCount,
        delegationDepth: subAgentMetrics.delegationDepth,
        interAgentMessages: subAgentMetrics.interAgentMessages,
        delegationOverheadMs: subAgentMetrics.delegationOverheadMs,
      };
      this.scheduler.addEvent(aiAgentTaskSummaryToNrEvent(summaryWithApp));

      const completedSpans = this.agenticTracer.getCompletedSpans();
      const taskSpan = completedSpans.find((s) => s.spanId === summary.spanId);
      if (taskSpan) {
        const perTask = TaskMetricsCalculator.computePerTaskMetrics(taskSpan);
        this.taskMetricsAggregator.recordTaskMetrics(perTask);
        const antiPatterns = this.antiPatternDetector.analyze(taskSpan);
        let hasSpinningWheels = false;
        for (const pattern of antiPatterns) {
          const event = emitAntiPatternEvent(pattern, summary.traceId, appName);
          this.scheduler.addEvent(aiAntiPatternToNrEvent(event));
          this.scheduler.recordMetric('ai.agent.anti_pattern_count', 1, { type: pattern.type });
          if (pattern.type === 'spinning_wheels') hasSpinningWheels = true;
        }
        if (hasSpinningWheels) {
          this.taskMetricsAggregator.recordSpinningWheels();
        }
      }
    };

    this.agentMessageListener = (e: Event) => {
      const event = (e as CustomEvent<AiAgentMessage>).detail;
      if (!this.scheduler) return;
      const withApp = { ...event, 'nr.appName': this.config.appName ?? 'nr-ai-agent' };
      this.scheduler.addEvent(aiAgentMessageToNrEvent(withApp));
    };

    this.contextResetListener = (e: Event) => {
      const event = (e as CustomEvent<AiContextReset>).detail;
      if (!this.scheduler) return;
      const activeContext = this.agenticTracer.getActiveTraceContext();
      const withApp = {
        ...event,
        'nr.appName': this.config.appName ?? 'nr-ai-agent',
        ...(activeContext ? { traceId: activeContext.traceId } : {}),
      };
      this.scheduler.addEvent(aiContextResetToNrEvent(withApp));
      this.scheduler.recordMetric('ai.context.compression_ratio', withApp.compressionRatio, {
        conversationId: withApp.conversationId,
      });
      this.scheduler.recordMetric('ai.context.tokens_removed', withApp.tokensRemoved, {
        conversationId: withApp.conversationId,
      });
    };

    globalThis.addEventListener?.('ai-agent-task-summary', this.taskSummaryListener);
    globalThis.addEventListener?.('ai-agent-message', this.agentMessageListener);
    globalThis.addEventListener?.('ai-context-reset', this.contextResetListener);

    if (!config.enabled) {
      this.scheduler = null;
      logger.info('Agent initialized in no-op mode (enabled=false)');
      return;
    }

    if (!config.accountId) {
      throw new Error(
        'Missing required configuration: NEW_RELIC_ACCOUNT_ID. ' +
          'Set the NEW_RELIC_ACCOUNT_ID environment variable or pass accountId in options.',
      );
    }

    initPricing(config.customPricingFile);

    let otlpTransport: OtlpTransport | null = null;
    let otlpEventBridge: OtlpEventBridge | null = null;

    if (config.otlpEndpoint) {
      const appName = config.appName ?? 'nr-ai-agent';
      otlpTransport = new OtlpTransport({
        endpoint: config.otlpEndpoint,
        headers: config.otlpHeaders,
        appName,
      });
      otlpEventBridge = new OtlpEventBridge({
        endpoint: config.otlpEndpoint,
        headers: config.otlpHeaders,
        appName,
      });
      otlpTransport.start();
      initTracer();
    }
    this.otlpTransport = otlpTransport;

    this.scheduler = new HarvestScheduler({
      licenseKey: config.licenseKey,
      transportOptions: {
        accountId: config.accountId,
        collectorHost: config.collectorHost,
      },
      sendEventsFn: sendEvents,
      sendMetricsFn: sendMetrics,
      otlpEventBridge: otlpEventBridge ?? undefined,
      otlpTransport: otlpTransport ?? undefined,
      transport: config.transport,
    });

    this.scheduler.start();

    this.customMetrics.setEventHandler((event) => {
      const e = event as { eventType: string; attributes: Record<string, unknown> };
      const flat: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(e.attributes)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          flat[k] = v;
        }
      }
      this.scheduler!.addEvent({ eventType: e.eventType, ...flat });
    });

    this.customMetrics.setMetricHandler((metric) => {
      const m = metric as { name: string; value: number; attributes?: Record<string, string | number> };
      this.scheduler!.recordMetric(m.name, m.value, m.attributes ?? {});
    });

    this.customMetrics.setSpanHandler((span) => {
      const s = span as { name: string; startTime: number; endTime: number; duration_ms: number; attributes: Record<string, unknown> };
      this.scheduler!.recordMetric('ai.custom.span.duration_ms', s.duration_ms, { spanName: s.name });
    });

    // Emit provider comparison summary events every 60s aligned with metric harvest
    this.providerComparisonIntervalId = setInterval(() => {
      this.emitProviderComparisonMetrics();
    }, 60_000);

    this.taskMetricsIntervalId = setInterval(() => {
      this.emitTaskAggregateMetrics();
    }, 60_000);

    this.costForecastIntervalId = setInterval(() => {
      this.emitCostForecastMetrics();
    }, 60_000);

    // Emit AiRecommendation events every 5 minutes
    this.recommendationIntervalId = setInterval(() => {
      this.emitRecommendationEvents();
    }, 5 * 60_000);

    // Emit AiExperimentSummary every 6 hours; check for conclusions at the same cadence
    this.experimentSummaryIntervalId = setInterval(() => {
      this.emitExperimentSummaries();
    }, 6 * 60 * 60_000);

    logger.info('Agent initialized', { appName: config.appName });
  }

  wrapAnthropicClient(client: Anthropic): Anthropic {
    if (!this.config.enabled) return client;

    const onRecord: RecordHandler = (record) => {
      this.ingestRequestRecord(record);
    };

    return wrapAnthropic(client, this.wrapperConfig, onRecord);
  }

  wrapOpenAiClient(client: OpenAI): OpenAI {
    if (!this.config.enabled) return client;

    const onRecord: RecordHandler = (record) => {
      this.ingestRequestRecord(record);
    };

    return wrapOpenAI(client, this.wrapperConfig, onRecord);
  }

  wrapGeminiClient(client: GoogleGenAI): GoogleGenAI {
    if (!this.config.enabled) return client;

    const onRecord: RecordHandler = (record) => {
      this.ingestRequestRecord(record);
    };

    const onEmbeddingRecord: EmbeddingRecordHandler = (record) => {
      this.ingestEmbeddingRecord(record);
    };

    return wrapGemini(client, this.wrapperConfig, onRecord, onEmbeddingRecord);
  }

  wrapBedrockClient(client: BedrockRuntimeClient): BedrockRuntimeClient {
    if (!this.config.enabled) return client;

    const onRecord: RecordHandler = (record) => {
      this.ingestRequestRecord(record);
    };

    return wrapBedrock(client, this.wrapperConfig, onRecord);
  }

  wrapMistralClient(client: Mistral): Mistral {
    if (!this.config.enabled) return client;

    const onRecord: RecordHandler = (record) => {
      this.ingestRequestRecord(record);
    };

    return wrapMistral(client, this.wrapperConfig, onRecord);
  }

  wrapCohereClient(client: CohereClient): CohereClient {
    if (!this.config.enabled) return client;

    const onRecord: RecordHandler = (record) => {
      this.ingestRequestRecord(record);
    };

    return wrapCohere(client, this.wrapperConfig, onRecord);
  }

  setConversationId(conversationId: string): void {
    this.conversationIdContext.enterWith(conversationId);
  }

  getConversationStats(conversationId: string): ReturnType<ConversationStore['getState']> {
    return this.conversationStore.getState(conversationId);
  }

  endConversation(conversationId: string): void {
    this.conversationStore.end(conversationId);
  }

  recordFeedback(requestId: string, score: number, metadata?: Record<string, string>): void {
    if (!this.recentRequestIds.has(requestId)) {
      logger.warn('Feedback for unknown request ID', { requestId });
      return;
    }
    this.qualityTracker.recordFeedback(requestId, score, metadata);
    this.anomalyDetector.recordSignal('user_feedback', score, Date.now());
    if (this.scheduler) {
      const feedbackEvent: Record<string, string | number | boolean> = {
        eventType: 'AiQualityFeedback',
        'nr.appName': this.config.appName ?? '',
        requestId,
        score,
      };
      if (metadata) {
        for (const [k, v] of Object.entries(metadata)) {
          feedbackEvent[k] = v;
        }
      }
      this.scheduler.addEvent(feedbackEvent);
    }
  }

  recordRegeneration(requestId: string): void {
    if (!this.recentRequestIds.has(requestId)) {
      logger.warn('Regeneration for unknown request ID', { requestId });
      return;
    }
    this.qualityTracker.recordRegeneration(requestId);
    this.anomalyDetector.recordSignal('regeneration_rate', 1, Date.now());
  }

  recordEditDistance(requestId: string, editDistance: number): void {
    if (!this.recentRequestIds.has(requestId)) {
      logger.warn('Edit distance for unknown request ID', { requestId });
      return;
    }
    this.qualityTracker.recordEditDistance(requestId, editDistance);
    this.anomalyDetector.recordSignal('edit_distance', editDistance, Date.now());
  }

  setAttributionContext(tags: AttributionTags): void {
    attributionStorage.enterWith(tags);
  }

  startTask(name: string, metadata?: Record<string, string>): TaskSpan {
    return this.agenticTracer.startTask(name, metadata);
  }

  async registerIntegration(frameworkName: string, options?: IntegrationOptions): Promise<void> {
    await globalIntegrationRegistry.registerIntegration(frameworkName, options);
  }

  getTaskMetrics(): TaskAggregateStats {
    return this.taskMetricsAggregator.getAggregateStats();
  }

  recordContextReset(conversationId: string, details: ContextResetDetails & { tokensBefore?: number; tokensAfter?: number }): void {
    this.contextManagementTracker.recordContextReset(conversationId, details);
  }

  getRecommendations(): Recommendation[] {
    return this.recommendationEngine.analyze();
  }

  defineExperiment(config: ExperimentConfig): void {
    this.experimentTracker.defineExperiment(config);
  }

  tagRequest(experimentName: string, variant: string): void {
    this.experimentTracker.tagRequest(experimentName, variant);
  }

  getCurrentVariant(experimentName: string): string | null {
    return this.experimentTracker.getCurrentVariant(experimentName);
  }

  getExperimentResults(experimentName: string): ExperimentResults {
    return this.experimentTracker.getExperimentResults(experimentName);
  }

  recordMetricValue(experimentName: string, variant: string, metricName: string, value: number): void {
    this.experimentTracker.recordMetricValue(experimentName, variant, metricName, value);
  }

  recordCustomEvent(eventName: string, attributes: Record<string, unknown>): void {
    this.customMetrics.recordCustomEvent(eventName, attributes);
  }

  recordCustomMetric(name: string, value: number, attributes?: Record<string, string | number | boolean>): void {
    this.customMetrics.recordCustomMetric(name, value, attributes);
  }

  startCustomSpan(spanName: string, attributes?: Record<string, unknown>): CustomSpan {
    return this.customMetrics.startCustomSpan(spanName, attributes);
  }

  instrument<T extends (...args: unknown[]) => Promise<unknown> | unknown>(spanName: string, fn: T): T {
    return this.customMetrics.instrument(spanName, fn);
  }

  getOTelExporter(): OTelExporter {
    return this.otelExporter;
  }

  getDriftDetector(): SemanticDriftDetector {
    return this.driftDetector;
  }

  getAnomalyDetector(): AnomalyDetector {
    return this.anomalyDetector;
  }

  async shutdown(): Promise<void> {
    globalThis.removeEventListener?.('ai-agent-task-summary', this.taskSummaryListener);
    globalThis.removeEventListener?.('ai-agent-message', this.agentMessageListener);
    globalThis.removeEventListener?.('ai-context-reset', this.contextResetListener);
    if (this.providerComparisonIntervalId !== null) {
      clearInterval(this.providerComparisonIntervalId);
      this.providerComparisonIntervalId = null;
    }
    if (this.taskMetricsIntervalId !== null) {
      clearInterval(this.taskMetricsIntervalId);
      this.taskMetricsIntervalId = null;
    }
    if (this.costForecastIntervalId !== null) {
      clearInterval(this.costForecastIntervalId);
      this.costForecastIntervalId = null;
    }
    if (this.recommendationIntervalId !== null) {
      clearInterval(this.recommendationIntervalId);
      this.recommendationIntervalId = null;
    }
    if (this.experimentSummaryIntervalId !== null) {
      clearInterval(this.experimentSummaryIntervalId);
      this.experimentSummaryIntervalId = null;
    }
    this.emitProviderComparisonMetrics();
    this.emitTaskAggregateMetrics();
    this.emitCostForecastMetrics();
    this.emitRecommendationEvents();
    this.emitExperimentSummaries();
    this.conversationStore.shutdown();
    if (this.scheduler) {
      await this.scheduler.stop();
    }
    if (this.otlpTransport) {
      await this.otlpTransport.shutdown();
    }
    initPromise = null;
    logger.info('Agent shut down');
  }

  getStats(): AgentStats {
    return {
      enabled: this.config.enabled,
      eventsBuffered: 0,
      eventsSent: 0,
      eventsDropped: 0,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  private ingestRequestRecord(record: AiRequestRecord): void {
    if (!this.scheduler) return;

    const appName = this.config.appName;

    // Track request ID for feedback callbacks
    this.recentRequestIds.set(record.id, Date.now());
    // Clean up old request IDs (keep last 1000 for 1 hour window)
    if (this.recentRequestIds.size > 1000) {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      for (const [id, timestamp] of Array.from(this.recentRequestIds.entries())) {
        if (timestamp < oneHourAgo) {
          this.recentRequestIds.delete(id);
        }
      }
    }

    const reasoningAttributes = reasoningMetricsToCustomAttributes(
      record.reasoningMetrics ?? null,
    );

    // Resolve conversation ID from context, record, or use default
    const conversationId = this.conversationIdContext.getStore() ?? record.conversationId ?? 'default';

    // Record conversation turn
    let conversationState = this.conversationStore.getOrCreate(conversationId, record.model);
    if (!record.error) {
      conversationState = this.conversationStore.recordTurn(
        conversationId,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.thinkingTokens,
        record.cost ?? 0,
        record.durationMs,
        record.systemPromptLength ?? null,
      );
      this.contextManagementTracker.recordTurn(conversationId, record.inputTokens, record.outputTokens);
    }

    const conversationAttributes = conversationStateToCustomAttributes(conversationState);

    // Resolve attribution tags (per-request > context > global defaults)
    const attributionTags = resolveAttribution(
      record.requestMetadata ?? null,
      attributionStorage.getStore(),
      this.config.attributionDefaults ?? undefined,
    );
    const attributionAttributes = attributionTagsToCustomAttributes(attributionTags);

    // Record quality signals
    const qualityInput: QualitySignalInput = {
      durationMs: record.durationMs,
      timeToFirstTokenMs: record.timeToFirstTokenMs,
      outputTokens: record.outputTokens,
      stopReason: record.stopReason,
      error: record.error,
      depthIndex: record.reasoningMetrics?.depthIndex ?? null,
    };

    const qualityAnomalyFlags = this.qualityTracker.recordStructuralSignals(qualityInput);
    // Convert boolean anomaly flags to numbers for custom attributes
    const normalizedQualityFlags: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(qualityAnomalyFlags)) {
      normalizedQualityFlags[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    }

    const qualityMetrics = this.qualityTracker.getMetrics();
    const qualityAttributes = qualityMetricsToCustomAttributes(qualityMetrics);
    this.scheduler.recordMetric('ai.quality.score', qualityMetrics.qualityScore, {
      provider: record.provider,
      model: record.model,
    });

    this.recommendationEngine.recordModelUsage(
      record.model,
      record.cost ?? 0,
      qualityMetrics.qualityScore,
    );

    // Feed anomaly detector with structural signals from each request
    const ts = record.timestamp;
    this.anomalyDetector.recordSignal('latency_ms', record.durationMs, ts);
    this.anomalyDetector.recordSignal('response_length', record.outputTokens, ts);
    // Always record 0/1 per request so the baseline distribution includes normal (non-error) requests
    this.anomalyDetector.recordSignal('error_rate', record.error ? 1 : 0, ts);
    // encode stop_reason as numeric: end_turn=1, max_tokens=2, tool_use=3, null/other=0
    const stopReasonCode = record.stopReason === 'end_turn' ? 1
      : record.stopReason === 'max_tokens' ? 2
      : record.stopReason === 'tool_use' ? 3 : 0;
    this.anomalyDetector.recordSignal('stop_reason', stopReasonCode, ts);
    if (record.reasoningMetrics?.depthIndex != null) {
      this.anomalyDetector.recordSignal('thinking_depth', record.reasoningMetrics.depthIndex, ts);
    }
    // Emit composite anomaly score as a metric
    if (this.scheduler) {
      const compositeScore = this.anomalyDetector.getCompositeScore();
      this.scheduler.recordMetric('ai.quality.anomaly_score', compositeScore, {
        provider: record.provider,
        model: record.model,
      });
    }

    // Feed semantic drift score to the anomaly detector (fire-and-forget; only runs when embedding fn is set)
    if (record.responseText && this.driftDetector.isInitialized()) {
      this.driftDetector.checkDrift(record.responseText).then((result) => {
        this.anomalyDetector.recordSignal('drift_score', result.similarity, record.timestamp);
      }).catch(() => { /* best-effort — drift check failure must not disrupt the main record path */ });
    }

    // Feed cost forecaster so it can project future spend with full attribution dimensions
    if (record.cost != null && record.cost > 0) {
      this.costForecaster.recordCost(record.timestamp, record.cost, {
        model: record.model,
        feature: attributionTags.feature,
        team: attributionTags.team,
      });
    }

    if (record.thinkingBudgetTokens && record.thinkingTokens !== undefined) {
      const budgetUtilization = record.thinkingBudgetTokens > 0
        ? (record.thinkingTokens / record.thinkingBudgetTokens) * 100
        : 0;
      this.recommendationEngine.recordThinkingBudgetUsage(budgetUtilization);
    }

    const modalityAttributes = record.modalityMetrics
      ? modalityMetricsToCustomAttributes(record.modalityMetrics)
      : {};
    if (record.modalityMetrics && record.modalityMetrics.imageTokenEstimate > 0) {
      this.scheduler.recordMetric('ai.multimodal.image_tokens', record.modalityMetrics.imageTokenEstimate, {
        provider: record.provider,
        model: record.model,
      });
    }
    if (record.modalityMetrics && record.modalityMetrics.imageCount > 0) {
      this.scheduler.recordMetric('ai.multimodal.requests_with_images', 1, {
        provider: record.provider,
        model: record.model,
      });
    }

    // Per-request cache economics attributes
    const cacheMetrics = extractCacheMetrics(
      {
        model: record.model,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        thinkingTokens: record.thinkingTokens,
        cacheReadTokens: record.cacheReadTokens,
        cacheCreationTokens: record.cacheCreationTokens,
        totalTokens: record.totalTokens,
      } as unknown as AiResponse,
      this.config.costTrackingEnabled !== false,
    );
    const cacheAttributes = cacheMetricsToCustomAttributes(cacheMetrics);

    // Attach active experiment tags as standardized ai.experiment.name / ai.experiment.variant fields
    // Multiple active experiments are comma-joined in declaration order
    const experimentAttributes: Record<string, string> = {};
    const activeVariants = this.experimentTracker.getActiveVariants();
    if (activeVariants.size > 0) {
      experimentAttributes['ai.experiment.name'] = Array.from(activeVariants.keys()).join(',');
      experimentAttributes['ai.experiment.variant'] = Array.from(activeVariants.values()).join(',');
    }

    const customAttributes = {
      ...reasoningAttributes,
      ...modalityAttributes,
      ...conversationAttributes,
      ...attributionAttributes,
      ...normalizedQualityFlags,
      ...qualityAttributes,
      ...cacheAttributes,
      ...experimentAttributes,
    };

    const request = createAiRequest({
      id: record.id,
      timestamp: record.timestamp,
      provider: record.provider,
      model: record.requestModel,
      requestMethod: resolveRequestMethod(record),
      maxTokens: record.maxTokens,
      temperature: record.temperature,
      topP: record.topP,
      systemPromptLength: record.systemPromptLength,
      messageCount: record.messageCount,
      toolCount: record.toolCount,
      toolNames: [...record.toolNames],
      thinkingEnabled: record.thinkingEnabled,
      thinkingBudgetTokens: record.thinkingBudgetTokens,
      streamingEnabled: record.streaming,
      appName,
      customAttributes,
    });

    const response = createAiResponse({
      id: record.id,
      timestamp: record.timestamp,
      provider: record.provider,
      model: record.model,
      durationMs: record.durationMs,
      timeToFirstTokenMs: record.timeToFirstTokenMs,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      thinkingTokens: record.thinkingTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheCreationTokens: record.cacheCreationTokens,
      stopReason: record.stopReason,
      contentBlockTypes: [...record.contentBlockTypes],
      error: record.error,
      appName,
      customAttributes,
    });

    this.scheduler.addEvent(aiRequestToNrEvent(request));
    this.scheduler.addEvent(aiResponseToNrEvent(response));

    // Record cache economics metrics
    this.cacheTracker.record(response);
    const cacheAggregates = this.cacheTracker.getAggregates();

    // Feed per-feature cache stats to recommendation engine
    this.recommendationEngine.recordFeatureCacheMetrics(
      attributionTags.feature ?? 'default',
      cacheAggregates.cacheHitRate,
      record.systemPromptLength != null && record.systemPromptLength > 0,
      record.cacheReadTokens,
    );

    this.scheduler.recordMetric('ai.cache.hit_rate', cacheAggregates.cacheHitRate, {
      provider: record.provider,
      model: record.model,
    });
    if (this.config.costTrackingEnabled !== false) {
      this.scheduler.recordMetric('ai.cache.cumulative_savings_usd', cacheAggregates.cumulativeSavingsUsd, {
        provider: record.provider,
        model: record.model,
      });
      if (cacheAggregates.cacheRoi !== null && Number.isFinite(cacheAggregates.cacheRoi)) {
        this.scheduler.recordMetric('ai.cache.roi', cacheAggregates.cacheRoi, {
          provider: record.provider,
          model: record.model,
        });
      }
      if (cacheAggregates.cacheEfficiencyScore !== null) {
        this.scheduler.recordMetric('ai.cache.efficiency_score', cacheAggregates.cacheEfficiencyScore, {
          provider: record.provider,
          model: record.model,
        });
      }
    }

    // Record provider comparison metrics
    const tokensPerSecond = record.durationMs > 0 ? (record.outputTokens / (record.durationMs / 1000)) : 0;
    this.providerComparisonAggregator.record(
      record.provider,
      record.model,
      record.durationMs,
      record.timeToFirstTokenMs,
      tokensPerSecond,
      record.cost ?? 0,
      record.error !== null,
      record.thinkingTokens,
      record.reasoningMetrics?.depthIndex ?? null,
      null, // category
    );

    this.scheduler.recordMetric('ai.request.duration', record.durationMs, {
      provider: record.provider,
      model: record.model,
    });

    if (record.totalTokens > 0) {
      this.scheduler.recordMetric('ai.tokens.total', record.totalTokens, {
        provider: record.provider,
        model: record.model,
      });
    }

    if (record.error) {
      this.scheduler.recordMetric('ai.error', 1, {
        provider: record.provider,
        model: record.model,
        errorType: record.error.type,
      });
    }

    if (record.reasoningMetrics?.depthIndex !== null && record.reasoningMetrics?.depthIndex !== undefined) {
      this.scheduler.recordMetric('ai.reasoning.depth_index', record.reasoningMetrics.depthIndex, {
        provider: record.provider,
        model: record.model,
      });
    }

    if (record.reasoningMetrics?.budgetUtilization !== null && record.reasoningMetrics?.budgetUtilization !== undefined) {
      this.scheduler.recordMetric('ai.reasoning.budget_utilization', record.reasoningMetrics.budgetUtilization, {
        provider: record.provider,
        model: record.model,
      });
    }
  }

  private emitProviderComparisonMetrics(): void {
    if (!this.scheduler) return;

    const appName = this.config.appName;
    const allStats = this.providerComparisonAggregator.getAllMetrics();

    for (const stats of allStats.values()) {
      this.scheduler.addEvent(providerModelStatsToNrEvent(stats, appName));

      this.scheduler.recordMetric('ai.provider.avg_duration_ms', stats.avgDurationMs, {
        provider: stats.provider,
        model: stats.model,
        category: stats.category,
      });
      this.scheduler.recordMetric('ai.provider.p95_duration_ms', stats.p95DurationMs, {
        provider: stats.provider,
        model: stats.model,
        category: stats.category,
      });
      this.scheduler.recordMetric('ai.provider.avg_cost_per_request_usd', stats.avgCostPerRequestUsd, {
        provider: stats.provider,
        model: stats.model,
        category: stats.category,
      });
      this.scheduler.recordMetric('ai.provider.error_rate', stats.errorRate, {
        provider: stats.provider,
        model: stats.model,
        category: stats.category,
      });
      this.scheduler.recordMetric('ai.provider.avg_tokens_per_second', stats.avgTokensPerSecond, {
        provider: stats.provider,
        model: stats.model,
        category: stats.category,
      });
      if (stats.avgTtftMs > 0) {
        this.scheduler.recordMetric('ai.provider.avg_ttft_ms', stats.avgTtftMs, {
          provider: stats.provider,
          model: stats.model,
          category: stats.category,
        });
      }
    }
  }

  private emitTaskAggregateMetrics(): void {
    if (!this.scheduler) return;
    const stats = this.taskMetricsAggregator.getAggregateStats();
    if (stats.completedTaskCount === 0) return;
    this.scheduler.recordMetric('ai.agent.avg_cost_per_task_usd', stats.avgCostPerTask, {});
    this.scheduler.recordMetric('ai.agent.completion_rate', stats.completionRate, {});
    this.scheduler.recordMetric('ai.agent.avg_steps_per_task', stats.avgStepsPerTask, {});
    this.scheduler.recordMetric('ai.agent.avg_duration_ms', stats.avgDurationMs, {});
    this.scheduler.recordMetric('ai.agent.spinning_wheels_rate', this.taskMetricsAggregator.getSpinningWheelsRate(), {});
  }

  private emitCostForecastMetrics(): void {
    if (!this.scheduler) return;
    const forecast = this.costForecaster.forecast(30);
    this.scheduler.recordMetric('ai.forecast.projected_monthly_cost_usd', forecast.projectedMonthlyCostUsd, {});
    this.scheduler.recordMetric('ai.forecast.growth_rate_percent', forecast.growthRatePercent, {});
    this.scheduler.recordMetric('ai.forecast.confidence_interval_low', forecast.confidenceIntervalLow, {});
    this.scheduler.recordMetric('ai.forecast.confidence_interval_high', forecast.confidenceIntervalHigh, {});
    const nextDayCost = forecast.projectedDailyCostUsd[0] ?? 0;
    this.scheduler.recordMetric('ai.forecast.projected_daily_cost_usd', nextDayCost, {});
    if (forecast.projectedBudgetExceedDate !== null) {
      const exceedMs = new Date(forecast.projectedBudgetExceedDate).getTime();
      if (!isNaN(exceedMs)) {
        this.scheduler.recordMetric('ai.forecast.budget_exceed_date', exceedMs, {});
      }
    }
  }

  private emitExperimentSummaries(): void {
    if (!this.scheduler) return;
    const appName = this.config.appName ?? 'nr-ai-agent';
    const now = Date.now();

    for (const expName of this.experimentTracker.getExperimentNames()) {
      const results = this.experimentTracker.getExperimentResults(expName);
      const config = this.experimentTracker.getExperimentConfig(expName);

      // Periodic summary event — include per-variant stats for the primary metric
      const summaryEvent: Record<string, string | number> = {
        eventType: 'AiExperimentSummary',
        'nr.appName': appName,
        experimentName: expName,
        variantCount: config?.variants.length ?? 0,
        metricCount: results.metrics.length,
        recommendedWinner: results.recommendedWinner ?? '',
        timestamp: now,
      };
      const primaryMetric = results.metrics[0];
      if (primaryMetric) {
        summaryEvent['primaryMetric'] = primaryMetric.metric;
        for (const vs of primaryMetric.variantStats) {
          summaryEvent[`variant.${vs.variant}.mean`] = vs.mean;
          summaryEvent[`variant.${vs.variant}.p95`] = vs.p95;
          summaryEvent[`variant.${vs.variant}.sampleCount`] = vs.sampleCount;
        }
      }
      this.scheduler.addEvent(summaryEvent);

      // Conclusion event: winner declared OR experiment end date reached
      if (!this.concludedExperiments.has(expName)) {
        const endDateReached = config?.endDate != null && config.endDate.getTime() <= now;
        if (results.recommendedWinner !== null || endDateReached) {
          this.concludedExperiments.add(expName);
          // Find the winning pairwise comparison for the primary metric
          const winningComparison = primaryMetric?.pairwiseComparisons.find(
            (c) => c.isSignificant,
          );
          const conclusionEvent: Record<string, string | number> = {
            eventType: 'AiExperimentConclusion',
            'nr.appName': appName,
            experimentName: expName,
            recommendedWinner: results.recommendedWinner ?? '',
            concluded: 1,
            endDateReached: endDateReached ? 1 : 0,
            timestamp: now,
          };
          // Only attach statistical fields when there is a declared winner — these are meaningless
          // for experiments that expired by end date with no statistically significant result.
          if (winningComparison && results.recommendedWinner !== null) {
            conclusionEvent['pValue'] = winningComparison.pValue;
            conclusionEvent['effectSize'] = winningComparison.relativeDifference;
            const winnerStats = primaryMetric?.variantStats.find(
              (v) => v.variant === results.recommendedWinner,
            );
            const loserVariant =
              winningComparison.variant1 === results.recommendedWinner
                ? winningComparison.variant2
                : winningComparison.variant1;
            const loserStats = primaryMetric?.variantStats.find((v) => v.variant === loserVariant);
            if (winnerStats) conclusionEvent['winnerSampleCount'] = winnerStats.sampleCount;
            if (loserStats) conclusionEvent['loserSampleCount'] = loserStats.sampleCount;
          }
          this.scheduler.addEvent(conclusionEvent);
        }
      }
    }
  }

  private emitRecommendationEvents(): void {
    if (!this.scheduler) return;
    const recommendations = this.recommendationEngine.analyze();
    const appName = this.config.appName ?? 'nr-ai-agent';
    for (const rec of recommendations) {
      this.scheduler.addEvent({
        eventType: 'AiRecommendation',
        'nr.appName': appName,
        type: rec.type,
        severity: rec.severity,
        title: rec.title,
        description: rec.description,
        estimatedImpact: rec.estimatedImpact,
        confidence: rec.confidence,
        timestamp: Date.now(),
      });
    }
  }

  private emitConversationSummaryEvent(state: ConversationState): void {
    if (!this.scheduler || state.turnCount === 0) return;
    const ctxStats = this.contextManagementTracker.getMetrics(state.conversationId);
    const event = conversationStateToNrEvent(state, this.config.appName, ctxStats);
    this.scheduler.addEvent(event);
    // Feed conversation context pressure data to the recommendation engine
    this.recommendationEngine.recordContextPressure(state.turnCount, null);
  }

  private ingestEmbeddingRecord(record: AiEmbeddingRecord): void {
    if (!this.scheduler) return;

    const appName = this.config.appName;

    // Apply attribution context — embeddings carry real cost and should be attributable
    const attributionTags = resolveAttribution(
      null,
      attributionStorage.getStore(),
      this.config.attributionDefaults ?? undefined,
    );
    const customAttributes = attributionTagsToCustomAttributes(attributionTags);

    const request = createAiRequest({
      id: record.id,
      timestamp: record.timestamp,
      provider: record.provider,
      model: record.requestModel,
      requestMethod: 'models.embedContent',
      messageCount: 1,
      streamingEnabled: false,
      appName,
      customAttributes,
    });

    const response = createAiResponse({
      id: record.id,
      timestamp: record.timestamp,
      provider: record.provider,
      model: record.model || record.requestModel,
      durationMs: record.durationMs,
      inputTokens: record.inputTokens,
      outputTokens: 0,
      error: record.error,
      appName,
      customAttributes,
    });

    this.scheduler.addEvent(aiRequestToNrEvent(request));
    this.scheduler.addEvent(aiResponseToNrEvent(response));

    this.scheduler.recordMetric('ai.embedding.duration', record.durationMs, {
      provider: record.provider,
      model: record.requestModel,
    });
  }
}

function resolveRequestMethod(
  record: AiRequestRecord,
): 'messages.create' | 'messages.stream' | 'models.generateContent' | 'models.generateContentStream' | 'chat.completions.create' | 'converse' | 'converse-stream' | 'chat.complete' | 'chat.stream' | 'chat' | 'chatStream' {
  if (record.provider === 'anthropic') {
    return record.streaming ? 'messages.stream' : 'messages.create';
  }
  if (record.provider === 'openai') {
    return 'chat.completions.create';
  }
  if (record.provider === 'bedrock') {
    return record.streaming ? 'converse-stream' : 'converse';
  }
  if (record.provider === 'mistral') {
    return record.streaming ? 'chat.stream' : 'chat.complete';
  }
  if (record.provider === 'cohere') {
    return record.streaming ? 'chatStream' : 'chat';
  }
  return record.streaming ? 'models.generateContentStream' : 'models.generateContent';
}

export { wrapBedrockClient } from './wrappers/bedrock.js';
export { wrapMistralClient } from './wrappers/mistral.js';
export { wrapCohereClient } from './wrappers/cohere.js';
