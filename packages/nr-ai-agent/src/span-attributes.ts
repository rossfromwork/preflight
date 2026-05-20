import type { Attributes } from '@opentelemetry/api';
import type { AiRequestRecord } from './types.js';

const PROVIDER_TO_SYSTEM: Record<string, string> = {
  anthropic: 'anthropic',
  google: 'google_genai',
  openai: 'openai',
  bedrock: 'aws.bedrock',
  mistral: 'mistral_ai',
  cohere: 'cohere',
};

const METHOD_TO_OPERATION: Record<string, string> = {
  'messages.create': 'chat',
  'messages.stream': 'chat',
  'models.generateContent': 'generate_content',
  'models.generateContentStream': 'generate_content',
  'models.embedContent': 'embeddings',
  'chat.completions.create': 'chat',
  'converse': 'chat',
  'converse-stream': 'chat',
  'chat.complete': 'chat',
  'chat.stream': 'chat',
  'chat': 'chat',
  'chatStream': 'chat',
};

// Narrower input type — both functions only need request-side fields, not the full AiRequestRecord.
// This allows them to be called with the partial `base` record from buildBaseRecord() before
// the response is available, as well as with a full AiRequestRecord in tests.
type RequestSideRecord = Pick<
  AiRequestRecord,
  'provider' | 'requestModel' | 'requestMethod' | 'streaming' | 'maxTokens' | 'temperature' | 'topP'
>;

export function buildSpanName(record: RequestSideRecord): string {
  const operation = METHOD_TO_OPERATION[record.requestMethod] ?? 'chat';
  return `${operation} ${record.requestModel}`;
}

export function buildRequestAttributes(record: RequestSideRecord): Attributes {
  const attrs: Attributes = {
    'gen_ai.system': PROVIDER_TO_SYSTEM[record.provider] ?? record.provider,
    'gen_ai.request.model': record.requestModel,
    'gen_ai.request.stream': record.streaming,
  };

  const operation = METHOD_TO_OPERATION[record.requestMethod];
  if (operation) attrs['gen_ai.operation.name'] = operation;
  if (record.maxTokens !== null) attrs['gen_ai.request.max_tokens'] = record.maxTokens;
  if (record.temperature !== null) attrs['gen_ai.request.temperature'] = record.temperature;
  if (record.topP !== null) attrs['gen_ai.request.top_p'] = record.topP;

  return attrs;
}

export function buildResponseAttributes(record: AiRequestRecord): Attributes {
  const attrs: Attributes = {};

  if (record.model) attrs['gen_ai.response.model'] = record.model;
  if (record.stopReason) attrs['gen_ai.response.finish_reason'] = record.stopReason;

  attrs['gen_ai.usage.input_tokens'] = record.inputTokens;
  attrs['gen_ai.usage.output_tokens'] = record.outputTokens;

  if (record.thinkingTokens > 0) attrs['gen_ai.usage.reasoning.output_tokens'] = record.thinkingTokens;
  if (record.cacheReadTokens > 0) attrs['gen_ai.usage.cache_read.input_tokens'] = record.cacheReadTokens;
  if (record.cacheCreationTokens > 0) attrs['gen_ai.usage.cache_creation.input_tokens'] = record.cacheCreationTokens;

  return attrs;
}
