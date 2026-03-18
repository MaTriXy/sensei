/**
 * Tests for retry with exponential backoff.
 */

import { describe, it, expect, vi } from 'vitest';
import { withRetry, isRetryableError, computeDelay } from '../src/retry.js';

describe('isRetryableError', () => {
  it('returns true for 429 status', () => {
    const err = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for 500 status', () => {
    const err = Object.assign(new Error('Internal server error'), { status: 500 });
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for 502 status', () => {
    const err = Object.assign(new Error('Bad gateway'), { status: 502 });
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for 503 status', () => {
    const err = Object.assign(new Error('Service unavailable'), { status: 503 });
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns false for 400 status', () => {
    const err = Object.assign(new Error('Bad request'), { status: 400 });
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns false for 401 status', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns false for 403 status', () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    expect(isRetryableError(err)).toBe(false);
  });

  it('returns true for timeout errors', () => {
    const err = new Error('Request timeout');
    err.name = 'AbortError';
    expect(isRetryableError(err)).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isRetryableError(new Error('connect ETIMEDOUT'))).toBe(true);
  });

  it('returns true for network errors', () => {
    expect(isRetryableError(new Error('connect ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('connect ECONNREFUSED'))).toBe(true);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
  });

  it('returns true for status codes in error message', () => {
    expect(isRetryableError(new Error('Error 429: Too many requests'))).toBe(true);
    expect(isRetryableError(new Error('Error 503: Service unavailable'))).toBe(true);
  });

  it('returns true for unknown errors (safe default)', () => {
    expect(isRetryableError(new Error('Something unexpected'))).toBe(true);
    expect(isRetryableError('string error')).toBe(true);
  });
});

describe('computeDelay', () => {
  it('increases exponentially with attempt number', () => {
    const config = { baseDelayMs: 500, maxDelayMs: 30000, jitter: 0 };

    const d0 = computeDelay(0, config);
    const d1 = computeDelay(1, config);
    const d2 = computeDelay(2, config);

    expect(d0).toBe(500);  // 500 * 2^0
    expect(d1).toBe(1000); // 500 * 2^1
    expect(d2).toBe(2000); // 500 * 2^2
  });

  it('caps delay at maxDelayMs', () => {
    const config = { baseDelayMs: 500, maxDelayMs: 5000, jitter: 0 };

    const d10 = computeDelay(10, config); // 500 * 2^10 = 512000, capped at 5000
    expect(d10).toBe(5000);
  });

  it('adds jitter within expected range', () => {
    const config = { baseDelayMs: 1000, maxDelayMs: 30000, jitter: 0.5 };

    // Run multiple times to verify jitter range
    for (let i = 0; i < 20; i++) {
      const delay = computeDelay(0, config);
      // Base is 1000, jitter adds 0 to 500 (1000 * 0.5 * random)
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1500);
    }
  });
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable errors and eventually succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 500 }))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10, jitter: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws immediately on non-retryable errors (400)', async () => {
    const err = Object.assign(new Error('Bad request'), { status: 400 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow('Bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on non-retryable errors (401)', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow('Unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on non-retryable errors (403)', async () => {
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow('Forbidden');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting all retries', async () => {
    const err = Object.assign(new Error('server error'), { status: 500 });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 10, jitter: 0 })).rejects.toThrow('server error');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('uses default config when none provided', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
  });

  it('retries timeout errors', async () => {
    const timeoutErr = new Error('Request timed out');
    timeoutErr.name = 'AbortError';

    const fn = vi.fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 10, jitter: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
