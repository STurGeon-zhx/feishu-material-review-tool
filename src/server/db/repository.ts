import { and, count, desc, eq, inArray, isNotNull, max, ne, or, sql } from "drizzle-orm";
import { formatMaterialNumber } from "../core/batching";
import { validateDeclaredFile } from "../uploads/policy";
import type { AppDatabase } from "./client";
import { assets, destinationLocks, projects, sheetTabs, verificationChecks, type ResourceType } from "./schema";

export type ShareMode = "anyone_readable" | "anyone_editable";

export function createOrGetProject(
  db: AppDatabase,
  input: {
    id: string;
    createKey: string;
    localUserId: string;
    name: string;
    requestedShareMode: ShareMode;
    resourceType?: ResourceType;
  },
) {
  const existing = db.select().from(projects).where(eq(projects.createKey, input.createKey)).get();
  if (existing) return existing;
  db.insert(projects).values({ ...input, resourceType: input.resourceType ?? "base" }).run();
  return db.select().from(projects).where(eq(projects.id, input.id)).get()!;
}

export function getProject(db: AppDatabase, projectId: string) {
  return db.select().from(projects).where(eq(projects.id, projectId)).get();
}

export function getProjectByCreateKey(db: AppDatabase, createKey: string) {
  return db.select().from(projects).where(eq(projects.createKey, createKey)).get();
}

export function getActiveProject(db: AppDatabase) {
  return db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.localUserId, "service_app"),
        eq(projects.resourceType, "sheet"),
        or(
          eq(projects.setupStatus, "ready"),
          and(eq(projects.setupStatus, "partial"), eq(projects.setupStep, "share_permission_failed")),
        ),
      ),
    )
    .orderBy(desc(projects.updatedAt), desc(projects.createdAt), sql`rowid DESC`)
    .get();
}

export function getPendingEnsureProject(db: AppDatabase) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.localUserId, "service_app"), eq(projects.resourceType, "sheet")))
    .orderBy(desc(projects.updatedAt), desc(projects.createdAt), sql`rowid DESC`)
    .all()
    .find((project) =>
      project.createKey.startsWith("ensure:")
      && project.setupStatus !== "ready"
      && !(project.setupStatus === "partial" && project.setupStep === "share_permission_failed"),
    );
}

export function getCurrentDestination(db: AppDatabase) {
  return getActiveProject(db) ?? getPendingEnsureProject(db);
}

export function isActiveDestination(db: AppDatabase, projectId: string): boolean {
  return getActiveProject(db)?.id === projectId;
}

export function canRegisterDestinationBatch(db: AppDatabase, projectId: string): boolean {
  const active = getActiveProject(db);
  const locked = db.select().from(destinationLocks).where(eq(destinationLocks.projectId, projectId)).get();
  return active?.id === projectId && !locked;
}

export function lockDestinationRebuild(db: AppDatabase, projectId: string): void {
  db.insert(destinationLocks)
    .values({ projectId, kind: "rebuild" })
    .onConflictDoNothing()
    .run();
}

export function unlockDestinationRebuild(db: AppDatabase, projectId: string): void {
  db.delete(destinationLocks).where(eq(destinationLocks.projectId, projectId)).run();
}

export function clearDestinationRebuildLocks(db: AppDatabase): void {
  db.delete(destinationLocks).run();
}

export function updateProject(
  db: AppDatabase,
  projectId: string,
  values: Partial<typeof projects.$inferInsert>,
) {
  db.update(projects)
    .set({ ...values, updatedAt: sql`datetime('now')` })
    .where(eq(projects.id, projectId))
    .run();
  return getProject(db, projectId);
}

export function listProjects(db: AppDatabase, localUserId: string) {
  return db.select().from(projects).where(eq(projects.localUserId, localUserId)).orderBy(desc(projects.createdAt)).all();
}

export function getAsset(db: AppDatabase, assetId: string) {
  return db.select().from(assets).where(eq(assets.id, assetId)).get();
}

export function updateAsset(db: AppDatabase, assetId: string, values: Partial<typeof assets.$inferInsert>) {
  db.update(assets)
    .set({ ...values, updatedAt: sql`datetime('now')` })
    .where(eq(assets.id, assetId))
    .run();
  return getAsset(db, assetId);
}

export function getSheetTabByDate(db: AppDatabase, projectId: string, localDate: string) {
  return db
    .select()
    .from(sheetTabs)
    .where(and(eq(sheetTabs.projectId, projectId), eq(sheetTabs.localDate, localDate)))
    .get();
}

