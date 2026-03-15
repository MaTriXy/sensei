/**
 * Comparator — Before/after comparison for the self-improvement layer.
 *
 * Uses the LLM judge to compare an agent's original output with its
 * revised output after feedback, scoring improvement quality.
 */

import OpenAI from 'openai';
import type { JudgeConfig, JudgeVerdict, KPIDefinition } from './types.js';

// ─── Comparison Prompt ──────────────────────────────────────────────

function buildComparisonPrompt(opts: {
  kpi: KPIDefinition;
  task: string;
  feedback: string;
  originalOutput: string;
  revisedOutput: string;
}): { system: string; user: string } {
  const comparisonType = opts.kpi.config.comparison_type ?? 'improvement';

  const system = `You are an expert evaluator assessing whether an AI agent improved its output after receiving feedback.
Always respond with valid JSON only — no markdown fences, no extra text.`;

  const user = `## KPI: ${opts.kpi.name}
Comparison type: ${comparisonType}

## Original Task
${opts.task}

## Feedback Given
${opts.feedback}

## Original Output
${opts.originalOutput}

## Revised Output
${opts.revisedOutput}

## Scoring Instructions
Evaluate the revised output compared to the original:
- For "improvement": Did the agent meaningfully address the feedback? (0-${opts.kpi.config.max_score ?? 10})
- For "consistency": Did the agent maintain strengths while improving? (0-${opts.kpi.config.max_score ?? 10})
- For "adaptation": Did the agent adapt its approach appropriately? (0-${opts.kpi.config.max_score ?? 10})

Respond in JSON:
{
  "score": <number>,
  "max_score": ${opts.kpi.config.max_score ?? 10},
  "reasoning": "<string explaining what improved and what didn't>",
  "confidence": <number 0.0-1.0>
}`;

  return { system, user };
}

// ─── LLM Client ─────────────────────────────────────────────────────

function createClient(config: JudgeConfig): OpenAI {
  const apiKey =
    config.api_key ??
    (config.provider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY ?? ''
      : process.env.OPENAI_API_KEY ?? '');

  if (config.provider === 'anthropic') {
    return new OpenAI({ apiKey, baseURL: config.base_url ?? 'https://api.anthropic.com/v1/' });
  }
  if (config.provider === 'openai-compatible' && config.base_url) {
    return new OpenAI({ apiKey, baseURL: config.base_url });
  }
  return new OpenAI({ apiKey });
}

// ─── Public API ─────────────────────────────────────────────────────

export class Comparator {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxRetries: number;

  constructor(private config: JudgeConfig) {
    this.client = createClient(config);
    this.model = config.model;
    this.temperature = config.temperature ?? 0.0;
    this.maxRetries = config.max_retries ?? 3;
  }

  async compare(opts: {
    kpi: KPIDefinition;
    task: string;
    feedback: string;
    originalOutput: string;
    revisedOutput: string;
  }): Promise<JudgeVerdict> {
    const prompt = buildComparisonPrompt(opts);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          temperature: this.temperature,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        });

        const raw = completion.choices[0]?.message?.content ?? '';
        const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;

        return {
          score: Number(parsed.score),
          max_score: Number(parsed.max_score),
          reasoning: String(parsed.reasoning ?? ''),
          confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error('Comparator call failed');
  }
}

export { buildComparisonPrompt };
