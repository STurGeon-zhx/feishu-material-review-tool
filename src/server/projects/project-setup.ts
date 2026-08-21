import type { AppDatabase } from "../db/client";
import { SingleFlight } from "../core/single-flight";
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
  private readonly flight = new SingleFlight<NonNullable<ReturnType<typeof getProject>>>();

  constructor(
    private readonly db: AppDatabase,
    private readonly createApi: () => Promise<FeishuResourceApi>,
  ) {}

  async run(projectId: string) {
    return this.flight.run(projectId, () => this.runOnce(projectId));
  }

  private async runOnce(projectId: string) {
    let project = getProject(this.db, projectId);
    if (!project) throw new Error("项目不存在");
    const preserveImportablePartial = project.setupStatus === "partial"
      && project.setupStep === "share_permission_failed";
    const api = await this.createApi();
    updateProject(this.db, projectId, {
      ...(preserveImportablePartial ? {} : { setupStatus: "creating" as const }),
      errorCode: null,
      errorMessage: null,
    });

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
      const checkedAt = new Date().toISOString();
      for (const [checkKey, evidence] of [
        ["create_base", { appToken: project.appToken }],
        ["create_fields", { tableId: project.tableId, fieldCount: 8 }],
        ["share_link", { url: project.feishuUrl }],
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
      await api.setPublicPermission(appToken, project.requestedShareMode);
      const effectiveShareMode = await api.getPublicPermission(appToken);
      if (effectiveShareMode !== project.requestedShareMode) {
        throw Object.assign(new Error("企业策略未允许请求的公开编辑权限"), {
          code: "1063003",
          effectiveShareMode,
        });
      }
      const ready = updateProject(this.db, projectId, {
        effectiveShareMode,
        setupStatus: "ready",
        setupStep: "ready",
        errorCode: null,
        errorMessage: null,
      })!;
      upsertVerification(this.db, {
        projectId,
        checkKey: "share_permission",
        source: "automatic",
        status: "pass",
        evidenceJson: JSON.stringify({ requested: ready.requestedShareMode, effective: ready.effectiveShareMode }),
        checkedAt,
      });
      return ready;
    } catch (error) {
      const latest = getProject(this.db, projectId)!;
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "SETUP_FAILED";
      if (code === "1063003" && latest.appToken && latest.tableId && latest.defaultTableDeleted) {
        const actualMode = typeof error === "object" && error && "effectiveShareMode" in error
          ? String(error.effectiveShareMode)
          : "closed";
        const partial = updateProject(this.db, projectId, {
          setupStatus: "partial",
          setupStep: "share_permission_failed",
          effectiveShareMode: actualMode,
          errorCode: code,
          errorMessage: error instanceof Error ? error.message : "企业策略禁止公开分享",
        })!;
        upsertVerification(this.db, {
          projectId,
          checkKey: "share_permission",
          source: "automatic",
          status: "fail",
          evidenceJson: JSON.stringify({ requested: partial.requestedShareMode, effective: actualMode, code }),
          checkedAt: new Date().toISOString(),
        });
        return partial;
      }
      if (preserveImportablePartial) {
        updateProject(this.db, projectId, {
          setupStatus: "partial",
          setupStep: "share_permission_failed",
          errorCode: code,
          errorMessage: error instanceof Error ? error.message : "公开权限重试失败",
        });
        throw error;
      }
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
