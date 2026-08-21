import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabaseHandle } from "../db/client";
import { createDatabase } from "../db/client";
import { createOrGetProject, getProject, getProjectChecks } from "../db/repository";
import { ProjectSetup, type FeishuResourceApi } from "./project-setup";

const handles: AppDatabaseHandle[] = [];
afterEach(() => handles.splice(0).forEach((handle) => handle.close()));

describe("项目创建恢复", () => {
  it("分享权限失败后保留 Base 和表，重试不重复创建资源", async () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    createOrGetProject(handle.db, {
      id: "project-1",
      createKey: "create-key",
      localUserId: "demo_user",
      name: "审核项目",
      requestedShareMode: "anyone_editable",
    });
    let permissionFailure: Error | undefined = Object.assign(new Error("企业策略禁止公开编辑"), { code: "1063003" });
    let baseCreations = 0;
    let tableCreations = 0;
    const api: FeishuResourceApi = {
      async createBase() {
        baseCreations += 1;
        return { appToken: "app-token", url: "https://example.feishu.cn/base/app-token" };
      },
      async listTables() {
        return [{ tableId: "tbl-default", name: "数据表" }];
      },
      async createReviewTable() {
        tableCreations += 1;
        return "tbl-review";
      },
      async deleteTable() {},
      async setPublicPermission() {
        if (permissionFailure) throw permissionFailure;
      },
      async getPublicPermission() {
        return "anyone_editable";
      },
    };
    const setup = new ProjectSetup(handle.db, async () => api);

    await expect(setup.run("project-1")).resolves.toMatchObject({ setupStatus: "partial" });
    expect(getProject(handle.db, "project-1")).toMatchObject({
      appToken: "app-token",
      tableId: "tbl-review",
      defaultTableDeleted: true,
      setupStatus: "partial",
      setupStep: "share_permission_failed",
      effectiveShareMode: "closed",
    });
    expect(getProjectChecks(handle.db, "project-1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkKey: "create_base", status: "pass" }),
      expect.objectContaining({ checkKey: "create_fields", status: "pass" }),
      expect.objectContaining({ checkKey: "share_link", status: "pass" }),
      expect.objectContaining({ checkKey: "share_permission", status: "fail" }),
    ]));

    permissionFailure = new Error("temporary network failure");
    await expect(setup.run("project-1")).rejects.toThrow("temporary network failure");
    expect(getProject(handle.db, "project-1")).toMatchObject({
      setupStatus: "partial",
      setupStep: "share_permission_failed",
      appToken: "app-token",
      tableId: "tbl-review",
    });

    permissionFailure = undefined;
    await setup.run("project-1");

    expect(getProject(handle.db, "project-1")).toMatchObject({
      setupStatus: "ready",
      effectiveShareMode: "anyone_editable",
    });
    expect(baseCreations).toBe(1);
    expect(tableCreations).toBe(1);
  });

  it("删除默认表的响应不确定时重试先回查并避免再次删除", async () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    createOrGetProject(handle.db, {
      id: "project-2",
      createKey: "create-key-2",
      localUserId: "demo_user",
      name: "审核项目",
      requestedShareMode: "anyone_readable",
    });
    let remoteDefaultDeleted = false;
    let deleteCalls = 0;
    const api: FeishuResourceApi = {
      async createBase() {
        return { appToken: "app-token", url: "https://example.feishu.cn/base/app-token" };
      },
      async listTables() {
        return remoteDefaultDeleted
          ? [{ tableId: "tbl-review", name: "审核素材" }]
          : [
              { tableId: "tbl-default", name: "数据表" },
              { tableId: "tbl-review", name: "审核素材" },
            ];
      },
      async createReviewTable() {
        return "tbl-review";
      },
      async deleteTable() {
        deleteCalls += 1;
        remoteDefaultDeleted = true;
        throw new Error("connection reset after delete");
      },
      async setPublicPermission() {},
      async getPublicPermission() {
        return "anyone_readable";
      },
    };
    const setup = new ProjectSetup(handle.db, async () => api);

    await expect(setup.run("project-2")).rejects.toThrow("connection reset after delete");
    await setup.run("project-2");

    expect(deleteCalls).toBe(1);
    expect(getProject(handle.db, "project-2")).toMatchObject({
      defaultTableDeleted: true,
      setupStatus: "ready",
    });
  });

  it("权限回读与请求不一致时按企业策略受限处理", async () => {
    const handle = createDatabase(":memory:");
    handles.push(handle);
    createOrGetProject(handle.db, {
      id: "project-policy-readback",
      createKey: "create-key-policy-readback",
      localUserId: "service_app",
      name: "审核项目",
      requestedShareMode: "anyone_editable",
    });
    const api: FeishuResourceApi = {
      async createBase() { return { appToken: "app-token", url: "https://example.feishu.cn/base/app-token" }; },
      async listTables() { return [{ tableId: "tbl-default", name: "数据表" }]; },
      async createReviewTable() { return "tbl-review"; },
      async deleteTable() {},
      async setPublicPermission() {},
      async getPublicPermission() { return "anyone_readable"; },
    };

    await expect(new ProjectSetup(handle.db, async () => api).run("project-policy-readback"))
      .resolves.toMatchObject({ setupStatus: "partial", effectiveShareMode: "anyone_readable" });
  });
});
