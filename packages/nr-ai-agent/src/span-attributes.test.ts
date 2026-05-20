import { buildSpanName, buildRequestAttributes, buildResponseAttributes } from './span-attributes.js';
import type { AiRequestRecord } from './types.js';

function makeRecord(overrides: Partial<AiRequestRecord> = {}): AiRequestRecord {
  return {
    id: 'test-id',
    timestamp: Date.now(),
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    requestModel: 'claude-sonnet-4-6',
    requestMethod: 'messages.create',
    streaming: false,
    maxTokens: null,
    temperature: null,
    topP: null,
    topK: null,
    messageCount: 1,
    toolCount: 0,
    toolNames: [],
    thinkingEnabled: false,
    thinkingBudgetTokens: null,
    systemPromptLength: null,
    durationMs: 100,
    timeToFirstTokenMs: null,
    inputTokens: 10,
    outputTokens: 10,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 20,
    stopReason: null,
    contentBlockTypes: [],
    systemPrompt: null,
    lastUserMessage: null,
    responseText: null,
    error: null,
    ...overrides,
  };
}

describe('buildRequestAttributes', () => {
  it('maps anthropic provider to gen_ai.system = anthropic', () => {
    const record = makeRecord({ provider: 'anthropic', requestModel: 'claude-sonnet-4-6' });
    const attrs = buildRequestAttributes(record);
    expect(attrs['gen_ai.system']).toBe('anthropic');
    expect(attrs['gen_ai.request.model']).toBe('claude-sonnet-4-6');
  });

  it('maps google to google_genai', () => {
    const record = makeRecord({ provider: 'google' });
    expect(buildRequestAttributes(record)['gen_ai.system']).toBe('google_genai');
  });

  it('maps openai to openai', () => {
    const record = makeRecord({ provider: 'openai' });
    expect(buildRequestAttributes(record)['gen_ai.system']).toBe('openai');
  });

  it('maps bedrock to aws.bedrock', () => {
    const record = makeRecord({ provider: 'bedrock' });
    expect(buildRequestAttributes(record)['gen_ai.system']).toBe('aws.bedrock');
  });

  it('maps mistral to mistral_ai', () => {
    const record = makeRecord({ provider: 'mistral' });
    expect(buildRequestAttributes(record)['gen_ai.system']).toBe('mistral_ai');
  });

  it('maps cohere to cohere', () => {
    const record = makeRecord({ provider: 'cohere' });
    expect(buildRequestAttributes(record)['gen_ai.system']).toBe('cohere');
  });

  it('sets gen_ai.request.stream based on streaming flag', () => {
    const streamingRecord = makeRecord({ streaming: true });
    expect(buildRequestAttributes(streamingRecord)['gen_ai.request.stream']).toBe(true);

    const nonStreamingRecord = makeRecord({ streaming: false });
    expect(buildRequestAttributes(nonStreamingRecord)['gen_ai.request.stream']).toBe(false);
  });

  it('includes gen_ai.operation.name for known methods', () => {
    const record = makeRecord({ requestMethod: 'messages.create' });
    const attrs = buildRequestAttributes(record);
    expect(attrs['gen_ai.operation.name']).toBe('chat');
  });

  it('includes optional attributes when not null', () => {
    const record = makeRecord({
      maxTokens: 1000,
      temperature: 0.7,
      topP: 0.9,
    });
    const attrs = buildRequestAttributes(record);
    expect(attrs['gen_ai.request.max_tokens']).toBe(1000);
    expect(attrs['gen_ai.request.temperature']).toBe(0.7);
    expect(attrs['gen_ai.request.top_p']).toBe(0.9);
  });

  it('omits optional attributes when null', () => {
    const record = makeRecord({
      maxTokens: null,
      temperature: null,
      topP: null,
    });
    const attrs = buildRequestAttributes(record);
    expect(attrs['gen_ai.request.max_tokens']).toBeUndefined();
    expect(attrs['gen_ai.request.temperature']).toBeUndefined();
    expect(attrs['gen_ai.request.top_p']).toBeUndefined();
  });
});

describe('buildResponseAttributes', () => {
  it('emits token usage attributes', () => {
    const record = makeRecord({
      inputTokens: 100,
      outputTokens: 50,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const attrs = buildResponseAttributes(record);
    expect(attrs['gen_ai.usage.input_tokens']).toBe(100);
    expect(attrs['gen_ai.usage.output_tokens']).toBe(50);
    expect(attrs['gen_ai.usage.reasoning.output_tokens']).toBeUndefined();
  });

  it('emits reasoning tokens when > 0', () => {
    const record = makeRecord({ thinkingTokens: 200 });
    expect(buildResponseAttributes(record)['gen_ai.usage.reasoning.output_tokens']).toBe(200);
  });

  it('does not emit reasoning tokens when = 0', () => {
    const record = makeRecord({ thinkingTokens: 0 });
    expect(buildResponseAttributes(record)['gen_ai.usage.reasoning.output_tokens']).toBeUndefined();
  });

  it('emits cache read tokens when > 0', () => {
    const record = makeRecord({ cacheReadTokens: 500 });
    expect(buildResponseAttributes(record)['gen_ai.usage.cache_read.input_tokens']).toBe(500);
  });

  it('does not emit cache read tokens when = 0', () => {
    const record = makeRecord({ cacheReadTokens: 0 });
    expect(buildResponseAttributes(record)['gen_ai.usage.cache_read.input_tokens']).toBeUndefined();
  });

  it('emits cache creation tokens when > 0', () => {
    const record = makeRecord({ cacheCreationTokens: 300 });
    expect(buildResponseAttributes(record)['gen_ai.usage.cache_creation.input_tokens']).toBe(300);
  });

  it('does not emit cache creation tokens when = 0', () => {
    const record = makeRecord({ cacheCreationTokens: 0 });
    expect(buildResponseAttributes(record)['gen_ai.usage.cache_creation.input_tokens']).toBeUndefined();
  });

  it('emits model and finish_reason when set', () => {
    const record = makeRecord({
      model: 'claude-opus-4-7',
      stopReason: 'end_turn',
    });
    const attrs = buildResponseAttributes(record);
    expect(attrs['gen_ai.response.model']).toBe('claude-opus-4-7');
    expect(attrs['gen_ai.response.finish_reason']).toBe('end_turn');
  });

  it('omits model and finish_reason when not set', () => {
    const record = makeRecord({
      model: '',
      stopReason: null,
    });
    const attrs = buildResponseAttributes(record);
    expect(attrs['gen_ai.response.model']).toBeUndefined();
    expect(attrs['gen_ai.response.finish_reason']).toBeUndefined();
  });
});

describe('buildSpanName', () => {
  it('uses operation + model', () => {
    const record = makeRecord({
      requestMethod: 'messages.create',
      requestModel: 'claude-opus-4-7',
    });
    expect(buildSpanName(record)).toBe('chat claude-opus-4-7');
  });

  it('defaults to chat for unknown methods', () => {
    const record = makeRecord({
      requestMethod: 'unknown.method' as unknown as string,
      requestModel: 'gpt-4',
    });
    expect(buildSpanName(record)).toBe('chat gpt-4');
  });

  it('handles generate_content operation', () => {
    const record = makeRecord({
      requestMethod: 'models.generateContent',
      requestModel: 'gemini-pro',
    });
    expect(buildSpanName(record)).toBe('generate_content gemini-pro');
  });

  it('handles embeddings operation', () => {
    const record = makeRecord({
      requestMethod: 'models.embedContent',
      requestModel: 'embedding-001',
    });
    expect(buildSpanName(record)).toBe('embeddings embedding-001');
  });
});
