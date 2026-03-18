/**
 * Tests for concurrency control, progress callbacks, and suite versioning.
 */

import { describe, it, expect, vi } from 'vitest';
import { Runner } from '../src/runner.js';
import { Semaphore } from '../src/semaphore.js';
import { qualifiedSuiteId } from '../src/types.js';
import type {
  AgentAdapter,
  AdapterOutput,
  SuiteDefinition,
  ProgressEvent,
  ScenarioDefinition,
} from '../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────

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

function makeScenario(id: string, layer: ScenarioDefinition['layer'] = 'execution', dependsOn?: string): ScenarioDefinition {
  return {
    id,
    name: `Scenario ${id}`,
    layer,
    input: { prompt: `prompt-${id}` },
    kpis: [{
      id: `kpi-${id}`,
      name: `KPI ${id}`,
      weight: 1,
      method: 'automated',
      config: { type: 'contains', expected: 'mock' },
    }],
    ...(dependsOn ? { depends_on: dependsOn } : {}),
  };
}

function createSuite(overrides?: Partial<SuiteDefinition>): SuiteDefinition {
  return {
    id: 'test',
    name: 'Test Suite',
    version: '1.0.0',
    agent: { adapter: 'http', endpoint: 'http://localhost' },
    scenarios: [makeScenario('s1')],
    ...overrides,
  };
}

// ─── Semaphore ──────────────────────────────────────────────────

describe('Semaphore', () => {
  it('limits concurrency to the specified number', async () => {
    const sem = new Semaphore(2);
    let maxConcurrent = 0;
    let current = 0;

    const work = () => sem.run(async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 20));
      current--;
    });

    await Promise.all([work(), work(), work(), work(), work()]);
    expect(maxConcurrent).toBe(2);
  });

  it('throws on invalid limit', () => {
    expect(() => new Semaphore(0)).toThrow('limit must be >= 1');
    expect(() => new Semaphore(-1)).toThrow('limit must be >= 1');
  });

  it('reports activeCount and queueLength', async () => {
    const sem = new Semaphore(1);
    let resolveFirst: () => void;
    const firstBlocks = new Promise<void>((r) => { resolveFirst = r; });

    const p1 = sem.run(() => firstBlocks);
    // p1 is active, nothing in queue yet
    expect(sem.activeCount).toBe(1);

    const p2 = sem.run(async () => {});
    // p2 should be queued
    expect(sem.queueLength).toBe(1);

    resolveFirst!();
    await p1;
    await p2;
    expect(sem.activeCount).toBe(0);
    expect(sem.queueLength).toBe(0);
  });

  it('propagates errors from the wrapped function', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // Semaphore should release slot even after error
    expect(sem.activeCount).toBe(0);
  });
});

// ─── Concurrency Control in Runner ──────────────────────────────

describe('Runner concurrency', () => {
  it('runs scenarios concurrently within a layer up to the limit', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const adapter = createMockAdapter();
    (adapter.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 30));
      current--;
      return { response: 'mock response', duration_ms: 30 };
    });

    const suite = createSuite({
      scenarios: [
        makeScenario('a'),
        makeScenario('b'),
        makeScenario('c'),
        makeScenario('d'),
      ],
    });

    const runner = new Runner(adapter, { concurrency: { scenarios: 2 } });
    const result = await runner.run(suite);

    expect(result.scenarios).toHaveLength(4);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBeGreaterThan(0);
  });

  it('defaults to concurrency of 5 when not specified', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const adapter = createMockAdapter();
    (adapter.send as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise((r) => setTimeout(r, 10));
      current--;
      return { response: 'mock response', duration_ms: 10 };
    });

    const scenarios: ScenarioDefinition[] = [];
    for (let i = 0; i < 8; i++) {
      scenarios.push(makeScenario(`s${i}`));
    }

    const runner = new Runner(adapter);
    await runner.run(createSuite({ scenarios }));

    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });

  it('respects depends_on ordering even with concurrency', async () => {
    const callOrder: string[] = [];
    const adapter = createMockAdapter();
    (adapter.send as ReturnType<typeof vi.fn>).mockImplementation(async (input: any) => {
      callOrder.push(input.prompt);
      return { response: 'mock response', duration_ms: 10 };
    });

    const suite = createSuite({
      scenarios: [
        makeScenario('exec1', 'execution'),
        makeScenario('exec2', 'execution'),
        makeScenario('reason1', 'reasoning', 'exec1'),
      ],
    });

    const runner = new Runner(adapter, { concurrency: { scenarios: 10 } });
    await runner.run(suite);

    // reasoning scenario should come after execution scenarios
    const execIndices = callOrder.filter(p => p.startsWith('prompt-exec')).map(p => callOrder.indexOf(p));
    const reasonIndex = callOrder.indexOf(callOrder.find(p => p.includes('reason'))!);
    expect(Math.max(...execIndices)).toBeLessThan(reasonIndex);
  });
});

// ─── Progress Callbacks ─────────────────────────────────────────

