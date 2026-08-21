import { describe, expect, it } from "vitest";
import { createDatabase } from "../db/client";
import {
  createOrGetProject,
  createTaskSheet,
  getAsset,
  registerBatch,
  setActiveTaskSheet,
  updateProject,
} from "../db/repository";

describe("任务批次目标固定", () => {
  it("登记批次后切换当前工作表，不会改变已登记素材的目标", () => {
    const handle = createDatabase(":memory:");
    createOrGetProject(handle.db, {
      id: "task-1", createKey: "task-key", localUserId: "service_app", name: "任务",
      requestedShareMode: "anyone_editable", resourceType: "sheet", accountId: "account-1",
    });
    updateProject(handle.db, "task-1", { setupStatus: "ready", setupStep: "ready", spreadsheetToken: "token" });
    createTaskSheet(handle.db, {
      id: "sheet-1", taskId: "task-1", createKey: "one", sheetId: "remote-1", name: "第一批",
      normalizedName: "第一批", setupStatus: "ready",
    });
    createTaskSheet(handle.db, {
      id: "sheet-2", taskId: "task-1", createKey: "two", sheetId: "remote-2", name: "第二批",
      normalizedName: "第二批", setupStatus: "ready",
    });
    setActiveTaskSheet(handle.db, "task-1", "sheet-1");
    registerBatch(handle.db, "task-1", "batch-1", [
      { id: "asset-1", name: "one.mp4", type: "video/mp4", size: 100 },
    ], "sheet-1");
    setActiveTaskSheet(handle.db, "task-1", "sheet-2");
    expect(getAsset(handle.db, "asset-1")?.taskSheetId).toBe("sheet-1");
    handle.close();
  });
});
