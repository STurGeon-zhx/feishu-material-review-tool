import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../db/client";
import { assets, destinationLocks, feishuAccounts, projects, sheetTabs, taskSheets, verificationChecks } from "../db/schema";
import { CredentialCipher } from "../security/credential-cipher";
import { AccountService, bootstrapLegacyWorkspace } from "./account-service";

describe("AccountService", () => {
  it("隔离多账号、记忆当前账号，并只在新 Secret 验证成功后替换", async () => {
    const handle = createDatabase(":memory:");
    const validate = vi.fn(async (_appId: string, secret: string) => {
      if (secret === "bad") throw new Error("凭证无效");
    });
    const service = new AccountService(handle.db, new CredentialCipher(Buffer.alloc(32, 1)), validate, (() => {
      let index = 0; return () => `account-${++index}`;
    })());
    const first = await service.create({ name: "账号 A", appId: "cli_a", appSecret: "secret-a" });
    const second = await service.create({ name: "账号 B", appId: "cli_b", appSecret: "secret-b" });
    expect(service.getActive()?.id).toBe(second.id);
    service.activate(first.id);
    expect(service.getActive()?.id).toBe(first.id);
    await expect(service.update(first.id, { appSecret: "bad" })).rejects.toThrow("凭证无效");
    expect(service.getCredentials(first.id).appSecret).toBe("secret-a");
    await service.update(first.id, { name: "账号 A 新名称", appSecret: "secret-a2" });
    expect(service.get(first.id)?.appId).toBe("cli_a");
    expect(service.getCredentials(first.id).appSecret).toBe("secret-a2");
    expect(service.list().find((item) => item.id === first.id)?.appIdMasked).not.toContain("secret");
    handle.close();
  });

  it("删除账号时级联清理本地任务记录、切换账号且重启后不重新导入环境凭证", async () => {
    const handle = createDatabase(":memory:");
    const cipher = new CredentialCipher(Buffer.alloc(32, 4));
    let index = 0;
    const service = new AccountService(handle.db, cipher, vi.fn(async () => undefined), () => `account-${++index}`);
    const keep = await service.create({ name: "保留账号", appId: "cli_keep", appSecret: "keep" });
    const removed = await service.create({ name: "删除账号", appId: "cli_remove", appSecret: "remove" });
    handle.db.insert(projects).values({
      id: "task-remove", createKey: "task-remove", localUserId: "service_app", name: "待删除任务",
      resourceType: "sheet", requestedShareMode: "anyone_editable", accountId: removed.id,
    }).run();
    handle.db.insert(taskSheets).values({
      id: "sheet-remove", taskId: "task-remove", createKey: "first", name: "首批",
      normalizedName: "首批", setupStatus: "ready",
    }).run();
    handle.db.insert(assets).values({
      id: "asset-remove", projectId: "task-remove", batchId: "batch", batchNumber: 1,
      materialSequence: 1, materialNumber: "001", fileName: "demo.jpg", mimeType: "image/jpeg",
      fileSize: 100, status: "completed",
    }).run();
    handle.db.insert(verificationChecks).values({
      projectId: "task-remove", checkKey: "upload_jpg", source: "automatic", status: "pass",
    }).run();
    handle.db.insert(destinationLocks).values({ projectId: "task-remove", kind: "upload" }).run();

    expect(service.delete(removed.id)).toMatchObject({
      deletedAccountId: removed.id,
      activeAccountId: keep.id,
      deletedTaskCount: 1,
    });
    expect(service.getActive()?.id).toBe(keep.id);
    expect(handle.db.select().from(projects).all()).toHaveLength(0);
    expect(handle.db.select().from(taskSheets).all()).toHaveLength(0);
    expect(handle.db.select().from(assets).all()).toHaveLength(0);
    expect(handle.db.select().from(verificationChecks).all()).toHaveLength(0);
    expect(handle.db.select().from(destinationLocks).all()).toHaveLength(0);

    service.delete(keep.id);
    bootstrapLegacyWorkspace(handle.db, cipher, { FEISHU_APP_ID: "cli_keep", FEISHU_APP_SECRET: "keep" });
    expect(service.list()).toHaveLength(0);
    expect(service.getActive()).toBeUndefined();
    handle.close();
  });
});

describe("bootstrapLegacyWorkspace", () => {
  it("幂等迁移现有电子表格及 73 条素材，不改变远端链接、Token 和行号", () => {
    const handle = createDatabase(":memory:");
    handle.db.insert(projects).values({
      id: "legacy-task", createKey: "legacy-key", localUserId: "service_app", name: "客户素材审核",
      resourceType: "sheet", requestedShareMode: "anyone_editable", spreadsheetToken: "sht-token",
      spreadsheetUrl: "https://example.feishu.cn/sheets/sht-token", setupStatus: "ready", setupStep: "ready",
    }).run();
    handle.db.insert(sheetTabs).values({
      id: "legacy-tab", projectId: "legacy-task", localDate: "2026-08-21", sheetId: "sheet-remote",
      sheetName: "0821素材审核", nextRow: 75, setupStatus: "ready",
    }).run();
    for (let index = 1; index <= 73; index += 1) {
      handle.db.insert(assets).values({
        id: `asset-${index}`, projectId: "legacy-task", batchId: "batch-1", batchNumber: 1,
        materialSequence: index, materialNumber: String(index).padStart(3, "0"), fileName: `${index}.mp4`,
        mimeType: "video/mp4", fileSize: 100, sheetId: index <= 50 ? "sheet-remote" : null,
        sheetRowNumber: index <= 50 ? index + 1 : null,
        status: "completed",
      }).run();
    }
    const cipher = new CredentialCipher(Buffer.alloc(32, 2));
    const env = { FEISHU_APP_ID: "cli_legacy", FEISHU_APP_SECRET: "legacy-secret" };
    bootstrapLegacyWorkspace(handle.db, cipher, env, () => "default-account");
    bootstrapLegacyWorkspace(handle.db, cipher, env, () => "should-not-be-created");

    const accountRows = handle.db.select().from(feishuAccounts).all();
    const migratedTask = handle.db.select().from(projects).where(eq(projects.id, "legacy-task")).get()!;
    const migratedSheets = handle.db.select().from(taskSheets).all();
    const migratedAssets = handle.db.select().from(assets).where(eq(assets.taskSheetId, "legacy-tab")).all();
    expect(accountRows).toHaveLength(1);
    expect(migratedSheets).toHaveLength(1);
    expect(migratedAssets).toHaveLength(73);
    expect(migratedTask.spreadsheetToken).toBe("sht-token");
    expect(migratedTask.spreadsheetUrl).toBe("https://example.feishu.cn/sheets/sht-token");
    expect(migratedSheets[0]).toMatchObject({ sheetId: "sheet-remote", nextRow: 75 });
    expect(migratedAssets[49].sheetRowNumber).toBe(51);
    expect(migratedAssets[72].sheetRowNumber).toBeNull();
    handle.close();
  });
});
