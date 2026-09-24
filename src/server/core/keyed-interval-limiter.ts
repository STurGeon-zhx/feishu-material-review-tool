import { KeyedMutex } from "./keyed-mutex";

export class KeyedIntervalLimiter {
  private readonly mutex = new KeyedMutex();
  private readonly nextStart = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly delay: (milliseconds: number) => Promise<void> = (milliseconds) => (
      new Promise((resolve) => setTimeout(resolve, milliseconds))
    ),
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("请求间隔必须大于 0");
  }

  acquire(key: string): Promise<void> {
    return this.mutex.run(key, async () => {
      const wait = Math.max(0, (this.nextStart.get(key) ?? 0) - this.now());
      if (wait > 0) await this.delay(wait);
      this.nextStart.set(key, this.now() + this.intervalMs);
    });
  }
}
