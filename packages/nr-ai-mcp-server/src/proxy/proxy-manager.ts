/**
 * ProxyManager — HTTP server that routes requests to upstream MCP servers
 * with transparent forwarding and observability recording.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createLogger } from '@nr-ai-observatory/shared';
import type {
  ForwardResult,
  ProxyRequestRecord,
  ProxyToolCallRecord,
  ProxyUpstream,
  UpstreamConfig,
} from './types.js';
import { TRACKED_METHODS } from './types.js';
import { HttpUpstream } from './upstream-http.js';
import { StdioUpstream } from './upstream-stdio.js';

const logger = createLogger('proxy-manager');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyManagerOptions {
  readonly port: number;
  readonly onToolCall?: (record: ProxyToolCallRecord) => void;
  readonly onRequest?: (record: ProxyRequestRecord) => void;
}

// ---------------------------------------------------------------------------
// JSON-RPC body parsing (just enough to identify the method)
// ---------------------------------------------------------------------------

interface JsonRpcPeek {
  method: string;
  id?: string | number;
  params?: Record<string, unknown>;
}

function peekJsonRpc(body: Buffer): JsonRpcPeek | null {
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString('utf-8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'method' in parsed &&
      typeof (parsed as Record<string, unknown>).method === 'string'
    ) {
      return parsed as JsonRpcPeek;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ProxyManager
// ---------------------------------------------------------------------------

export class ProxyManager {
  private readonly upstreams = new Map<string, ProxyUpstream>();
  private httpServer: Server | null = null;
  private readonly port: number;
  private readonly onToolCall: ((record: ProxyToolCallRecord) => void) | undefined;
  private readonly onRequest: ((record: ProxyRequestRecord) => void) | undefined;

  constructor(options: ProxyManagerOptions) {
    this.port = options.port;
    this.onToolCall = options.onToolCall;
    this.onRequest = options.onRequest;
  }

  /** Register an upstream MCP server for proxying. */
  registerUpstream(config: UpstreamConfig): void {
    const upstream = createUpstream(config);
    this.upstreams.set(config.name, upstream);
    logger.info(`Registered upstream "${config.name}"`, { transportType: config.transportType });
  }

  /** Get the list of registered upstream names. */
  getUpstreamNames(): string[] {
    return Array.from(this.upstreams.keys());
  }

  /** Get a registered upstream by name (for testing). */
  getUpstream(name: string): ProxyUpstream | undefined {
    return this.upstreams.get(name);
  }

  /** Connect all upstreams and start the HTTP proxy server. */
  async start(): Promise<void> {
    // Connect all upstreams
    const connectResults = await Promise.allSettled(
      Array.from(this.upstreams.values()).map((u) => u.connect()),
    );
    for (const result of connectResults) {
      if (result.status === 'rejected') {
        logger.error('Failed to connect upstream', { error: String(result.reason) });
      }
    }

    // Start HTTP server
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        logger.error('Unhandled request error', { error: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      });
    });

    return new Promise((resolve) => {
      this.httpServer!.listen(this.port, '127.0.0.1', () => {
        logger.info(`Proxy server listening`, { port: this.port });
        resolve();
      });
    });
  }

  /** Stop the HTTP server and disconnect all upstreams. */
  async stop(): Promise<void> {
    // Close the HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    // Disconnect all upstreams
    await Promise.allSettled(
      Array.from(this.upstreams.values()).map((u) => u.disconnect()),
    );

    logger.info('Proxy server stopped');
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';

    // Health check
    if (url === '/health' && req.method === 'GET') {
      const body = JSON.stringify({
        status: 'ok',
        upstreams: this.getUpstreamNames(),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    // Parse /proxy/{server-name} route
    const match = url.match(/^\/proxy\/([^/]+)/);
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', message: `No route for ${url}` }));
      return;
    }

    const serverName = decodeURIComponent(match[1]);
    const upstream = this.upstreams.get(serverName);
    if (!upstream) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_not_found', message: `Unknown upstream: ${serverName}` }));
      return;
    }

    // Read request body (for POST/DELETE; empty for GET)
    const body = await readBody(req);

    // Forward with interception
    await this.forwardWithInterception(upstream, req, res, body);
  }

  private async forwardWithInterception(
    upstream: ProxyUpstream,
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const rpc = peekJsonRpc(body);
    const isTracked = rpc !== null && TRACKED_METHODS.has(rpc.method);

    const overallStart = performance.now();
    const result = await upstream.forward(req, res, body);
    const overallEnd = performance.now();

    if (!isTracked || !rpc) return;

    const totalDurationMs = overallEnd - overallStart;
    const proxyOverheadMs = totalDurationMs - result.upstreamLatencyMs;

    if (rpc.method === 'tools/call') {
      this.emitToolCallRecord(upstream, rpc, result, totalDurationMs, proxyOverheadMs, body);
    } else {
      this.emitRequestRecord(upstream, rpc, result, totalDurationMs, proxyOverheadMs);
    }
  }

  private emitToolCallRecord(
    upstream: ProxyUpstream,
    rpc: JsonRpcPeek,
    result: ForwardResult,
    durationMs: number,
    proxyOverheadMs: number,
    body: Buffer,
  ): void {
    if (!this.onToolCall) return;

    const toolName = typeof rpc.params?.name === 'string' ? rpc.params.name : 'unknown';

    const record: ProxyToolCallRecord = {
      id: randomUUID(),
      sessionId: null,
      toolName,
      toolUseId: String(rpc.id ?? ''),
      timestamp: Date.now(),
      durationMs,
      success: result.statusCode >= 200 && result.statusCode < 400,
      serverName: upstream.name,
      upstreamLatencyMs: result.upstreamLatencyMs,
      proxyOverheadMs,
      inputSizeBytes: body.length,
      outputSizeBytes: result.responseSizeBytes ?? undefined,
    };

    this.onToolCall(record);
  }

  private emitRequestRecord(
    upstream: ProxyUpstream,
    rpc: JsonRpcPeek,
    result: ForwardResult,
    durationMs: number,
    proxyOverheadMs: number,
  ): void {
    if (!this.onRequest) return;

    const record: ProxyRequestRecord = {
      id: randomUUID(),
      serverName: upstream.name,
      method: rpc.method,
      timestamp: Date.now(),
      durationMs,
      upstreamLatencyMs: result.upstreamLatencyMs,
      proxyOverheadMs,
      success: result.statusCode >= 200 && result.statusCode < 400,
      responseSizeBytes: result.responseSizeBytes ?? undefined,
    };

    this.onRequest(record);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET') {
      resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createUpstream(config: UpstreamConfig): ProxyUpstream {
  if (config.transportType === 'http') {
    return new HttpUpstream(config);
  }
  return new StdioUpstream(config);
}
