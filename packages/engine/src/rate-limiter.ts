/**
 * Token-bucket rate limiter for LLM judge calls.
 *
 * Supports configurable RPM (requests per minute) and RPS (requests per second).
 * Queues requests when the limit is hit and drains them as tokens refill.
 */

export interface RateLimiterConfig {
  /** Maximum requests per minute (default: 60) */
  rpm?: number;
  /** Maximum requests per second (default: none — derived from rpm) */
  rps?: number;
}

interface Waiter {
  resolve: () => void;
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number; // tokens per ms
  private lastRefill: number;
  private queue: Waiter[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: RateLimiterConfig = {}) {
    // RPS takes priority; fall back to RPM / 60
    const rps = config.rps ?? (config.rpm ? config.rpm / 60 : 1);
    this.maxTokens = Math.max(1, Math.ceil(rps));
    this.tokens = this.maxTokens;
    this.refillRate = rps / 1000; // tokens per millisecond
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  private drainQueue(): void {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const waiter = this.queue.shift()!;
      waiter.resolve();
    }

    // If there are still waiters, schedule another drain
    if (this.queue.length > 0 && this.drainTimer === null) {
      const msPerToken = 1 / this.refillRate;
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        this.drainQueue();
      }, Math.ceil(msPerToken));
    }
  }

  /**
   * Acquire a token, waiting if necessary. Returns a promise that resolves
   * when a token is available.
   */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Queue and wait
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      if (this.drainTimer === null) {
        const msPerToken = 1 / this.refillRate;
        this.drainTimer = setTimeout(() => {
          this.drainTimer = null;
          this.drainQueue();
        }, Math.ceil(msPerToken));
      }
    });
  }

  /** Wrap an async function with rate limiting. */
  async wrap<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }

  /** Number of pending requests in the queue. */
  get pending(): number {
    return this.queue.length;
  }

  /** Dispose of any pending timers. */
  dispose(): void {
    if (this.drainTimer !== null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }
}
