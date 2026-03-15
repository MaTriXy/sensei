/**
 * T8.6 — Full runner integration with mock HTTP adapter.
 *
 * Tests the adapter layer: factory, HTTP adapter with a fake server,
 * stdio adapter basics, and error handling.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  createAdapter,
  registerAdapter,
  HttpAdapter,
  type AgentConfig,
  type AgentAdapter,
  type AdapterInput,
  type AdapterOutput,
} from '../src/index.js';

// ─── Mock HTTP Server ───────────────────────────────────────────────

let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/execute' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            response: `Executed: ${parsed.task}`,
            structured: { echo: true },
          }),
        );
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('createAdapter factory', () => {
  it('creates an HTTP adapter from config', () => {
    const config: AgentConfig = { adapter: 'http', endpoint: 'http://localhost:3000' };
    const adapter = createAdapter(config);
    expect(adapter.name).toBe('http');
  });

  it('throws for unknown adapter type', () => {
    const config = { adapter: 'unknown' } as AgentConfig;
    expect(() => createAdapter(config)).toThrow('Unknown adapter');
  });

  it('allows registering custom adapters', () => {
    const mockAdapter: AgentAdapter = {
      name: 'custom',
      connect: vi.fn(),
      healthCheck: vi.fn(async () => true),
      send: vi.fn(async () => ({ response: 'ok', duration_ms: 1 })),
      disconnect: vi.fn(),
    };
    registerAdapter('custom' as string, () => mockAdapter);

    const config = { adapter: 'custom' } as AgentConfig;
    const adapter = createAdapter(config);
    expect(adapter.name).toBe('custom');
  });
});

describe('HttpAdapter', () => {
  it('requires an endpoint', () => {
    expect(() => new HttpAdapter({ adapter: 'http' })).toThrow('requires an endpoint');
  });

  it('passes health check against mock server', async () => {
    const adapter = new HttpAdapter({
      adapter: 'http',
      endpoint: `http://localhost:${port}`,
    });
    await adapter.connect();
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(true);
    await adapter.disconnect();
  });

  it('returns false for health check on unreachable server', async () => {
    const adapter = new HttpAdapter({
      adapter: 'http',
      endpoint: 'http://localhost:1',
      health_check: 'http://localhost:1/health',
    });
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(false);
  });

  it('sends a task and receives a response', async () => {
    const adapter = new HttpAdapter({
      adapter: 'http',
      endpoint: `http://localhost:${port}`,
    });
    await adapter.connect();

    const input: AdapterInput = {
      prompt: 'Write a cold email',
      context: { prospect: 'Sarah Chen' },
    };
    const output = await adapter.send(input);

    expect(output.response).toBe('Executed: Write a cold email');
    expect(output.duration_ms).toBeGreaterThan(0);
    expect(output.metadata).toEqual({ echo: true });
    expect(output.error).toBeUndefined();

    await adapter.disconnect();
  });

  it('returns error for failed requests after retries', async () => {
    const adapter = new HttpAdapter({
      adapter: 'http',
      endpoint: 'http://localhost:1', // unreachable
      timeout_ms: 500,
    });

    const output = await adapter.send({ prompt: 'test' });
    expect(output.error).toBeDefined();
    expect(output.response).toBe('');
  }, 30_000);
});
