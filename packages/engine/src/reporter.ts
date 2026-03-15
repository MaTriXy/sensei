/**
 * Reporter — Generates reports from suite results.
 * Stub: implementation handled by Agent A.
 */

import type { SuiteResult } from './types.js';

export class Reporter {
  toJSON(result: SuiteResult): string {
    return JSON.stringify(result, null, 2);
  }

  toTerminal(_result: SuiteResult): string {
    // TODO: Implement terminal reporter (Agent A)
    throw new Error('Reporter.toTerminal() not yet implemented');
  }
}
