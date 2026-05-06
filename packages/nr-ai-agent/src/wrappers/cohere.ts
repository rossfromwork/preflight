import type { CohereClient } from 'cohere-ai';
import { randomUUID } from 'node:crypto';
import { RequestTimer } from '@nr-ai-observatory/shared';
import type { RequestTimerMetrics } from '@nr-ai-observatory/shared';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function redact(text: string, patterns: readonly RegExp[]): string {
  return patterns.reduce((s, pattern) => s.replace(pattern, '[REDACTED]'), text);
}

function extractSystemPromptText(input: Record<string, unknown>): string | null {
  const preamble = input.preamble;
  return typeof preamble === 'string' ? preamble : null;
}

function extractLastUserMessage(input: Record<string, unknown>): string | null {
  const message = input.message;
  return typeof message === 'string' ? message : null;
}

function extractResponseText(text: string | null | undefined): string | null {
  return text && typeof text === 'string' ? text : null;
}

function mapStopReason(finishReason: string | null | undefined): string | null {
  if (!finishReason) return null;
  const map: Record<string, string> = {
    COMPLETE: 'end_turn',
    MAX_TOKENS: 'max_tokens',
    STOP_SEQUENCE: 'end_turn',
    ERROR: 'error',
    ERROR_TOXIC: 'content_filter',
  };
  return map[finishReason] ?? finishReason.toLowerCase();
}

function buildBaseRecord(
  params: Record<string, unknown>,
  config: WrapperConfig,
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
  const rawSystemPrompt = extractSystemPromptText(params);
  const rawUserMessage = extractLastUserMessage(params);

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    provider: 'cohere',
    model: '',
    requestModel: String(params.model ?? ''),
    requestMethod: '',
    streaming: false,
    maxTokens: params.max_tokens ? Number(params.max_tokens) : null,
    temperature: params.temperature ? Number(params.temperature) : null,
    topP: params.p ? Number(params.p) : null,
    topK: params.k ? Number(params.k) : null,
    messageCount: params.chat_history ? (Array.isArray(params.chat_history) ? params.chat_history.length + 1 : 2) : 1,
    toolCount: 0,
    toolNames: [],
    thinkingEnabled: false,
    thinkingBudgetTokens: null,
    systemPromptLength: rawSystemPrompt ? rawSystemPrompt.length : null,
    systemPrompt:
      shouldCapture && rawSystemPrompt
        ? truncate(rawSystemPrompt, config.contentMaxLength)
        : null,
    lastUserMessage:
      shouldCapture && rawUserMessage
        ? truncate(rawUserMessage, config.contentMaxLength)
        : null,
  };
}

function finalizeRecord(
  base: ReturnType<typeof buildBaseRecord>,
  response: unknown,
  metrics: RequestTimerMetrics,
  config: WrapperConfig,
): AiRequestRecord {
  const shouldCapture = config.recordContent && !config.highSecurity;
  const resp = response as Record<string, unknown>;
  const meta = resp.meta as Record<string, unknown>;
  const tokens = meta?.tokens as Record<string, unknown>;
  const inputTokens = tokens?.input_tokens ? Number(tokens.input_tokens) : 0;
  const outputTokens = tokens?.output_tokens ? Number(tokens.output_tokens) : 0;
  const responseText = extractResponseText(typeof resp.text === 'string' ? resp.text : null);

  return {
    ...base,
    model: base.requestModel,
    durationMs: metrics.durationMs,
    timeToFirstTokenMs: metrics.timeToFirstTokenMs,
    inputTokens,
    outputTokens,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: inputTokens + outputTokens,
    stopReason: mapStopReason(resp.finish_reason ? String(resp.finish_reason) : null),
    contentBlockTypes: responseText ? ['text'] : [],
    responseText:
      shouldCapture && responseText
        ? truncate(responseText, config.contentMaxLength)
        : null,
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
  const error = err as {
    status?: number;
    statusCode?: number;
    message?: string;
  };
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
    error: {
      type: err instanceof Error ? err.constructor.name : 'Unknown',
      message: truncate(redact(rawMessage, config.redactionPatterns), 1024),
      statusCode: error.status ?? error.statusCode ?? null,
    },
  };
}

function wrapChat(
  original: (params: unknown) => Promise<unknown>,
  config: WrapperConfig,
  onRecord: RecordHandler,
): unknown {
  return async function wrappedChat(
    this: unknown,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const base = buildBaseRecord(params, config);
    base.requestMethod = 'chat';
    base.streaming = false;
    const timer = new RequestTimer();
    timer.start();

    try {
      const response = await original(params);
      timer.stop();
      const record = finalizeRecord(base, response, timer.getMetrics(), config);
      onRecord(record);
      return response;
    } catch (err) {
      const record = buildErrorRecord(base, err, timer, config);
      onRecord(record);
      throw err;
    }
  };
}

function wrapChatStream(
  original: (params: unknown) => AsyncIterable<unknown>,
  config: WrapperConfig,
  onRecord: RecordHandler,
): unknown {
  return function wrappedChatStream(
    this: unknown,
    params: Record<string, unknown>,
  ): unknown {
    const base = buildBaseRecord(params, config);
    base.requestMethod = 'chatStream';
    base.streaming = true;
    const timer = new RequestTimer();
    timer.start();

    const streamPromise = Promise.resolve(original(params));

    async function* wrappedAsyncIter(): AsyncGenerator<unknown> {
      let inputTokens = 0;
      let outputTokens = 0;
      let accumulatedText = '';
      let stopReason: string | null = null;
      const shouldCapture = config.recordContent && !config.highSecurity;

      try {
        const stream = await streamPromise;
        for await (const event of stream) {
          const evt = event as Record<string, unknown>;

          if (evt.eventType === 'text-generation') {
            const text = evt.text ? String(evt.text) : '';
            if (text) {
              timer.markFirstToken();
              if (shouldCapture) accumulatedText += text;
            }
          }

          if (evt.eventType === 'stream-end') {
            const response = evt.response as Record<string, unknown>;
            const meta = response?.meta as Record<string, unknown>;
            const tokens = meta?.tokens as Record<string, unknown>;
            inputTokens = tokens?.input_tokens ? Number(tokens.input_tokens) : 0;
            outputTokens = tokens?.output_tokens ? Number(tokens.output_tokens) : 0;
            stopReason = mapStopReason(response?.finish_reason ? String(response.finish_reason) : null);
          }

          yield event;
        }

        timer.stop();
        const record: AiRequestRecord = {
          ...base,
          model: base.requestModel,
          durationMs: timer.getMetrics().durationMs,
          timeToFirstTokenMs: timer.getMetrics().timeToFirstTokenMs,
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
          error: null,
        };
        onRecord(record);
      } catch (err) {
        const record = buildErrorRecord(base, err, timer, config);
        onRecord(record);
        throw err;
      }
    }

    return wrappedAsyncIter();
  };
}

export function wrapCohereClient(
  client: CohereClient,
  config: WrapperConfig,
  onRecord: RecordHandler,
): CohereClient {
  if (!config.enabled) return client;

  const originalChat = client.chat.bind(client) as unknown as (params: unknown) => Promise<unknown>;
  const originalChatStream = client.chatStream.bind(client) as unknown as (params: unknown) => AsyncIterable<unknown>;

  client.chat = wrapChat(originalChat, config, onRecord) as unknown as CohereClient['chat'];
  client.chatStream = wrapChatStream(originalChatStream, config, onRecord) as unknown as CohereClient['chatStream'];

  return client;
}
