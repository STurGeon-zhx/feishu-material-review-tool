import { randomUUID } from "node:crypto";
import { SingleFlight } from "../core/single-flight";
import type { AppDatabase } from "../db/client";
import {
  createOrGetProject,
  getProject,
  getProjectByCreateKey,
  getTaskByName,
  getTaskSheet,
  listTaskSheets,
  listTasksByAccount,
  setActiveTaskSheet,
  updateProject,
  upsertVerification,
} from "../db/repository";
import type { WorkbookSheet } from "../feishu/sheets-service";
import { normalizeDisplayName, normalizeSheetName, type AccountService } from "../accounts/account-service";
import type { TaskSheetManager } from "../sheets/task-sheet-manager";

interface TaskResourceApi {
  createSpreadsheet(name: string): Promise<{ spreadsheetToken: string; url: string }>;
  getWorkbookInfo(token: string): Promise<{ sheets: WorkbookSheet[] }>;
  setPublicPermission(token: string, mode: "anyone_editable"): Promise<void>;
  getPublicPermission(token: string): Promise<string>;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error ? String(error.code) : "TASK_SETUP_FAILED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "任务电子表格配置失败";
}

function importable(task: NonNullable<ReturnType<typeof getProject>>): boolean {
  return task.setupStatus === "ready"
    || (task.setupStatus === "partial" && task.setupStep === "share_permission_failed");
}

export class TaskService {
  private readonly setupFlight = new SingleFlight<NonNullable<ReturnType<typeof getProject>>>();

