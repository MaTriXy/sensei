/**
 * OpenClaw Adapter — Native integration with OpenClaw agents.
 *
 * TODO: Implement once the OpenClaw CLI / API client is available.
 *       Current stub follows the AgentAdapter interface so the engine
 *       can reference it without breaking the build.
 *
 * Expected integration paths:
 *   1. CLI: `openclaw agent --message "..." --session-id "sensei-{suite}-{run}" --json`
 *   2. API: POST to OpenClaw API endpoint with session management
 */

import type { AgentAdapter, AgentConfig, AdapterInput, AdapterOutput } from '../types.js';
import { registerAdapter } from './types.js';

export class OpenClawAdapter implements AgentAdapter {
  readonly name = 'openclaw';

  // TODO: Add OpenClaw client / session tracking fields
  // private sessionId: string;
  // private apiEndpoint: string;

  constructor(private config: AgentConfig) {
    // TODO: Validate config.session_key or config.endpoint for OpenClaw
  }

  async connect(): Promise<void> {
    // TODO: Initialize OpenClaw session
    //   - If CLI mode: verify `openclaw` binary is available
    //   - If API mode: authenticate and create session
    throw new Error('OpenClawAdapter is not yet implemented');
  }

  async healthCheck(): Promise<boolean> {
    // TODO: Check OpenClaw agent availability
    //   - CLI: `openclaw agent --health --json`
    //   - API: GET /health on the OpenClaw endpoint
    return false;
  }

  async send(_input: AdapterInput): Promise<AdapterOutput> {
    // TODO: Send task to OpenClaw agent
    //   - CLI: `openclaw agent --message "{task}" --session-id "sensei-..." --json`
    //   - API: POST /execute with session context
    //   - Parse structured JSON response
    throw new Error('OpenClawAdapter.send() is not yet implemented');
  }

  async disconnect(): Promise<void> {
    // TODO: Clean up OpenClaw session
    //   - CLI: `openclaw agent --end-session "sensei-..."`
    //   - API: DELETE /sessions/{id}
  }
}

registerAdapter('openclaw', (config) => new OpenClawAdapter(config));
