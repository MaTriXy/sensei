/**
 * Tests for TokenBucketRateLimiter.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TokenBucketRateLimiter } from '../src/rate-limiter.js';

describe('TokenBucketRateLimiter', () => {
  let limiter: TokenBucketRateLimiter;

  afterEach(() => {
    limiter?.dispose();
  });

  it('allows immediate requests up to burst capacity', async () => {
    limiter = new TokenBucketRateLimiter({ rps: 5 });

    // Should be able to acquire 5 tokens immediately
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
    // Queue should be empty since all tokens were available
    expect(limiter.pending).toBe(0);
  });

  it('queues requests when tokens are exhausted', async () => {
    limiter = new TokenBucketRateLimiter({ rps: 1 });

    // First acquire should be instant
    await limiter.acquire();

    // Second acquire should be queued
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;

    // Should have waited approximately 1 second (allow margin)
    expect(elapsed).toBeGreaterThanOrEqual(500);
  }, 5000);

  it('derives rate from RPM config', async () => {
    // 120 RPM = 2 RPS = burst of 2
    limiter = new TokenBucketRateLimiter({ rpm: 120 });

    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.pending).toBe(0);
  });

  it('wraps async functions with rate limiting', async () => {
    limiter = new TokenBucketRateLimiter({ rps: 10 });

    const result = await limiter.wrap(async () => 42);
    expect(result).toBe(42);
  });

  it('reports pending queue length', async () => {
    limiter = new TokenBucketRateLimiter({ rps: 1 });

    // Exhaust the single token
    await limiter.acquire();

    // Queue two more — they will be pending
    const p1 = limiter.acquire();
    const p2 = limiter.acquire();
    expect(limiter.pending).toBe(2);

    // Wait for them to complete
    await Promise.all([p1, p2]);
    expect(limiter.pending).toBe(0);
  }, 10000);

  it('defaults to 1 RPS when no config is provided', async () => {
    limiter = new TokenBucketRateLimiter();

    // Should get at least 1 token immediately
    await limiter.acquire();
    expect(limiter.pending).toBe(0);
  });

  it('dispose clears pending timers', () => {
    limiter = new TokenBucketRateLimiter({ rps: 1 });
    // Just verify it doesn't throw
    limiter.dispose();
    limiter.dispose(); // double dispose should be safe
  });
});
