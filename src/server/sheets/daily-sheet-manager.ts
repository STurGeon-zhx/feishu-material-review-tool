import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/client";
import {
  getSheetTabByDate,
  updateSheetTab,
  upsertSheetTab,
} from "../db/repository";
import type {
  CellRangeRead,
  ResizeOperation,
  SheetCell,
  WorkbookSheet,
} from "../feishu/sheets-service";

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
const REVIEW_SHEET_COLUMNS = REVIEW_HEADERS.length;

interface DailySheetApi {
  getWorkbookInfo(spreadsheetToken: string): Promise<{ sheets: WorkbookSheet[] }>;
  createSheet(
    spreadsheetToken: string,
    title: string,
    rowCount?: number,
    columnCount?: number,
  ): Promise<WorkbookSheet>;
  renameSheet(spreadsheetToken: string, sheetId: string, title: string): Promise<void>;
  setCellRange(
    spreadsheetToken: string,
    sheetId: string,
    range: string,
    cells: SheetCell[][],
  ): Promise<void>;
  getCellRange(spreadsheetToken: string, sheetId: string, range: string): Promise<CellRangeRead>;
  resizeRanges(
    spreadsheetToken: string,
    sheetId: string,
    operations: ResizeOperation[],
  ): Promise<void>;
  freezeRows(spreadsheetToken: string, sheetId: string, count: number): Promise<void>;
  hideColumns(spreadsheetToken: string, sheetId: string, range: string): Promise<void>;
  getSheetStructure(spreadsheetToken: string, sheetId: string): Promise<Record<string, unknown>>;
}

export function formatLocalDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shortSheetName(localDate: string): string {
  const [, month, day] = localDate.split("-");
  return `${month}${day}素材审核`;
}

function longSheetName(localDate: string): string {
  return `${localDate.replaceAll("-", "")}素材审核`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasNumericProperty(value: unknown, keys: Set<string>, expected: number): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && child === expected) return true;
    if (hasNumericProperty(child, keys, expected)) return true;
  }
  return false;
}

function hasHiddenReviewColumns(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  if (serialized.includes("D:I")) return true;
  return hasNumericProperty(value, new Set(["hidden_column_count", "hidden_columns_count"]), 6);
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

function assertLayout(headers: CellRangeRead, structure: Record<string, unknown>): void {
  const actualHeaders = (headers.cells[0] ?? []).map((cell) => cell.value);
  if (JSON.stringify(actualHeaders) !== JSON.stringify(REVIEW_HEADERS)) {
    throw new Error("审核工作表表头回读不一致");
  }
  if (!hasNumericProperty(structure, new Set(["frozen_rows", "freeze_rows", "frozenRows"]), 1)) {
    throw new Error("审核工作表首行冻结未生效");
  }
  if (!hasHiddenReviewColumns(structure)) {
    throw new Error("审核工作表辅助列隐藏未生效");
  }
}

export class DailySheetManager {
  constructor(
    private readonly db: AppDatabase,
    private readonly api: DailySheetApi,
    private readonly createId: () => string = randomUUID,
  ) {}

  async ensure(
    projectId: string,
    spreadsheetToken: string,
    date: Date,
    reusableSheetId?: string,
  ) {
    const localDate = formatLocalDate(date);
    const existing = getSheetTabByDate(this.db, projectId, localDate);
    if (existing?.setupStatus === "ready") return existing;

    let tab = existing;
    try {
      if (!tab) {
        const workbook = await this.api.getWorkbookInfo(spreadsheetToken);
        const shortName = shortSheetName(localDate);
        const sheetName = workbook.sheets.some((sheet) => sheet.title === shortName)
          ? longSheetName(localDate)
          : shortName;
        const reusable = reusableSheetId
          ? workbook.sheets.find((sheet) => sheet.sheetId === reusableSheetId)
          : undefined;
        const sheet = reusable
          ? await this.renameReusableSheet(spreadsheetToken, reusable, sheetName)
          : await this.api.createSheet(
            spreadsheetToken,
            sheetName,
            REVIEW_SHEET_ROWS,
            REVIEW_SHEET_COLUMNS,
          );
        tab = upsertSheetTab(this.db, {
          id: this.createId(),
          projectId,
          localDate,
          sheetId: sheet.sheetId,
          sheetName,
          nextRow: 2,
          setupStatus: "creating",
          setupError: null,
        });
      } else {
        tab = updateSheetTab(this.db, tab.id, { setupStatus: "creating", setupError: null })!;
      }

      await this.configure(spreadsheetToken, tab.sheetId);
      return updateSheetTab(this.db, tab.id, {
        setupStatus: "ready",
        setupError: null,
      })!;
    } catch (error) {
      if (tab) {
        updateSheetTab(this.db, tab.id, {
          setupStatus: "failed",
          setupError: errorMessage(error),
        });
      }
      throw error;
    }
  }

  private async renameReusableSheet(
    spreadsheetToken: string,
    sheet: WorkbookSheet,
    sheetName: string,
  ): Promise<WorkbookSheet> {
    if (sheet.title !== sheetName) {
      await this.api.renameSheet(spreadsheetToken, sheet.sheetId, sheetName);
    }
    return { ...sheet, title: sheetName };
  }

  private async configure(spreadsheetToken: string, sheetId: string): Promise<void> {
    await this.api.setCellRange(spreadsheetToken, sheetId, "A1:I1", headerCells());
    await this.api.resizeRanges(spreadsheetToken, sheetId, [
      { range: "A:A", width: 400 },
      { range: "B:B", width: 120 },
      { range: "C:C", width: 320 },
      { range: "D:I", width: 100 },
      { range: "1:1", height: 32 },
    ]);
    await this.api.freezeRows(spreadsheetToken, sheetId, 1);
    await this.api.hideColumns(spreadsheetToken, sheetId, "D:I");
    const [headers, structure] = await Promise.all([
      this.api.getCellRange(spreadsheetToken, sheetId, "A1:I1"),
      this.api.getSheetStructure(spreadsheetToken, sheetId),
    ]);
    assertLayout(headers, structure);
  }
}
