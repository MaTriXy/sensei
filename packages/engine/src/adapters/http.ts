/**
 * HTTP Adapter — POST JSON to an agent endpoint.
 * Supports health check, configurable timeout, and retries.
 */

import type { AgentAdapter, AgentConfig, AdapterInput, AdapterOutput } from '../types.js';
import { registerAdapter } from './types.js';

export class HttpAdapter implements AgentAdapter {
  readonly name = 'http';
  private endpoint: string;
  private healthEndpoint: string;
  private timeoutMs: number;
  private maxRetries: number;
  private headers: Record<string, string>;

  constructor(private config: AgentConfig) {
    if (!config.endpoint) {
      throw new Error('HttpAdapter requires an endpoint URL');
    }
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.healthEndpoint = config.health_check ?? `${this.endpoint}/health`;
    this.timeoutMs = config.timeout_ms ?? 30_000;
    this.maxRetries = 3;
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
  }

  async connect(): Promise<void> {
    // HTTP is stateless — nothing to initialize
  }

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(this.healthEndpoint, {
        method: 'GET',
        signal: controller.signal,
        headers: this.headers,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  async send(input: AdapterInput): Promise<AdapterOutput> {
    const timeout = input.timeout_ms ?? this.timeoutMs;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const start = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        const res = await fetch(`${this.endpoint}/execute`, {
          method: 'POST',
          headers: this.headers,
          signal: controller.signal,
          body: JSON.stringify({
            task: input.prompt,
            context: input.context,
          }),
        });
        clearTimeout(timer);

        if (!res.ok) {
          throw new Error(`Agent returned HTTP ${res.status}: ${await res.text()}`);
        }

        const body = (await res.json()) as Record<string, unknown>;
        const duration_ms = Date.now() - start;

        return {
          response: (body.response as string) ?? '',
          duration_ms,
          metadata: (body.structured as Record<string, unknown>) ?? undefined,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries) {
          // Exponential back-off: 200ms, 400ms, 800ms
          await sleep(200 * Math.pow(2, attempt));
        }
      }
    }

    return {
      response: '',
      duration_ms: 0,
      error: lastError?.message ?? 'Unknown error after retries',
    };
  }

  async disconnect(): Promise<void> {
    // HTTP is stateless — nothing to tear down
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

registerAdapter('http', (config) => new HttpAdapter(config));
