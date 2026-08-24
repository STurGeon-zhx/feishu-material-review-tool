import { describe, expect, it, vi } from "vitest";
import { AccountService } from "../accounts/account-service";
import { createDatabase } from "../db/client";
import { CredentialCipher } from "../security/credential-cipher";
import { REVIEW_HEADERS, TaskSheetManager, type TaskSheetApi } from "../sheets/task-sheet-manager";
import { TaskService } from "./task-service";

describe("TaskService", () => {
  it("按账号过滤任务；新任务使用独立电子表格，同一任务的命名工作表共享链接", async () => {
    const handle = createDatabase(":memory:");
    let accountIndex = 0;
    const accounts = new AccountService(
      handle.db,
      new CredentialCipher(Buffer.alloc(32, 3)),
      vi.fn(async () => undefined),
      () => `account-${++accountIndex}`,
    );
    const workbooks = new Map<string, Array<{ sheetId: string; title: string; rowCount: number; columnCount: number }>>();
    let spreadsheetIndex = 0;
    let remoteSheetIndex = 0;
    const createApi = async (accountId: string) => ({
      createSpreadsheet: async (name: string) => {
        const token = `${accountId}-spreadsheet-${++spreadsheetIndex}`;
        workbooks.set(token, [{ sheetId: `${token}-default`, title: "Sheet1", rowCount: 200, columnCount: 9 }]);
        return { spreadsheetToken: token, url: `https://example.feishu.cn/sheets/${token}?title=${name}` };
      },
      getWorkbookInfo: async (token: string) => ({ sheets: workbooks.get(token) ?? [] }),
      setPublicPermission: async () => undefined,
      getPublicPermission: async () => "anyone_editable",
      createSheet: async (token: string, title: string) => {
        const sheet = { sheetId: `remote-${++remoteSheetIndex}`, title, rowCount: 200, columnCount: 9 };
        workbooks.get(token)!.push(sheet);
        return sheet;
      },
      renameSheet: async (token: string, sheetId: string, title: string) => {
        const sheet = workbooks.get(token)!.find((item) => item.sheetId === sheetId)!;
        sheet.title = title;
      },
      setCellRange: async () => undefined,
      getCellRange: async () => ({ cells: [[...REVIEW_HEADERS].map((value) => ({ value }))] }),
      resizeRanges: async () => undefined,
      freezeRows: async () => undefined,
      hideColumns: async () => undefined,
      getSheetStructure: async () => ({ frozen_rows: 1, hidden_columns_count: 6 }),
    });
    let localSheetIndex = 0;
    const sheetManager = new TaskSheetManager(
      handle.db,
      createApi as (accountId: string) => Promise<TaskSheetApi>,
      () => `task-sheet-${++localSheetIndex}`,
    );
    let taskIndex = 0;
    const tasks = new TaskService(handle.db, accounts, createApi, sheetManager, () => `task-${++taskIndex}`);

    const accountA = await accounts.create({ name: "账号 A", appId: "cli_a", appSecret: "secret-a" });
    const taskA = await tasks.create("create-a", { name: "任务 A", firstSheetName: "首批" });
    const firstUrl = taskA.spreadsheetUrl;
    await tasks.createSheet(taskA.id, "sheet-2", "第二批");
    expect(tasks.getSheets(taskA.id)).toHaveLength(2);
    expect(tasks.getTask(taskA.id)?.spreadsheetUrl).toBe(firstUrl);

    const accountB = await accounts.create({ name: "账号 B", appId: "cli_b", appSecret: "secret-b" });
    const taskB = await tasks.create("create-b", { name: "任务 B", firstSheetName: "审核" });
    expect(taskB.spreadsheetUrl).not.toBe(firstUrl);
    expect(tasks.listForActiveAccount().map((task) => task.id)).toEqual([taskB.id]);
    accounts.activate(accountA.id);
    expect(tasks.listForActiveAccount().map((task) => task.id)).toEqual([taskA.id]);
    await expect(tasks.create("duplicate", { name: "任务 a", firstSheetName: "不会创建" }))
      .rejects.toMatchObject({ code: "TASK_NAME_EXISTS" });
    expect(accountB.id).not.toBe(accountA.id);
    const remoteToken = taskA.spreadsheetToken!;
    expect(tasks.delete(taskA.id)).toMatchObject({
      deletedTaskId: taskA.id,
      activeTaskId: null,
      remoteSpreadsheetUrl: firstUrl,
    });
    expect(tasks.getTask(taskA.id)).toBeUndefined();
    expect(tasks.getSheets(taskA.id)).toHaveLength(0);
    expect(accounts.get(accountA.id)?.activeTaskId).toBeNull();
    expect(workbooks.has(remoteToken)).toBe(true);
    handle.close();
  });
});
