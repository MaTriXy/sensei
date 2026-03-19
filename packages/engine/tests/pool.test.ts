import { describe, it, expect, vi } from 'vitest';
import { SuiteLoader, resolvePools } from '../src/index.js';
import type { ScenarioDefinition, ScenarioEntry, ScenarioPool } from '../src/index.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeScenario(id: string): ScenarioDefinition {
  return {
    id,
    name: `Scenario ${id}`,
    layer: 'execution',
    input: { prompt: `Prompt for ${id}` },
    kpis: [{ id: 'k1', name: 'Check', weight: 1.0, method: 'llm-judge', config: { rubric: 'Score it' } }],
  };
}

function makePool(overrides: Partial<ScenarioPool> & { scenarios?: ScenarioDefinition[] } = {}): { pool: ScenarioPool } {
  return {
    pool: {
      id: 'test-pool',
      count: 2,
      seed: 42,
      scenarios: [makeScenario('p1'), makeScenario('p2'), makeScenario('p3')],
      ...overrides,
    },
  };
}

function makeSuiteYaml(scenariosYaml: string): string {
  return `
id: test-suite
name: Test Suite
version: "1.0.0"
scenarios:
${scenariosYaml}
`;
}

const REGULAR_SCENARIO_YAML = `  - id: fixed
    name: Fixed Scenario
    layer: execution
    input:
      prompt: "Do this"
    kpis:
      - id: k1
        name: Check
        weight: 1.0
        method: llm-judge
        config:
          rubric: "Score it"`;

const POOL_YAML = `  - pool:
      id: creative-pool
      count: 2
      seed: 42
      scenarios:
        - id: s1
          name: Scenario 1
          layer: execution
          input:
            prompt: "Prompt 1"
          kpis:
            - id: k1
              name: Check
              weight: 1.0
              method: llm-judge
              config:
                rubric: "Score it"
        - id: s2
          name: Scenario 2
          layer: execution
          input:
            prompt: "Prompt 2"
          kpis:
            - id: k1
              name: Check
              weight: 1.0
              method: llm-judge
              config:
                rubric: "Score it"
        - id: s3
          name: Scenario 3
          layer: execution
          input:
            prompt: "Prompt 3"
          kpis:
            - id: k1
              name: Check
              weight: 1.0
              method: llm-judge
              config:
                rubric: "Score it"`;

// ─── Tests ──────────────────────────────────────────────────────────

