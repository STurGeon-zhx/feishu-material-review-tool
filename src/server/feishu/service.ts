import type { ShareMode } from "../db/repository";
import { retryOperation } from "../core/retry";
import { FeishuHttpClient } from "./http-client";

export const REVIEW_FIELDS = [
  { name: "素材编号", type: "text" },
  { name: "素材", type: "attachment" },
  { name: "素材名称", type: "text" },
  {
    name: "类型",
    type: "select",
    multiple: false,
    options: [{ name: "图片" }, { name: "视频" }],
  },
  { name: "批次", type: "text" },
  {
    name: "审核状态",
    type: "select",
    multiple: false,
    options: [{ name: "待审核" }, { name: "通过" }, { name: "需修改" }],
  },
  { name: "客户意见", type: "text" },
  { name: "上传时间", type: "created_at", style: { format: "yyyy-MM-dd HH:mm" } },
] as const;

export interface ReviewRecordInput {
  materialNumber: string;
  fileToken: string;
  fileName: string;
  kind: "图片" | "视频";
  batchLabel: string;
}

export class FeishuService {
  constructor(private readonly client: FeishuHttpClient) {}

  async createBase(name: string) {
    const baseData = await retryOperation(() =>
      this.client.json<{
        base?: { app_token?: string; url?: string };
        app?: { app_token?: string; url?: string };
        app_token?: string;
        url?: string;
      }>("/open-apis/base/v3/bases", { method: "POST", body: JSON.stringify({ name }) }),
    );
    const base = baseData.base ?? baseData.app ?? baseData;
    const appToken = base.app_token;
    if (!appToken) throw new Error("飞书创建 Base 成功，但响应缺少 app_token");
    const url = base.url ?? `https://feishu.cn/base/${appToken}`;
    return { appToken, url };
  }

  async listTables(appToken: string) {
    const tableList = await retryOperation(() =>
      this.client.json<{ items?: Array<{ table_id: string; name: string }> }>(
        `/open-apis/base/v3/bases/${encodeURIComponent(appToken)}/tables`,
      ),
    );
    return (tableList.items ?? []).map((table) => ({ tableId: table.table_id, name: table.name }));
  }

  async createReviewTable(appToken: string) {
    const tableData = await retryOperation(() =>
      this.client.json<{ table?: { table_id?: string }; table_id?: string }>(
        `/open-apis/base/v3/bases/${encodeURIComponent(appToken)}/tables`,
        { method: "POST", body: JSON.stringify({ name: "审核素材", fields: REVIEW_FIELDS }) },
      ),
    );
    const tableId = tableData.table?.table_id ?? tableData.table_id;
    if (!tableId) throw new Error("飞书创建审核数据表成功，但响应缺少 table_id");
    return tableId;
  }

  async deleteTable(appToken: string, tableId: string): Promise<void> {
    await retryOperation(() =>
      this.client.json(
        `/open-apis/base/v3/bases/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}`,
        { method: "DELETE" },
      ),
    );
  }

  async setPublicPermission(appToken: string, requestedShareMode: ShareMode): Promise<void> {
    await retryOperation(() =>
      this.client.json(`/open-apis/drive/v1/permissions/${encodeURIComponent(appToken)}/public?type=bitable`, {
        method: "PATCH",
        body: JSON.stringify({ external_access: true, link_share_entity: requestedShareMode }),
      }),
    );
  }

  async getPublicPermission(appToken: string): Promise<string> {
    const permission = await retryOperation(() =>
      this.client.json<{
        permission_public?: { link_share_entity?: string; external_access?: boolean };
        link_share_entity?: string;
      }>(`/open-apis/drive/v1/permissions/${encodeURIComponent(appToken)}/public?type=bitable`),
    );
    const effective = permission.permission_public?.link_share_entity ?? permission.link_share_entity;
    return effective ?? "closed";
  }

