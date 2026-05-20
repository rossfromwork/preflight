import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { request as nodeRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OtlpReceiver } from './otlp-receiver.js';
import type { OtlpReceiverOptions } from './otlp-receiver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

function makeReceiver(overrides: Partial<OtlpReceiverOptions> = {}): OtlpReceiver {
  return new OtlpReceiver({
    port: 0,
    forwardEndpoint: null,
    forwardHeaders: {},
    enrichmentAttributes: { 'ai.session.id': 'test-session' },
    ...overrides,
  });
}

function getBoundPort(receiver: OtlpReceiver): number {
  const internals = receiver as unknown as { server: Server | null };
  const addr = internals.server?.address() as AddressInfo | null;
  if (!addr) throw new Error('Receiver not started');
  return addr.port;
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string | Buffer,
  headers?: Record<string, string>,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = nodeRequest({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// enrichPayload
// ---------------------------------------------------------------------------

describe('enrichPayload', () => {
  it('injects attributes into resourceSpans[0].resource.attributes', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'sess-123' } });
    const input = { resourceSpans: [{ resource: { attributes: [] } }] };
    const result = JSON.parse(
      receiver.enrichPayload(Buffer.from(JSON.stringify(input))).toString('utf-8'),
    ) as typeof input;
    expect(result.resourceSpans[0].resource.attributes).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'sess-123' },
    });
  });

  it('injects attributes into resourceMetrics', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'sess-123' } });
    const input = { resourceMetrics: [{ resource: { attributes: [] } }] };
    const result = JSON.parse(
      receiver.enrichPayload(Buffer.from(JSON.stringify(input))).toString('utf-8'),
    ) as typeof input;
    expect(result.resourceMetrics[0].resource.attributes).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'sess-123' },
    });
  });

  it('injects attributes into resourceLogs', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'sess-123' } });
    const input = { resourceLogs: [{ resource: { attributes: [] } }] };
    const result = JSON.parse(
      receiver.enrichPayload(Buffer.from(JSON.stringify(input))).toString('utf-8'),
    ) as typeof input;
    expect(result.resourceLogs[0].resource.attributes).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'sess-123' },
    });
  });

  it('creates missing resource and attributes when not present', () => {
    const receiver = makeReceiver({ enrichmentAttributes: { 'ai.session.id': 'sess-123' } });
    const input = { resourceSpans: [{}] };
    const result = JSON.parse(
      receiver.enrichPayload(Buffer.from(JSON.stringify(input))).toString('utf-8'),
    ) as { resourceSpans: [{ resource: { attributes: unknown[] } }] };
    expect(result.resourceSpans[0].resource.attributes).toContainEqual({
      key: 'ai.session.id',
      value: { stringValue: 'sess-123' },
    });
  });

  it('passes non-JSON bytes through unchanged', () => {
    const receiver = makeReceiver();
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    const result = receiver.enrichPayload(binary);
    expect(result).toBe(binary);
  });
});

// ---------------------------------------------------------------------------
// handleRequest (via live HTTP)
// ---------------------------------------------------------------------------

describe('handleRequest', () => {
  let receiver: OtlpReceiver;

  beforeEach(async () => {
    receiver = makeReceiver();
    await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it('returns 404 for non-POST requests', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'GET', '/v1/traces');
    expect(statusCode).toBe(404);
  });

  it('returns 404 for paths that do not start with /v1/', async () => {
    const port = getBoundPort(receiver);
    const { statusCode } = await httpRequest(port, 'POST', '/health', '{}');
    expect(statusCode).toBe(404);
  });

  it('returns 200 with {} when forwardEndpoint is null', async () => {
    const port = getBoundPort(receiver);
    const { statusCode, body } = await httpRequest(
      port,
      'POST',
      '/v1/traces',
      JSON.stringify({ resourceSpans: [] }),
    );
    expect(statusCode).toBe(200);
    expect(body).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// forward (mock fetch)
// ---------------------------------------------------------------------------

describe('forward', () => {
  const mockFetch = jest.fn<(url: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue({
    status: 200,
    text: async () => '{}',
  } as Response);

  beforeEach(() => {
    mockFetch.mockClear();
    (globalThis as { fetch?: unknown }).fetch = mockFetch;
  });

  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it('calls fetch with the forward URL and api-key header', async () => {
    const receiver = makeReceiver({
      forwardEndpoint: 'https://otlp.nr-data.net',
      forwardHeaders: { 'api-key': 'test-key' },
    });
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      await httpRequest(port, 'POST', '/v1/traces', JSON.stringify({ resourceSpans: [] }));
      expect(mockFetch).toHaveBeenCalledWith(
        'https://otlp.nr-data.net/v1/traces',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'api-key': 'test-key' }),
        }),
      );
    } finally {
      await receiver.stop();
    }
  });

  it('preserves Content-Type: application/x-protobuf for protobuf payloads', async () => {
    const receiver = makeReceiver({
      forwardEndpoint: 'https://otlp.nr-data.net',
      forwardHeaders: {},
    });
    await receiver.start();
    try {
      const port = getBoundPort(receiver);
      const binaryBody = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      await httpRequest(port, 'POST', '/v1/traces', binaryBody, {
        'content-type': 'application/x-protobuf',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://otlp.nr-data.net/v1/traces',
        expect.objectContaining({
          headers: expect.objectContaining({ 'Content-Type': 'application/x-protobuf' }),
        }),
      );
    } finally {
      await receiver.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// start / stop lifecycle
// ---------------------------------------------------------------------------

describe('start / stop lifecycle', () => {
  it('starts an HTTP server and stop() closes it', async () => {
    const receiver = makeReceiver();
    await receiver.start();
    const port = getBoundPort(receiver);
    await expect(httpRequest(port, 'GET', '/v1/traces')).resolves.toBeDefined();
    await receiver.stop();
    await expect(httpRequest(port, 'GET', '/v1/traces')).rejects.toThrow();
  });

  it('stop() resolves immediately when not yet started', async () => {
    const receiver = makeReceiver();
    await expect(receiver.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// constructor SSRF guard
// ---------------------------------------------------------------------------

describe('constructor SSRF guard', () => {
  it('throws for a private RFC-1918 forwardEndpoint', () => {
    expect(
      () => new OtlpReceiver({
        port: 0,
        forwardEndpoint: 'http://192.168.1.1/endpoint',
        forwardHeaders: {},
        enrichmentAttributes: {},
      }),
    ).toThrow();
  });

  it('throws for a loopback forwardEndpoint', () => {
    expect(
      () => new OtlpReceiver({
        port: 0,
        forwardEndpoint: 'http://127.0.0.1:4317',
        forwardHeaders: {},
        enrichmentAttributes: {},
      }),
    ).toThrow();
  });

  it('accepts a public forwardEndpoint', () => {
    expect(
      () => new OtlpReceiver({
        port: 0,
        forwardEndpoint: 'https://otlp.nr-data.net',
        forwardHeaders: {},
        enrichmentAttributes: {},
      }),
    ).not.toThrow();
  });

  it('accepts null forwardEndpoint without validation', () => {
    expect(
      () => new OtlpReceiver({
        port: 0,
        forwardEndpoint: null,
        forwardHeaders: {},
        enrichmentAttributes: {},
      }),
    ).not.toThrow();
  });
});
