import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabaseHandle } from "../db/client";
import { createDatabase } from "../db/client";
import {
  createOrGetProject,
  getSheetTabByDate,
  registerBatch,
  updateProject,
  upsertSheetTab,
} from "../db/repository";
import { assets } from "../db/schema";
import type { CellRangeRead, SheetCell, WorkbookSheet } from "../feishu/sheets-service";
import { FeishuApiError } from "../feishu/http-client";
import { SheetBatchFinalizer, type SheetWriteApi } from "./finalize-sheet-batch";

const handles: AppDatabaseHandle[] = [];
afterEach(() => handles.splice(0).forEach((handle) => handle.close()));

function database(): AppDatabaseHandle {
  const handle = createDatabase(":memory:");
  handles.push(handle);
  createOrGetProject(handle.db, {
    id: "p1",
    createKey: "sheet-finalizer",
    localUserId: "service_app",
    name: "客户素材审核",
    requestedShareMode: "anyone_editable",
    resourceType: "sheet",
  });
  updateProject(handle.db, "p1", {
    spreadsheetToken: "sht1",
    spreadsheetUrl: "https://example.feishu.cn/sheets/sht1",
    setupStatus: "ready",
    setupStep: "ready",
  });
  upsertSheetTab(handle.db, {
    id: "tab-1",
    projectId: "p1",
    localDate: "2026-08-21",
    sheetId: "sheet-1",
    sheetName: "0821素材审核",
    nextRow: 2,
    setupStatus: "ready",
  });
  return handle;
}

function addBatch(
  handle: AppDatabaseHandle,
  batchId: string,
  files: Array<{ id: string; name: string; type: string; size: number }>,
): void {
  registerBatch(handle.db, "p1", batchId, files);
  handle.db.update(assets).set({
    status: "uploaded",
    fileToken: "file-1",
    createdAt: "2026-08-21 04:00:00",
  }).where(eq(assets.batchId, batchId)).run();
  files.forEach((file, index) => {
    handle.db.update(assets).set({ fileToken: `file-${index + 1}` }).where(eq(assets.id, file.id)).run();
  });
}

const columnIndex = (column: string) => column.charCodeAt(0) - 65;

class FakeSheetApi implements SheetWriteApi {
  rowCount = 2;
  readonly rows = new Map<number, SheetCell[]>();
  readonly writes: Array<{ range: string; cells: SheetCell[][] }> = [];
  readonly insertRows = vi.fn(async (_token: string, _sheetId: string, _position: number, count: number) => {
    this.rowCount += count;
  });
  failAfterRows?: number;
  writeError?: Error;

  async getWorkbookInfo(): Promise<{ sheets: WorkbookSheet[] }> {
    return { sheets: [{ sheetId: "sheet-1", title: "0821素材审核", rowCount: this.rowCount, columnCount: 9 }] };
  }

  async setCellRange(_token: string, _sheetId: string, range: string, cells: SheetCell[][]): Promise<void> {
    this.writes.push({ range, cells });
    if (this.writeError) throw this.writeError;
    const match = range.match(/^A(\d+):I(\d+)$/);
    if (!match) throw new Error(`unexpected write range ${range}`);
    const start = Number(match[1]);
    const count = this.failAfterRows ?? cells.length;
    cells.slice(0, count).forEach((row, index) => this.rows.set(start + index, row));
    if (this.failAfterRows !== undefined) throw new Error("connection reset after write");
  }

  async getCellRange(_token: string, _sheetId: string, range: string): Promise<CellRangeRead> {
    const match = range.match(/^([A-I])(\d+):([A-I])(\d+)$/);
    if (!match) throw new Error(`unexpected read range ${range}`);
    const startColumn = columnIndex(match[1]);
    const startRow = Number(match[2]);
    const endColumn = columnIndex(match[3]);
    const requestedEnd = Number(match[4]);
    const lastRow = Math.max(1, ...this.rows.keys());
    const endRow = Math.min(requestedEnd, Math.max(lastRow, startRow - 1));
    const cells = endRow < startRow
      ? []
      : Array.from({ length: endRow - startRow + 1 }, (_, index) => {
        const row = this.rows.get(startRow + index) ?? [];
        return row.slice(startColumn, endColumn + 1);
      });
    return { cells, currentRegion: `A1:I${lastRow}` };
  }
}

function daily(handle: AppDatabaseHandle) {
  return {
    ensure: vi.fn(async () => getSheetTabByDate(handle.db, "p1", "2026-08-21")!),
  };
}