export function upsertSheetTab(db: AppDatabase, value: typeof sheetTabs.$inferInsert) {
  db.insert(sheetTabs)
    .values(value)
    .onConflictDoUpdate({
      target: [sheetTabs.projectId, sheetTabs.localDate],
      set: {
        sheetId: value.sheetId,
        sheetName: value.sheetName,
        nextRow: value.nextRow,
        setupStatus: value.setupStatus,
        setupError: value.setupError,
        updatedAt: sql`datetime('now')`,
      },
    })
    .run();
  return getSheetTabByDate(db, value.projectId, value.localDate)!;
}

export function updateSheetTab(
  db: AppDatabase,
  id: string,
  values: Partial<typeof sheetTabs.$inferInsert>,
) {
  db.update(sheetTabs)
    .set({ ...values, updatedAt: sql`datetime('now')` })
    .where(eq(sheetTabs.id, id))
    .run();
  return db.select().from(sheetTabs).where(eq(sheetTabs.id, id)).get();
}

export function setAssetSheetLocation(
  db: AppDatabase,
  assetId: string,
  sheetId: string,
  rowNumber: number,
) {
  return updateAsset(db, assetId, { sheetId, sheetRowNumber: rowNumber });
}

export function getProjectAssets(db: AppDatabase, projectId: string) {
  return db.select().from(assets).where(eq(assets.projectId, projectId)).orderBy(assets.materialSequence).all();
}

export function listRecoverableBatchIds(db: AppDatabase, projectId: string): string[] {
  return db
    .selectDistinct({ batchId: assets.batchId })
    .from(assets)
    .where(
      and(
        eq(assets.projectId, projectId),
        isNotNull(assets.fileToken),
        ne(assets.status, "completed"),
      ),
    )
    .all()
    .map((row) => row.batchId);
}

export function hasPendingProjectAssets(db: AppDatabase, projectId: string): boolean {
  return db
    .select({ status: assets.status, fileToken: assets.fileToken, recordId: assets.recordId })
    .from(assets)
    .where(eq(assets.projectId, projectId))
    .all()
    .some((asset) =>
      !new Set(["completed", "failed"]).has(asset.status)
      || (asset.status !== "completed" && Boolean(asset.fileToken)),
    );
}

export function getProjectChecks(db: AppDatabase, projectId: string) {
  return db.select().from(verificationChecks).where(eq(verificationChecks.projectId, projectId)).all();
}

export function registerBatch(
  db: AppDatabase,
  projectId: string,
  batchId: string,
  files: Array<{ id: string; name: string; type: string; size: number }>,
) {
  if (files.length === 0) throw new Error("至少选择一个文件");
  files.forEach(validateDeclaredFile);

  return db.transaction((tx) => {
    const project = tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new Error("项目不存在");
    const aggregate = tx
      .select({ maxBatch: max(assets.batchNumber), assetCount: count(assets.id) })
      .from(assets)
      .where(eq(assets.projectId, projectId))
      .get();
    const batchNumber = (aggregate?.maxBatch ?? 0) + 1;
    const firstSequence = (aggregate?.assetCount ?? 0) + 1;
    const rows = files.map((file, index) => ({
      id: file.id,
      projectId,
      batchId,
      batchNumber,
      materialSequence: firstSequence + index,
      materialNumber: formatMaterialNumber(firstSequence + index),
      fileName: file.name,
      mimeType: file.type,
      fileSize: file.size,
    }));
    tx.insert(assets).values(rows).run();
    return tx.select().from(assets).where(and(eq(assets.projectId, projectId), eq(assets.batchId, batchId))).all();
  });
}

export function recoverInterruptedAssets(db: AppDatabase): number {
  return db
    .update(assets)
    .set({
      status: "failed",
      errorCode: "UPLOAD_INTERRUPTED",
      errorMessage: "应用重启导致上传中断，请重新上传该文件",
      updatedAt: sql`datetime('now')`,
    })
    .where(inArray(assets.status, ["receiving", "uploading", "recording"]))
    .run().changes;
}

export function upsertVerification(
  db: AppDatabase,
  value: typeof verificationChecks.$inferInsert,
): void {
  db.insert(verificationChecks)
    .values(value)
    .onConflictDoUpdate({
      target: [verificationChecks.projectId, verificationChecks.checkKey],
      set: { ...value, updatedAt: sql`datetime('now')` },
    })
    .run();
}
