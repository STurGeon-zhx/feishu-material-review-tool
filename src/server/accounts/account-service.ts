import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client";
import {
  appState,
  assets,
  destinationLocks,
  feishuAccounts,
  projects,
  sheetTabs,
  taskSheets,
  verificationChecks,
} from "../db/schema";
import { CredentialCipher } from "../security/credential-cipher";

const STATE_ID = "local";

export interface AccountCredentials {
  id: string;
  appId: string;
  appSecret: string;
  version: string;
}

function conflict(message: string, code: string): Error {
  return Object.assign(new Error(message), { code, retryable: false });
}

export function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeSheetName(value: string): string {
  return normalizeDisplayName(value).toLocaleLowerCase("zh-CN");
}

export function maskAppId(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 4)}***`;
  return `${value.slice(0, 7)}***${value.slice(-4)}`;
}

export class AccountService {
  constructor(
    private readonly db: AppDatabase,
    private readonly cipher: CredentialCipher,
    private readonly validateCredentials: (appId: string, appSecret: string) => Promise<void>,
    private readonly createId: () => string = randomUUID,
  ) {}

  list() {
    const activeAccountId = this.getActive()?.id;
    return this.db.select().from(feishuAccounts).orderBy(desc(feishuAccounts.createdAt)).all().map((account) => ({
      id: account.id,
      name: account.name,
      appIdMasked: maskAppId(account.appId),
      validationStatus: account.validationStatus,
      lastValidatedAt: account.lastValidatedAt,
      activeTaskId: account.activeTaskId,
      isActive: account.id === activeAccountId,
    }));
  }

  get(accountId: string) {
    return this.db.select().from(feishuAccounts).where(eq(feishuAccounts.id, accountId)).get();
  }

  getActive() {
    const state = this.db.select().from(appState).where(eq(appState.id, STATE_ID)).get();
    return state?.activeAccountId ? this.get(state.activeAccountId) : undefined;
  }

  getCredentials(accountId: string): AccountCredentials {
    const account = this.get(accountId);
    if (!account) throw conflict("飞书账号不存在", "ACCOUNT_NOT_FOUND");
    return {
      id: account.id,
      appId: account.appId,
      appSecret: this.cipher.decrypt(account.appSecretCiphertext),
      version: account.appSecretCiphertext,
    };
  }

  async create(input: { name: string; appId: string; appSecret: string }) {
    const existing = this.db.select().from(feishuAccounts).where(eq(feishuAccounts.appId, input.appId)).get();
    if (existing) throw conflict("该 App ID 已保存", "ACCOUNT_APP_ID_EXISTS");
    await this.validateCredentials(input.appId, input.appSecret);
    const id = this.createId();
    const checkedAt = new Date().toISOString();
    this.db.transaction((tx) => {
      tx.insert(feishuAccounts).values({
        id,
        name: normalizeDisplayName(input.name),
        appId: input.appId.trim(),
        appSecretCiphertext: this.cipher.encrypt(input.appSecret),
        validationStatus: "valid",
        lastValidatedAt: checkedAt,
      }).run();
      tx.insert(appState).values({ id: STATE_ID, activeAccountId: id })
        .onConflictDoUpdate({ target: appState.id, set: { activeAccountId: id, updatedAt: sql`datetime('now')` } })
        .run();
    });
    return this.get(id)!;
  }

  async update(accountId: string, input: { name?: string; appSecret?: string }) {
    const account = this.get(accountId);
    if (!account) throw conflict("飞书账号不存在", "ACCOUNT_NOT_FOUND");
    let encrypted = account.appSecretCiphertext;
    let checkedAt = account.lastValidatedAt;
    if (input.appSecret !== undefined) {
      await this.validateCredentials(account.appId, input.appSecret);
      encrypted = this.cipher.encrypt(input.appSecret);
      checkedAt = new Date().toISOString();
    }
    this.db.update(feishuAccounts).set({
      ...(input.name === undefined ? {} : { name: normalizeDisplayName(input.name) }),
      appSecretCiphertext: encrypted,
      validationStatus: "valid",
      lastValidatedAt: checkedAt,
      updatedAt: sql`datetime('now')`,
    }).where(eq(feishuAccounts.id, accountId)).run();
    return this.get(accountId)!;
  }

  activate(accountId: string) {
    const account = this.get(accountId);
    if (!account) throw conflict("飞书账号不存在", "ACCOUNT_NOT_FOUND");
    this.db.insert(appState).values({ id: STATE_ID, activeAccountId: accountId })
      .onConflictDoUpdate({ target: appState.id, set: { activeAccountId: accountId, updatedAt: sql`datetime('now')` } })
      .run();
    return account;
  }

  setActiveTask(accountId: string, taskId: string | null) {
    this.db.update(feishuAccounts)
      .set({ activeTaskId: taskId, updatedAt: sql`datetime('now')` })
      .where(eq(feishuAccounts.id, accountId))
      .run();
  }

  delete(accountId: string) {
    const account = this.get(accountId);
    if (!account) throw conflict("飞书账号不存在", "ACCOUNT_NOT_FOUND");
    const taskIds = this.db.select({ id: projects.id }).from(projects)
      .where(eq(projects.accountId, accountId)).all().map((task) => task.id);
    let activeAccountId: string | null = null;
    this.db.transaction((tx) => {
      if (taskIds.length > 0) {
        tx.delete(destinationLocks).where(inArray(destinationLocks.projectId, taskIds)).run();
        tx.delete(verificationChecks).where(inArray(verificationChecks.projectId, taskIds)).run();
        tx.delete(assets).where(inArray(assets.projectId, taskIds)).run();
        tx.delete(taskSheets).where(inArray(taskSheets.taskId, taskIds)).run();
        tx.delete(sheetTabs).where(inArray(sheetTabs.projectId, taskIds)).run();
        tx.delete(projects).where(inArray(projects.id, taskIds)).run();
      }
      tx.delete(feishuAccounts).where(eq(feishuAccounts.id, accountId)).run();
      const state = tx.select().from(appState).where(eq(appState.id, STATE_ID)).get();
      if (state?.activeAccountId === accountId) {
        activeAccountId = tx.select({ id: feishuAccounts.id }).from(feishuAccounts)
          .orderBy(desc(feishuAccounts.createdAt)).get()?.id ?? null;
        tx.update(appState).set({ activeAccountId, updatedAt: sql`datetime('now')` })
          .where(eq(appState.id, STATE_ID)).run();
      } else {
        activeAccountId = state?.activeAccountId ?? null;
      }
    });
    return { deletedAccountId: accountId, activeAccountId, deletedTaskCount: taskIds.length };
  }
}

export function bootstrapLegacyWorkspace(
  db: AppDatabase,
  cipher: CredentialCipher,
  environment: Record<string, string | undefined>,
  createId: () => string = randomUUID,
): void {
  db.transaction((tx) => {
    const existingState = tx.select().from(appState).where(eq(appState.id, STATE_ID)).get();
    let account = tx.select().from(feishuAccounts).orderBy(feishuAccounts.createdAt).get();
    if (!account && !existingState && environment.FEISHU_APP_ID && environment.FEISHU_APP_SECRET) {
      const id = createId();
      tx.insert(feishuAccounts).values({
        id,
        name: "默认飞书账号",
        appId: environment.FEISHU_APP_ID,
        appSecretCiphertext: cipher.encrypt(environment.FEISHU_APP_SECRET),
        validationStatus: "unverified",
      }).run();
      account = tx.select().from(feishuAccounts).where(eq(feishuAccounts.id, id)).get();
    }

    tx.insert(appState).values({ id: STATE_ID, activeAccountId: account?.id ?? null })
      .onConflictDoNothing()
      .run();
    if (!account) return;

    const state = tx.select().from(appState).where(eq(appState.id, STATE_ID)).get();
    if (!state?.activeAccountId) {
      tx.update(appState).set({ activeAccountId: account.id, updatedAt: sql`datetime('now')` })
        .where(eq(appState.id, STATE_ID)).run();
    }

    const legacyTask = tx.select().from(projects).where(and(
      eq(projects.resourceType, "sheet"),
      isNull(projects.accountId),
    )).orderBy(desc(projects.updatedAt), desc(projects.createdAt)).get();
    if (legacyTask) {
      const legacyTabs = tx.select().from(sheetTabs).where(eq(sheetTabs.projectId, legacyTask.id)).all();
      for (const tab of legacyTabs) {
        tx.insert(taskSheets).values({
          id: tab.id,
          taskId: legacyTask.id,
          createKey: `legacy:${tab.localDate}`,
          sheetId: tab.sheetId,
          name: tab.sheetName,
          normalizedName: normalizeSheetName(tab.sheetName),
          nextRow: tab.nextRow,
          setupStatus: tab.setupStatus,
          setupError: tab.setupError,
          createdAt: tab.createdAt,
          updatedAt: tab.updatedAt,
        }).onConflictDoNothing().run();
      }
      const selectedSheetId = legacyTabs[0]?.id ?? null;
      tx.update(projects).set({
        accountId: account.id,
        activeTaskSheetId: selectedSheetId,
        updatedAt: sql`datetime('now')`,
      }).where(eq(projects.id, legacyTask.id)).run();
      if (!account.activeTaskId) {
        tx.update(feishuAccounts).set({ activeTaskId: legacyTask.id, updatedAt: sql`datetime('now')` })
          .where(eq(feishuAccounts.id, account.id)).run();
      }
    }

    const migratedTaskId = legacyTask?.id ?? account.activeTaskId;
    if (migratedTaskId) {
      const migratedSheets = tx.select().from(taskSheets).where(eq(taskSheets.taskId, migratedTaskId)).all();
      for (const sheet of migratedSheets) {
        if (!sheet.sheetId) continue;
        tx.update(assets).set({ taskSheetId: sheet.id })
          .where(and(eq(assets.projectId, migratedTaskId), eq(assets.sheetId, sheet.sheetId)))
          .run();
      }
      if (migratedSheets.length === 1) {
        tx.update(assets).set({ taskSheetId: migratedSheets[0].id })
          .where(and(eq(assets.projectId, migratedTaskId), isNull(assets.taskSheetId)))
          .run();
      }
    }
  });
}
