import { describe, expect, it, vi } from "vitest";
import { TenantTokenProvider } from "./tenant-token";

describe("TenantTokenProvider", () => {
  it("在令牌有效期内复用同一个 tenant_access_token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token-1", expire: 7200 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const provider = new TenantTokenProvider(
      { appId: "cli_test", appSecret: "secret" },
      fetcher,
      () => 1_000_000,
    );

    await expect(provider.getToken()).resolves.toBe("tenant-token-1");
    await expect(provider.getToken()).resolves.toBe("tenant-token-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("并发获取时只向飞书请求一次令牌", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () => new Promise<Response>((resolve) => { resolveResponse = resolve; }),
    );
    const provider = new TenantTokenProvider(
      { appId: "cli_test", appSecret: "secret" },
      fetcher,
      () => 1_000_000,
    );

    const first = provider.getToken();
    const second = provider.getToken();
    resolveResponse(new Response(
      JSON.stringify({ code: 0, tenant_access_token: "tenant-token-1", expire: 7200 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await expect(Promise.all([first, second])).resolves.toEqual(["tenant-token-1", "tenant-token-1"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("飞书临时返回非 JSON 的 503 时仍会重试", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("service unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ code: 0, tenant_access_token: "tenant-token-2", expire: 7200 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ));
    const provider = new TenantTokenProvider(
      { appId: "cli_test", appSecret: "secret" },
      fetcher,
      () => 1_000_000,
    );

    await expect(provider.getToken()).resolves.toBe("tenant-token-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
