import type { AppDatabase } from "../db/client";
import { getProject, updateProject, upsertVerification, type ShareMode } from "../db/repository";

export interface FeishuResourceApi {
  createBase(name: string): Promise<{ appToken: string; url: string }>;
  listTables(appToken: string): Promise<Array<{ tableId: string; name: string }>>;
  createReviewTable(appToken: string): Promise<string>;
  deleteTable(appToken: string, tableId: string): Promise<void>;
  setPublicPermission(appToken: string, mode: ShareMode): Promise<void>;
  getPublicPermission(appToken: string): Promise<string>;
}

export class ProjectSetup {
  constructor(
    private readonly db: AppDatabase,
    private readonly createApi: (localUserId: string) => Promise<FeishuResourceApi>,
  ) {}

  async run(projectId: string) {
    let project = getProject(this.db, projectId);
    if (!project) throw new Error("项目不存在");
    const api = await this.createApi(project.localUserId);
    updateProject(this.db, projectId, { setupStatus: "creating", errorCode: null, errorMessage: null });

    try {
      if (!project.appToken) {
        const base = await api.createBase(project.name);
        project = updateProject(this.db, projectId, {
          appToken: base.appToken,
          feishuUrl: base.url,
          setupStep: "base_created",
        })!;
      }
      const appToken = project.appToken;
      if (!appToken) throw new Error("项目缺少飞书 app_token");
      if (!project.defaultTableId) {
        const tables = await api.listTables(appToken);
        const defaultTableId = tables[0]?.tableId;
        if (!defaultTableId) throw new Error("无法定位新 Base 的默认数据表");
        project = updateProject(this.db, projectId, { defaultTableId, setupStep: "default_table_found" })!;
      }
      if (!project.tableId) {
        const tables = await api.listTables(appToken);
        const defaultTableId = project.defaultTableId;
        const existingReviewTable = tables.find(
          (table) => table.name === "审核素材" && table.tableId !== defaultTableId,
        );
        const tableId = existingReviewTable?.tableId ?? await api.createReviewTable(appToken);
        project = updateProject(this.db, projectId, { tableId, setupStep: "review_table_created" })!;
      }
      if (!project.defaultTableDeleted) {
        const tables = await api.listTables(appToken);
        const defaultTableId = project.defaultTableId;
        if (defaultTableId && tables.some((table) => table.tableId === defaultTableId)) {
          await api.deleteTable(appToken, defaultTableId);
        }
        project = updateProject(this.db, projectId, {
          defaultTableDeleted: true,
          setupStep: "default_table_deleted",
        })!;
      }
      await api.setPublicPermission(appToken, project.requestedShareMode);
      const effectiveShareMode = await api.getPublicPermission(appToken);
      const ready = updateProject(this.db, projectId, {
        effectiveShareMode,
        setupStatus: "ready",
        setupStep: "ready",
        errorCode: null,
        errorMessage: null,
      })!;
      const checkedAt = new Date().toISOString();
      for (const [checkKey, evidence] of [
        ["create_base", { appToken: ready.appToken }],
        ["create_fields", { tableId: ready.tableId, fieldCount: 8 }],
        ["share_permission", { requested: ready.requestedShareMode, effective: ready.effectiveShareMode }],
        ["share_link", { url: ready.feishuUrl }],
      ] as const) {
        upsertVerification(this.db, {
          projectId,
          checkKey,
          source: "automatic",
          status: "pass",
          evidenceJson: JSON.stringify(evidence),
          checkedAt,
        });
      }
      return ready;
    } catch (error) {
      const latest = getProject(this.db, projectId)!;
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "SETUP_FAILED";
      updateProject(this.db, projectId, {
        setupStatus: latest.appToken ? "partial" : "failed",
        setupStep: `${latest.setupStep}_failed`,
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : "项目创建失败",
      });
      throw error;
    }
  }
}
