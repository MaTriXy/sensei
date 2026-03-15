/**
 * Runner — Orchestrates test execution against an agent.
 * Stub: implementation handled by Agent A.
 */

import type { SuiteDefinition, SuiteResult, AgentAdapter, JudgeConfig } from './types.js';

export interface RunOptions {
  suite: SuiteDefinition;
  adapter: AgentAdapter;
  judgeConfig?: JudgeConfig;
}

export class Runner {
  async run(_options: RunOptions): Promise<SuiteResult> {
    // TODO: Implement run orchestration (Agent A)
    throw new Error('Runner.run() not yet implemented');
  }
}
