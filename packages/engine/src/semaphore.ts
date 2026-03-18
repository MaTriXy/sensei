/**
 * Semaphore — limits concurrency for async operations.
 *
 * Usage:
 *   const sem = new Semaphore(5);
 *   await sem.run(() => doWork());
 */

export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error('Semaphore limit must be >= 1');
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }

  /** Current number of active slots in use */
  get activeCount(): number {
    return this.active;
  }

  /** Current number of waiters in the queue */
  get queueLength(): number {
    return this.queue.length;
  }
}
