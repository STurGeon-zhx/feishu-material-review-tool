import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db/client";
import { projects } from "../db/schema";
import { TaskSheetManager, REVIEW_HEADERS, type TaskSheetApi } from "./task-sheet-manager";

function seedTask() {
  const handle = createDatabase(":memory:");
  handle.db.insert(projects).values({
    id: "task-1", createKey: "task-key", localUserId: "service_app", name: "任务",
    resourceType: "sheet", requestedShareMode: "anyone_editable", spreadsheetToken: "spreadsheet-1",
  }).run();
  return handle;
}

function api(overrides: Partial<TaskSheetApi> = {}): TaskSheetApi {
  return {
    getWorkbookInfo: vi.fn(async () => ({ sheets: [] })),
    createSheet: vi.fn(async (_token, title) => ({ sheetId: "remote-sheet", title, rowCount: 200, columnCount: 9 })),
    renameSheet: vi.fn(async () => undefined),
    setCellRange: vi.fn(async () => undefined),
    getCellRange: vi.fn(async () => ({ cells: [[...REVIEW_HEADERS].map((value) => ({ value }))] })),
    resizeRanges: vi.fn(async () => undefined),
    freezeRows: vi.fn(async () => undefined),
    hideColumns: vi.fn(async () => undefined),
    getSheetStructure: vi.fn(async () => ({ frozen_rows: 1, hidden_columns_count: 6 })),
    ...overrides,
  };
}

describe("TaskSheetManager", () => {
  it("创建命名工作表并完成表头、列宽、冻结、隐藏和回读验证", async () => {
    const handle = seedTask();
    const remote = api();
    const manager = new TaskSheetManager(handle.db, async () => remote, () => "task-sheet-1");
    const sheet = await manager.ensure({
      accountId: "account-1", taskId: "task-1", spreadsheetToken: "spreadsheet-1",
      createKey: "custom:key-1", name: "0827素材审核",
    });
    expect(sheet).toMatchObject({ name: "0827素材审核", sheetId: "remote-sheet", setupStatus: "ready", nextRow: 2 });
    expect(remote.setCellRange).toHaveBeenCalledWith("spreadsheet-1", "remote-sheet", "A1:I1", expect.any(Array));
    expect(remote.freezeRows).toHaveBeenCalledWith("spreadsheet-1", "remote-sheet", 1);
    expect(remote.hideColumns).toHaveBeenCalledWith("spreadsheet-1", "remote-sheet", "D:I");
    handle.close();
  });

  it("配置失败后保留远端 sheet_id，并以同一幂等键继续而不重复创建", async () => {
    const handle = seedTask();
    const structure = vi.fn()
      .mockRejectedValueOnce(new Error("回读暂时失败"))
      .mockResolvedValue({ frozen_rows: 1, hidden_columns_count: 6 });
    const remote = api({ getSheetStructure: structure });
    const manager = new TaskSheetManager(handle.db, async () => remote, () => "task-sheet-1");
    const input = {
      accountId: "account-1", taskId: "task-1", spreadsheetToken: "spreadsheet-1",
      createKey: "custom:key-1", name: "0827素材审核",
    };
    await expect(manager.ensure(input)).rejects.toThrow("回读暂时失败");
    const ready = await manager.ensure(input);
    expect(ready.setupStatus).toBe("ready");
    expect(remote.createSheet).toHaveBeenCalledTimes(1);
    handle.close();
  });

  it("忽略大小写阻止同一任务中的重复名称", async () => {
    const handle = seedTask();
    const manager = new TaskSheetManager(handle.db, async () => api(), (() => {
      let index = 0; return () => `task-sheet-${++index}`;
    })());
    await manager.ensure({ accountId: "account-1", taskId: "task-1", spreadsheetToken: "spreadsheet-1", createKey: "one", name: "Review" });
    await expect(manager.ensure({ accountId: "account-1", taskId: "task-1", spreadsheetToken: "spreadsheet-1", createKey: "two", name: "review" }))
      .rejects.toMatchObject({ code: "TASK_SHEET_NAME_EXISTS" });
    handle.close();
  });
});
