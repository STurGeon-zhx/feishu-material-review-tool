import { describe, expect, it } from "vitest";
import { KeyedIntervalLimiter } from "./keyed-interval-limiter";

describe("按账号隔离的请求限速器", () => {
  it("同一账号的请求启动时间至少间隔 250ms", async () => {
    let clock = 0;
    const starts: number[] = [];
    const limiter = new KeyedIntervalLimiter(250, () => clock, async (milliseconds) => { clock += milliseconds; });

    await Promise.all(Array.from({ length: 4 }, async () => {
      await limiter.acquire("account-a");
      starts.push(clock);
    }));

    expect(starts).toEqual([0, 250, 500, 750]);
  });

  it("不同账号拥有独立限速队列", async () => {
    let clock = 0;
    const limiter = new KeyedIntervalLimiter(250, () => clock, async (milliseconds) => { clock += milliseconds; });

    await limiter.acquire("account-a");
    await limiter.acquire("account-b");

    expect(clock).toBe(0);
  });
});
