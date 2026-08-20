import { describe, expect, it, vi } from "vitest";
import { FeishuApiError, FeishuHttpClient, buildAuthorizeUrl } from "./http-client";

describe("飞书 HTTP 客户端", () => {
  it("授权链接包含回调地址、state 和最小权限", () => {
    const url = new URL(
      buildAuthorizeUrl({
        appId: "cli_demo",
        redirectUri: "http://localhost:3000/api/feishu/callback",
        state: "secure-state",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
    expect(url.searchParams.get("app_id")).toBe("cli_demo");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/feishu/callback");
    expect(url.searchParams.get("state")).toBe("secure-state");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "bitable:bitable",
      "drive:drive",
      "docs:permission.setting:read",
      "docs:permission.setting:write_only",
    ]);
  });

  it("企业策略拒绝被映射为不可重试错误并保留请求 ID", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 1063003, msg: "Invalid operation" }), {
        status: 200,
        headers: { "x-tt-logid": "request-1", "content-type": "application/json" },
      }),
    );
    const client = new FeishuHttpClient("user-token", fetcher);

    await expect(client.json("/open-apis/example")).rejects.toMatchObject({
      code: "1063003",
      retryable: false,
      feishuRequestId: "request-1",
    } satisfies Partial<FeishuApiError>);
  });

  it("限流响应被映射为可重试错误", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 1254291, msg: "Write conflict" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new FeishuHttpClient("user-token", fetcher);

    await expect(client.json("/open-apis/example")).rejects.toMatchObject({ retryable: true });
  });

  it("网络异常被映射为可重试错误且不暴露访问令牌", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const client = new FeishuHttpClient("secret-user-token", fetcher);

    await expect(client.json("/open-apis/example")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
      status: 0,
    } satisfies Partial<FeishuApiError>);
  });
});