describe("电子表格批次写入", () => {
  it("扩容后写入附件、审核下拉和隐藏幂等字段，并在回读通过后完成", async () => {
    const handle = database();
    addBatch(handle, "batch-1", [
      { id: "asset-1", name: "one.mp4", type: "video/mp4", size: 1024 },
      { id: "asset-2", name: "two.png", type: "image/png", size: 2048 },
    ]);
    const api = new FakeSheetApi();
    const finalizer = new SheetBatchFinalizer(handle.db, async () => api, daily(handle));

    await expect(finalizer.run("p1", "batch-1")).resolves.toEqual({ completed: 2, failed: 0 });

    expect(api.insertRows).toHaveBeenCalledWith("sht1", "sheet-1", 3, 200);
    expect(api.writes).toHaveLength(1);
    expect(api.writes[0].range).toBe("A2:I3");
    expect(api.writes[0].cells[0]).toEqual([
      { rich_text: [{
        type: "attachment",
        text: "one.mp4",
        attachment_name: "one.mp4",
        attachment_token: "file-1",
        file_size: 1024,
        mime_type: "video/mp4",
      }] },
      { value: "待审核", data_validation: {
        type: "list",
        items: ["待审核", "审核通过", "需修改"],
        highlight_colors: ["#E5E7EB", "#BFF7D9", "#FFB3B3"],
        support_multiple_values: false,
      } },
      { value: "" },
      { value: "001" },
      { value: "第 1 批" },
      { value: "asset-1" },
      { value: "视频" },
      { value: "file-1" },
      { value: "2026-08-21T12:00:00.000+08:00" },
    ]);
    expect(handle.db.select().from(assets).where(eq(assets.id, "asset-1")).get()).toMatchObject({
      status: "completed",
      sheetId: "sheet-1",
      sheetRowNumber: 2,
      recordId: null,
    });
    expect(getSheetTabByDate(handle.db, "p1", "2026-08-21")?.nextRow).toBe(4);
  });

  it("UUID 已存在时按最新远端行号完成，不重复写入", async () => {
    const handle = database();
    addBatch(handle, "batch-existing", [
      { id: "asset-existing", name: "existing.mp4", type: "video/mp4", size: 100 },
    ]);
    const api = new FakeSheetApi();
    api.rows.set(7, [
      { rich_text: [{
        type: "attachment", text: "existing.mp4", attachment_name: "existing.mp4",
        attachment_token: "file-1", file_size: 100, mime_type: "video/mp4",
      }] },
      { value: "审核通过" }, {}, {}, {}, { value: "asset-existing" }, {}, { value: "file-1" }, {},
    ]);

    const result = await new SheetBatchFinalizer(handle.db, async () => api, daily(handle))
      .run("p1", "batch-existing");

    expect(result).toEqual({ completed: 1, failed: 0 });
    expect(api.writes).toHaveLength(0);
    expect(handle.db.select().from(assets).where(eq(assets.id, "asset-existing")).get())
      .toMatchObject({ status: "completed", sheetRowNumber: 7 });
  });

  it("写入响应不确定时逐项回查，只保留确实成功的行", async () => {
    const handle = database();
    addBatch(handle, "batch-partial", [
      { id: "asset-a", name: "a.mp4", type: "video/mp4", size: 100 },
      { id: "asset-b", name: "b.mp4", type: "video/mp4", size: 100 },
    ]);
    const api = new FakeSheetApi();
    api.rowCount = 200;
    api.failAfterRows = 1;

    const result = await new SheetBatchFinalizer(handle.db, async () => api, daily(handle))
      .run("p1", "batch-partial");
    const rows = handle.db.select().from(assets).where(eq(assets.batchId, "batch-partial")).all();

    expect(result).toEqual({ completed: 1, failed: 1 });
    expect(rows.find((row) => row.id === "asset-a")).toMatchObject({ status: "completed", sheetRowNumber: 2 });
    expect(rows.find((row) => row.id === "asset-b")).toMatchObject({
      status: "failed",
      sheetRowNumber: null,
      errorCode: "SHEET_WRITE_FAILED",
    });
  });

  it("应用重启后直接续写已有 file_token 的批次", async () => {
    const handle = database();
    addBatch(handle, "batch-resume", [
      { id: "asset-resume", name: "resume.jpg", type: "image/jpeg", size: 100 },
    ]);
    handle.db.update(assets).set({ status: "failed", errorCode: "UPLOAD_INTERRUPTED" })
      .where(eq(assets.id, "asset-resume")).run();
    const api = new FakeSheetApi();
    api.rowCount = 200;
    const finalizer = new SheetBatchFinalizer(handle.db, async () => api, daily(handle));

    await expect(finalizer.resumeProject("p1")).resolves.toEqual([
      { batchId: "batch-resume", completed: 1, failed: 0 },
    ]);
  });

  it("附件素材没有关联目标表时标记为需要重新上传", async () => {
    const handle = database();
    addBatch(handle, "batch-relation", [
      { id: "asset-relation", name: "relation.mp4", type: "video/mp4", size: 100 },
    ]);
    const api = new FakeSheetApi();
    api.rowCount = 200;
    api.writeError = new FeishuApiError({
      code: "602134071",
      message: "all file not has relation",
      retryable: false,
      status: 400,
    });

    await new SheetBatchFinalizer(handle.db, async () => api, daily(handle))
      .run("p1", "batch-relation");

    expect(handle.db.select().from(assets).where(eq(assets.id, "asset-relation")).get())
      .toMatchObject({ status: "failed", errorCode: "FILE_RELATION_MISSING" });
  });

  it("写入完全失败时不推进下一行，重试仍从第 2 行写入", async () => {
    const handle = database();
    addBatch(handle, "batch-retry-row", [
      { id: "asset-retry-row", name: "retry.mp4", type: "video/mp4", size: 100 },
    ]);
    const api = new FakeSheetApi();
    api.rowCount = 200;
    api.writeError = new Error("write rejected");
    const finalizer = new SheetBatchFinalizer(handle.db, async () => api, daily(handle));

    await finalizer.run("p1", "batch-retry-row");

    expect(getSheetTabByDate(handle.db, "p1", "2026-08-21")?.nextRow).toBe(2);

    api.writeError = undefined;
    await finalizer.run("p1", "batch-retry-row");

    expect(api.writes.at(-1)?.range).toBe("A2:I2");
    expect(getSheetTabByDate(handle.db, "p1", "2026-08-21")?.nextRow).toBe(3);
  });
});
