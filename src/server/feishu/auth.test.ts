import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabaseHandle } from "../db/client";
import { createDatabase } from "../db/client";
import { upsertConnection } from "../db/repository";
import { encryptSecret } from "../security/token-crypto";
import { FeishuAuth } from "./auth";

const handles: AppDatabaseHandle[] = [];
afterEach(() => handles.splice(0).forEach((handle) => handle.close()));

function response(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data }), {
    headers: { "content-type": "application/json" },
  });
}

describe("飞书用户令牌生命周期", () => {
  it("过期令牌的并发请求只刷新一次并保存新令牌", async () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    const key = Buffer.alloc(32, 9).toString("base64");
    upsertConnection(handle.db, {
      localUserId: "demo_user",
      feishuOpenId: "ou_demo",
      accessTokenCiphertext: encryptSecret("old-access", key),
      refreshTokenCiphertext: encryptSecret("old-refresh", key),
      accessExpiresAt: 1,
      scopes: "bitable:bitable",
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v3/app_access_token/internal")) return response({ app_access_token: "app-token" });
      if (url.endsWith("/authen/v1/refresh_access_token")) {
        await Promise.resolve();
        return response({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
          refresh_expires_in: 2592000,
          scope: "bitable:bitable",
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const auth = new FeishuAuth(
      handle.db,
      { appId: "cli_demo", appSecret: "secret", encryptionKey: key },
      fetcher,
      () => 1_800_000_000_000,
    );

    const tokens = await Promise.all([
      auth.getValidAccessToken("demo_user"),
      auth.getValidAccessToken("demo_user"),
      auth.getValidAccessToken("demo_user"),
    ]);

    expect(tokens).toEqual(["new-access", "new-access", "new-access"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("刷新令牌时的瞬时网络错误会按上限重试", async () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    const key = Buffer.alloc(32, 7).toString("base64");
    upsertConnection(handle.db, {
      localUserId: "demo_user",
      feishuOpenId: "ou_demo",
      accessTokenCiphertext: encryptSecret("old-access", key),
      refreshTokenCiphertext: encryptSecret("old-refresh", key),
      accessExpiresAt: 1,
      scopes: "bitable:bitable",
    });
    let appTokenAttempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/v3/app_access_token/internal")) {
        appTokenAttempts += 1;
        if (appTokenAttempts === 1) throw new TypeError("fetch failed");
        return response({ app_access_token: "app-token" });
      }
      if (url.endsWith("/authen/v1/refresh_access_token")) {
        return response({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const auth = new FeishuAuth(
      handle.db,
      { appId: "cli_demo", appSecret: "secret", encryptionKey: key },
      fetcher,
      () => 1_800_000_000_000,
    );

    await expect(auth.getValidAccessToken("demo_user")).resolves.toBe("new-access");
    expect(appTokenAttempts).toBe(2);
  });
});