describe('Progress callbacks', () => {
  it('emits suite and scenario lifecycle events', async () => {
    const events: ProgressEvent[] = [];
    const adapter = createMockAdapter();

    const suite = createSuite({
      scenarios: [makeScenario('s1'), makeScenario('s2')],
    });

    const runner = new Runner(adapter, {
      onProgress: (event) => events.push(event),
    });

    await runner.run(suite);

    const types = events.map((e) => e.type);
    expect(types).toContain('suite:started');
    expect(types).toContain('suite:completed');
    expect(types.filter((t) => t === 'scenario:started')).toHaveLength(2);
    expect(types.filter((t) => t === 'scenario:completed')).toHaveLength(2);
  });

  it('includes progress counts in scenario events', async () => {
    const events: ProgressEvent[] = [];
    const adapter = createMockAdapter();

    const suite = createSuite({
      scenarios: [makeScenario('s1'), makeScenario('s2'), makeScenario('s3')],
    });

    const runner = new Runner(adapter, {
      onProgress: (event) => events.push(event),
      concurrency: { scenarios: 1 }, // sequential for predictable progress
    });

    await runner.run(suite);

    const completions = events.filter((e) => e.type === 'scenario:completed');
    expect(completions).toHaveLength(3);
    expect(completions[0].progress?.completed).toBe(1);
    expect(completions[1].progress?.completed).toBe(2);
    expect(completions[2].progress?.completed).toBe(3);
    expect(completions[2].progress?.total).toBe(3);
  });

  it('includes elapsed_ms in all events', async () => {
    const events: ProgressEvent[] = [];
    const adapter = createMockAdapter();

    const runner = new Runner(adapter, {
      onProgress: (event) => events.push(event),
    });

    await runner.run(createSuite());

    for (const event of events) {
      expect(event.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(event.timestamp).toBeDefined();
    }
  });

  it('emits scoring events for KPIs', async () => {
    const events: ProgressEvent[] = [];
    const adapter = createMockAdapter();

    const runner = new Runner(adapter, {
      onProgress: (event) => events.push(event),
    });

    await runner.run(createSuite());

    const scoringStarted = events.filter((e) => e.type === 'scoring:started');
    const scoringCompleted = events.filter((e) => e.type === 'scoring:completed');
    expect(scoringStarted).toHaveLength(1);
    expect(scoringCompleted).toHaveLength(1);
    expect(scoringCompleted[0].kpi_id).toBe('kpi-s1');
  });

  it('suite:completed event includes score and badge', async () => {
    const events: ProgressEvent[] = [];
    const adapter = createMockAdapter();

    const runner = new Runner(adapter, {
      onProgress: (event) => events.push(event),
    });

    await runner.run(createSuite());

    const suiteCompleted = events.find((e) => e.type === 'suite:completed');
    expect(suiteCompleted).toBeDefined();
    expect(suiteCompleted!.score).toBeDefined();
    expect(suiteCompleted!.badge).toBeDefined();
  });
});

// ─── Suite Versioning ───────────────────────────────────────────

describe('Suite versioning', () => {
  describe('qualifiedSuiteId', () => {
    it('returns id@version when no namespace', () => {
      expect(qualifiedSuiteId({ id: 'my-suite', version: '1.0.0' })).toBe('my-suite@1.0.0');
    });

    it('returns namespace/id@version with namespace', () => {
      expect(qualifiedSuiteId({ id: 'my-suite', version: '2.0.0', namespace: 'acme' })).toBe('acme/my-suite@2.0.0');
    });

    it('returns plain id when no version', () => {
      expect(qualifiedSuiteId({ id: 'my-suite', version: '' })).toBe('my-suite');
    });

    it('returns namespace/id when namespace but no version', () => {
      expect(qualifiedSuiteId({ id: 'my-suite', version: '', namespace: 'acme' })).toBe('acme/my-suite');
    });
  });

  it('suite_id in result uses qualified ID format', async () => {
    const adapter = createMockAdapter();
    const runner = new Runner(adapter);

    const result = await runner.run(createSuite({
      id: 'sdr-eval',
      version: '2.1.0',
      namespace: 'acme',
    }));

    expect(result.suite_id).toBe('acme/sdr-eval@2.1.0');
    expect(result.suite_version).toBe('2.1.0');
  });

  it('suite_id works without namespace (backward compatible)', async () => {
    const adapter = createMockAdapter();
    const runner = new Runner(adapter);

    const result = await runner.run(createSuite({
      id: 'sdr-eval',
      version: '1.0.0',
    }));

    expect(result.suite_id).toBe('sdr-eval@1.0.0');
  });

  it('rejects duplicate scenario IDs', async () => {
    const adapter = createMockAdapter();
    const runner = new Runner(adapter);

    const suite = createSuite({
      scenarios: [
        makeScenario('dup'),
        makeScenario('dup'),
      ],
    });

    await expect(runner.run(suite)).rejects.toThrow('Duplicate scenario ID "dup"');
  });
});
