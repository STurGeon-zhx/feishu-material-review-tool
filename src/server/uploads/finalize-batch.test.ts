import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDatabaseHandle } from "../db/client";
import { createDatabase } from "../db/client";
import { createOrGetProject, registerBatch, updateProject } from "../db/repository";
import { assets } from "../db/schema";
import { BatchFinalizer, type FeishuRecordApi } from "./finalize-batch";

const handles: AppDatabaseHandle[] = [];
afterEach(() => handles.splice(0).forEach((handle) => handle.close()));

describe("批次记录写入", () => {
  it("不确定响应通过素材编号回查后标记完成而不重复写入", async () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    createOrGetProject(handle.db, {
      id: "project-1",
      createKey: "create-key",
      localUserId: "demo_user",
      name: "审核项目",
      requestedShareMode: "anyone_readable",
    });
    updateProject(handle.db, "project-1", {
      appToken: "app-token",
      tableId: "tbl-review",
      feishuUrl: "https://example.feishu.cn/base/app-token",
      setupStatus: "ready",
    });
    registerBatch(handle.db, "project-1", "batch-1", [
      { id: "asset-1", name: "one.jpg", type: "image/jpeg", size: 100 },
    ]);
    handle.db
      .update(assets)
      .set({ status: "uploaded", fileToken: "file-token" })
      .where(eq(assets.id, "asset-1"))
      .run();
    let createAttempts = 0;
    const api: FeishuRecordApi = {
      async batchCreateRecords() {
        createAttempts += 1;
        throw new Error("connection reset after write");
      },
      async searchRecordIds() {
        return new Map([["001", "rec-existing"]]);
      },
      async verifyRecordAttachment() {
        return true;
      },
    };
    const finalizer = new BatchFinalizer(handle.db, async () => api);

    const result = await finalizer.run("project-1", "batch-1");

    expect(result).toMatchObject({ completed: 1, failed: 0 });
    expect(handle.db.select().from(assets).where(eq(assets.id, "asset-1")).get()).toMatchObject({
      status: "completed",
      recordId: "rec-existing",
    });
    expect(createAttempts).toBe(0);
  });

  it("不确定响应只回查到部分记录时保留成功项并只留下失败项重试", async () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    createOrGetProject(handle.db, {
      id: "project-2",
      createKey: "create-key-2",
      localUserId: "demo_user",
      name: "审核项目",
      requestedShareMode: "anyone_readable",
    });
    updateProject(handle.db, "project-2", {
      appToken: "app-token",
      tableId: "tbl-review",
      feishuUrl: "https://example.feishu.cn/base/app-token",
      setupStatus: "ready",
    });
    registerBatch(handle.db, "project-2", "batch-2", [
      { id: "asset-2", name: "two.jpg", type: "image/jpeg", size: 100 },
      { id: "asset-3", name: "three.png", type: "image/png", size: 100 },
    ]);
    handle.db
      .update(assets)
      .set({ status: "uploaded", fileToken: "file-token" })
      .where(eq(assets.projectId, "project-2"))
      .run();
    let searches = 0;
    const api: FeishuRecordApi = {
      async batchCreateRecords() {
        throw new Error("connection reset after partial write");
      },
      async searchRecordIds() {
        searches += 1;
        return searches === 1 ? new Map() : new Map([["001", "rec-existing"]]);
      },
      async verifyRecordAttachment(_appToken, _tableId, recordId) {
        return recordId === "rec-existing";
      },
    };

    const result = await new BatchFinalizer(handle.db, async () => api).run("project-2", "batch-2");
    const rows = handle.db.select().from(assets).where(eq(assets.projectId, "project-2")).all();

    expect(result).toEqual({ completed: 1, failed: 1 });
    expect(rows.find((row) => row.materialNumber === "001")).toMatchObject({
      status: "completed",
      recordId: "rec-existing",
    });
    expect(rows.find((row) => row.materialNumber === "002")).toMatchObject({
      status: "failed",
      recordId: null,
    });
  });
});
