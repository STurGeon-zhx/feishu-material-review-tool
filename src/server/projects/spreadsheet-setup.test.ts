import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDatabaseHandle } from "../db/client";
import { createDatabase } from "../db/client";
import { createOrGetProject, getProject, getProjectChecks } from "../db/repository";
import { SpreadsheetSetup, type SpreadsheetResourceApi } from "./spreadsheet-setup";

const handles: AppDatabaseHandle[] = [];

afterEach(() => handles.splice(0).forEach((handle) => handle.close()));

function project(): AppDatabaseHandle {
  const handle = createDatabase(":memory:");
  handles.push(handle);
  createOrGetProject(handle.db, {
    id: "p1",
    createKey: "sheet-setup",
    localUserId: "service_app",
    name: "客户素材审核",
    requestedShareMode: "anyone_editable",
    resourceType: "sheet",
  });
  return handle;
}

function resourceApi(overrides: Partial<SpreadsheetResourceApi> = {}): SpreadsheetResourceApi {
  return {
    createSpreadsheet: vi.fn(async () => ({
      spreadsheetToken: "sht1",
      url: "https://example.feishu.cn/sheets/sht1",
    })),
    getWorkbookInfo: vi.fn(async () => ({
      sheets: [{ sheetId: "default", title: "Sheet1", rowCount: 200, columnCount: 9 }],
    })),
    setPublicPermission: vi.fn(async () => undefined),
    getPublicPermission: vi.fn(async () => "anyone_editable"),
    ...overrides,
  };
}

describe("电子表格目标配置", () => {
  it("公开权限被企业策略拒绝时保留可导入电子表格，重试不重复创建", async () => {
    const { db } = project();
    let permissionError: Error | undefined = Object.assign(new Error("企业策略禁止公开编辑"), {
      code: "1063003",
    });
    const api = resourceApi({
      setPublicPermission: vi.fn(async () => {
        if (permissionError) throw permissionError;
      }),
      getPublicPermission: vi.fn(async () => permissionError ? "closed" : "anyone_editable"),
    });
    const daily = {
      ensure: vi.fn(async () => ({ sheetId: "default", sheetName: "0821素材审核", setupStatus: "ready" })),
    };
    const setup = new SpreadsheetSetup(db, async () => api, daily, () => new Date("2026-08-21T02:00:00+08:00"));

    await expect(setup.run("p1")).resolves.toMatchObject({
      setupStatus: "partial",
      setupStep: "share_permission_failed",
    });
    expect(getProject(db, "p1")).toMatchObject({
      resourceType: "sheet",
      spreadsheetToken: "sht1",
      spreadsheetUrl: "https://example.feishu.cn/sheets/sht1",
      effectiveShareMode: "closed",
    });
    expect(getProjectChecks(db, "p1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkKey: "create_spreadsheet", status: "pass" }),
      expect.objectContaining({ checkKey: "configure_review_sheet", status: "pass" }),
      expect.objectContaining({ checkKey: "share_link", status: "pass" }),
      expect.objectContaining({ checkKey: "share_permission", status: "fail" }),
    ]));

    permissionError = undefined;
    await expect(setup.run("p1")).resolves.toMatchObject({ setupStatus: "ready" });
    expect(api.createSpreadsheet).toHaveBeenCalledTimes(1);
    expect(daily.ensure).toHaveBeenCalledTimes(2);
  });

  it("工作表配置失败后保留 spreadsheet_token，重试复用资源", async () => {
    const { db } = project();
    const api = resourceApi();
    let fail = true;
    const daily = {
      ensure: vi.fn(async (
        _projectId: string,
        _token: string,
        _date: Date,
        _reusableSheetId?: string,
      ) => {
        if (fail) throw new Error("layout readback failed");
        return { sheetId: "default", sheetName: "0821素材审核", setupStatus: "ready" };
      }),
    };
    const setup = new SpreadsheetSetup(db, async () => api, daily, () => new Date("2026-08-21T02:00:00+08:00"));

    await expect(setup.run("p1")).rejects.toThrow("layout readback failed");
    expect(getProject(db, "p1")).toMatchObject({
      spreadsheetToken: "sht1",
      setupStatus: "partial",
      setupStep: "spreadsheet_created_failed",
    });

    fail = false;
    await expect(setup.run("p1")).resolves.toMatchObject({ setupStatus: "ready" });
    expect(api.createSpreadsheet).toHaveBeenCalledTimes(1);
    expect(api.getWorkbookInfo).toHaveBeenCalledTimes(2);
    expect(daily.ensure.mock.calls[1][3]).toBe("default");
  });

  it("权限回读不等于请求模式时标记 PARTIAL", async () => {
    const { db } = project();
    const api = resourceApi({
      getPublicPermission: vi.fn(async () => "anyone_readable"),
    });
    const daily = {
      ensure: vi.fn(async () => ({ sheetId: "default", sheetName: "0821素材审核", setupStatus: "ready" })),
    };

    const result = await new SpreadsheetSetup(db, async () => api, daily).run("p1");

    expect(result).toMatchObject({
      setupStatus: "partial",
      setupStep: "share_permission_failed",
      effectiveShareMode: "anyone_readable",
      errorCode: "1063003",
    });
  });
});
