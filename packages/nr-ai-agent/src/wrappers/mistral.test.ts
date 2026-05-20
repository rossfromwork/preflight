import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { wrapMistralClient } from './mistral.js';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';
import type { Mistral } from '@mistralai/mistralai';
import * as tracing from '../tracing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChatResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-test123',
    object: 'text_completion',
    created: 1700000000,
    model: 'mistral-large-latest',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello from Mistral' },
        finishReason: 'stop',
      },
    ],
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    },
    ...overrides,
  };
}

function makeChatParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'mistral-large-latest',
    messages: [{ role: 'user', content: 'Hello' }],
    max_tokens: 1024,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    enabled: true,
    recordContent: true,
    highSecurity: false,
    contentMaxLength: 4096,
    redactionPatterns: [],
    ...overrides,
  };
}

function makeRecorder(): { records: AiRequestRecord[]; handler: RecordHandler } {
  const records: AiRequestRecord[] = [];
  return { records, handler: (r) => records.push(r) };
}

function makeStreamEvents(includeUsage = true): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    {
      data: {
        id: 'cmpl-stream1',
        object: 'text_completion.chunk',
        created: 1700000000,
        model: 'mistral-large-latest',
        choices: [{ index: 0, delta: { content: 'Hello' }, finishReason: null }],
      },
    },
    {
      data: {
        id: 'cmpl-stream1',
        object: 'text_completion.chunk',
        created: 1700000000,
        model: 'mistral-large-latest',
        choices: [{ index: 0, delta: { content: ' from Mistral' }, finishReason: null }],
      },
    },
    {
      data: {
        id: 'cmpl-stream1',
        object: 'text_completion.chunk',
        created: 1700000000,
        model: 'mistral-large-latest',
        choices: [{ index: 0, delta: { content: null }, finishReason: 'stop' }],
      },
    },
  ];

  if (includeUsage) {
    events.push({
      data: {
        id: 'cmpl-stream1',
        object: 'text_completion.chunk',
        created: 1700000000,
        model: 'mistral-large-latest',
        choices: [],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      },
    });
  }

  return events;
}

