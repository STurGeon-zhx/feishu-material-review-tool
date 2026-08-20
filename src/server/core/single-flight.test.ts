import { describe, expect, it } from "vitest";
import { SingleFlight } from "./single-flight";

describe("令牌刷新互斥", () => {
  it("同一用户的并发请求共享一次刷新", async () => {
    const gate = new SingleFlight<string>();
    let calls = 0;
    const refresh = () =>
      gate.run("demo_user", async () => {
        calls += 1;
        await Promise.resolve();
        return "new-token";
      });

    const results = await Promise.all([refresh(), refresh(), refresh()]);

    expect(results).toEqual(["new-token", "new-token", "new-token"]);
    expect(calls).toBe(1);
  });
});
