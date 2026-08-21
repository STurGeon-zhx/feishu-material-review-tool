import { describe, expect, it } from "vitest";
import { AccountRuntimeRegistry } from "./account-runtime";

describe("AccountRuntimeRegistry", () => {
  it("按账号隔离令牌 Provider，并在 Secret 版本变化后替换缓存", () => {
    const credentials = new Map([
      ["account-a", { id: "account-a", appId: "cli_a", appSecret: "secret-a", version: "v1" }],
      ["account-b", { id: "account-b", appId: "cli_b", appSecret: "secret-b", version: "v1" }],
    ]);
    const registry = new AccountRuntimeRegistry((id) => credentials.get(id)!);
    const firstA = registry.getProvider("account-a");
    expect(registry.getProvider("account-a")).toBe(firstA);
    expect(registry.getProvider("account-b")).not.toBe(firstA);
    credentials.set("account-a", { id: "account-a", appId: "cli_a", appSecret: "secret-a2", version: "v2" });
    expect(registry.getProvider("account-a")).not.toBe(firstA);
  });
});