  constructor(
    private readonly db: AppDatabase,
    private readonly accounts: AccountService,
    private readonly createApi: (accountId: string) => Promise<TaskResourceApi>,
    private readonly sheets: TaskSheetManager,
    private readonly createId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  listForActiveAccount() {
    const account = this.accounts.getActive();
    return account ? listTasksByAccount(this.db, account.id) : [];
  }

  getTask(taskId: string) {
    return getProject(this.db, taskId);
  }

  getTaskForActiveAccount(taskId: string) {
    return this.requireTaskForActiveAccount(taskId);
  }

  getSheets(taskId: string) {
    return listTaskSheets(this.db, taskId);
  }

  async create(createKey: string, input: { name: string; firstSheetName: string }) {
    const account = this.accounts.getActive();
    if (!account) throw Object.assign(new Error("请先添加并选择飞书账号"), { code: "ACCOUNT_REQUIRED" });
    const taskName = normalizeDisplayName(input.name);
    const normalizedTaskName = normalizeSheetName(taskName);
    const normalizedKey = `task:${account.id}:${createKey}`;
    let task = getProjectByCreateKey(this.db, normalizedKey);
    if (!task) {
      if (getTaskByName(this.db, account.id, normalizedTaskName)) {
        throw Object.assign(new Error("当前账号已存在同名任务"), { code: "TASK_NAME_EXISTS", retryable: false });
      }
      task = createOrGetProject(this.db, {
        id: this.createId(),
        createKey: normalizedKey,
        localUserId: "service_app",
        name: taskName,
        requestedShareMode: "anyone_editable",
        resourceType: "sheet",
        accountId: account.id,
        initialSheetName: normalizeDisplayName(input.firstSheetName),
      });
    }
    const ready = importable(task) ? task : await this.setup(task.id);
    this.accounts.setActiveTask(account.id, ready.id);
    return ready;
  }

  async retry(taskId: string) {
    const task = this.requireTaskForActiveAccount(taskId);
    if (importable(task)) return task;
    const ready = await this.setup(taskId);
    if (importable(ready)) this.accounts.setActiveTask(ready.accountId!, ready.id);
    return ready;
  }

  activate(taskId: string) {
    const task = this.requireTaskForActiveAccount(taskId);
    this.accounts.setActiveTask(task.accountId!, task.id);
    return task;
  }

  activateSheet(taskId: string, taskSheetId: string) {
    this.requireTaskForActiveAccount(taskId);
    const sheet = getTaskSheet(this.db, taskSheetId);
    if (!sheet || sheet.taskId !== taskId || sheet.setupStatus !== "ready") {
      throw Object.assign(new Error("工作表不存在或尚未配置完成"), { code: "TASK_SHEET_NOT_READY" });
    }
    setActiveTaskSheet(this.db, taskId, taskSheetId);
    return sheet;
  }

  async createSheet(taskId: string, createKey: string, name: string) {
    const task = this.requireTaskForActiveAccount(taskId);
    if (!task.spreadsheetToken || !importable(task)) {
      throw Object.assign(new Error("任务电子表格尚未配置完成"), { code: "TASK_NOT_READY" });
    }
    return this.sheets.ensure({
      accountId: task.accountId!,
      taskId,
      spreadsheetToken: task.spreadsheetToken,
      createKey: `custom:${createKey}`,
      name,
    });
  }

  async retrySheet(taskId: string, taskSheetId: string) {
    const task = this.requireTaskForActiveAccount(taskId);
    const sheet = getTaskSheet(this.db, taskSheetId);
    if (!sheet || sheet.taskId !== taskId) {
      throw Object.assign(new Error("当前任务下不存在该工作表"), { code: "TASK_SHEET_NOT_FOUND", retryable: false });
    }
    if (!task.spreadsheetToken || !importable(task)) {
      throw Object.assign(new Error("任务电子表格尚未配置完成"), { code: "TASK_NOT_READY" });
    }
    return this.sheets.ensure({
      accountId: task.accountId!,
      taskId,
      spreadsheetToken: task.spreadsheetToken,
      createKey: sheet.createKey,
      name: sheet.name,
    });
  }

  private requireTaskForActiveAccount(taskId: string) {
    const account = this.accounts.getActive();
    const task = getProject(this.db, taskId);
    if (!account || !task || task.accountId !== account.id || task.resourceType !== "sheet") {
      throw Object.assign(new Error("当前账号下不存在该任务"), { code: "TASK_NOT_FOUND", retryable: false });
    }
    return task;
  }

  private setup(taskId: string) {
    return this.setupFlight.run(taskId, () => this.setupOnce(taskId));
  }

  private async setupOnce(taskId: string) {
    let task = getProject(this.db, taskId);
    if (!task?.accountId || task.resourceType !== "sheet" || !task.initialSheetName) {
      throw new Error("任务配置数据不完整");
    }
    const accountId = task.accountId;
    const initialSheetName = task.initialSheetName;
    updateProject(this.db, taskId, { setupStatus: "creating", errorCode: null, errorMessage: null });
    let api: TaskResourceApi | undefined;
    try {
      api = await this.createApi(accountId);
      if (!task.spreadsheetToken) {
        const spreadsheet = await api.createSpreadsheet(task.name);
        task = updateProject(this.db, taskId, {
          spreadsheetToken: spreadsheet.spreadsheetToken,
          spreadsheetUrl: spreadsheet.url,
          setupStep: "spreadsheet_created",
        })!;
      }
      const token = task.spreadsheetToken;
      if (!token) throw new Error("任务缺少 spreadsheet_token");
      const workbook = await api.getWorkbookInfo(token);
      const existingSheets = listTaskSheets(this.db, taskId);
      const reusableSheetId = existingSheets.length === 0 && workbook.sheets.length === 1
        ? workbook.sheets[0].sheetId
        : undefined;
      const firstSheet = await this.sheets.ensure({
        accountId,
        taskId,
        spreadsheetToken: token,
        createKey: "first",
        name: initialSheetName,
        reusableSheetId,
      });
      task = updateProject(this.db, taskId, {
        activeTaskSheetId: firstSheet.id,
        setupStep: "first_sheet_ready",
      })!;

      const checkedAt = this.now().toISOString();
      for (const [checkKey, evidence] of [
        ["create_spreadsheet", { taskId, resourceType: "sheet" }],
        ["configure_review_sheet", { sheetName: firstSheet.name, sheetId: firstSheet.sheetId }],
        ["share_link", { url: task.spreadsheetUrl }],
      ] as const) {
        upsertVerification(this.db, {
          projectId: taskId,
          checkKey,
          source: "automatic",
          status: "pass",
          evidenceJson: JSON.stringify(evidence),
          checkedAt,
        });
      }

      await api.setPublicPermission(token, "anyone_editable");
      const effectiveShareMode = await api.getPublicPermission(token);
      if (effectiveShareMode !== "anyone_editable") {
        throw Object.assign(new Error("企业策略未允许公开编辑权限"), {
          code: "1063003",
          effectiveShareMode,
        });
      }
      const ready = updateProject(this.db, taskId, {
        effectiveShareMode,
        setupStatus: "ready",
        setupStep: "ready",
        errorCode: null,
        errorMessage: null,
      })!;
      upsertVerification(this.db, {
        projectId: taskId,
        checkKey: "share_permission",
        source: "automatic",
        status: "pass",
        evidenceJson: JSON.stringify({ requested: "anyone_editable", effective: effectiveShareMode }),
        checkedAt,
      });
      return ready;
    } catch (error) {
      const latest = getProject(this.db, taskId)!;
      const code = errorCode(error);
      if (code === "1063003" && latest.spreadsheetToken) {
        let effective = typeof error === "object" && error && "effectiveShareMode" in error
          ? String(error.effectiveShareMode)
          : "closed";
        if (api) {
          try { effective = await api.getPublicPermission(latest.spreadsheetToken); } catch { /* keep closed */ }
        }
        const partial = updateProject(this.db, taskId, {
          effectiveShareMode: effective,
          setupStatus: "partial",
          setupStep: "share_permission_failed",
          errorCode: code,
          errorMessage: errorMessage(error),
        })!;
        upsertVerification(this.db, {
          projectId: taskId,
          checkKey: "share_permission",
          source: "automatic",
          status: "fail",
          evidenceJson: JSON.stringify({ requested: "anyone_editable", effective, code }),
          checkedAt: this.now().toISOString(),
        });
        return partial;
      }
      updateProject(this.db, taskId, {
        setupStatus: latest.spreadsheetToken ? "partial" : "failed",
        setupStep: `${latest.setupStep}_failed`,
        errorCode: code,
        errorMessage: errorMessage(error),
      });
      throw error;
    }
  }
}
