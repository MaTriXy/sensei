/**
 * T8.7 — Judge integration with mocked OpenAI.
 *
 * Tests the Judge class, prompt building, verdict parsing,
 * multi-judge median, and the Comparator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Judge,
  Comparator,
  buildJudgePrompt,
  parseVerdict,
  median,
  type JudgeConfig,
  type KPIDefinition,
  type ScenarioInput,
} from '../src/index.js';

// ─── Mock OpenAI ────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate,
        },
      };
    },
  };
});

// ─── Fixtures ───────────────────────────────────────────────────────

const sampleKPI: KPIDefinition = {
  id: 'personalization',
  name: 'Personalization Quality',
  weight: 0.3,
  method: 'llm-judge',
  config: {
    max_score: 5,
    rubric: '5: Excellent\n3: Average\n1: Poor',
  },
};

const sampleInput: ScenarioInput = {
  prompt: 'Write a personalized cold email',
  context: { prospect: 'Sarah Chen' },
};

const judgeConfig: JudgeConfig = {
  provider: 'openai',
  model: 'gpt-4o',
  api_key: 'test-key',
  temperature: 0,
  max_retries: 1,
};

function mockVerdictResponse(verdict: { score: number; max_score: number; reasoning: string; confidence: number }) {
  mockCreate.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify(verdict) } }],
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('buildJudgePrompt', () => {
  it('includes KPI name and rubric in the prompt', () => {
    const prompt = buildJudgePrompt({
      kpi: sampleKPI,
      task: 'Write an email',
      inputContext: '{"prospect": "Sarah"}',
      agentOutput: 'Dear Sarah...',
    });

    expect(prompt.system).toContain('expert evaluator');
    expect(prompt.user).toContain('Personalization Quality');
    expect(prompt.user).toContain('Excellent');
    expect(prompt.user).toContain('Dear Sarah');
    expect(prompt.user).toContain('max_score');
  });
});

describe('parseVerdict', () => {
  it('parses valid JSON verdict', () => {
    const verdict = parseVerdict(
      '{"score": 4, "max_score": 5, "reasoning": "Good job", "confidence": 0.9}',
    );
    expect(verdict).toEqual({
      score: 4,
      max_score: 5,
      reasoning: 'Good job',
      confidence: 0.9,
    });
  });

  it('strips markdown code fences', () => {
    const verdict = parseVerdict(
      '```json\n{"score": 3, "max_score": 5, "reasoning": "OK", "confidence": 0.7}\n```',
    );
    expect(verdict.score).toBe(3);
  });

  it('clamps confidence to 0-1', () => {
    const verdict = parseVerdict(
      '{"score": 5, "max_score": 5, "reasoning": "Great", "confidence": 1.5}',
    );
    expect(verdict.confidence).toBe(1);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseVerdict('not json')).toThrow();
  });
});

describe('median', () => {
  it('returns median of odd-length array', () => {
    expect(median([1, 3, 5])).toBe(3);
    expect(median([5, 1, 3])).toBe(3);
  });

  it('returns average of middle two for even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('Judge', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('evaluates a KPI and returns a verdict', async () => {
    mockVerdictResponse({ score: 4, max_score: 5, reasoning: 'Well personalized', confidence: 0.85 });

    const judge = new Judge(judgeConfig);
    const verdict = await judge.evaluate({
      kpi: sampleKPI,
      scenarioInput: sampleInput,
      agentOutput: 'Dear Sarah, I noticed your microservices migration...',
    });

    expect(verdict.score).toBe(4);
    expect(verdict.max_score).toBe(5);
    expect(verdict.reasoning).toBe('Well personalized');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('uses multi-judge when configured', async () => {
    mockVerdictResponse({ score: 4, max_score: 5, reasoning: 'Good', confidence: 0.8 });
    mockVerdictResponse({ score: 3, max_score: 5, reasoning: 'OK', confidence: 0.7 });
    mockVerdictResponse({ score: 5, max_score: 5, reasoning: 'Great', confidence: 0.9 });

    const judge = new Judge({ ...judgeConfig, multi_judge: true });
    const verdict = await judge.evaluate({
      kpi: sampleKPI,
      scenarioInput: sampleInput,
      agentOutput: 'Some email output',
    });

    // Median of [3, 4, 5] = 4
    expect(verdict.score).toBe(4);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('handles Anthropic provider config', () => {
    // Should not throw — just verifies client creation
    const judge = new Judge({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      api_key: 'test-anthropic-key',
      base_url: 'https://api.anthropic.com/v1/',
    });
    expect(judge).toBeDefined();
  });

  it('handles openai-compatible provider config', () => {
    const judge = new Judge({
      provider: 'openai-compatible',
      model: 'local-model',
      api_key: 'test-key',
      base_url: 'http://localhost:8080/v1',
    });
    expect(judge).toBeDefined();
  });
});

describe('Comparator', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('compares before/after outputs', async () => {
    mockVerdictResponse({
      score: 4,
      max_score: 5,
      reasoning: 'Good improvement on feedback points',
      confidence: 0.8,
    });

    const comparator = new Comparator(judgeConfig);
    const verdict = await comparator.compare({
      kpi: {
        ...sampleKPI,
        method: 'comparative-judge',
        config: { comparison_type: 'improvement', max_score: 5 },
      },
      task: 'Write a cold email',
      feedback: 'Make it shorter and more personal',
      originalOutput: 'Original long email...',
      revisedOutput: 'Revised shorter email...',
    });

    expect(verdict.score).toBe(4);
    expect(verdict.reasoning).toContain('improvement');
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Verify the prompt includes both outputs
    const call = mockCreate.mock.calls[0][0];
    const userMsg = call.messages.find((m: { role: string }) => m.role === 'user');
    expect(userMsg.content).toContain('Original long email');
    expect(userMsg.content).toContain('Revised shorter email');
  });
});
