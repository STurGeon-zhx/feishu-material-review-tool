import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDatabaseHandle } from "./client";
import { createDatabase } from "./client";
import { assets } from "./schema";
import {
  createOrGetProject,
  recoverInterruptedAssets,
  registerBatch,
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
});
