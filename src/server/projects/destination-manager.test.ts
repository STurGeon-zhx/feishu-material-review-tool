import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabaseHandle } from "../db/client";
import { createDatabase } from "../db/client";
import {
  canRegisterDestinationBatch,
  createOrGetProject,
  getActiveProject,
  getProject,
  registerBatch,
  updateProject,
} from "../db/repository";
import { DestinationManager } from "./destination-manager";

const handles: AppDatabaseHandle[] = [];
afterEach(() => handles.splice(0).forEach((handle) => handle.close()));

function database() {
  const handle = createDatabase(":memory:");
  handles.push(handle);
  return handle;
}

describe("DestinationManager", () => {
  it("并发首次确保目标表时只创建一个审核表", async () => {
    const { db } = database();
    let setupCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new DestinationManager(
      db,
      {
        async run(projectId) {
          setupCalls += 1;
          await gate;
          return updateProject(db, projectId, {
            setupStatus: "ready",
            setupStep: "ready",
            spreadsheetToken: "sht-token",
            spreadsheetUrl: "https://example.feishu.cn/sheets/sht-token",
          })!;
        },
      },
      () => "destination-1",
      () => new Date("2026-08-20T07:00:00.000Z"),
    );

    const first = manager.ensure("ensure-key-1");
    const second = manager.ensure("ensure-key-2");
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe("destination-1");
    expect(b.id).toBe("destination-1");
    expect(setupCalls).toBe(1);
    expect(getProject(db, "destination-1")?.resourceType).toBe("sheet");
  });

  it("重建失败时不替换原来的活动审核表", async () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "destination-old",
      createKey: "old-key",
      localUserId: "service_app",
      name: "客户素材审核",
      requestedShareMode: "anyone_editable",
      resourceType: "sheet",
    });
    updateProject(db, "destination-old", {
      setupStatus: "ready",
      setupStep: "ready",
      spreadsheetToken: "sht-old",
    });
    const manager = new DestinationManager(
      db,
      {
        async run(projectId) {
          updateProject(db, projectId, { setupStatus: "failed", setupStep: "base_created_failed" });
          throw new Error("创建失败");
        },
      },
      () => "destination-new",
      () => new Date("2026-08-20T07:00:00.000Z"),
    );

    await expect(manager.rebuild("rebuild-key")).rejects.toThrow("创建失败");
    expect(getProject(db, "destination-new")).toMatchObject({ setupStatus: "failed" });
    expect(getActiveProject(db)?.id).toBe("destination-old");
  });

  it("首次建表中断后使用新的请求键继续同一个候选表", async () => {
    const { db } = database();
    let setupCalls = 0;
    const ids = ["destination-candidate", "destination-duplicate"];
    const manager = new DestinationManager(
      db,
      {
        async run(projectId) {
          setupCalls += 1;
          if (setupCalls === 1) {
            updateProject(db, projectId, { setupStatus: "partial", setupStep: "spreadsheet_created_failed", spreadsheetToken: "sht-partial" });
            throw new Error("temporary failure");
          }
          return updateProject(db, projectId, {
            setupStatus: "ready",
            setupStep: "ready",
            spreadsheetToken: "sht-partial",
          })!;
        },
      },
      () => ids.shift()!,
    );

    await expect(manager.ensure("first-request")).rejects.toThrow("temporary failure");
    await expect(manager.ensure("second-request")).resolves.toMatchObject({ id: "destination-candidate" });
    expect(getProject(db, "destination-duplicate")).toBeUndefined();
  });

  it("并发重建只创建一个新审核表", async () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "destination-old", createKey: "old", localUserId: "service_app",
      name: "客户素材审核", requestedShareMode: "anyone_editable", resourceType: "sheet",
    });
    updateProject(db, "destination-old", { setupStatus: "ready", setupStep: "ready", spreadsheetToken: "sht-old" });
    let setupCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ids = ["destination-new-1", "destination-new-2"];
    const manager = new DestinationManager(
      db,
      {
        async run(projectId) {
          setupCalls += 1;
          await gate;
          return updateProject(db, projectId, {
            setupStatus: "ready", setupStep: "ready", spreadsheetToken: "sht-new",
          })!;
        },
      },
      () => ids.shift()!,
    );

    const first = manager.rebuild("rebuild-1");
    const second = manager.rebuild("rebuild-1");
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.id).toBe("destination-new-1");
    expect(b.id).toBe("destination-new-1");
    expect(setupCalls).toBe(1);
    expect(getProject(db, "destination-new-2")).toBeUndefined();
  });

  it("不同幂等键并发重建时明确拒绝第二个请求", async () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "destination-old", createKey: "old", localUserId: "service_app",
      name: "客户素材审核", requestedShareMode: "anyone_editable", resourceType: "sheet",
    });
    updateProject(db, "destination-old", { setupStatus: "ready", setupStep: "ready", spreadsheetToken: "sht-old" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new DestinationManager(db, {
      async run(projectId) {
        await gate;
        return updateProject(db, projectId, {
          setupStatus: "ready", setupStep: "ready", spreadsheetToken: "sht-new",
        })!;
      },
    }, () => "destination-new");

    const first = manager.rebuild("rebuild-first");
    await expect(manager.rebuild("rebuild-second")).rejects.toMatchObject({
      code: "DESTINATION_MUTATION_IN_PROGRESS",
    });
    release();
    await first;
  });

  it("相同重建幂等键顺序重放不会再次配置已成功目标", async () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "destination-old", createKey: "old", localUserId: "service_app",
      name: "客户素材审核", requestedShareMode: "anyone_editable", resourceType: "sheet",
    });
    updateProject(db, "destination-old", { setupStatus: "ready", setupStep: "ready", spreadsheetToken: "sht-old" });
    let setupCalls = 0;
    const manager = new DestinationManager(db, {
      async run(projectId) {
        setupCalls += 1;
        return updateProject(db, projectId, {
          setupStatus: "ready", setupStep: "ready", spreadsheetToken: "sht-new",
        })!;
      },
    }, () => `destination-new-${setupCalls}`);

    const first = await manager.rebuild("stable-key");
    const second = await manager.rebuild("stable-key");

    expect(second.id).toBe(first.id);
    expect(setupCalls).toBe(1);
  });

  it("活动表存在未完成批次时拒绝重建", async () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "destination-old", createKey: "old", localUserId: "service_app",
      name: "客户素材审核", requestedShareMode: "anyone_editable", resourceType: "sheet",
    });
    updateProject(db, "destination-old", { setupStatus: "ready", setupStep: "ready", spreadsheetToken: "sht-old" });
    registerBatch(db, "destination-old", "batch-pending", [
      { id: "asset-pending", name: "one.mp4", type: "video/mp4", size: 100 },
    ]);
    let setupCalls = 0;
    const manager = new DestinationManager(db, {
      async run(projectId) { setupCalls += 1; return getProject(db, projectId)!; },
    });

    await expect(manager.rebuild("blocked-rebuild")).rejects.toMatchObject({
      code: "DESTINATION_HAS_PENDING_IMPORTS",
    });
    expect(setupCalls).toBe(0);
    expect(getActiveProject(db)?.id).toBe("destination-old");
  });

  it("策略受限的 PARTIAL 旧表在重建等待期间仍保持活动但不接收新批次", async () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "destination-partial", createKey: "old-partial", localUserId: "service_app",
      name: "客户素材审核", requestedShareMode: "anyone_editable", resourceType: "sheet",
    });
    updateProject(db, "destination-partial", {
      setupStatus: "partial", setupStep: "share_permission_failed", spreadsheetToken: "sht-old",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new DestinationManager(db, {
      async run(projectId) {
        await gate;
        return updateProject(db, projectId, {
          setupStatus: "ready", setupStep: "ready", spreadsheetToken: "sht-new",
        })!;
      },
    }, () => "destination-new");

    const rebuilding = manager.rebuild("partial-rebuild");
    expect(getActiveProject(db)?.id).toBe("destination-partial");
    expect(canRegisterDestinationBatch(db, "destination-partial")).toBe(false);
    release();
    await rebuilding;
  });

  it("重建进行中拒绝同时重试目标配置", async () => {
    const { db } = database();
    createOrGetProject(db, {
      id: "destination-ready", createKey: "old-ready", localUserId: "service_app",
      name: "客户素材审核", requestedShareMode: "anyone_editable", resourceType: "sheet",
    });
    updateProject(db, "destination-ready", {
      setupStatus: "ready", setupStep: "ready", spreadsheetToken: "sht-old",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new DestinationManager(db, {
      async run(projectId) { await gate; return getProject(db, projectId)!; },
    }, () => "destination-new");

    const rebuilding = manager.rebuild("rebuild-lock");
    await expect(manager.retry()).rejects.toMatchObject({ code: "DESTINATION_MUTATION_IN_PROGRESS" });
    release();
    await rebuilding;
  });
});
