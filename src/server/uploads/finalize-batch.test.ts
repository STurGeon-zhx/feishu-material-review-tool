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
      localUserId: "service_app",
      name: "审核项目",
      requestedShareMode: "anyone_readable",
      resourceType: "sheet",
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
      localUserId: "service_app",
      name: "审核项目",
      requestedShareMode: "anyone_readable",
      resourceType: "sheet",
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

  it("仅因公开分享策略受限的 PARTIAL 表仍可写入记录", async () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    createOrGetProject(handle.db, {
      id: "project-partial",
      createKey: "create-key-partial",
      localUserId: "service_app",
      name: "审核项目",
      requestedShareMode: "anyone_editable",
      resourceType: "sheet",
    });
    updateProject(handle.db, "project-partial", {
      appToken: "app-token",
      tableId: "tbl-review",
      setupStatus: "partial",
      setupStep: "share_permission_failed",
    });
    registerBatch(handle.db, "project-partial", "batch-partial", [
      { id: "asset-partial", name: "one.mp4", type: "video/mp4", size: 100 },
    ]);
    handle.db
      .update(assets)
      .set({ status: "uploaded", fileToken: "file-token" })
      .where(eq(assets.id, "asset-partial"))
      .run();
    const api: FeishuRecordApi = {
      async batchCreateRecords() { return ["record-created"]; },
      async searchRecordIds() { return new Map(); },
      async verifyRecordAttachment() { return true; },
    };

    await expect(new BatchFinalizer(handle.db, async () => api).run("project-partial", "batch-partial"))
      .resolves.toEqual({ completed: 1, failed: 0 });
  });

  it("并发完成同一批次时只向飞书新增一次记录", async () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    createOrGetProject(handle.db, {
      id: "project-concurrent", createKey: "create-key-concurrent", localUserId: "service_app",
      name: "审核项目", requestedShareMode: "anyone_editable", resourceType: "sheet",
    });
    updateProject(handle.db, "project-concurrent", {
      appToken: "app-token", tableId: "tbl-review", setupStatus: "ready",
    });
    registerBatch(handle.db, "project-concurrent", "batch-concurrent", [
      { id: "asset-concurrent", name: "one.jpg", type: "image/jpeg", size: 100 },
    ]);
    handle.db.update(assets).set({ status: "uploaded", fileToken: "file-token" })
      .where(eq(assets.id, "asset-concurrent")).run();
    let createCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const api: FeishuRecordApi = {
      async batchCreateRecords() { createCalls += 1; await gate; return ["record-created"]; },
      async searchRecordIds() { return new Map(); },
      async verifyRecordAttachment() { return true; },
    };
    const finalizer = new BatchFinalizer(handle.db, async () => api);

    const first = finalizer.run("project-concurrent", "batch-concurrent");
    const second = finalizer.run("project-concurrent", "batch-concurrent");
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { completed: 1, failed: 0 }, { completed: 1, failed: 0 },
    ]);
    expect(createCalls).toBe(1);
  });

  it("应用重启后自动续写所有已有 file_token 的批次", async () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    createOrGetProject(handle.db, {
      id: "project-recovery", createKey: "ensure:recovery", localUserId: "service_app",
      name: "审核项目", requestedShareMode: "anyone_editable", resourceType: "sheet",
    });
    updateProject(handle.db, "project-recovery", {
      appToken: "app-token", tableId: "tbl-review", setupStatus: "ready",
    });
    registerBatch(handle.db, "project-recovery", "batch-recovery", [
      { id: "asset-recovery", name: "one.mp4", type: "video/mp4", size: 100 },
    ]);
    handle.db.update(assets).set({ status: "failed", fileToken: "file-token", errorCode: "UPLOAD_INTERRUPTED" })
      .where(eq(assets.id, "asset-recovery")).run();
    const api: FeishuRecordApi = {
      async batchCreateRecords() { return ["record-recovered"]; },
      async searchRecordIds() { return new Map(); },
      async verifyRecordAttachment() { return true; },
    };

    const results = await new BatchFinalizer(handle.db, async () => api).resumeProject("project-recovery");

    expect(results).toEqual([{ batchId: "batch-recovery", completed: 1, failed: 0 }]);
    expect(handle.db.select().from(assets).where(eq(assets.id, "asset-recovery")).get())
      .toMatchObject({ status: "completed", recordId: "record-recovered" });
  });
});
