import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabaseHandle } from "../db/client";
import { createDatabase } from "../db/client";
import { createOrGetProject, getSheetTabByDate } from "../db/repository";
import type { SheetCell, WorkbookSheet } from "../feishu/sheets-service";
import { DailySheetManager, REVIEW_HEADERS, formatLocalDate } from "./daily-sheet-manager";

const handles: AppDatabaseHandle[] = [];

afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close());
});

function database(): AppDatabaseHandle {
  const handle = createDatabase(":memory:");
  handles.push(handle);
  createOrGetProject(handle.db, {
    id: "p1",
    createKey: "sheet-manager",
    localUserId: "service_app",
    name: "客户素材审核",
    requestedShareMode: "anyone_editable",
    resourceType: "sheet",
  });
  return handle;
}

class FakeSheetsApi {
  sheets: WorkbookSheet[] = [];
  headerCells: SheetCell[][] = [];
  failFreezeOnce = false;
  readonly createSheet = vi.fn(async (_token: string, title: string, rows: number, columns: number) => {
    const sheet = { sheetId: `sheet-${this.sheets.length + 1}`, title, rowCount: rows, columnCount: columns };
    this.sheets.push(sheet);
    return sheet;
  });
  readonly renameSheet = vi.fn(async (_token: string, sheetId: string, title: string) => {
    const sheet = this.sheets.find((item) => item.sheetId === sheetId);
    if (sheet) sheet.title = title;
  });
  readonly setCellRange = vi.fn(async (_token: string, _sheetId: string, _range: string, cells: SheetCell[][]) => {
    this.headerCells = cells;
  });
  readonly resizeRanges = vi.fn(async () => undefined);
  readonly freezeRows = vi.fn(async () => {
    if (this.failFreezeOnce) {
      this.failFreezeOnce = false;
      throw new Error("freeze failed");
    }
  });
  readonly hideColumns = vi.fn(async () => undefined);
  readonly getCellRange = vi.fn(async () => ({ cells: this.headerCells }));
  readonly getSheetStructure = vi.fn(async () => ({ frozen_rows: 1, hidden_columns: ["D:I"] }));
  readonly getWorkbookInfo = vi.fn(async () => ({ sheets: this.sheets }));
}

describe("每日审核工作表", () => {
  it("使用 Asia/Shanghai 日期边界", () => {
    expect(formatLocalDate(new Date("2026-08-20T16:30:00Z"))).toBe("2026-08-21");
  });

  it("同日复用，跨日创建新工作表", async () => {
    const { db } = database();
    const api = new FakeSheetsApi();
    const manager = new DailySheetManager(db, api, () => `tab-${api.sheets.length + 1}`);

    await expect(manager.ensure("p1", "sht1", new Date("2026-08-21T02:00:00Z")))
      .resolves.toMatchObject({ sheetName: "0821素材审核", setupStatus: "ready" });
    await manager.ensure("p1", "sht1", new Date("2026-08-21T08:00:00Z"));
    await manager.ensure("p1", "sht1", new Date("2026-08-22T02:00:00+08:00"));

    expect(api.createSheet).toHaveBeenCalledTimes(2);
    expect(api.createSheet.mock.calls.map((call) => call[1])).toEqual([
      "0821素材审核",
      "0822素材审核",
    ]);
    expect(api.setCellRange.mock.calls[0][2]).toBe("A1:I1");
    expect(api.headerCells[0].map((cell) => cell.value)).toEqual([...REVIEW_HEADERS]);
    expect(api.resizeRanges).toHaveBeenCalledWith("sht1", "sheet-1", [
      { range: "A:A", width: 400 },
      { range: "B:B", width: 120 },
      { range: "C:C", width: 320 },
      { range: "D:I", width: 100 },
      { range: "1:1", height: 32 },
    ]);
    expect(api.freezeRows).toHaveBeenCalledWith("sht1", "sheet-1", 1);
    expect(api.hideColumns).toHaveBeenCalledWith("sht1", "sheet-1", "D:I");
  });

  it("首次工作簿复用唯一默认工作表，同名冲突时使用含年份名称", async () => {
    const first = database();
    const firstApi = new FakeSheetsApi();
    firstApi.sheets = [{ sheetId: "default", title: "Sheet1", rowCount: 200, columnCount: 9 }];
    const firstManager = new DailySheetManager(first.db, firstApi, () => "tab-default");

    const reused = await firstManager.ensure(
      "p1",
      "sht1",
      new Date("2026-08-21T02:00:00+08:00"),
      "default",
    );

    expect(reused.sheetId).toBe("default");
    expect(firstApi.renameSheet).toHaveBeenCalledWith("sht1", "default", "0821素材审核");
    expect(firstApi.createSheet).not.toHaveBeenCalled();

    const second = database();
    const secondApi = new FakeSheetsApi();
    secondApi.sheets = [{ sheetId: "old", title: "0821素材审核", rowCount: 200, columnCount: 9 }];
    const secondManager = new DailySheetManager(second.db, secondApi, () => "tab-new-year");

    const created = await secondManager.ensure("p1", "sht2", new Date("2027-08-21T02:00:00+08:00"));

    expect(created.sheetName).toBe("20270821素材审核");
    expect(secondApi.createSheet).toHaveBeenCalledWith("sht2", "20270821素材审核", 200, 9);
  });

  it("配置失败后保存远端 sheet_id，重试不重复创建", async () => {
    const { db } = database();
    const api = new FakeSheetsApi();
    api.failFreezeOnce = true;
    const manager = new DailySheetManager(db, api, () => "tab-retry");
    const date = new Date("2026-08-21T02:00:00+08:00");

    await expect(manager.ensure("p1", "sht1", date)).rejects.toThrow("freeze failed");
    expect(getSheetTabByDate(db, "p1", "2026-08-21")).toMatchObject({
      sheetId: "sheet-1",
      setupStatus: "failed",
      setupError: "freeze failed",
    });

    await expect(manager.ensure("p1", "sht1", date)).resolves.toMatchObject({
      sheetId: "sheet-1",
      setupStatus: "ready",
    });
    expect(api.createSheet).toHaveBeenCalledTimes(1);
  });
});
