import { describe, expect, it } from "vitest";
import { retryOperation } from "./retry";

describe("飞书请求重试", () => {
  it("可重试错误在第三次成功时返回结果", async () => {
    let attempts = 0;
    const result = await retryOperation(
      async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("busy"), { retryable: true });
        return "ok";
      },
      { delay: async () => undefined },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("不可重试错误立即抛出", async () => {
    let attempts = 0;

    await expect(
      retryOperation(async () => {
        attempts += 1;
        throw Object.assign(new Error("denied"), { retryable: false });
      }),
    ).rejects.toThrow("denied");
    expect(attempts).toBe(1);
  });
});