function makeMockStream(events: Record<string, unknown>[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function makeMockClient(overrides: Partial<{ complete: jest.Mock; stream: jest.Mock }> = {}): unknown {
  return {
    chat: {
      complete: jest.fn(),
      stream: jest.fn(),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapMistralClient', () => {
  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('enabled=false', () => {
    it('returns the original client unmodified', () => {
      const client = makeMockClient() as unknown as Mistral;
      const config = makeConfig({ enabled: false });
      const { handler } = makeRecorder();

      const result = wrapMistralClient(client, config, handler);

      expect(result).toBe(client);
    });
  });

  describe('chat.complete() — non-streaming', () => {
    it('captures all fields in the AiRequestRecord', async () => {
      const response = makeChatResponse();
      const client = makeMockClient() as unknown as Mistral;
      (client.chat!.complete as jest.Mock).mockResolvedValue(response);

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();

      wrapMistralClient(client, config, handler);

      const params = makeChatParams({
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
        temperature: 0.7,
        top_p: 0.9,
      });

      const result = await client.chat!.complete!(params as never);

      expect(result).toBe(response);
      expect(records).toHaveLength(1);

      const record = records[0];
      expect(record.provider).toBe('mistral');
      expect(record.model).toBe('mistral-large-latest');
      expect(record.requestModel).toBe('mistral-large-latest');
      expect(record.requestMethod).toBe('chat.complete');
      expect(record.streaming).toBe(false);

      expect(record.maxTokens).toBe(1024);
      expect(record.temperature).toBe(0.7);
      expect(record.topP).toBe(0.9);
      expect(record.topK).toBeNull();
      expect(record.messageCount).toBe(2);
      expect(record.toolCount).toBe(0);
      expect(record.toolNames).toEqual([]);
      expect(record.thinkingEnabled).toBe(false);
      expect(record.thinkingBudgetTokens).toBeNull();
      expect(record.systemPromptLength).toBe('You are a helpful assistant.'.length);

      expect(record.durationMs).toBeGreaterThan(0);
      expect(record.timeToFirstTokenMs).toBeNull();
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
      expect(record.totalTokens).toBe(150);
      expect(record.cacheReadTokens).toBe(0);
      expect(record.cacheCreationTokens).toBe(0);
      expect(record.stopReason).toBe('end_turn');
      expect(record.contentBlockTypes).toEqual(['text']);

      expect(record.systemPrompt).toBe('You are a helpful assistant.');
      expect(record.lastUserMessage).toBe('Hello');
      expect(record.responseText).toBe('Hello from Mistral');

      expect(record.error).toBeNull();
    });

    it('maps stop reasons correctly', async () => {
      // Test 'length' -> 'max_tokens'
      const client1 = makeMockClient() as unknown as Mistral;
      (client1.chat!.complete as jest.Mock).mockResolvedValue(
        makeChatResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'text' }, finishReason: 'length' }] }),
      );
      const { records: records1, handler: handler1 } = makeRecorder();
      wrapMistralClient(client1, makeConfig(), handler1);
      await client1.chat!.complete!(makeChatParams() as never);
      expect(records1[0].stopReason).toBe('max_tokens');

      // Test 'stop' -> 'end_turn'
      const client2 = makeMockClient() as unknown as Mistral;
      (client2.chat!.complete as jest.Mock).mockResolvedValue(
        makeChatResponse({ choices: [{ index: 0, message: { role: 'assistant', content: 'text' }, finishReason: 'stop' }] }),
      );
      const { records: records2, handler: handler2 } = makeRecorder();
      wrapMistralClient(client2, makeConfig(), handler2);
      await client2.chat!.complete!(makeChatParams() as never);
      expect(records2[0].stopReason).toBe('end_turn');
    });

    it('extracts system prompt and last user message from messages array', async () => {
      const response = makeChatResponse();
      const client = makeMockClient() as unknown as Mistral;
      (client.chat!.complete as jest.Mock).mockResolvedValue(response);

      const { records, handler } = makeRecorder();
      wrapMistralClient(client, makeConfig(), handler);

      await client.chat!.complete!(
        makeChatParams({
          messages: [
            { role: 'system', content: 'Be concise.' },
            { role: 'user', content: 'First question' },
            { role: 'assistant', content: 'Answer one.' },
            { role: 'user', content: 'Second question' },
          ],
        }) as never,
      );

      expect(records[0].systemPromptLength).toBe('Be concise.'.length);
      expect(records[0].systemPrompt).toBe('Be concise.');
      expect(records[0].lastUserMessage).toBe('Second question');
    });

    it('truncates content to contentMaxLength', async () => {
      const longText = 'a'.repeat(200);
      const response = makeChatResponse({
        choices: [{ index: 0, message: { role: 'assistant', content: longText }, finishReason: 'stop' }],
      });
      const client = makeMockClient() as unknown as Mistral;
      (client.chat!.complete as jest.Mock).mockResolvedValue(response);

      const config = makeConfig({ recordContent: true, contentMaxLength: 50 });
      const { records, handler } = makeRecorder();
      wrapMistralClient(client, config, handler);

      await client.chat!.complete!(
        makeChatParams({
          messages: [
            { role: 'system', content: longText },
            { role: 'user', content: longText },
          ],
        }) as never,
      );

      expect(records[0].systemPrompt!.length).toBe(50);
      expect(records[0].lastUserMessage!.length).toBe(50);
      expect(records[0].responseText!.length).toBe(50);
    });

    it('handles recordContent=false', async () => {
      const response = makeChatResponse();
      const client = makeMockClient() as unknown as Mistral;
      (client.chat!.complete as jest.Mock).mockResolvedValue(response);

      const config = makeConfig({ recordContent: false });
      const { records, handler } = makeRecorder();
      wrapMistralClient(client, config, handler);

      await client.chat!.complete!(makeChatParams() as never);

      expect(records[0].systemPrompt).toBeNull();
      expect(records[0].lastUserMessage).toBeNull();
      expect(records[0].responseText).toBeNull();
    });

    it('handles highSecurity=true', async () => {
      const response = makeChatResponse();
      const client = makeMockClient() as unknown as Mistral;
      (client.chat!.complete as jest.Mock).mockResolvedValue(response);

      const config = makeConfig({ recordContent: true, highSecurity: true });
      const { records, handler } = makeRecorder();
      wrapMistralClient(client, config, handler);

      await client.chat!.complete!(makeChatParams() as never);

      expect(records[0].systemPrompt).toBeNull();
      expect(records[0].lastUserMessage).toBeNull();
      expect(records[0].responseText).toBeNull();
    });

    it('handles missing optional fields gracefully', async () => {
      const response = makeChatResponse();
      const client = makeMockClient() as unknown as Mistral;
      (client.chat!.complete as jest.Mock).mockResolvedValue(response);

      const { records, handler } = makeRecorder();
      wrapMistralClient(client, makeConfig(), handler);

      await client.chat!.complete!(
        {
          model: 'mistral-large-latest',
          messages: [{ role: 'user', content: 'Hi' }],
        } as never,
      );

      const record = records[0];
      expect(record.maxTokens).toBeNull();
      expect(record.temperature).toBeNull();
      expect(record.topP).toBeNull();
      expect(record.systemPromptLength).toBeNull();
    });
  });

  describe('chat.complete() — error handling', () => {
    it('propagates errors and captures error record', async () => {
      const apiError = Object.assign(new Error('rate limit exceeded'), {
        status: 429,
      });
      const client = makeMockClient() as unknown as Mistral;
      (client.chat!.complete as jest.Mock).mockRejectedValue(apiError);

      const { records, handler } = makeRecorder();
      wrapMistralClient(client, makeConfig(), handler);

      await expect(client.chat!.complete!(makeChatParams() as never)).rejects.toThrow(
        'rate limit exceeded',
      );

      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.error).not.toBeNull();
      expect(record.error!.message).toBe('rate limit exceeded');
      expect(record.error!.statusCode).toBe(429);
      expect(record.inputTokens).toBe(0);
      expect(record.outputTokens).toBe(0);
    });

    it('redacts secret patterns from error messages', async () => {
      const apiError = new Error('auth failed: Bearer sk-secret12345 was rejected');
      const client = makeMockClient() as unknown as Mistral;
      (client.chat!.complete as jest.Mock).mockRejectedValue(apiError);

      const config = makeConfig({ redactionPatterns: [/Bearer\s+\S+/g] });
      const { records, handler } = makeRecorder();
      wrapMistralClient(client, config, handler);

      await expect(client.chat!.complete!(makeChatParams() as never)).rejects.toThrow();

      expect(records[0].error!.message).toBe('auth failed: [REDACTED] was rejected');
    });
  });

  describe('chat.stream() — streaming', () => {
    it('yields all events unmodified and captures usage and TTFT', async () => {
      const events = makeStreamEvents();
      const mockStream = makeMockStream(events);
      const mockClient = makeMockClient() as unknown as Mistral;
      (mockClient.chat!.stream as jest.Mock).mockReturnValue(mockStream);

      const { records, handler } = makeRecorder();
      wrapMistralClient(mockClient, makeConfig(), handler);

      const stream = (mockClient.chat!.stream!(makeChatParams() as never) as unknown) as AsyncIterable<unknown>;

      const collected: unknown[] = [];
      for await (const event of stream) {
        collected.push(event);
      }

      expect(collected).toHaveLength(events.length);
      for (let i = 0; i < events.length; i++) {
        expect(collected[i]).toBe(events[i]);
      }

      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.provider).toBe('mistral');
      expect(record.requestMethod).toBe('chat.stream');
      expect(record.streaming).toBe(true);
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
      expect(record.totalTokens).toBe(150);
      expect(record.stopReason).toBe('end_turn');
      expect(record.responseText).toBe('Hello from Mistral');
      expect(record.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
    });

    it('handles streaming without usage event', async () => {
      const events = makeStreamEvents(false);
      const mockStream = makeMockStream(events);
      const mockClient = makeMockClient() as unknown as Mistral;
      (mockClient.chat!.stream as jest.Mock).mockReturnValue(mockStream);

      const { records, handler } = makeRecorder();
      wrapMistralClient(mockClient, makeConfig(), handler);

      const stream = (mockClient.chat!.stream!(makeChatParams() as never) as unknown) as AsyncIterable<unknown>;

      for await (const _event of stream) {
        // Consume stream
      }

      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.inputTokens).toBe(0);
      expect(record.outputTokens).toBe(0);
    });

    it('respects recordContent=false in streaming', async () => {
      const events = makeStreamEvents();
      const mockStream = makeMockStream(events);
      const mockClient = makeMockClient() as unknown as Mistral;
      (mockClient.chat!.stream as jest.Mock).mockReturnValue(mockStream);

      const config = makeConfig({ recordContent: false });
      const { records, handler } = makeRecorder();
      wrapMistralClient(mockClient, config, handler);

      const stream = (mockClient.chat!.stream!(makeChatParams() as never) as unknown) as AsyncIterable<unknown>;

      for await (const _event of stream) {
        // Consume stream
      }

      expect(records[0].responseText).toBeNull();
    });
  });

  describe('span lifecycle', () => {
    let mockSpan: { setAttributes: jest.Mock; setStatus: jest.Mock; recordException: jest.Mock; end: jest.Mock };
    let mockTracer: { startSpan: jest.Mock };

    beforeEach(() => {
      mockSpan = {
        setAttributes: jest.fn(),
        setStatus: jest.fn(),
        recordException: jest.fn(),
        end: jest.fn(),
      };
      mockTracer = { startSpan: jest.fn(() => mockSpan) };
      jest.spyOn(tracing, 'getTracer').mockReturnValue(mockTracer as unknown as Tracer);
    });

    it('starts and ends a span on success', async () => {
      const response = makeChatResponse();
      const client = makeMockClient() as unknown as Mistral;
      (client.chat!.complete as jest.Mock).mockResolvedValue(response);

      const config = makeConfig();
      const { handler } = makeRecorder();

      wrapMistralClient(client, config, handler);
      await client.chat!.complete(makeChatParams() as never);

      expect(mockTracer.startSpan).toHaveBeenCalledTimes(1);
      expect(mockSpan.end).toHaveBeenCalledTimes(1);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    });

    it('records exception and ends span on error', async () => {
      const error = new Error('SDK error');
      const client = makeMockClient() as unknown as Mistral;
      (client.chat!.complete as jest.Mock).mockRejectedValue(error);

      const config = makeConfig();
      const { handler } = makeRecorder();

      wrapMistralClient(client, config, handler);
      await expect(client.chat!.complete(makeChatParams() as never)).rejects.toThrow('SDK error');

      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
      expect(mockSpan.end).toHaveBeenCalledTimes(1);
    });
  });
});
