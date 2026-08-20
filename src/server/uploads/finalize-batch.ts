import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { chunkRecords } from "../core/batching";
import type { AppDatabase } from "../db/client";
import { getProject, upsertVerification } from "../db/repository";
import { assets } from "../db/schema";
import type { ReviewRecordInput } from "../feishu/service";

export interface FeishuRecordApi {
  batchCreateRecords(appToken: string, tableId: string, records: ReviewRecordInput[]): Promise<string[]>;
  searchRecordIds(appToken: string, tableId: string, materialNumbers: string[]): Promise<Map<string, string>>;
  verifyRecordAttachment(appToken: string, tableId: string, recordId: string, fileToken: string): Promise<boolean>;
}

export class BatchFinalizer {
  constructor(
    private readonly db: AppDatabase,
    private readonly createApi: (localUserId: string) => Promise<FeishuRecordApi>,
  ) {}

  async run(projectId: string, batchId: string): Promise<{ completed: number; failed: number }> {
    const project = getProject(this.db, projectId);
    if (!project || !project.appToken || !project.tableId || project.setupStatus !== "ready") {
      throw new Error("项目尚未完成飞书审核表配置");
    }
    const rows = this.db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.projectId, projectId),
          eq(assets.batchId, batchId),
          isNotNull(assets.fileToken),
          ne(assets.status, "completed"),
        ),
      )
      .all();
    if (rows.length === 0) return { completed: 0, failed: 0 };
    const api = await this.createApi(project.localUserId);
    let completed = 0;
    let failed = 0;

    for (const chunk of chunkRecords(rows)) {
      const chunkIds = chunk.map((asset) => asset.id);
      this.db
        .update(assets)
        .set({ status: "recording", errorCode: null, errorMessage: null, updatedAt: sql`datetime('now')` })
        .where(inArray(assets.id, chunkIds))
        .run();
      const toRecordInput = (asset: (typeof chunk)[number]) => ({
        materialNumber: asset.materialNumber,
        fileToken: asset.fileToken!,
        fileName: asset.fileName,
        kind: asset.mimeType.startsWith("image/") ? ("图片" as const) : ("视频" as const),
        batchLabel: `第 ${asset.batchNumber} 批`,
      });

      const recordIds = new Map<string, string>();
      for (const asset of chunk) {
        if (asset.recordId) recordIds.set(asset.materialNumber, asset.recordId);
      }
      const unresolved = chunk.filter((asset) => !asset.recordId);

      if (unresolved.length > 0) {
        let existing: Map<string, string> | undefined;
        try {
          existing = await api.searchRecordIds(
            project.appToken,
            project.tableId,
            unresolved.map((asset) => asset.materialNumber),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "写记录前回查失败";
          for (const asset of unresolved) {
            this.db
              .update(assets)
              .set({ status: "failed", errorCode: "RECORD_RECONCILE_FAILED", errorMessage: message })
              .where(eq(assets.id, asset.id))
              .run();
            failed += 1;
          }
        }
        if (existing) {
          for (const [materialNumber, recordId] of existing) recordIds.set(materialNumber, recordId);

          const missing = unresolved.filter((asset) => !recordIds.has(asset.materialNumber));
          if (missing.length > 0) {
            try {
              const ids = await api.batchCreateRecords(
                project.appToken,
                project.tableId,
                missing.map(toRecordInput),
              );
              missing.forEach((asset, index) => recordIds.set(asset.materialNumber, ids[index]));
            } catch (createError) {
              let reconciledSuccessfully = true;
              try {
                const reconciled = await api.searchRecordIds(
                  project.appToken,
                  project.tableId,
                  missing.map((asset) => asset.materialNumber),
                );
                for (const [materialNumber, recordId] of reconciled) recordIds.set(materialNumber, recordId);
              } catch (reconcileError) {
                reconciledSuccessfully = false;
                const message = reconcileError instanceof Error ? reconcileError.message : "写入结果回查失败";
                for (const asset of missing) {
                  this.db
                    .update(assets)
                    .set({ status: "failed", errorCode: "RECORD_RECONCILE_FAILED", errorMessage: message })
                    .where(eq(assets.id, asset.id))
                    .run();
                  failed += 1;
                }
              }

              if (reconciledSuccessfully) {
                const stillMissing = missing.filter((asset) => !recordIds.has(asset.materialNumber));
                const message = createError instanceof Error ? createError.message : "批量写入失败";
                for (const asset of stillMissing) {
                  this.db
                    .update(assets)
                    .set({ status: "failed", errorCode: "RECORD_CREATE_FAILED", errorMessage: message })
                    .where(eq(assets.id, asset.id))
                    .run();
                  failed += 1;
                }
              }
            }
          }
        }
      }

      for (const asset of chunk) {
        const recordId = recordIds.get(asset.materialNumber);
        if (!recordId) continue;
        let attachmentVerified = false;
        let verificationMessage = "记录已创建，但回读时未找到对应附件 token";
        try {
          attachmentVerified = await api.verifyRecordAttachment(
            project.appToken,
            project.tableId,
            recordId,
            asset.fileToken!,
          );
        } catch (error) {
          verificationMessage = error instanceof Error ? error.message : "附件回读失败";
        }
        if (!attachmentVerified) {
          this.db
            .update(assets)
            .set({
              status: "failed",
              recordId,
              errorCode: "ATTACHMENT_VERIFY_FAILED",
              errorMessage: verificationMessage,
            })
            .where(eq(assets.id, asset.id))
            .run();
          failed += 1;
          continue;
        }
        this.db
          .update(assets)
          .set({ status: "completed", recordId, errorCode: null, errorMessage: null, updatedAt: sql`datetime('now')` })
          .where(eq(assets.id, asset.id))
          .run();
        completed += 1;
      }
    }

    const evidence = JSON.stringify({ batchId, completed, failed });
    upsertVerification(this.db, {
      projectId,
      checkKey: "batch_create_records",
      source: "automatic",
      status: failed === 0 ? "pass" : "fail",
      evidenceJson: evidence,
      checkedAt: new Date().toISOString(),
    });
    upsertVerification(this.db, {
      projectId,
      checkKey: "attachment_field",
      source: "automatic",
      status: failed === 0 ? "pass" : "fail",
      evidenceJson: JSON.stringify({ batchId, completed, failed, verifiedByRecordReadback: true }),
      checkedAt: new Date().toISOString(),
    });
    if (rows.some((asset) => asset.batchNumber >= 2)) {
      upsertVerification(this.db, {
        projectId,
        checkKey: "second_batch_same_link",
        source: "automatic",
        status: failed === 0 ? "pass" : "fail",
        evidenceJson: JSON.stringify({ appToken: project.appToken, tableId: project.tableId, url: project.feishuUrl }),
        checkedAt: new Date().toISOString(),
      });
    }
    return { completed, failed };
  }
}
