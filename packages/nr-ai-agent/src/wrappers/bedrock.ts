import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import {
  ConverseCommand,
  ConverseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommandInput,
  ConverseStreamOutput,
  ContentBlock,
  Message,
} from '@aws-sdk/client-bedrock-runtime';
import { SpanStatusCode } from '@opentelemetry/api';
import { randomUUID } from 'node:crypto';
import { RequestTimer } from '@nr-ai-observatory/shared';
import type { RequestTimerMetrics } from '@nr-ai-observatory/shared';
import { extractReasoningMetrics } from '../metrics/reasoning.js';
import { generateConversationIdFromMessages } from '../metrics/conversation.js';
import { detectModalities } from '../metrics/multimodal.js';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';
import { getTracer } from '../tracing.js';
import { buildSpanName, buildRequestAttributes, buildResponseAttributes } from '../span-attributes.js';

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function redact(text: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((s, pattern) => s.replace(pattern, '[REDACTED]'), text);
}

function extractSystemPromptLength(input: ConverseCommandInput): number | null {
  if (!input.system || input.system.length === 0) return null;
  return input.system.reduce((sum, block) => {
    return sum + ('text' in block && typeof block.text === 'string' ? block.text.length : 0);
  }, 0);
}

function extractSystemPromptText(input: ConverseCommandInput): string | null {
  if (!input.system || input.system.length === 0) return null;
  const textBlocks = input.system.filter(
    (b): b is { text: string } => 'text' in b && typeof b.text === 'string',
  );
  return textBlocks.map((b) => b.text).join('\n') || null;
}

function extractLastUserMessage(messages: Message[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && msg.content) {
      for (const block of msg.content) {
        if ('text' in block && typeof block.text === 'string') return block.text;
      }
    }
  }
  return null;
}

function extractResponseText(content: ContentBlock[] | undefined): string | null {
  if (!content) return null;
  const textBlocks = content.filter((b): b is { text: string } => 'text' in b);
  return textBlocks.length === 0 ? null : textBlocks.map((b) => b.text).join('');
}

function extractContentBlockTypes(content: ContentBlock[] | undefined): string[] {
  if (!content) return [];
  return [...new Set(content.map((b) => ('text' in b ? 'text' : 'other')))];
}

function buildBaseRecord(
  input: ConverseCommandInput,
  config: WrapperConfig,
  requestMethod: string,
  streaming: boolean,
): Omit<
  AiRequestRecord,
  | 'durationMs'
  | 'timeToFirstTokenMs'
  | 'inputTokens'
  | 'outputTokens'
  | 'thinkingTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
  | 'totalTokens'
  | 'stopReason'
  | 'contentBlockTypes'
  | 'responseText'
  | 'error'
> {
  const shouldCapture = config.recordContent && !config.highSecurity;
  const rawSystemPrompt = extractSystemPromptText(input);
  const rawUserMessage = extractLastUserMessage(input.messages);

  const inferenceConfigAny = input.inferenceConfig as unknown as Record<string, unknown>;
  const maxTokens = inferenceConfigAny?.maxTokens ? Number(inferenceConfigAny.maxTokens) : null;
  const temperature = inferenceConfigAny?.temperature
    ? Number(inferenceConfigAny.temperature)
    : null;
  const topP = inferenceConfigAny?.topP ? Number(inferenceConfigAny.topP) : null;

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    provider: 'bedrock',
    model: '',
    requestModel: input.modelId ?? '',
    requestMethod,
    streaming,
    maxTokens,
    temperature,
    topP,
    topK: null,
    messageCount: input.messages?.length ?? 0,
    toolCount: 0,
    toolNames: [],
    thinkingEnabled: false,
    thinkingBudgetTokens: null,
    systemPromptLength: extractSystemPromptLength(input),
    systemPrompt:
      shouldCapture && rawSystemPrompt !== null
        ? truncate(rawSystemPrompt, config.contentMaxLength)
        : null,
    lastUserMessage:
      shouldCapture && rawUserMessage !== null
        ? truncate(rawUserMessage, config.contentMaxLength)
        : null,
    conversationId: generateConversationIdFromMessages((input.messages ?? []) as unknown[]),
    modalityMetrics: detectModalities((input.messages ?? []) as unknown[]),
  };
}

function finalizeRecord(
  base: ReturnType<typeof buildBaseRecord>,
  response: ConverseCommandOutput,
  metrics: RequestTimerMetrics,
  config: WrapperConfig,
): AiRequestRecord {
  const usage = response.usage;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const shouldCapture = config.recordContent && !config.highSecurity;

  const responseText = extractResponseText(response.output?.message?.content);

  const reasoningMetrics = extractReasoningMetrics({
    thinkingTokens: 0,
    outputTokens,
    thinkingBudgetTokens: null,
    thinkingDurationMs: null,
    totalDurationMs: metrics.durationMs,
  });

  return {
    ...base,
    model: base.requestModel,
    durationMs: metrics.durationMs,
    timeToFirstTokenMs: null,
    inputTokens,
    outputTokens,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: inputTokens + outputTokens,
    stopReason: response.stopReason ?? null,
    contentBlockTypes: extractContentBlockTypes(response.output?.message?.content),
    responseText:
      shouldCapture && responseText ? truncate(responseText, config.contentMaxLength) : null,
    reasoningMetrics,
    error: null,
  };
}

