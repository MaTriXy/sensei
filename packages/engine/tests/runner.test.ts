import { describe, it, expect, vi } from 'vitest';
import { Runner } from '../src/runner.js';
import type { AgentAdapter, AdapterOutput, SuiteDefinition } from '../src/types.js';

function createMockAdapter(response: string = 'mock response'): AgentAdapter {
  return {
    name: 'mock-agent',
    connect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    send: vi.fn().mockResolvedValue({
      response,
      duration_ms: 100,
    } satisfies AdapterOutput),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function createSuite(overrides?: Partial<SuiteDefinition>): SuiteDefinition {
  return {
    id: 'test',
    name: 'Test Suite',
    version: '1.0.0',
    agent: { adapter: 'http', endpoint: 'http://localhost' },
    scenarios: [
      {
        id: 'exec1',
        name: 'Execution Test',
        layer: 'execution',
        input: { prompt: 'Do something' },
        kpis: [
          {
            id: 'k1',
            name: 'Contains Check',
            weight: 1,
            method: 'automated',
            config: { type: 'contains', expected: 'mock' },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('Runner', () => {
  it('runs a basic suite and returns results', async () => {
    const adapter = createMockAdapter();
    const runner = new Runner(adapter);
    const result = await runner.run(createSuite());

    expect(adapter.connect).toHaveBeenCalled();
    expect(adapter.healthCheck).toHaveBeenCalled();
    expect(adapter.send).toHaveBeenCalled();
    expect(adapter.disconnect).toHaveBeenCalled();

    expect(result.suite_id).toBe('test@1.0.0');
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].score).toBe(100); // "mock" is in "mock response"
    expect(result.badge).toBeDefined();
  });

  it('throws when health check fails', async () => {
    const adapter = createMockAdapter();
    (adapter.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const runner = new Runner(adapter);
    await expect(runner.run(createSuite())).rejects.toThrow('health check failed');
  });

  it('handles adapter errors with retries', async () => {
    const adapter = createMockAdapter();
    let callCount = 0;
    (adapter.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount < 3) return Promise.resolve({ response: '', duration_ms: 0, error: 'fail' });
      return Promise.resolve({ response: 'mock success', duration_ms: 50 });
    });

    const runner = new Runner(adapter, { retries: 3 });
    const result = await runner.run(createSuite());
    expect(result.scenarios[0].agent_output).toBe('mock success');
  });

  it('returns error result when all retries exhausted', async () => {
    const adapter = createMockAdapter();
    (adapter.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      response: '',
      duration_ms: 0,
      error: 'persistent failure',
    });

    const runner = new Runner(adapter, { retries: 1 });
    const result = await runner.run(createSuite());
    expect(result.scenarios[0].score).toBe(0);
    expect(result.scenarios[0].error).toBe('persistent failure');
  });

  it('orders scenarios by layer', async () => {
    const adapter = createMockAdapter();
    const order: string[] = [];
    (adapter.send as ReturnType<typeof vi.fn>).mockImplementation(async (input: any) => {
      order.push(input.prompt);
      return { response: 'ok', duration_ms: 10 };
    });

    const suite = createSuite({
      scenarios: [
        {
          id: 'si', name: 'SI', layer: 'self-improvement',
          input: { prompt: 'improve' },
          kpis: [{ id: 'k', name: 'K', weight: 1, method: 'automated', config: { type: 'contains', expected: 'ok' } }],
        },
        {
          id: 'ex', name: 'EX', layer: 'execution',
          input: { prompt: 'execute' },
          kpis: [{ id: 'k', name: 'K', weight: 1, method: 'automated', config: { type: 'contains', expected: 'ok' } }],
        },
        {
          id: 're', name: 'RE', layer: 'reasoning',
          input: { prompt: 'reason' },
          kpis: [{ id: 'k', name: 'K', weight: 1, method: 'automated', config: { type: 'contains', expected: 'ok' } }],
        },
      ],
    });

    await new Runner(adapter).run(suite);
    expect(order).toEqual(['execute', 'reason', 'improve']);
  });

  it('injects depends_on output into prompt', async () => {
    const adapter = createMockAdapter();
    const prompts: string[] = [];
    (adapter.send as ReturnType<typeof vi.fn>).mockImplementation(async (input: any) => {
      prompts.push(input.prompt);
      return { response: 'output-from-exec', duration_ms: 10 };
    });

    const suite = createSuite({
      scenarios: [
        {
          id: 'exec', name: 'Exec', layer: 'execution',
          input: { prompt: 'do it' },
          kpis: [{ id: 'k', name: 'K', weight: 1, method: 'automated', config: { type: 'contains', expected: 'output' } }],
        },
        {
          id: 'reason', name: 'Reason', layer: 'reasoning',
          depends_on: 'exec',
          input: { prompt: 'explain' },
          kpis: [{ id: 'k', name: 'K', weight: 1, method: 'automated', config: { type: 'contains', expected: 'output' } }],
        },
      ],
    });

    await new Runner(adapter).run(suite);
    expect(prompts[1]).toContain('output-from-exec');
    expect(prompts[1]).toContain('explain');
  });

  it('calls onScenarioComplete callback', async () => {
    const adapter = createMockAdapter();
    const calls: number[] = [];
    const runner = new Runner(adapter, {
      onScenarioComplete: (_result, index) => calls.push(index),
    });

    await runner.run(createSuite());
    expect(calls).toEqual([0]);
  });

  it('computes correct timing data', async () => {
    const adapter = createMockAdapter();
    const runner = new Runner(adapter);
    const result = await runner.run(createSuite());
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.scenarios[0].duration_ms).toBeGreaterThanOrEqual(0);
  });
});