  async createReviewResources(name: string, requestedShareMode: ShareMode) {
    const { appToken, url } = await this.createBase(name);
    const tables = await this.listTables(appToken);
    const defaultTableId = tables[0]?.tableId;
    if (!defaultTableId) throw new Error("无法定位新 Base 的默认数据表");
    const tableId = await this.createReviewTable(appToken);
    await this.deleteTable(appToken, defaultTableId);
    await this.setPublicPermission(appToken, requestedShareMode);
    const effective = await this.getPublicPermission(appToken);

    return {
      appToken,
      tableId,
      defaultTableId,
      url,
      effectiveShareMode: effective,
    };
  }

  async batchCreateRecords(appToken: string, tableId: string, records: ReviewRecordInput[]): Promise<string[]> {
    if (records.length === 0) return [];
    const data = await this.client.json<{
      record_id_list?: string[];
      records?: Array<{ record_id?: string; id?: string }>;
    }>(
      `/open-apis/base/v3/bases/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_create`,
      {
        method: "POST",
        body: JSON.stringify({
          fields: ["素材编号", "素材", "素材名称", "类型", "批次", "审核状态"],
          rows: records.map((record) => [
            record.materialNumber,
            [{ file_token: record.fileToken }],
            record.fileName,
            record.kind,
            record.batchLabel,
            "待审核",
          ]),
        }),
      },
    );
    const ids = data.record_id_list ?? data.records?.map((record) => record.record_id ?? record.id ?? "") ?? [];
    if (ids.length !== records.length || ids.some((id) => !id)) {
      throw Object.assign(new Error("飞书批量创建响应缺少完整 record_id"), { retryable: false });
    }
    return ids;
  }

  async searchRecordIds(appToken: string, tableId: string, materialNumbers: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const materialNumber of materialNumbers) {
      const data = await retryOperation(() => this.client.json<{
        items?: Array<{ record_id?: string; id?: string; fields?: Record<string, unknown> }>;
        fields?: string[];
        record_id_list?: string[];
        data?: unknown[][];
        records?: Array<{ record_id?: string; id?: string; data?: unknown[]; fields?: Record<string, unknown> }>;
      }>(
        `/open-apis/base/v3/bases/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search`,
        {
          method: "POST",
          body: JSON.stringify({
            filter: { logic: "and", conditions: [["素材编号", "==", materialNumber]] },
            select_fields: ["素材编号"],
            limit: 2,
          }),
        },
      ));
      const record = data.items?.[0];
      const recordId = data.record_id_list?.[0]
        ?? data.records?.[0]?.record_id
        ?? data.records?.[0]?.id
        ?? record?.record_id
        ?? record?.id;
      if (recordId) result.set(materialNumber, recordId);
    }
    return result;
  }

  async verifyRecordAttachment(appToken: string, tableId: string, recordId: string, fileToken: string): Promise<boolean> {
    const data = await retryOperation(() => this.client.json<{
      record?: { fields?: Record<string, unknown> };
      fields?: Record<string, unknown> | string[];
      record_id_list?: string[];
      data?: unknown[][];
      records?: Array<{ data?: unknown[]; fields?: Record<string, unknown> }>;
    }>(
      `/open-apis/base/v3/bases/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_get`,
      {
        method: "POST",
        body: JSON.stringify({ record_id_list: [recordId], select_fields: ["素材"] }),
      },
    ));
    const legacyFields = data.record?.fields
      ?? data.records?.[0]?.fields
      ?? (data.fields && !Array.isArray(data.fields) ? data.fields : undefined)
      ?? {};
    const rowAttachments = Array.isArray(data.data?.[0]?.[0])
      ? data.data![0][0]
      : Array.isArray(data.records?.[0]?.data?.[0])
        ? data.records![0].data![0]
        : undefined;
    const attachments = rowAttachments ?? (Array.isArray(legacyFields["素材"]) ? legacyFields["素材"] : []);
    return attachments.some(
      (attachment) =>
        typeof attachment === "object" &&
        attachment !== null &&
        "file_token" in attachment &&
        attachment.file_token === fileToken,
    );
  }
}