function buildErrorRecord(
  base: ReturnType<typeof buildBaseRecord>,
  err: unknown,
  timer: RequestTimer,
  config: WrapperConfig,
): AiRequestRecord {
  timer.stop();
  const metrics = timer.getMetrics();
  const error = err as { $metadata?: { httpStatusCode?: number }; message?: string };
  const rawMessage = error.message ?? (err instanceof Error ? err.message : String(err));
  return {
    ...base,
    model: base.requestModel,
    durationMs: metrics.durationMs,
    timeToFirstTokenMs: null,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    stopReason: null,
    contentBlockTypes: [],
    responseText: null,
    reasoningMetrics: null,
    error: {
      type: err instanceof Error ? err.constructor.name : 'Unknown',
      message: truncate(redact(rawMessage, config.redactionPatterns), 1024),
      statusCode: error.$metadata?.httpStatusCode ?? null,
    },
  };
}

type SendFn = (...args: unknown[]) => Promise<unknown>;

async function interceptConverse(
  command: ConverseCommand,
  originalSend: SendFn,
  config: WrapperConfig,
  onRecord: RecordHandler,
  extraArgs: unknown[],
): Promise<ConverseCommandOutput> {
  const input = command.input;
  const base = buildBaseRecord(input, config, 'converse', false);
  const timer = new RequestTimer();
  timer.start();

  const tracer = getTracer();
  const span = tracer.startSpan(buildSpanName(base), {
    attributes: buildRequestAttributes(base),
  });

  try {
    const response = (await originalSend(command, ...extraArgs)) as ConverseCommandOutput;
    timer.stop();
    const record = finalizeRecord(base, response, timer.getMetrics(), config);
    onRecord(record);
    span.setAttributes(buildResponseAttributes(record));
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return response;
  } catch (err) {
    const record = buildErrorRecord(base, err, timer, config);
    onRecord(record);
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    span.setStatus({ code: SpanStatusCode.ERROR, message: record.error?.message ?? 'Unknown error' });
    span.end();
    throw err;
  }
}

async function interceptConverseStream(
  command: ConverseStreamCommand,
  originalSend: SendFn,
  config: WrapperConfig,
  onRecord: RecordHandler,
  extraArgs: unknown[],
): Promise<unknown> {
  const input = command.input as ConverseStreamCommandInput;
  const base = buildBaseRecord(input, config, 'converse-stream', true);
  const timer = new RequestTimer();
  timer.start();

  const tracer = getTracer();
  const span = tracer.startSpan(buildSpanName(base), {
    attributes: buildRequestAttributes(base),
  });

  const response = await originalSend(command, ...extraArgs);
  const originalStream = (response as { stream: AsyncIterable<ConverseStreamOutput> }).stream;

  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;
  let accumulatedText = '';
  const shouldCapture = config.recordContent && !config.highSecurity;

  async function* wrappedStream(): AsyncGenerator<ConverseStreamOutput> {
    try {
      for await (const event of originalStream) {
        if (event.contentBlockDelta?.delta && 'text' in event.contentBlockDelta.delta) {
          const text = event.contentBlockDelta.delta.text ?? '';
          if (text) {
            timer.markFirstToken();
            if (shouldCapture) accumulatedText += text;
          }
        }
        if (event.metadata?.usage) {
          inputTokens = event.metadata.usage.inputTokens ?? 0;
          outputTokens = event.metadata.usage.outputTokens ?? 0;
        }
        if (event.messageStop) {
          stopReason = event.messageStop.stopReason ?? null;
        }
        yield event;
      }

      timer.stop();
      const streamMetrics = timer.getMetrics();
      const reasoningMetrics = extractReasoningMetrics({
        thinkingTokens: 0,
        outputTokens,
        thinkingBudgetTokens: null,
        thinkingDurationMs: null,
        totalDurationMs: streamMetrics.durationMs,
      });
      const record: AiRequestRecord = {
        ...base,
        model: base.requestModel,
        durationMs: streamMetrics.durationMs,
        timeToFirstTokenMs: streamMetrics.timeToFirstTokenMs,
        inputTokens,
        outputTokens,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: inputTokens + outputTokens,
        stopReason,
        contentBlockTypes: accumulatedText ? ['text'] : [],
        responseText:
          shouldCapture && accumulatedText
            ? truncate(accumulatedText, config.contentMaxLength)
            : null,
        reasoningMetrics,
        error: null,
      };
      onRecord(record);
      span.setAttributes(buildResponseAttributes(record));
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
    } catch (err) {
      const record = buildErrorRecord(base, err, timer, config);
      onRecord(record);
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: record.error?.message ?? 'Unknown error' });
      span.end();
      throw err;
    }
  }

  return {
    ...(response as Record<string, unknown>),
    stream: wrappedStream(),
  };
}

export function wrapBedrockClient(
  client: BedrockRuntimeClient,
  config: WrapperConfig,
  onRecord: RecordHandler,
): BedrockRuntimeClient {
  if (!config.enabled) return client;

  const originalSend = client.send.bind(client) as SendFn;

  (client as { send: unknown }).send = async function wrappedSend(
    command: unknown,
    ...args: unknown[]
  ) {
    if (command instanceof ConverseCommand) {
      return await interceptConverse(command, originalSend, config, onRecord, args);
    }
    if (command instanceof ConverseStreamCommand) {
      return await interceptConverseStream(command, originalSend, config, onRecord, args);
    }
    // Pass through all other commands unmodified
    return originalSend(command, ...args);
  };

  return client;
}
