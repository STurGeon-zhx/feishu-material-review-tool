import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { formatMaterialNumber } from "../core/batching";
import { validateDeclaredFile } from "../uploads/policy";
import type { AppDatabase } from "./client";
import { assets, feishuConnections, projects, verificationChecks } from "./schema";

export type ShareMode = "anyone_readable" | "anyone_editable";

export function createOrGetProject(
  db: AppDatabase,
  input: { id: string; createKey: string; localUserId: string; name: string; requestedShareMode: ShareMode },
) {
  const existing = db.select().from(projects).where(eq(projects.createKey, input.createKey)).get();
  if (existing) return existing;
  db.insert(projects).values(input).run();
  return db.select().from(projects).where(eq(projects.id, input.id)).get()!;
}

export function getProject(db: AppDatabase, projectId: string) {
  return db.select().from(projects).where(eq(projects.id, projectId)).get();
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

export function getProjectAssets(db: AppDatabase, projectId: string) {
  return db.select().from(assets).where(eq(assets.projectId, projectId)).orderBy(assets.materialSequence).all();
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

export function upsertConnection(db: AppDatabase, value: typeof feishuConnections.$inferInsert): void {
  db.insert(feishuConnections)
    .values(value)
    .onConflictDoUpdate({
      target: feishuConnections.localUserId,
      set: { ...value, updatedAt: sql`datetime('now')` },
    })
    .run();
}

export function getConnection(db: AppDatabase, localUserId: string) {
  return db.select().from(feishuConnections).where(eq(feishuConnections.localUserId, localUserId)).get();
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
