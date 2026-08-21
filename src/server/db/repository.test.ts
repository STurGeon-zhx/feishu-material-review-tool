import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDatabaseHandle } from "./client";
import { createDatabase } from "./client";
import { assets } from "./schema";
import * as repositoryModule from "./repository";
import {
  createOrGetProject,
  canRegisterDestinationBatch,
  getActiveProject,
  getCurrentDestination,
  hasPendingProjectAssets,
  isActiveDestination,
  listRecoverableBatchIds,
  lockDestinationRebuild,
  recoverInterruptedAssets,
  registerBatch,
  updateProject,
  unlockDestinationRebuild,
} from "./repository";

const handles: AppDatabaseHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function database(): AppDatabaseHandle {
  const handle = createDatabase(":memory:");
  handles.push(handle);
  return handle;
}

describe("SQLite 数据仓库", () => {
  it("按项目和日期幂等保存工作表并记录素材行位置", () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "sheet-tab-project",
      createKey: "sheet-tab-key",
      localUserId: "service_app",
      name: "客户素材审核",
      requestedShareMode: "anyone_editable",
      resourceType: "sheet",
    });
    registerBatch(db, "sheet-tab-project", "batch-1", [
      { id: "asset-1", name: "one.mp4", type: "video/mp4", size: 100 },
    ]);

    const repository = repositoryModule as typeof repositoryModule & {
      upsertSheetTab: (database: typeof db, value: {
        id: string; projectId: string; localDate: string; sheetId: string; sheetName: string;
        nextRow: number; setupStatus: "creating" | "ready" | "failed";
      }) => { id: string; sheetId: string; setupStatus: string };
      getSheetTabByDate: (database: typeof db, projectId: string, localDate: string) =>
        { id: string; sheetId: string; setupStatus: string } | undefined;
      updateSheetTab: (database: typeof db, id: string, value: { setupStatus: "ready"; nextRow: number }) =>
        { id: string; sheetId: string; setupStatus: string } | undefined;
      setAssetSheetLocation: (database: typeof db, assetId: string, sheetId: string, rowNumber: number) =>
        { sheetId: string | null; sheetRowNumber: number | null; recordId: string | null } | undefined;
    };

    expect(repository.upsertSheetTab).toBeTypeOf("function");
    repository.upsertSheetTab(db, {
      id: "tab-1",
      projectId: "sheet-tab-project",
      localDate: "2026-08-21",
      sheetId: "sheet-1",
      sheetName: "0821素材审核",
      nextRow: 2,
      setupStatus: "creating",
    });
    repository.upsertSheetTab(db, {
      id: "tab-retry",
      projectId: "sheet-tab-project",
      localDate: "2026-08-21",
      sheetId: "sheet-1",
      sheetName: "0821素材审核",
      nextRow: 2,
      setupStatus: "creating",
    });
    const ready = repository.updateSheetTab(db, "tab-1", { setupStatus: "ready", nextRow: 3 });
    const asset = repository.setAssetSheetLocation(db, "asset-1", "sheet-1", 2);

    expect(repository.getSheetTabByDate(db, "sheet-tab-project", "2026-08-21")).toMatchObject({
      id: "tab-1",
      sheetId: "sheet-1",
    });
    expect(ready).toMatchObject({ id: "tab-1", setupStatus: "ready" });
    expect(asset).toMatchObject({ sheetId: "sheet-1", sheetRowNumber: 2, recordId: null });
  });

  it("只把成功的电子表格项目选为活动目标", () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "legacy-base",
      createKey: "legacy-base-key",
      localUserId: "service_app",
      name: "旧 Base",
      requestedShareMode: "anyone_editable",
      resourceType: "base",
    });
    updateProject(db, "legacy-base", {
      setupStatus: "ready",
      setupStep: "ready",
      appToken: "base-app-token",
      tableId: "base-table-id",
    });

    expect(getActiveProject(db)).toBeUndefined();

    createOrGetProject(db, {
      id: "sheet-project",
      createKey: "sheet-project-key",
      localUserId: "service_app",
      name: "新电子表格",
      requestedShareMode: "anyone_editable",
      resourceType: "sheet",
    });
    updateProject(db, "sheet-project", {
      setupStatus: "ready",
      setupStep: "ready",
      spreadsheetToken: "sht-project",
      spreadsheetUrl: "https://example.feishu.cn/sheets/sht-project",
    });

    expect(getActiveProject(db)?.id).toBe("sheet-project");
  });

  it("相同幂等键重复创建时返回原项目", () => {
    const { db } = database();
    const first = createOrGetProject(db, {
      id: "project-1",
      createKey: "create-key",
      localUserId: "demo_user",
      name: "第一版",
      requestedShareMode: "anyone_readable",
    });
    const second = createOrGetProject(db, {
      id: "project-2",
      createKey: "create-key",
      localUserId: "demo_user",
      name: "不应覆盖",
      requestedShareMode: "anyone_editable",
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("第一版");
  });

  it("不同批次共享连续素材编号", () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "project-1",
      createKey: "create-key",
      localUserId: "demo_user",
      name: "审核项目",
      requestedShareMode: "anyone_readable",
    });

    const first = registerBatch(db, "project-1", "batch-1", [
      { id: "asset-1", name: "one.jpg", type: "image/jpeg", size: 100 },
      { id: "asset-2", name: "two.png", type: "image/png", size: 200 },
    ]);
    const second = registerBatch(db, "project-1", "batch-2", [
      { id: "asset-3", name: "three.mp4", type: "video/mp4", size: 300 },
    ]);

    expect(first.map((item) => [item.batchNumber, item.materialNumber])).toEqual([
      [1, "001"],
      [1, "002"],
    ]);
    expect(second.map((item) => [item.batchNumber, item.materialNumber])).toEqual([[2, "003"]]);
  });

  it("重启时仅把中断中的素材恢复为可重试失败", () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "project-1",
      createKey: "create-key",
      localUserId: "demo_user",
      name: "审核项目",
      requestedShareMode: "anyone_readable",
    });
    registerBatch(db, "project-1", "batch-1", [
      { id: "asset-1", name: "one.jpg", type: "image/jpeg", size: 100 },
      { id: "asset-2", name: "two.png", type: "image/png", size: 200 },
    ]);
    db.update(assets).set({ status: "uploading" }).where(eq(assets.id, "asset-1")).run();
    db.update(assets).set({ status: "uploaded", fileToken: "file-token" }).where(eq(assets.id, "asset-2")).run();

    recoverInterruptedAssets(db);
    const rows = db.select().from(assets).all();

    expect(rows.find((row) => row.id === "asset-1")).toMatchObject({
      status: "failed",
      errorCode: "UPLOAD_INTERRUPTED",
    });
    expect(rows.find((row) => row.id === "asset-2")).toMatchObject({ status: "uploaded", fileToken: "file-token" });
  });

  it("重建失败时继续返回最近可用的审核表", () => {
    const { db } = database();
    for (const [id, key] of [["old-ready", "key-1"], ["policy-partial", "key-2"], ["failed", "key-3"]]) {
      createOrGetProject(db, {
        id,
        createKey: key,
        localUserId: "service_app",
        name: id,
        requestedShareMode: "anyone_editable",
        resourceType: "sheet",
      });
    }
    updateProject(db, "old-ready", {
      setupStatus: "ready",
      setupStep: "ready",
      appToken: "app-old",
      tableId: "table-old",
      updatedAt: "2026-08-20 10:00:00",
    });
    updateProject(db, "policy-partial", {
      setupStatus: "partial",
      setupStep: "share_permission_failed",
      appToken: "app-partial",
      tableId: "table-partial",
      updatedAt: "2026-08-20 11:00:00",
    });
    updateProject(db, "failed", {
      setupStatus: "failed",
      setupStep: "base_created_failed",
      updatedAt: "2026-08-20 12:00:00",
    });

    expect(getActiveProject(db)?.id).toBe("policy-partial");

    updateProject(db, "failed", {
      setupStatus: "ready",
      setupStep: "ready",
      appToken: "app-new",
      tableId: "table-new",
      updatedAt: "2026-08-20 13:00:00",
    });
    expect(getActiveProject(db)?.id).toBe("failed");
  });

  it("不会把旧用户 OAuth 创建的项目当作应用身份固定表", () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "service-destination",
      createKey: "service-key",
      localUserId: "service_app",
      name: "应用身份审核表",
      requestedShareMode: "anyone_editable",
      resourceType: "sheet",
    });
    updateProject(db, "service-destination", {
      setupStatus: "ready",
      setupStep: "ready",
      appToken: "service-app-token",
      tableId: "service-table-id",
    });
    createOrGetProject(db, {
      id: "legacy-user-project",
      createKey: "legacy-key",
      localUserId: "demo_user",
      name: "旧用户项目",
      requestedShareMode: "anyone_editable",
    });
    updateProject(db, "legacy-user-project", {
      setupStatus: "ready",
      setupStep: "ready",
      appToken: "legacy-app-token",
      tableId: "legacy-table-id",
    });

    expect(getActiveProject(db)?.id).toBe("service-destination");
    expect(isActiveDestination(db, "service-destination")).toBe(true);
    expect(isActiveDestination(db, "legacy-user-project")).toBe(false);
  });

  it("首次创建失败时对外保留同一个应用身份候选目标", () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "pending-ensure", createKey: "ensure:first", localUserId: "service_app",
      name: "客户素材审核", requestedShareMode: "anyone_editable", resourceType: "sheet",
    });
    updateProject(db, "pending-ensure", {
      setupStatus: "partial", setupStep: "base_created_failed", appToken: "partial-app",
    });

    expect(getCurrentDestination(db)?.id).toBe("pending-ensure");
    expect(isActiveDestination(db, "pending-ensure")).toBe(false);
  });

  it("只列出已取得 file_token 且尚未完成的恢复批次", () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "recovery-project", createKey: "ensure:recovery", localUserId: "service_app",
      name: "客户素材审核", requestedShareMode: "anyone_editable",
    });
    registerBatch(db, "recovery-project", "batch-uploaded", [
      { id: "asset-uploaded", name: "one.jpg", type: "image/jpeg", size: 100 },
    ]);
    registerBatch(db, "recovery-project", "batch-queued", [
      { id: "asset-queued", name: "two.png", type: "image/png", size: 100 },
    ]);
    db.update(assets).set({ status: "uploaded", fileToken: "file-token" })
      .where(eq(assets.id, "asset-uploaded")).run();

    expect(listRecoverableBatchIds(db, "recovery-project")).toEqual(["batch-uploaded"]);
  });

  it("重建锁定期间禁止登记新批次但仍保持旧表为活动目标", () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "locked-project", createKey: "ensure:locked", localUserId: "service_app",
      name: "客户素材审核", requestedShareMode: "anyone_editable", resourceType: "sheet",
    });
    updateProject(db, "locked-project", {
      setupStatus: "partial", setupStep: "share_permission_failed", appToken: "app", tableId: "table",
    });
    lockDestinationRebuild(db, "locked-project");

    expect(isActiveDestination(db, "locked-project")).toBe(true);
    expect(canRegisterDestinationBatch(db, "locked-project")).toBe(false);
    unlockDestinationRebuild(db, "locked-project");
    expect(canRegisterDestinationBatch(db, "locked-project")).toBe(true);
  });

  it("附件回读失败但已有 file_token 和 record_id 时仍会阻止重建", () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "verify-failed-project", createKey: "ensure:verify-failed", localUserId: "service_app",
      name: "客户素材审核", requestedShareMode: "anyone_editable",
    });
    registerBatch(db, "verify-failed-project", "batch-verify-failed", [
      { id: "asset-verify-failed", name: "one.jpg", type: "image/jpeg", size: 100 },
    ]);
    db.update(assets).set({
      status: "failed", fileToken: "file-token", recordId: "record-id", errorCode: "ATTACHMENT_VERIFY_FAILED",
    }).where(eq(assets.id, "asset-verify-failed")).run();

    expect(hasPendingProjectAssets(db, "verify-failed-project")).toBe(true);
  });
});
