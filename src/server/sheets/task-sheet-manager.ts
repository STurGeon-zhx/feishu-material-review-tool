import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/client";
import {
  createTaskSheet,
  getTaskSheetByCreateKey,
  getTaskSheetByName,
  setActiveTaskSheet,
  updateTaskSheet,
} from "../db/repository";
import type { CellRangeRead, ResizeOperation, SheetCell, WorkbookSheet } from "../feishu/sheets-service";
import { normalizeDisplayName, normalizeSheetName } from "../accounts/account-service";

export const REVIEW_HEADERS = [
  "素材",
  "审核",
  "客户意见",
  "素材编号",
  "批次",
  "素材UUID",
  "类型",
  "文件Token",
  "上传时间",
] as const;

const REVIEW_SHEET_ROWS = 200;

export interface TaskSheetApi {
  getWorkbookInfo(spreadsheetToken: string): Promise<{ sheets: WorkbookSheet[] }>;
  createSheet(spreadsheetToken: string, title: string, rowCount?: number, columnCount?: number): Promise<WorkbookSheet>;
  renameSheet(spreadsheetToken: string, sheetId: string, title: string): Promise<void>;
  setCellRange(spreadsheetToken: string, sheetId: string, range: string, cells: SheetCell[][]): Promise<void>;
  getCellRange(spreadsheetToken: string, sheetId: string, range: string): Promise<CellRangeRead>;
  resizeRanges(spreadsheetToken: string, sheetId: string, operations: ResizeOperation[]): Promise<void>;
  freezeRows(spreadsheetToken: string, sheetId: string, count: number): Promise<void>;
  hideColumns(spreadsheetToken: string, sheetId: string, range: string): Promise<void>;
  getSheetStructure(spreadsheetToken: string, sheetId: string): Promise<Record<string, unknown>>;
}

function headerCells(): SheetCell[][] {
  return [[...REVIEW_HEADERS].map((value) => ({
    value,
    cell_styles: {
      font_weight: "bold",
      background_color: "#E8F3FF",
      horizontal_alignment: "center",
      vertical_alignment: "middle",
    },
  }))];
}

function hasNumericProperty(value: unknown, keys: Set<string>, expected: number): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && child === expected) return true;
    if (hasNumericProperty(child, keys, expected)) return true;
  }
  return false;
}

function assertLayout(headers: CellRangeRead, structure: Record<string, unknown>): void {
  const values = (headers.cells[0] ?? []).map((cell) => cell.value);
  if (JSON.stringify(values) !== JSON.stringify(REVIEW_HEADERS)) throw new Error("审核工作表表头回读不一致");
  if (!hasNumericProperty(structure, new Set(["frozen_rows", "freeze_rows", "frozenRows"]), 1)) {
    throw new Error("审核工作表首行冻结未生效");
  }
  const serialized = JSON.stringify(structure);
  const hidden = serialized.includes("D:I")
    || hasNumericProperty(structure, new Set(["hidden_column_count", "hidden_columns_count"]), 6);
  if (!hidden) throw new Error("审核工作表辅助列隐藏未生效");
}

function setupError(error: unknown): string {
  return error instanceof Error ? error.message : "工作表配置失败";
}

export class TaskSheetManager {
  constructor(
    private readonly db: AppDatabase,
    private readonly createApi: (accountId: string) => Promise<TaskSheetApi>,
    private readonly createId: () => string = randomUUID,
  ) {}

  async ensure(input: {
    accountId: string;
    taskId: string;
    spreadsheetToken: string;
    createKey: string;
    name: string;
    reusableSheetId?: string;
  }) {
    const name = normalizeDisplayName(input.name);
    const normalizedName = normalizeSheetName(name);
    const sameName = getTaskSheetByName(this.db, input.taskId, normalizedName);
    const existing = getTaskSheetByCreateKey(this.db, input.taskId, input.createKey);
    if (sameName && sameName.id !== existing?.id) {
      throw Object.assign(new Error("当前任务已存在同名工作表"), { code: "TASK_SHEET_NAME_EXISTS", retryable: false });
    }
    if (existing?.setupStatus === "ready") return existing;

    const api = await this.createApi(input.accountId);
    let target = existing;
    try {
      if (!target) {
        target = createTaskSheet(this.db, {
          id: this.createId(),
          taskId: input.taskId,
          createKey: input.createKey,
          sheetId: null,
          name,
          normalizedName,
          nextRow: 2,
          setupStatus: "creating",
          setupError: null,
        });
      } else {
        target = updateTaskSheet(this.db, target.id, { setupStatus: "creating", setupError: null })!;
      }

      if (!target.sheetId) {
        const workbook = await api.getWorkbookInfo(input.spreadsheetToken);
        let remote: WorkbookSheet;
        const recovered = workbook.sheets.find((sheet) => normalizeSheetName(sheet.title) === normalizedName);
        const reusable = input.reusableSheetId
          ? workbook.sheets.find((sheet) => sheet.sheetId === input.reusableSheetId)
          : undefined;
        if (recovered) {
          remote = recovered;
        } else if (reusable) {
          if (reusable.title !== name) await api.renameSheet(input.spreadsheetToken, reusable.sheetId, name);
          remote = { ...reusable, title: name };
        } else {
          remote = await api.createSheet(input.spreadsheetToken, name, REVIEW_SHEET_ROWS, REVIEW_HEADERS.length);
        }
        target = updateTaskSheet(this.db, target.id, {
          sheetId: remote.sheetId,
        })!;
      }
      if (!target.sheetId) throw new Error("工作表缺少远端 sheet_id");
      await this.configure(api, input.spreadsheetToken, target.sheetId);
      const ready = updateTaskSheet(this.db, target.id, { setupStatus: "ready", setupError: null })!;
      setActiveTaskSheet(this.db, input.taskId, ready.id);
      return ready;
    } catch (error) {
      if (target) updateTaskSheet(this.db, target.id, { setupStatus: "failed", setupError: setupError(error) });
      throw error;
    }
  }

  private async configure(api: TaskSheetApi, spreadsheetToken: string, sheetId: string): Promise<void> {
    await api.setCellRange(spreadsheetToken, sheetId, "A1:I1", headerCells());
    await api.resizeRanges(spreadsheetToken, sheetId, [
      { range: "A:A", width: 400 },
      { range: "B:B", width: 120 },
      { range: "C:C", width: 320 },
      { range: "D:I", width: 100 },
      { range: "1:1", height: 32 },
    ]);
    await api.freezeRows(spreadsheetToken, sheetId, 1);
    await api.hideColumns(spreadsheetToken, sheetId, "D:I");
    const [headers, structure] = await Promise.all([
      api.getCellRange(spreadsheetToken, sheetId, "A1:I1"),
      api.getSheetStructure(spreadsheetToken, sheetId),
    ]);
    assertLayout(headers, structure);
  }
}
