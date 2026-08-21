import { SingleFlight } from "../core/single-flight";
import type { AppDatabase } from "../db/client";
import {
  getProject,
  updateProject,
  upsertVerification,
  type ShareMode,
} from "../db/repository";
import type { WorkbookSheet } from "../feishu/sheets-service";

export interface SpreadsheetResourceApi {
  createSpreadsheet(name: string): Promise<{ spreadsheetToken: string; url: string }>;
  getWorkbookInfo(token: string): Promise<{ sheets: WorkbookSheet[] }>;
  setPublicPermission(token: string, mode: ShareMode): Promise<void>;
  getPublicPermission(token: string): Promise<string>;
}

interface DailySheetSetup {
  ensure(
    projectId: string,
    spreadsheetToken: string,
    date: Date,
    reusableSheetId?: string,
  ): Promise<{ sheetId: string; sheetName: string; setupStatus: string }>;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error
    ? String(error.code)
    : "SETUP_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "电子表格配置失败";
}

function errorEffectiveMode(error: unknown): string | undefined {
  return typeof error === "object" && error && "effectiveShareMode" in error
    ? String(error.effectiveShareMode)
    : undefined;
}

export class SpreadsheetSetup {
  private readonly flight = new SingleFlight<NonNullable<ReturnType<typeof getProject>>>();

  constructor(
    private readonly db: AppDatabase,
    private readonly createApi: () => Promise<SpreadsheetResourceApi>,
    private readonly dailySheet: DailySheetSetup,
    private readonly now: () => Date = () => new Date(),
  ) {}

  run(projectId: string) {
    return this.flight.run(projectId, () => this.runOnce(projectId));
  }

  private async runOnce(projectId: string) {
    let project = getProject(this.db, projectId);
    if (!project) throw new Error("项目不存在");
    if (project.resourceType !== "sheet") throw new Error("目标不是飞书电子表格");

    const preserveImportablePartial = project.setupStatus === "partial"
      && project.setupStep === "share_permission_failed";
    updateProject(this.db, projectId, {
      ...(preserveImportablePartial ? {} : { setupStatus: "creating" as const }),
      errorCode: null,
      errorMessage: null,
    });

    let api: SpreadsheetResourceApi | undefined;
    try {
      api = await this.createApi();
      if (!project.spreadsheetToken) {
        const spreadsheet = await api.createSpreadsheet(project.name);
        project = updateProject(this.db, projectId, {
          spreadsheetToken: spreadsheet.spreadsheetToken,
          spreadsheetUrl: spreadsheet.url,
          setupStep: "spreadsheet_created",
        })!;
      }

      const spreadsheetToken = project.spreadsheetToken;
      if (!spreadsheetToken) throw new Error("项目缺少 spreadsheet_token");
      const workbook = await api.getWorkbookInfo(spreadsheetToken);
      const reusableSheetId = workbook.sheets.length === 1 ? workbook.sheets[0].sheetId : undefined;
      const dailyTab = await this.dailySheet.ensure(
        projectId,
        spreadsheetToken,
        this.now(),
        reusableSheetId,
      );
      project = updateProject(this.db, projectId, { setupStep: "daily_sheet_ready" })!;

      const checkedAt = this.now().toISOString();
      for (const [checkKey, evidence] of [
        ["create_spreadsheet", { projectId, resourceType: "sheet" }],
        ["configure_review_sheet", { sheetName: dailyTab.sheetName, sheetId: dailyTab.sheetId }],
        ["share_link", { url: project.spreadsheetUrl }],
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

      await api.setPublicPermission(spreadsheetToken, project.requestedShareMode);
      const effectiveShareMode = await api.getPublicPermission(spreadsheetToken);
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
        evidenceJson: JSON.stringify({
          requested: ready.requestedShareMode,
          effective: ready.effectiveShareMode,
        }),
        checkedAt,
      });
      return ready;
    } catch (error) {
      const latest = getProject(this.db, projectId)!;
      const code = errorCode(error);
      if (code === "1063003" && latest.spreadsheetToken && api) {
        let actualMode = errorEffectiveMode(error);
        if (!actualMode) {
          try {
            actualMode = await api.getPublicPermission(latest.spreadsheetToken);
          } catch {
            actualMode = "closed";
          }
        }
        const partial = updateProject(this.db, projectId, {
          setupStatus: "partial",
          setupStep: "share_permission_failed",
          effectiveShareMode: actualMode,
          errorCode: code,
          errorMessage: errorMessage(error),
        })!;
        upsertVerification(this.db, {
          projectId,
          checkKey: "share_permission",
          source: "automatic",
          status: "fail",
          evidenceJson: JSON.stringify({
            requested: partial.requestedShareMode,
            effective: actualMode,
            code,
          }),
          checkedAt: this.now().toISOString(),
        });
        return partial;
      }

      if (preserveImportablePartial) {
        updateProject(this.db, projectId, {
          setupStatus: "partial",
          setupStep: "share_permission_failed",
          errorCode: code,
          errorMessage: errorMessage(error),
        });
        throw error;
      }

      updateProject(this.db, projectId, {
        setupStatus: latest.spreadsheetToken ? "partial" : "failed",
        setupStep: `${latest.setupStep}_failed`,
        errorCode: code,
        errorMessage: errorMessage(error),
      });
      throw error;
    }
  }
}
