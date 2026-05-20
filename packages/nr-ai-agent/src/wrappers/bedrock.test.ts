import { SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { wrapBedrockClient } from './bedrock.js';
import type { AiRequestRecord, WrapperConfig, RecordHandler } from '../types.js';
import { ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import * as tracing from '../tracing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConverseResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    output: {
      message: {
        role: 'assistant',
        content: [{ text: 'Hello from Bedrock' }],
      },
    },
    stopReason: 'end_turn',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
    },
    ...overrides,
  };
}

function makeConverseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
    inferenceConfig: { maxTokens: 1024 },
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

function makeStreamEvents(includeMetadata = true): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    {
      contentBlockStart: { contentBlockIndex: 0, contentBlock: { type: 'text' } },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    },
    {
      contentBlockDelta: {
        contentBlockIndex: 0,
        delta: { type: 'text_delta', text: ' from Bedrock' },
      },
    },
    {
      contentBlockStop: { contentBlockIndex: 0 },
    },
    {
      messageStop: { stopReason: 'end_turn' },
    },
  ];

  if (includeMetadata) {
    events.push({
      metadata: { usage: { inputTokens: 100, outputTokens: 50 } },
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

function makeMockClient(sendMock?: jest.Mock): Partial<BedrockRuntimeClient> {
  return {
    send: sendMock || jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wrapBedrockClient', () => {
  // Suppress logger output in tests
  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('enabled=false', () => {
    it('returns the original client unmodified', () => {
      const client = makeMockClient() as unknown as BedrockRuntimeClient;
      const config = makeConfig({ enabled: false });
      const { handler } = makeRecorder();

      const result = wrapBedrockClient(client, config, handler);

      expect(result).toBe(client);
    });
  });

  describe('ConverseCommand — non-streaming', () => {
    it('captures all fields in the AiRequestRecord', async () => {
      const response = makeConverseResponse();
      const sendMock = jest.fn().mockResolvedValue(response);
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const config = makeConfig({ recordContent: true });
      const { records, handler } = makeRecorder();

      wrapBedrockClient(client, config, handler);

      const command = new ConverseCommand(
        makeConverseInput({
          modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          system: [{ text: 'You are a helpful assistant.' }],
          messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
          inferenceConfig: { maxTokens: 1024, temperature: 0.7, topP: 0.9 },
        }) as never,
      );

      const result = await client.send(command);

      expect(result).toBe(response);
      expect(records).toHaveLength(1);

      const record = records[0];
      expect(record.provider).toBe('bedrock');
      expect(record.requestModel).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
      expect(record.requestMethod).toBe('converse');
      expect(record.streaming).toBe(false);

      expect(record.maxTokens).toBe(1024);
      expect(record.temperature).toBe(0.7);
      expect(record.topP).toBe(0.9);
      expect(record.topK).toBeNull();
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

      expect(record.systemPrompt).toBe('You are a helpful assistant.');
      expect(record.lastUserMessage).toBe('Hello');
      expect(record.responseText).toBe('Hello from Bedrock');

      expect(record.error).toBeNull();
    });

    it('extracts last user message from messages array', async () => {
      const response = makeConverseResponse();
      const sendMock = jest.fn().mockResolvedValue(response);
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, makeConfig(), handler);

      const command = new ConverseCommand(
        makeConverseInput({
          messages: [
            { role: 'user', content: [{ text: 'First question' }] },
            { role: 'assistant', content: [{ text: 'Answer one.' }] },
            { role: 'user', content: [{ text: 'Second question' }] },
          ],
        }) as never,
      );

      await client.send(command);

      expect(records[0].lastUserMessage).toBe('Second question');
    });

    it('truncates content to contentMaxLength', async () => {
      const longText = 'a'.repeat(200);
      const response = makeConverseResponse({
        output: {
          message: {
            role: 'assistant',
            content: [{ text: longText }],
          },
        },
      });
      const sendMock = jest.fn().mockResolvedValue(response);
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const config = makeConfig({ recordContent: true, contentMaxLength: 50 });
      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, config, handler);

      const command = new ConverseCommand(
        makeConverseInput({
          system: [{ text: longText }],
          messages: [{ role: 'user', content: [{ text: longText }] }],
        }) as never,
      );

      await client.send(command);

      expect(records[0].systemPrompt!.length).toBe(50);
      expect(records[0].lastUserMessage!.length).toBe(50);
      expect(records[0].responseText!.length).toBe(50);
    });

    it('handles recordContent=false', async () => {
      const response = makeConverseResponse();
      const sendMock = jest.fn().mockResolvedValue(response);
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const config = makeConfig({ recordContent: false });
      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, config, handler);

      const command = new ConverseCommand(
        makeConverseInput({
          system: [{ text: 'System prompt' }],
          messages: [{ role: 'user', content: [{ text: 'User message' }] }],
        }) as never,
      );

      await client.send(command);

      expect(records[0].systemPrompt).toBeNull();
      expect(records[0].lastUserMessage).toBeNull();
      expect(records[0].responseText).toBeNull();
    });

    it('handles highSecurity=true', async () => {
      const response = makeConverseResponse();
      const sendMock = jest.fn().mockResolvedValue(response);
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const config = makeConfig({ recordContent: true, highSecurity: true });
      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, config, handler);

      const command = new ConverseCommand(
        makeConverseInput({
          system: [{ text: 'System prompt' }],
          messages: [{ role: 'user', content: [{ text: 'User message' }] }],
        }) as never,
      );

      await client.send(command);

      expect(records[0].systemPrompt).toBeNull();
      expect(records[0].lastUserMessage).toBeNull();
      expect(records[0].responseText).toBeNull();
    });

    it('handles missing optional fields gracefully', async () => {
      const response = makeConverseResponse();
      const sendMock = jest.fn().mockResolvedValue(response);
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, makeConfig(), handler);

      const command = new ConverseCommand({
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
      } as never,
      );

      await client.send(command);

      const record = records[0];
      expect(record.maxTokens).toBeNull();
      expect(record.temperature).toBeNull();
      expect(record.topP).toBeNull();
      expect(record.systemPromptLength).toBeNull();
      expect(record.systemPrompt).toBeNull();
    });
  });

  describe('ConverseCommand — error handling', () => {
    it('propagates errors and captures error record', async () => {
      const apiError = Object.assign(new Error('rate limit exceeded'), {
        $metadata: { httpStatusCode: 429 },
      });
      const sendMock = jest.fn().mockRejectedValue(apiError);
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, makeConfig(), handler);

      const command = new ConverseCommand(makeConverseInput() as never);

      await expect(client.send(command)).rejects.toThrow('rate limit exceeded');

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
      const sendMock = jest.fn().mockRejectedValue(apiError);
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const config = makeConfig({ redactionPatterns: [/Bearer\s+\S+/g] });
      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, config, handler);

      const command = new ConverseCommand(makeConverseInput() as never);

      await expect(client.send(command)).rejects.toThrow();

      expect(records[0].error!.message).toBe('auth failed: [REDACTED] was rejected');
    });
  });

  describe('ConverseStreamCommand — streaming', () => {
    it('yields all events unmodified and captures usage and TTFT', async () => {
      const events = makeStreamEvents();
      const mockStream = makeMockStream(events);
      const sendMock = jest.fn().mockResolvedValue({ stream: mockStream });
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, makeConfig(), handler);

      const command = new ConverseStreamCommand(
        makeConverseInput({}) as never,
      );

      const response = await client.send(command);
      const stream = (response as { stream: AsyncIterable<unknown> }).stream;

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
      expect(record.provider).toBe('bedrock');
      expect(record.requestMethod).toBe('converse-stream');
      expect(record.streaming).toBe(true);
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(50);
      expect(record.totalTokens).toBe(150);
      expect(record.stopReason).toBe('end_turn');
      expect(record.responseText).toBe('Hello from Bedrock');
      expect(record.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
    });

    it('handles streaming without metadata event', async () => {
      const events = makeStreamEvents(false);
      const mockStream = makeMockStream(events);
      const sendMock = jest.fn().mockResolvedValue({ stream: mockStream });
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, makeConfig(), handler);

      const command = new ConverseStreamCommand(
        makeConverseInput({}) as never,
      );

      const response = await client.send(command);
      const stream = (response as { stream: AsyncIterable<unknown> }).stream;

      const collected: unknown[] = [];
      for await (const event of stream) {
        collected.push(event);
      }

      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.inputTokens).toBe(0);
      expect(record.outputTokens).toBe(0);
    });

    it('respects recordContent=false in streaming', async () => {
      const events = makeStreamEvents();
      const mockStream = makeMockStream(events);
      const sendMock = jest.fn().mockResolvedValue({ stream: mockStream });
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const config = makeConfig({ recordContent: false });
      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, config, handler);

      const command = new ConverseStreamCommand(
        makeConverseInput({}) as never,
      );

      const response = await client.send(command);
      const stream = (response as { stream: AsyncIterable<unknown> }).stream;

      for await (const _event of stream) {
        // Consume stream
      }

      expect(records[0].responseText).toBeNull();
    });
  });

  describe('non-Converse commands', () => {
    it('passes through other commands unmodified', async () => {
      const sendMock = jest.fn().mockResolvedValue({ models: [] });
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const { records, handler } = makeRecorder();
      wrapBedrockClient(client, makeConfig(), handler);

      const customCommand = { name: 'ListFoundationModelsCommand' };
      const result = await client.send(customCommand as never);

      expect(result).toEqual({ models: [] });
      expect(records).toHaveLength(0);
      expect(sendMock).toHaveBeenCalledWith(customCommand);
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
      const response = makeConverseResponse();
      const sendMock = jest.fn().mockResolvedValue(response);
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const config = makeConfig();
      const { handler } = makeRecorder();

      wrapBedrockClient(client, config, handler);
      await client.send(new ConverseCommand(makeConverseInput() as never));

      expect(mockTracer.startSpan).toHaveBeenCalledTimes(1);
      expect(mockSpan.end).toHaveBeenCalledTimes(1);
      expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    });

    it('records exception and ends span on error', async () => {
      const error = new Error('SDK error');
      const sendMock = jest.fn().mockRejectedValue(error);
      const client = makeMockClient(sendMock) as unknown as BedrockRuntimeClient;

      const config = makeConfig();
      const { handler } = makeRecorder();

      wrapBedrockClient(client, config, handler);
      await expect(client.send(new ConverseCommand(makeConverseInput() as never))).rejects.toThrow('SDK error');

      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
      expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
      expect(mockSpan.end).toHaveBeenCalledTimes(1);
    });
  });
});