describe('Scenario Pools', () => {
  describe('YAML parsing', () => {
    it('should parse a pool from YAML', () => {
      const loader = new SuiteLoader();
      const suite = loader.loadString(makeSuiteYaml(POOL_YAML));
      // After loading, pools are resolved — scenarios is flat ScenarioDefinition[]
      expect(suite.scenarios.length).toBe(2);
      expect(suite.scenarios.every((s) => 'id' in s && 'input' in s)).toBe(true);
    });

    it('should parse mixed regular + pool scenarios from YAML', () => {
      const loader = new SuiteLoader();
      const yaml = makeSuiteYaml(`${REGULAR_SCENARIO_YAML}\n${POOL_YAML}`);
      const suite = loader.loadString(yaml);
      // 1 regular + 2 from pool = 3
      expect(suite.scenarios.length).toBe(3);
      expect(suite.scenarios[0].id).toBe('fixed');
    });

    it('should still work with suites that have no pools (backward compat)', () => {
      const loader = new SuiteLoader();
      const suite = loader.loadString(makeSuiteYaml(REGULAR_SCENARIO_YAML));
      expect(suite.scenarios.length).toBe(1);
      expect(suite.scenarios[0].id).toBe('fixed');
    });
  });

  describe('resolvePools', () => {
    it('should select count scenarios from pool', () => {
      const suite = {
        scenarios: [makePool({ count: 2, seed: 42 })] as ScenarioEntry[],
      };
      resolvePools(suite);
      expect(suite.scenarios.length).toBe(2);
      // All resolved entries should be ScenarioDefinition
      for (const s of suite.scenarios) {
        expect((s as ScenarioDefinition).id).toBeDefined();
        expect((s as ScenarioDefinition).input).toBeDefined();
      }
    });

    it('should select all when count === pool size', () => {
      const suite = {
        scenarios: [makePool({ count: 3, seed: 1 })] as ScenarioEntry[],
      };
      resolvePools(suite);
      expect(suite.scenarios.length).toBe(3);
      const ids = new Set((suite.scenarios as ScenarioDefinition[]).map((s) => s.id));
      expect(ids).toEqual(new Set(['p1', 'p2', 'p3']));
    });

    it('should clamp when count > pool size', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const suite = {
        scenarios: [makePool({ count: 10 })] as ScenarioEntry[],
      };
      resolvePools(suite);
      expect(suite.scenarios.length).toBe(3); // clamped to pool size
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('clamping'));
      warn.mockRestore();
    });

    it('should throw on count=0', () => {
      const suite = {
        scenarios: [makePool({ count: 0 })] as ScenarioEntry[],
      };
      expect(() => resolvePools(suite)).toThrow('count=0');
    });

    it('should throw on empty pool', () => {
      const suite = {
        scenarios: [makePool({ scenarios: [], count: 1 })] as ScenarioEntry[],
      };
      expect(() => resolvePools(suite)).toThrow('has no scenarios');
    });

    it('should produce deterministic results with same seed', () => {
      const run = () => {
        const suite = {
          scenarios: [makePool({ count: 2, seed: 99 })] as ScenarioEntry[],
        };
        resolvePools(suite);
        return (suite.scenarios as ScenarioDefinition[]).map((s) => s.id);
      };

      const first = run();
      const second = run();
      expect(first).toEqual(second);
    });

    it('should produce different results with different seeds', () => {
      const run = (seed: number) => {
        const scenarios = Array.from({ length: 20 }, (_, i) => makeScenario(`s${i}`));
        const suite = {
          scenarios: [{ pool: { id: 'big', count: 5, seed, scenarios } }] as ScenarioEntry[],
        };
        resolvePools(suite);
        return (suite.scenarios as ScenarioDefinition[]).map((s) => s.id);
      };

      const a = run(1);
      const b = run(2);
      // Extremely unlikely to be identical with different seeds over 20 items picking 5
      expect(a).not.toEqual(b);
    });

    it('should handle mixed regular + pool entries', () => {
      const suite = {
        scenarios: [
          makeScenario('regular-1'),
          makePool({ count: 1, seed: 42 }),
          makeScenario('regular-2'),
        ] as ScenarioEntry[],
      };
      resolvePools(suite);
      expect(suite.scenarios.length).toBe(3);
      expect((suite.scenarios[0] as ScenarioDefinition).id).toBe('regular-1');
      expect((suite.scenarios[2] as ScenarioDefinition).id).toBe('regular-2');
    });

    it('should allow null seed (non-deterministic)', () => {
      // Just ensure it doesn't throw
      const suite = {
        scenarios: [makePool({ count: 2, seed: null })] as ScenarioEntry[],
      };
      resolvePools(suite);
      expect(suite.scenarios.length).toBe(2);
    });

    it('should allow undefined seed (non-deterministic)', () => {
      const suite = {
        scenarios: [makePool({ count: 2, seed: undefined })] as ScenarioEntry[],
      };
      // Remove seed key entirely
      delete (suite.scenarios[0] as any).pool.seed;
      resolvePools(suite);
      expect(suite.scenarios.length).toBe(2);
    });
  });

  describe('ID collision detection', () => {
    it('pool scenario IDs should not collide with regular scenario IDs', () => {
      // resolvePools itself doesn't check collisions — that's the Runner's job.
      // But we verify the loader produces a flat list where collisions can be detected.
      const loader = new SuiteLoader();
      const yaml = makeSuiteYaml(`
  - id: s1
    name: Regular S1
    layer: execution
    input:
      prompt: "Prompt"
    kpis:
      - id: k1
        name: Check
        weight: 1.0
        method: llm-judge
        config:
          rubric: "Score it"
  - pool:
      id: pool1
      count: 1
      seed: 42
      scenarios:
        - id: s1
          name: Pool S1
          layer: execution
          input:
            prompt: "Pool prompt"
          kpis:
            - id: k1
              name: Check
              weight: 1.0
              method: llm-judge
              config:
                rubric: "Score it"`);

      const suite = loader.loadString(yaml);
      // Both have id "s1" — the runner will catch the duplicate
      const ids = suite.scenarios.map((s) => s.id);
      const hasDuplicate = ids.length !== new Set(ids).size;
      expect(hasDuplicate).toBe(true);
    });
  });
});
