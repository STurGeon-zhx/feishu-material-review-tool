import { describe, expect, it, vi } from "vitest";
import { FeishuHttpClient } from "./http-client";
import { FeishuService } from "./service";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data }), {
    headers: { "content-type": "application/json" },
  });
}

describe("飞书审核表资源编排", () => {
  it("创建 Base 时兼容 v3 返回的 base_token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ base_token: "base-token-v3", url: "https://example.feishu.cn/base/base-token-v3" }),
    );
    const service = new FeishuService(new FeishuHttpClient("tenant-token", fetcher));

    await expect(service.createBase("客户素材审核")).resolves.toEqual({
      appToken: "base-token-v3",
      url: "https://example.feishu.cn/base/base-token-v3",
    });
  });

  it("读取 Base v3 返回的 tables 和 id 作为数据表列表", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        tables: [{ id: "tbl-default", name: "数据表", records_count: 0, rev: 1 }],
        total: 1,
      }),
    );
    const service = new FeishuService(new FeishuHttpClient("tenant-token", fetcher));

    await expect(service.listTables("base-token-v3")).resolves.toEqual([
      { tableId: "tbl-default", name: "数据表" },
    ]);
  });

  it("创建数据表时兼容 Base v3 返回的 id", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ id: "tbl-review", name: "审核素材", fields: [] }),
    );
    const service = new FeishuService(new FeishuHttpClient("tenant-token", fetcher));

    await expect(service.createReviewTable("base-token-v3")).resolves.toBe("tbl-review");
  });

  it("创建审核表、删除默认表并回读公开权限", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const responses = [
      jsonResponse({ base: { app_token: "app-token", url: "https://example.feishu.cn/base/app-token" } }),
      jsonResponse({ items: [{ table_id: "tbl-default", name: "数据表" }] }),
      jsonResponse({ table: { table_id: "tbl-review", name: "审核素材" } }),
      jsonResponse({}),
      jsonResponse({ permission_public: { external_access: true, link_share_entity: "anyone_editable" } }),
      jsonResponse({ permission_public: { external_access: true, link_share_entity: "anyone_editable" } }),
    ];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return responses.shift()!;
    });
    const service = new FeishuService(new FeishuHttpClient("user-token", fetcher));

    const result = await service.createReviewResources("8月广告审核", "anyone_editable");

    expect(result).toEqual({
      appToken: "app-token",
      tableId: "tbl-review",
      defaultTableId: "tbl-default",
      url: "https://example.feishu.cn/base/app-token",
      effectiveShareMode: "anyone_editable",
    });
    expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      "POST /open-apis/base/v3/bases",
      "GET /open-apis/base/v3/bases/app-token/tables",
      "POST /open-apis/base/v3/bases/app-token/tables",
      "DELETE /open-apis/base/v3/bases/app-token/tables/tbl-default",
      "PATCH /open-apis/drive/v1/permissions/app-token/public",
      "GET /open-apis/drive/v1/permissions/app-token/public",
    ]);
    const tableBody = requests[2].body as { name: string; fields: Array<{ name: string; type: string }> };
    expect(tableBody.name).toBe("审核素材");
    expect(tableBody.fields.slice(0, 3)).toEqual([
      { name: "素材编号", type: "text" },
      { name: "素材", type: "attachment" },
      { name: "素材名称", type: "text" },
    ]);
    expect(tableBody.fields).toHaveLength(8);
    expect(requests[4].body).toEqual({ external_access: true, link_share_entity: "anyone_editable" });
  });

  it("批量记录包含附件 token 和固定审核状态", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ record_id_list: ["rec-1"], records: [{ record_id: "rec-1" }] }),
    );
    const service = new FeishuService(new FeishuHttpClient("user-token", fetcher));

    const ids = await service.batchCreateRecords("app-token", "tbl-review", [
      {
        materialNumber: "001",
        fileToken: "file-token",
        fileName: "demo.jpg",
        kind: "图片",
        batchLabel: "第 1 批",
      },
    ]);

    expect(ids).toEqual(["rec-1"]);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      fields: ["素材编号", "素材", "素材名称", "类型", "批次", "审核状态"],
      rows: [["001", [{ file_token: "file-token" }], "demo.jpg", "图片", "第 1 批", "待审核"]],
    });
  });

  it("回读记录时确认附件 token 已写入素材字段", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      fields: ["素材"],
      record_id_list: ["rec-1"],
      data: [[[{ file_token: "file-token" }]]],
    }));
    const service = new FeishuService(new FeishuHttpClient("user-token", fetcher));

    await expect(service.verifyRecordAttachment("app-token", "tbl-review", "rec-1", "file-token")).resolves.toBe(true);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe(
      "/open-apis/base/v3/bases/app-token/tables/tbl-review/records/batch_get",
    );
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      record_id_list: ["rec-1"],
      select_fields: ["素材"],
    });
  });

  it("附件写入暂未可见时自动重试回读", async () => {
    vi.useFakeTimers();
    try {
      const responses = [
        jsonResponse({ fields: ["素材"], record_id_list: ["rec-1"], data: [[[]]] }),
        jsonResponse({
          fields: ["素材"],
          record_id_list: ["rec-1"],
          data: [[[ { file_token: "file-token" } ]]],
        }),
      ];
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!);
      const service = new FeishuService(new FeishuHttpClient("tenant-token", fetcher));

      const verification = service.verifyRecordAttachment("app-token", "tbl-review", "rec-1", "file-token");
      await vi.runAllTimersAsync();

      await expect(verification).resolves.toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("按素材编号使用 Base v3 关键词字段回查记录", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      fields: ["素材编号"],
      record_id_list: ["rec-1"],
      data: [["001"]],
    }));
    const service = new FeishuService(new FeishuHttpClient("user-token", fetcher));

    await expect(service.searchRecordIds("app-token", "tbl-review", ["001"])).resolves.toEqual(
      new Map([["001", "rec-1"]]),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      keyword: "001",
      search_fields: ["素材编号"],
      limit: 2,
    });
  });
});
