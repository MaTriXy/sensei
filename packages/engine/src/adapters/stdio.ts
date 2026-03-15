/**
 * Stdio Adapter — spawn a child process, communicate via stdin/stdout JSON.
 *
 * Protocol:
 *   stdin  → JSON line: { "task": "...", "context": {...} }
 *   stdout ← JSON line: { "response": "...", "structured": {...} }
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentAdapter, AgentConfig, AdapterInput, AdapterOutput } from '../types.js';
import { registerAdapter } from './types.js';

export class StdioAdapter implements AgentAdapter {
  readonly name = 'stdio';
  private command: string;
  private args: string[];
  private timeoutMs: number;
  private proc: ChildProcess | null = null;

  constructor(private config: AgentConfig) {
    if (!config.command) {
      throw new Error('StdioAdapter requires a command');
    }
    const parts = config.command.split(/\s+/);
    this.command = parts[0];
    this.args = parts.slice(1);
    this.timeoutMs = config.timeout_ms ?? 30_000;
  }

  async connect(): Promise<void> {
    this.proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  async healthCheck(): Promise<boolean> {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async send(input: AdapterInput): Promise<AdapterOutput> {
    if (!this.proc?.stdin || !this.proc?.stdout) {
      return { response: '', duration_ms: 0, error: 'Process not connected' };
    }

    const timeout = input.timeout_ms ?? this.timeoutMs;
    const start = Date.now();

    return new Promise<AdapterOutput>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          response: '',
          duration_ms: Date.now() - start,
          error: `Stdio adapter timed out after ${timeout}ms`,
        });
      }, timeout);

      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        // Look for a complete JSON line
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx !== -1) {
          clearTimeout(timer);
          this.proc!.stdout!.off('data', onData);

          const line = buffer.slice(0, newlineIdx).trim();
          try {
            const body = JSON.parse(line) as Record<string, unknown>;
            resolve({
              response: (body.response as string) ?? '',
              duration_ms: Date.now() - start,
              metadata: (body.structured as Record<string, unknown>) ?? undefined,
            });
          } catch {
            resolve({
              response: line,
              duration_ms: Date.now() - start,
              error: 'Failed to parse JSON from agent stdout',
            });
          }
        }
      };

      this.proc!.stdout!.on('data', onData);

      const payload = JSON.stringify({ task: input.prompt, context: input.context }) + '\n';
      this.proc!.stdin!.write(payload);
    });
  }

  async disconnect(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }
}

registerAdapter('stdio', (config) => new StdioAdapter(config));
