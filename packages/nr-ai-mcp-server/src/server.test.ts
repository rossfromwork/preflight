import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, NrMcpServer } from './server.js';

let stderrSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('NrMcpServer', () => {
  it('instantiates without error', () => {
    const server = createServer();
    expect(server).toBeInstanceOf(NrMcpServer);
  });

  it('uses default name and version', () => {
    const server = createServer();
    expect(server.server).toBeDefined();
  });

  it('accepts custom name and version', () => {
    const server = createServer({ name: 'test-server', version: '9.9.9' });
    expect(server.server).toBeDefined();
  });

  it('close() completes without error on a non-connected server', async () => {
    const server = createServer();
    await expect(server.close()).resolves.toBeUndefined();
  });
});

describe('MCP protocol via InMemoryTransport', () => {
  let server: NrMcpServer;
  let client: Client;

  beforeEach(async () => {
    server = createServer({ name: 'test-mcp', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: 'test-client', version: '1.0.0' });

    await Promise.all([
      server.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('responds to tools/list with an empty tool list', async () => {
    const result = await client.listTools();
    expect(result.tools).toEqual([]);
  });

  it('responds to resources/list with an empty resource list', async () => {
    const result = await client.listResources();
    expect(result.resources).toEqual([]);
  });

  it('reports server info with correct name', async () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('test-mcp');
    expect(info?.version).toBe('0.0.1');
  });
});
