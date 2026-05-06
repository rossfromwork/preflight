import type { Mistral } from '@mistralai/mistralai';
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

function extractSystemPrompt(messages: unknown[]): string | null {
  if (!Array.isArray(messages)) return null;
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m.role === 'system' && typeof m.content === 'string') {
      return m.content;
    }
  }
  return null;
}

function extractLastUserMessage(messages: unknown[]): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m.role === 'user' && typeof m.content === 'string') {
      return m.content;
    }
  }
  return null;
}

function extractResponseText(content: string | null | undefined): string | null {
  return content && typeof content === 'string' ? content : null;
}

function mapStopReason(finishReason: string | null | undefined): string | null {
  if (!finishReason) return null;
  const map: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
  };
  return map[finishReason] ?? finishReason;
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
  const messages = (params.messages as unknown[]) || [];
  const rawSystemPrompt = extractSystemPrompt(messages);
  const rawUserMessage = extractLastUserMessage(messages);

  return {
    id: randomUUID(),
    timestamp: Date.now(),
    provider: 'mistral',
    model: '',
    requestModel: String(params.model ?? ''),
    requestMethod: '',
    streaming: false,
    maxTokens: params.max_tokens ? Number(params.max_tokens) : null,
    temperature: params.temperature ? Number(params.temperature) : null,
    topP: params.top_p ? Number(params.top_p) : null,
    topK: null,
    messageCount: messages.length,
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
  const usage = resp.usage as Record<string, unknown>;
  const inputTokens = usage?.promptTokens ? Number(usage.promptTokens) : 0;
  const outputTokens = usage?.completionTokens ? Number(usage.completionTokens) : 0;
  const choices = resp.choices as unknown[];
  const choice = choices?.[0] as Record<string, unknown>;
  const message = choice?.message as Record<string, unknown>;
  const content = message?.content;
  const responseText = extractResponseText(typeof content === 'string' ? content : null);

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
    stopReason: mapStopReason(choice?.finishReason ? String(choice.finishReason) : null),
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

function wrapComplete(
  original: (params: unknown) => Promise<unknown>,
  config: WrapperConfig,
  onRecord: RecordHandler,
): Mistral['chat']['complete'] {
  return async function wrappedComplete(
    this: unknown,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const base = buildBaseRecord(params, config);
    base.requestMethod = 'chat.complete';
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
  } as Mistral['chat']['complete'];
}

function wrapStream(
  original: (params: unknown) => Promise<AsyncIterable<unknown>>,
  config: WrapperConfig,
  onRecord: RecordHandler,
): Mistral['chat']['stream'] {
  return function wrappedStream(
    this: unknown,
    params: Record<string, unknown>,
  ): unknown {
    const base = buildBaseRecord(params, config);
    base.requestMethod = 'chat.stream';
    base.streaming = true;
    const timer = new RequestTimer();
    timer.start();

    const streamPromise = original(params);

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
          const data = evt.data as Record<string, unknown>;
          const choices = data?.choices as unknown[];
          const choice = choices?.[0] as Record<string, unknown>;
          const delta = choice?.delta as Record<string, unknown>;

          if (delta?.content) {
            const text = String(delta.content);
            if (text) {
              timer.markFirstToken();
              if (shouldCapture) accumulatedText += text;
            }
          }

          const usage = data?.usage as Record<string, unknown>;
          if (usage) {
            inputTokens = usage.promptTokens ? Number(usage.promptTokens) : 0;
            outputTokens = usage.completionTokens ? Number(usage.completionTokens) : 0;
          }

          if (choice?.finishReason) {
            const finishReason = String(choice.finishReason);
            stopReason = mapStopReason(finishReason);
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
  } as Mistral['chat']['stream'];
}

export function wrapMistralClient(
  client: Mistral,
  config: WrapperConfig,
  onRecord: RecordHandler,
): Mistral {
  if (!config.enabled) return client;

  const originalComplete = client.chat.complete.bind(client.chat) as (params: unknown) => Promise<unknown>;
  const originalStream = client.chat.stream.bind(client.chat) as (params: unknown) => Promise<AsyncIterable<unknown>>;

  client.chat.complete = wrapComplete(originalComplete, config, onRecord);
  client.chat.stream = wrapStream(originalStream, config, onRecord);

  return client;
}
