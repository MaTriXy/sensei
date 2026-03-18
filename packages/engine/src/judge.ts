/**
 * LLM-as-Judge — Evaluates agent outputs against rubrics using an LLM.
 *
 * Supports:
 *  - Single judge evaluation
 *  - Multi-judge (3 parallel judges, median score)
 *  - OpenAI, Anthropic (via openai-compatible base_url), and generic openai-compatible providers
 *  - Token-bucket rate limiting (configurable RPM/RPS)
 *  - Exponential backoff retry with jitter (skips 400/401/403)
 */

import OpenAI from 'openai';
import pLimit from 'p-limit';
import type { JudgeConfig, JudgeVerdict, KPIDefinition, ScenarioInput } from './types.js';
import { createLLMClient } from './llm-client.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { withRetry, type RetryConfig } from './retry.js';

// ─── Prompt Template ────────────────────────────────────────────────

function buildJudgePrompt(opts: {
  kpi: KPIDefinition;
  task: string;
  inputContext: string;
  agentOutput: string;
}): { system: string; user: string } {
  const system = `You are an expert evaluator for AI agent qualification tests.
Your task: Score the agent's output on a specific KPI.
Always respond with valid JSON only — no markdown fences, no extra text.`;

  const user = `## KPI: ${opts.kpi.name}
${opts.kpi.config.rubric ?? 'No rubric provided.'}

## Task Given to Agent
${opts.task}

## Input Context
${opts.inputContext}

## Agent's Output
${opts.agentOutput}

## Instructions
1. Evaluate the output against the rubric
2. Provide a numeric score (0 to ${opts.kpi.config.max_score ?? 10})
3. Explain your reasoning in 2-3 sentences
4. Rate your confidence (0.0-1.0)

Respond in JSON:
{
  "score": <number>,
  "max_score": ${opts.kpi.config.max_score ?? 10},
  "reasoning": "<string>",
  "confidence": <number>
}`;

  return { system, user };
}

// ─── Core Judge ─────────────────────────────────────────────────────

const DEFAULT_CALL_TIMEOUT_MS = 60_000;

async function callJudge(
  client: OpenAI,
  model: string,
  temperature: number,
  prompt: { system: string; user: string },
  maxRetries: number,
  rateLimiter?: TokenBucketRateLimiter,
  retryConfig?: RetryConfig,
): Promise<JudgeVerdict> {
  return withRetry(
    async () => {
      // Acquire rate limit token before making the call
      if (rateLimiter) {
        await rateLimiter.acquire();
      }

      // Per-call timeout via AbortController
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_CALL_TIMEOUT_MS);
      let completion;
      try {
        completion = await client.chat.completions.create(
          {
            model,
            temperature,
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
          },
          { signal: controller.signal as AbortSignal },
        );
      } finally {
        clearTimeout(timer);
      }

      const raw = completion.choices[0]?.message?.content ?? '';
      return parseVerdict(raw);
    },
    { maxRetries, ...retryConfig },
  );
}

function parseVerdict(raw: string): JudgeVerdict {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  const score = Number(parsed.score);
  const max_score = Number(parsed.max_score);
  const confidence = Number(parsed.confidence);
  const reasoning = String(parsed.reasoning ?? '');

  if (Number.isNaN(score) || Number.isNaN(max_score)) {
    throw new Error(`Invalid judge verdict: ${raw}`);
  }

  return {
    score,
    max_score,
    reasoning,
    confidence: Number.isNaN(confidence) ? 0.5 : Math.max(0, Math.min(1, confidence)),
  };
}

// ─── Multi-Judge (median of 3) ──────────────────────────────────────

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Default concurrency limit for LLM judge calls to avoid rate-limiting (Fix #12)
const DEFAULT_LLM_CONCURRENCY = 3;

async function multiJudge(
  client: OpenAI,
  model: string,
  temperature: number,
  prompt: { system: string; user: string },
  maxRetries: number,
  concurrencyLimit?: ReturnType<typeof pLimit>,
  rateLimiter?: TokenBucketRateLimiter,
  retryConfig?: RetryConfig,
): Promise<JudgeVerdict> {
  const limit = concurrencyLimit ?? pLimit(DEFAULT_LLM_CONCURRENCY);
  const verdicts = await Promise.all([
    limit(() => callJudge(client, model, temperature, prompt, maxRetries, rateLimiter, retryConfig)),
    limit(() => callJudge(client, model, temperature, prompt, maxRetries, rateLimiter, retryConfig)),
    limit(() => callJudge(client, model, temperature, prompt, maxRetries, rateLimiter, retryConfig)),
  ]);

  const medianScore = median(verdicts.map((v) => v.score));
  // Pick the verdict closest to the median for reasoning
  const best = verdicts.reduce((a, b) =>
    Math.abs(a.score - medianScore) <= Math.abs(b.score - medianScore) ? a : b,
  );

  return {
    score: medianScore,
    max_score: best.max_score,
    reasoning: best.reasoning,
    confidence: median(verdicts.map((v) => v.confidence)),
  };
}

// ─── Public API ─────────────────────────────────────────────────────

export class Judge {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxRetries: number;
  private useMultiJudge: boolean;
  private concurrencyLimit: ReturnType<typeof pLimit>;
  private rateLimiter?: TokenBucketRateLimiter;
  private retryConfig?: RetryConfig;

  constructor(private config: JudgeConfig, judgeConcurrency?: number) {
    this.client = createLLMClient(config);
    this.model = config.model;
    this.temperature = config.temperature ?? 0.0;
    this.maxRetries = config.max_retries ?? 3;
    this.useMultiJudge = config.multi_judge ?? false;
    // Rate limiter shared across all evaluations on this Judge instance (Fix #12)
    this.concurrencyLimit = pLimit(judgeConcurrency ?? DEFAULT_LLM_CONCURRENCY);

    if (config.rate_limit) {
      this.rateLimiter = new TokenBucketRateLimiter(config.rate_limit);
    }

    if (config.retry) {
      this.retryConfig = {
        baseDelayMs: config.retry.base_delay_ms,
        maxDelayMs: config.retry.max_delay_ms,
        jitter: config.retry.jitter,
      };
    }
  }

  async evaluate(opts: {
    kpi: KPIDefinition;
    scenarioInput: ScenarioInput;
    agentOutput: string;
  }): Promise<JudgeVerdict> {
    const prompt = buildJudgePrompt({
      kpi: opts.kpi,
      task: opts.scenarioInput.prompt,
      inputContext: JSON.stringify(opts.scenarioInput.context ?? {}),
      agentOutput: opts.agentOutput,
    });

    if (this.useMultiJudge) {
      return multiJudge(
        this.client, this.model, this.temperature, prompt,
        this.maxRetries, this.concurrencyLimit, this.rateLimiter, this.retryConfig,
      );
    }

    return this.concurrencyLimit(() =>
      callJudge(this.client, this.model, this.temperature, prompt, this.maxRetries, this.rateLimiter, this.retryConfig),
    );
  }

  /** Dispose of rate limiter timers. Call when done with this Judge instance. */
  dispose(): void {
    this.rateLimiter?.dispose();
  }
}

// Re-export helpers for testing
export { buildJudgePrompt, parseVerdict, median };
