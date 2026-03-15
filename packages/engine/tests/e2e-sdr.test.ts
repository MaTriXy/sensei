/**
 * T8.8 — End-to-end: load SDR suite YAML → mock run → verify scores.
 *
 * This test loads the actual SDR suite definition, runs it against
 * a mock adapter and mocked LLM judge, and verifies the full scoring pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type {
  AgentAdapter,
  AdapterInput,
  AdapterOutput,
  JudgeConfig,
  KPIDefinition,
  ScenarioInput,
  ScenarioResult,
  KPIResult,
  EvaluationLayer,
  SuiteResult,
} from '../src/types.js';
import { Judge, Comparator, determineBadge, LAYER_WEIGHTS } from '../src/index.js';

// ─── Mock OpenAI ────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  },
}));

// ─── Mock Adapter ───────────────────────────────────────────────────

function createMockAdapter(): AgentAdapter {
  return {
    name: 'mock-http',
    connect: vi.fn(async () => {}),
    healthCheck: vi.fn(async () => true),
    send: vi.fn(async (input: AdapterInput): Promise<AdapterOutput> => {
      const task = input.prompt.toLowerCase();
      if (task.includes('cold email')) {
        return {
          response: `Subject: Scaling engineering at Meridian?\n\nHi Sarah,\n\nI noticed your recent post about the monolith-to-microservices migration at Meridian Health Systems — that's a massive undertaking with a 450-person engineering org spread across time zones.\n\nAt AgentOps, we help VPs of Engineering like you measure developer productivity during transitions like this, without adding overhead to your team. Unlike LinearB, we never read code content.\n\nWould you have 10 minutes this week for a quick call?\n\nBest,\nAlex`,
          duration_ms: 1200,
        };
      }
      if (task.includes('analyze') && task.includes('call')) {
        return {
          response: `## Discovery Call Analysis\n\n### Pain Points\n1. Migration slowing release cadence\n2. No clear productivity metrics\n3. Difficulty justifying hires to the board\n\n### BANT Assessment\n- Budget: Series C funded, likely has budget\n- Authority: VP of Engineering — decision maker\n- Need: Clear need for productivity measurement\n- Timeline: Immediate — board pressure\n\n### Competitive Landscape\n- Evaluated LinearB last quarter, rejected due to privacy concerns\n\n### Next Steps\n1. Schedule demo with solutions engineer\n2. Include David Park (Engineering Manager)\n3. Prepare privacy-focused positioning\n\n### Call Quality: 8/10\nStrong discovery, good rapport, clear next steps identified.`,
          duration_ms: 1800,
        };
      }
      if (task.includes('3-email') || task.includes('sequence')) {
        return {
          response: `## Email 1 — Day 0: Initial Outreach\nSubject: Your microservices migration metrics\n\nHi Sarah...\n\n## Email 2 — Day 3: Value Add\nSubject: How Meridian can measure migration velocity\n\nSarah, I came across a case study...\n\n## Email 3 — Day 7: Break-up\nSubject: Should I close your file?\n\nSarah, I don't want to be a bother...`,
          duration_ms: 2000,
        };
      }
      if (task.includes('explain') || task.includes('strategic')) {
        return {
          response: `I chose the subject line because it references Sarah's specific project and creates curiosity. I prioritized the migration pain point because it's timely and top-of-mind based on her LinkedIn activity. The value proposition was tailored around productivity measurement during transitions, which directly addresses her board-reporting challenge. I chose a low-commitment CTA (10-minute call) because cold outreach conversion improves with lower asks. I considered but rejected: referencing mutual connections (none found), leading with pricing (too early), and using a case study (better for follow-up).`,
          duration_ms: 1500,
        };
      }
      if (task.includes('revise') || task.includes('feedback') || task.includes('rewrite')) {
        return {
          response: `Subject: Prove it to your board\n\nSarah,\n\nYou mentioned needing to justify two senior hires to the board — but without data on whether the microservices migration is a people problem or process problem, that's a tough sell.\n\nAgentOps gives engineering leaders like you that data in under a week, with zero setup overhead for your team.\n\nHave 10 minutes to see how it works?\n\nBest,\nAlex\n\nP.S. 73% of engineering leaders say they lack the metrics to justify headcount decisions (State of DevOps 2024).`,
          duration_ms: 1400,
        };
      }
      return { response: 'Default response', duration_ms: 500 };
    }),
    disconnect: vi.fn(async () => {}),
  };
}

// ─── Suite Loading ──────────────────────────────────────────────────

async function loadSuiteYAML() {
  const suitePath = resolve(import.meta.dirname ?? __dirname, '../../../suites/sdr-qualification/suite.yaml');
  const content = await readFile(suitePath, 'utf-8');
  return YAML.parse(content) as {
    id: string;
    version: string;
    scenarios: Array<{
      id: string;
      name: string;
      layer: EvaluationLayer;
      input: { prompt: string; context?: Record<string, unknown>; fixtures?: Record<string, unknown>; feedback?: string };
      kpis: Array<{
        id: string;
        name: string;
        weight: number;
        method: string;
        config: Record<string, unknown>;
      }>;
    }>;
  };
}

// ─── Scoring Helpers (mirrors engine scorer logic) ──────────────────

function normalizeScore(raw: number, max: number): number {
  return Math.round((raw / max) * 100);
}

function scoreScenario(kpiResults: KPIResult[]): number {
  const totalWeight = kpiResults.reduce((sum, k) => sum + k.weight, 0);
  if (totalWeight === 0) return 0;
  return Math.round(kpiResults.reduce((sum, k) => sum + k.score * k.weight, 0) / totalWeight);
}

function scoreLayer(scenarioResults: ScenarioResult[], layer: EvaluationLayer): number {
  const layerResults = scenarioResults.filter((s) => s.layer === layer);
  if (layerResults.length === 0) return 0;
  return Math.round(layerResults.reduce((sum, s) => sum + s.score, 0) / layerResults.length);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('E2E: SDR Qualification Suite', () => {
  let suite: Awaited<ReturnType<typeof loadSuiteYAML>>;

  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('loads the SDR suite YAML successfully', async () => {
    suite = await loadSuiteYAML();
    expect(suite.id).toBe('sdr-qualification');
    expect(suite.version).toBe('1.0.0');
    expect(suite.scenarios.length).toBe(5);
  });

  it('has scenarios across all 3 layers', async () => {
    suite = await loadSuiteYAML();
    const layers = new Set(suite.scenarios.map((s) => s.layer));
    expect(layers.has('execution')).toBe(true);
    expect(layers.has('reasoning')).toBe(true);
    expect(layers.has('self-improvement')).toBe(true);
  });

  it('all KPIs have valid weights summing to ~1.0 per scenario', async () => {
    suite = await loadSuiteYAML();
    for (const scenario of suite.scenarios) {
      const totalWeight = scenario.kpis.reduce((sum, k) => sum + k.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 1);
    }
  });

  it('runs full pipeline: adapter → judge → scoring → badge', async () => {
    suite = await loadSuiteYAML();
    const adapter = createMockAdapter();
    await adapter.connect();

    // Mock judge to return score 4/5 for every evaluation
    mockCreate.mockImplementation(async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            score: 4,
            max_score: 5,
            reasoning: 'Solid performance across criteria',
            confidence: 0.85,
          }),
        },
      }],
    }));

    const judgeConfig: JudgeConfig = {
      provider: 'openai',
      model: 'gpt-4o',
      api_key: 'test-key',
      temperature: 0,
      max_retries: 1,
    };

    const judge = new Judge(judgeConfig);
    const comparator = new Comparator(judgeConfig);
    const scenarioResults: ScenarioResult[] = [];

    // Run each scenario
    for (const scenario of suite.scenarios) {
      const adapterOutput = await adapter.send({
        prompt: scenario.input.prompt,
        context: scenario.input.context,
      });

      const kpiResults: KPIResult[] = [];
      for (const kpi of scenario.kpis) {
        const kpiDef: KPIDefinition = {
          id: kpi.id,
          name: kpi.name,
          weight: kpi.weight,
          method: kpi.method as KPIDefinition['method'],
          config: kpi.config,
        };

        let rawScore: number;
        let maxScore: number;
        let evidence: string;

        if (kpi.method === 'automated') {
          // Simulate word count check for brevity KPI
          const wordCount = adapterOutput.response.split(/\s+/).length;
          const range = kpi.config.expected as { min: number; max: number };
          rawScore = wordCount >= range.min && wordCount <= range.max + (kpi.config.tolerance as number ?? 0) ? 5 : 2;
          maxScore = 5;
          evidence = `Word count: ${wordCount}`;
        } else if (kpi.method === 'comparative-judge') {
          const verdict = await comparator.compare({
            kpi: kpiDef,
            task: scenario.input.prompt,
            feedback: scenario.input.feedback ?? '',
            originalOutput: 'Original email text',
            revisedOutput: adapterOutput.response,
          });
          rawScore = verdict.score;
          maxScore = verdict.max_score;
          evidence = verdict.reasoning;
        } else {
          // llm-judge
          const verdict = await judge.evaluate({
            kpi: kpiDef,
            scenarioInput: {
              prompt: scenario.input.prompt,
              context: scenario.input.context,
            },
            agentOutput: adapterOutput.response,
          });
          rawScore = verdict.score;
          maxScore = verdict.max_score;
          evidence = verdict.reasoning;
        }

        kpiResults.push({
          kpi_id: kpi.id,
          kpi_name: kpi.name,
          score: normalizeScore(rawScore, maxScore),
          raw_score: rawScore,
          max_score: maxScore,
          weight: kpi.weight,
          method: kpi.method as KPIResult['method'],
          evidence,
        });
      }

      scenarioResults.push({
        scenario_id: scenario.id,
        scenario_name: scenario.name,
        layer: scenario.layer,
        score: scoreScenario(kpiResults),
        kpis: kpiResults,
        duration_ms: adapterOutput.duration_ms,
        agent_input: scenario.input.prompt,
        agent_output: adapterOutput.response,
      });
    }

    // Compute layer and overall scores
    const executionScore = scoreLayer(scenarioResults, 'execution');
    const reasoningScore = scoreLayer(scenarioResults, 'reasoning');
    const selfImprovementScore = scoreLayer(scenarioResults, 'self-improvement');
    const overall = Math.round(
      executionScore * LAYER_WEIGHTS.execution +
      reasoningScore * LAYER_WEIGHTS.reasoning +
      selfImprovementScore * LAYER_WEIGHTS['self-improvement'],
    );

    const result: SuiteResult = {
      suite_id: suite.id,
      suite_version: suite.version,
      agent_id: 'mock-agent',
      timestamp: new Date().toISOString(),
      scores: {
        overall,
        execution: executionScore,
        reasoning: reasoningScore,
        self_improvement: selfImprovementScore,
      },
      scenarios: scenarioResults,
      badge: determineBadge(overall),
      duration_ms: scenarioResults.reduce((sum, s) => sum + s.duration_ms, 0),
      judge_model: 'gpt-4o',
    };

    // Assertions
    expect(result.suite_id).toBe('sdr-qualification');
    expect(result.scenarios).toHaveLength(5);
    expect(result.scores.overall).toBeGreaterThan(0);
    expect(result.scores.execution).toBeGreaterThan(0);
    expect(result.scores.reasoning).toBeGreaterThan(0);
    expect(result.scores.self_improvement).toBeGreaterThan(0);

    // With most scores at 4/5 = 80%, badge should be silver (75-89)
    expect(result.badge).toBe('silver');
    expect(result.scores.overall).toBeGreaterThanOrEqual(75);
    expect(result.scores.overall).toBeLessThan(90);

    // Verify adapter was called for each scenario
    expect(adapter.send).toHaveBeenCalledTimes(5);

    // Verify judge was called for LLM-scored KPIs
    expect(mockCreate).toHaveBeenCalled();

    // All scenarios should have non-zero scores
    for (const scenario of result.scenarios) {
      expect(scenario.score).toBeGreaterThan(0);
      expect(scenario.kpis.length).toBeGreaterThan(0);
    }

    await adapter.disconnect();
  });
});
