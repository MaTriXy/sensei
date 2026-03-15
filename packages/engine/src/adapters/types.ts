/**
 * Adapter factory and shared types.
 * Agent-specific adapters implement AgentAdapter from ../types.ts
 */

import type { AgentAdapter, AgentConfig } from '../types.js';

export interface AdapterFactory {
  (config: AgentConfig): AgentAdapter;
}

const registry = new Map<string, AdapterFactory>();

export function registerAdapter(name: string, factory: AdapterFactory): void {
  registry.set(name, factory);
}

export function createAdapter(config: AgentConfig): AgentAdapter {
  const factory = registry.get(config.adapter);
  if (!factory) {
    throw new Error(
      `Unknown adapter "${config.adapter}". Registered: ${[...registry.keys()].join(', ')}`,
    );
  }
  return factory(config);
}

export { registry as adapterRegistry };
