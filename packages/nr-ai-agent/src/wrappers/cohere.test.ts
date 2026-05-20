import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { wrapCohereClient } from './cohere.js';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';
import type { CohereClient } from 'cohere-ai';
import * as tracing from '../tracing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChatResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'Hello from Cohere',
    finish_reason: 'COMPLETE',
    meta: {
      tokens: {
        input_tokens: 100,
        output_tokens: 50,
      },
    },
    ...overrides,
  };
}

function makeChatParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'command-r',
    message: 'Hello',
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

function makeStreamEvents(includeStreamEnd = true): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    {
      eventType: 'text-generation',
      text: 'Hello',
    },
    {
      eventType: 'text-generation',
      text: ' from Cohere',
    },
  ];

  if (includeStreamEnd) {
    events.push({
      eventType: 'stream-end',
      response: {
        text: 'Hello from Cohere',
        finish_reason: 'COMPLETE',
        meta: {
          tokens: {
            input_tokens: 100,
            output_tokens: 50,
          },
        },
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

function makeMockClient(overrides: Partial<{ chat: jest.Mock; chatStream: jest.Mock }> = {}): unknown {
  return {
    chat: jest.fn(),
    chatStream: jest.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapCohereClient', () => {
  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('enabled=false', () => {
    it('returns the original client unmodified', () => {
      const client = makeMockClient() as unknown as CohereClient;
      const config = makeConfig({ enabled: false });
      const { handler } = makeRecorder();

      const result = wrapCohereClient(client, config, handler);

      expect(result).toBe(client);
    });
  });

  describe('chat() — non-streaming', () => {
    it('captures all fields in the AiRequestRecord', async () => {
      const response = makeChatResponse();
      const client = makeMockClient() as unknown as CohereClient;
      (client.chat as jest.Mock).mockResolvedValue(response);

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();

      wrapCohereClient(client, config, handler);

      const params = makeChatParams({
        preamble: 'You are a helpful assistant.',
        message: 'Hello',
        temperature: 0.7,
        p: 0.9,
        k: 40,
        max_tokens: 1024,
      });

      const result = await client.chat!(params as never);

      expect(result).toBe(response);
      expect(records).toHaveLength(1);

      const record = records[0];
      expect(record.provider).toBe('cohere');
      expect(record.model).toBe('command-r');
      expect(record.requestModel).toBe('command-r');
      expect(record.requestMethod).toBe('chat');
      expect(record.streaming).toBe(false);

      expect(record.maxTokens).toBe(1024);
      expect(record.temperature).toBe(0.7);
      expect(record.topP).toBe(0.9);
      expect(record.topK).toBe(40);
      expect(record.messageCount).toBe(1);
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
      expect(record.responseText).toBe('Hello from Cohere');

      expect(record.error).toBeNull();
    });

    it('maps stop reasons correctly', async () => {
      // Test 'MAX_TOKENS' -> 'max_tokens'
      const client1 = makeMockClient() as unknown as CohereClient;
      (client1.chat as jest.Mock).mockResolvedValue(
        makeChatResponse({ finish_reason: 'MAX_TOKENS' }),
      );
      const { records: records1, handler: handler1 } = makeRecorder();
      wrapCohereClient(client1, makeConfig(), handler1);
      await client1.chat!(makeChatParams() as never);
      expect(records1[0].stopReason).toBe('max_tokens');

      // Test 'COMPLETE' -> 'end_turn'
      const client2 = makeMockClient() as unknown as CohereClient;
      (client2.chat as jest.Mock).mockResolvedValue(
        makeChatResponse({ finish_reason: 'COMPLETE' }),
      );
      const { records: records2, handler: handler2 } = makeRecorder();
      wrapCohereClient(client2, makeConfig(), handler2);
      await client2.chat!(makeChatParams() as never);
      expect(records2[0].stopReason).toBe('end_turn');

      // Test 'ERROR_TOXIC' -> 'content_filter'
      const client3 = makeMockClient() as unknown as CohereClient;
      (client3.chat as jest.Mock).mockResolvedValue(
        makeChatResponse({ finish_reason: 'ERROR_TOXIC' }),
      );
      const { records: records3, handler: handler3 } = makeRecorder();
      wrapCohereClient(client3, makeConfig(), handler3);
      await client3.chat!(makeChatParams() as never);
      expect(records3[0].stopReason).toBe('content_filter');
    });

    it('truncates content to contentMaxLength', async () => {
      const longText = 'a'.repeat(200);
      const response = makeChatResponse({
        text: longText,
      });
      const client = makeMockClient() as unknown as CohereClient;
      (client.chat as jest.Mock).mockResolvedValue(response);

      const config = makeConfig({ recordContent: true, contentMaxLength: 50 });
      const { records, handler } = makeRecorder();
      wrapCohereClient(client, config, handler);

      await client.chat!(
        makeChatParams({
          preamble: longText,
          message: longText,
        }) as never,
      );

      expect(records[0].systemPrompt!.length).toBe(50);
      expect(records[0].lastUserMessage!.length).toBe(50);
      expect(records[0].responseText!.length).toBe(50);
    });

    it('handles recordContent=false', async () => {
      const response = makeChatResponse();
      const client = makeMockClient() as unknown as CohereClient;
      (client.chat as jest.Mock).mockResolvedValue(response);

      const config = makeConfig({ recordContent: false });
      const { records, handler } = makeRecorder();
      wrapCohereClient(client, config, handler);

      await client.chat!(makeChatParams() as never);

      expect(records[0].systemPrompt).toBeNull();
      expect(records[0].lastUserMessage).toBeNull();
      expect(records[0].responseText).toBeNull();
    });

    it('handles highSecurity=true', async () => {
      const response = makeChatResponse();
      const client = makeMockClient() as unknown as CohereClient;
      (client.chat as jest.Mock).mockResolvedValue(response);

      const config = makeConfig({ recordContent: true, highSecurity: true });
      const { records, handler } = makeRecorder();
      wrapCohereClient(client, config, handler);

      await client.chat!(makeChatParams() as never);

      expect(records[0].systemPrompt).toBeNull();
      expect(records[0].lastUserMessage).toBeNull();
      expect(records[0].responseText).toBeNull();
    });

    it('handles missing optional fields gracefully', async () => {
      const response = makeChatResponse();
      const client = makeMockClient() as unknown as CohereClient;
      (client.chat as jest.Mock).mockResolvedValue(response);

      const { records, handler } = makeRecorder();
      wrapCohereClient(client, makeConfig(), handler);

      await client.chat!(
        {
          model: 'command-r',
          message: 'Hi',
        } as never,
      );

      const record = records[0];
      expect(record.maxTokens).toBeNull();
      expect(record.temperature).toBeNull();
      expect(record.topP).toBeNull();
      expect(record.topK).toBeNull();
      expect(record.systemPromptLength).toBeNull();
    });
  });

  describe('chat() — error handling', () => {
    it('propagates errors and captures error record', async () => {
      const apiError = Object.assign(new Error('rate limit exceeded'), {
        status: 429,
      });
      const client = makeMockClient() as unknown as CohereClient;
      (client.chat as jest.Mock).mockRejectedValue(apiError);

      const { records, handler } = makeRecorder();
      wrapCohereClient(client, makeConfig(), handler);

      await expect(client.chat!(makeChatParams() as never)).rejects.toThrow(
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
      const client = makeMockClient() as unknown as CohereClient;
      (client.chat as jest.Mock).mockRejectedValue(apiError);

      const config = makeConfig({ redactionPatterns: [/Bearer\s+\S+/g] });
      const { records, handler } = makeRecorder();
      wrapCohereClient(client, config, handler);

      await expect(client.chat!(makeChatParams() as never)).rejects.toThrow();

      expect(records[0].error!.message).toBe('auth failed: [REDACTED] was rejected');
    });
  });

  describe('chatStream() — streaming', () => {
    it('yields all events unmodified and captures token usage and TTFT', async () => {
      const events = makeStreamEvents();
      const mockStream = makeMockStream(events);
      const mockClient = makeMockClient() as unknown as CohereClient;
      (mockClient.chatStream as jest.Mock).mockReturnValue(mockStream);

      const { records, handler } = makeRecorder();
      wrapCohereClient(mockClient, makeConfig(), handler);

      const stream = (mockClient.chatStream!(makeChatParams() as never) as unknown) as AsyncIterable<unknown>;

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
      expect(record.provider).toBe('cohere');
      expect(record.requestMethod).toBe('chatStream');
      expect(record.streaming).toBe(true);
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
      expect(record.totalTokens).toBe(150);
      expect(record.stopReason).toBe('end_turn');
      expect(record.responseText).toBe('Hello from Cohere');
      expect(record.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
    });

    it('handles streaming without stream-end event', async () => {
      const events = makeStreamEvents(false);
      const mockStream = makeMockStream(events);
      const mockClient = makeMockClient() as unknown as CohereClient;
      (mockClient.chatStream as jest.Mock).mockReturnValue(mockStream);

      const { records, handler } = makeRecorder();
      wrapCohereClient(mockClient, makeConfig(), handler);

      const stream = (mockClient.chatStream!(makeChatParams() as never) as unknown) as AsyncIterable<unknown>;

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
      const mockClient = makeMockClient() as unknown as CohereClient;
      (mockClient.chatStream as jest.Mock).mockReturnValue(mockStream);

      const config = makeConfig({ recordContent: false });
      const { records, handler } = makeRecorder();
      wrapCohereClient(mockClient, config, handler);

      const stream = (mockClient.chatStream!(makeChatParams() as never) as unknown) as AsyncIterable<unknown>;

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
      const client = makeMockClient() as unknown as CohereClient;
      (client.chat as jest.Mock).mockResolvedValue(response);

      const config = makeConfig();
      const { handler } = makeRecorder();

      wrapCohereClient(client, config, handler);
      await client.chat!(makeChatParams() as never);

      expect(mockTracer.startSpan).toHaveBeenCalledTimes(1);
      expect(mockSpan.end).toHaveBeenCalledTimes(1);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    });

    it('records exception and ends span on error', async () => {
      const error = new Error('SDK error');
      const client = makeMockClient() as unknown as CohereClient;
      (client.chat as jest.Mock).mockRejectedValue(error);

      const config = makeConfig();
      const { handler } = makeRecorder();

      wrapCohereClient(client, config, handler);
      await expect(client.chat!(makeChatParams() as never)).rejects.toThrow('SDK error');

      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
      expect(mockSpan.end).toHaveBeenCalledTimes(1);
    });
  });
});
