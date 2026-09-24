import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { chunkRecords } from "../core/batching";
import { KeyedMutex } from "../core/keyed-mutex";
import { SingleFlight } from "../core/single-flight";
import type { AppDatabase } from "../db/client";
import {
  getProject,
  getTaskSheet,
  listRecoverableBatchIds,
  setAssetSheetLocation,
  updateAsset,
  updateSheetTab,
  updateTaskSheet,
  upsertVerification,
} from "../db/repository";
import { assets } from "../db/schema";
import type { CellRangeRead, ResizeOperation, SheetCell, WorkbookSheet } from "../feishu/sheets-service";

export interface SheetWriteApi {
  getWorkbookInfo(spreadsheetToken: string): Promise<{ sheets: WorkbookSheet[] }>;
  insertRows(
    spreadsheetToken: string,
    sheetId: string,
    position: number,
    count: number,
  ): Promise<void>;
  getCellRange(
    spreadsheetToken: string,
    sheetId: string,
    range: string,
  ): Promise<CellRangeRead>;
  setCellRange(
    spreadsheetToken: string,
    sheetId: string,
    range: string,
    cells: SheetCell[][],
  ): Promise<void>;
  resizeRanges(
    spreadsheetToken: string,
    sheetId: string,
    operations: ResizeOperation[],
  ): Promise<void>;
}

interface TaskSheetTarget {
  id: string;
  sheetId: string;
  nextRow: number;
  setupStatus: string;
}

interface LegacyDailySheetProvider {
  ensure(projectId: string, spreadsheetToken: string, date: Date): Promise<TaskSheetTarget>;
}

interface RemoteAssetRow {
  rowNumber: number;
}

const WRITE_CHUNK_SIZE = 50;
const ROW_GROWTH_SIZE = 200;

function parseSqliteDate(value: string): Date {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

function cellText(cell: SheetCell | undefined): string | undefined {
  const value = cell?.value;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function mediaToken(cell: SheetCell | undefined): string | undefined {
  const segment = cell?.rich_text?.find((item) => item.type === "attachment" || item.type === "embed-image");
  if (segment?.type === "attachment") return segment.attachment_token;
  return segment?.image_token;
}

function assetCells(asset: typeof assets.$inferSelect): SheetCell[] {
  const fileToken = asset.fileToken!;
  const mediaCell: SheetCell = asset.mimeType.startsWith("image/")
    ? {
      rich_text: [{
        type: "embed-image",
        text: asset.fileName,
        image_name: asset.fileName,
        image_token: fileToken,
        image_width: 144,
        image_height: 96,
      }],
    }
    : {
      rich_text: [{
        type: "attachment",
        text: asset.fileName,
        attachment_name: asset.fileName,
        attachment_token: fileToken,
        file_size: asset.fileSize,
        mime_type: asset.mimeType,
      }],
    };
  return [
    mediaCell,
    {
      value: "待审核",
      data_validation: {
        type: "list",
        items: ["待审核", "审核通过", "需修改"],
        highlight_colors: ["#E5E7EB", "#BFF7D9", "#FFB3B3"],
        support_multiple_values: false,
      },
    },
    { value: "" },
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "电子表格写入失败";
}

function writeErrorCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error && String(error.code) === "602134071"
    ? "FILE_RELATION_MISSING"
    : "SHEET_WRITE_FAILED";
}

export class SheetBatchFinalizer {
  private readonly flight = new SingleFlight<{ completed: number; failed: number }>();
  private readonly sheetMutex = new KeyedMutex();

  constructor(
    private readonly db: AppDatabase,
    private readonly createApi: (accountId: string) => Promise<SheetWriteApi>,
    private readonly legacyDailySheet?: LegacyDailySheetProvider,
  ) {}

  run(projectId: string, batchId: string): Promise<{ completed: number; failed: number }> {
    return this.flight.run(`${projectId}:${batchId}`, () => this.runOnce(projectId, batchId));
  }

  async resumeProject(projectId: string) {
    const results: Array<{ batchId: string; completed: number; failed: number }> = [];
    for (const batchId of listRecoverableBatchIds(this.db, projectId)) {
      try {
        results.push({ batchId, ...await this.run(projectId, batchId) });
      } catch {
        results.push({ batchId, completed: 0, failed: 1 });
      }
    }
    return results;
  }

  private async runOnce(projectId: string, batchId: string) {
    const project = getProject(this.db, projectId);
    const importable = project?.setupStatus === "ready"
      || (project?.setupStatus === "partial" && project.setupStep === "share_permission_failed");
    if (
      !project
      || project.resourceType !== "sheet"
      || (!project.accountId && !this.legacyDailySheet)
      || !project.spreadsheetToken
      || !importable
    ) {
      throw new Error("电子表格尚未完成配置");
    }

    const pendingAssets = this.db.select().from(assets).where(and(
      eq(assets.projectId, projectId),
      eq(assets.batchId, batchId),
      isNotNull(assets.fileToken),
      ne(assets.status, "completed"),
    )).all();
    if (pendingAssets.length === 0) return { completed: 0, failed: 0 };
    const taskSheetIds = new Set(pendingAssets.map((asset) => asset.taskSheetId).filter((id): id is string => Boolean(id)));
    let target: TaskSheetTarget | undefined;
    if (taskSheetIds.size === 1) {
      const stored = getTaskSheet(this.db, [...taskSheetIds][0]);
      if (stored?.sheetId) target = { ...stored, sheetId: stored.sheetId };
    } else if (this.legacyDailySheet) {
      target = await this.legacyDailySheet.ensure(
        projectId,
        project.spreadsheetToken,
        parseSqliteDate(pendingAssets[0].createdAt),
      );
    }
    if (!target || target.setupStatus !== "ready" || !target.sheetId) {
      throw new Error("目标工作表尚未完成配置");
    }
    const api = await this.createApi(project.accountId ?? "legacy");
    return this.sheetMutex.run(`${projectId}:${target.sheetId}`, () => this.appendBatch(
      project,
      { ...target, sheetId: target.sheetId },
      pendingAssets,
      batchId,
      api,
    ));
  }

  private async appendBatch(
    project: NonNullable<ReturnType<typeof getProject>>,
    taskSheet: TaskSheetTarget,
    pendingAssets: Array<typeof assets.$inferSelect>,
    batchId: string,
    api: SheetWriteApi,
  ): Promise<{ completed: number; failed: number }> {
    const token = project.spreadsheetToken!;
    const sheetId = taskSheet.sheetId;
    const scanEnd = Math.max(2, taskSheet.nextRow + pendingAssets.length + ROW_GROWTH_SIZE - 1);
    const initialRead = await api.getCellRange(token, sheetId, `A2:A${scanEnd}`);
    let remoteIndex = this.remoteIndex(initialRead);
    let completed = 0;
    let failed = 0;
    const missing: Array<typeof assets.$inferSelect> = [];

    for (const asset of pendingAssets) {
      const remote = remoteIndex.get(asset.fileToken!);
      if (!remote) {
        missing.push(asset);
        continue;
      }
      if (await this.verifyRemoteAsset(api, token, sheetId, remote.rowNumber, asset.fileToken!)) {
        this.completeAsset(asset.id, sheetId, remote.rowNumber);
        completed += 1;
      } else {
        this.failAsset(asset.id, "ATTACHMENT_VERIFY_FAILED", "素材已存在，但附件 token 回读不一致");
        failed += 1;
      }
    }

    if (missing.length > 0) {
      const maxRemoteRow = Math.max(1, ...[...remoteIndex.values()].map((row) => row.rowNumber));
      const startRow = Math.max(
        2,
        taskSheet.nextRow,
        maxRemoteRow + 1,
      );
      const assignments = missing.map((asset, index) => ({ asset, rowNumber: startRow + index }));
      const endRow = assignments.at(-1)!.rowNumber;
      await this.ensureCapacity(api, token, sheetId, endRow);

      this.db.update(assets).set({
        status: "recording",
        errorCode: null,
        errorMessage: null,
        updatedAt: sql`datetime('now')`,
      }).where(inArray(assets.id, missing.map((asset) => asset.id))).run();

      for (const chunk of chunkRecords(assignments, WRITE_CHUNK_SIZE)) {
        const firstRow = chunk[0].rowNumber;
        const lastRow = chunk.at(-1)!.rowNumber;
        let writeError: unknown;
        try {
          const imageRows = chunk
            .filter(({ asset }) => asset.mimeType.startsWith("image/"))
            .map(({ rowNumber }) => ({ range: `${rowNumber}:${rowNumber}`, height: 104 }));
          if (imageRows.length > 0) await api.resizeRanges(token, sheetId, imageRows);
          await api.setCellRange(
            token,
            sheetId,
            `A${firstRow}:C${lastRow}`,
            chunk.map(({ asset }) => assetCells(asset)),
          );
        } catch (error) {
          writeError = error;
        }

        const readback = await api.getCellRange(token, sheetId, `A${firstRow}:C${lastRow}`);
        for (const assignment of chunk) {
          const offset = assignment.rowNumber - firstRow;
          const row = readback.cells[offset];
          if (this.rowMatches(row, assignment.asset)) {
            this.completeAsset(assignment.asset.id, sheetId, assignment.rowNumber);
            remoteIndex.set(assignment.asset.fileToken!, { rowNumber: assignment.rowNumber });
            completed += 1;
          } else {
            this.failAsset(
              assignment.asset.id,
              writeErrorCode(writeError),
              writeError ? errorMessage(writeError) : "电子表格写入后回读不一致",
            );
            failed += 1;
          }
        }
      }
    }

    const actualLastRow = Math.max(taskSheet.nextRow - 1, 1, ...[...remoteIndex.values()].map((row) => row.rowNumber));
    if (getTaskSheet(this.db, taskSheet.id)) {
      updateTaskSheet(this.db, taskSheet.id, { nextRow: actualLastRow + 1 });
    } else {
      updateSheetTab(this.db, taskSheet.id, { nextRow: actualLastRow + 1 });
    }

    this.saveVerification(project, batchId, completed, failed, remoteIndex.size);
    return { completed, failed };
  }

  private remoteIndex(read: CellRangeRead): Map<string, RemoteAssetRow> {
    const index = new Map<string, RemoteAssetRow>();
    read.cells.forEach((row, offset) => {
      const fileToken = mediaToken(row[0]);
      if (fileToken) index.set(fileToken, { rowNumber: offset + 2 });
    });
    return index;
  }

  private async verifyRemoteAsset(
    api: SheetWriteApi,
    token: string,
    sheetId: string,
    rowNumber: number,
    expectedFileToken: string,
  ): Promise<boolean> {
    const readback = await api.getCellRange(token, sheetId, `A${rowNumber}:C${rowNumber}`);
    const row = readback.cells[0];
    return mediaToken(row?.[0]) === expectedFileToken;
  }

  private rowMatches(row: SheetCell[] | undefined, asset: typeof assets.$inferSelect): boolean {
    return mediaToken(row?.[0]) === asset.fileToken
      && cellText(row?.[1]) === "待审核";
  }

  private async ensureCapacity(
    api: SheetWriteApi,
    token: string,
    sheetId: string,
    requiredEndRow: number,
  ): Promise<void> {
    const workbook = await api.getWorkbookInfo(token);
    const sheet = workbook.sheets.find((item) => item.sheetId === sheetId);
    if (!sheet) throw new Error("无法回读目标工作表容量");
    if (requiredEndRow <= sheet.rowCount) return;
    const count = Math.ceil((requiredEndRow - sheet.rowCount) / ROW_GROWTH_SIZE) * ROW_GROWTH_SIZE;
    await api.insertRows(token, sheetId, sheet.rowCount + 1, count);
    const confirmed = await api.getWorkbookInfo(token);
    const confirmedSheet = confirmed.sheets.find((item) => item.sheetId === sheetId);
    if (!confirmedSheet || confirmedSheet.rowCount < requiredEndRow) {
      throw new Error("工作表扩容回读未生效");
    }
  }

  private completeAsset(assetId: string, sheetId: string, rowNumber: number): void {
    setAssetSheetLocation(this.db, assetId, sheetId, rowNumber);
    updateAsset(this.db, assetId, {
      status: "completed",
      recordId: null,
      errorCode: null,
      errorMessage: null,
    });
  }

  private failAsset(assetId: string, code: string, message: string): void {
    updateAsset(this.db, assetId, {
      status: "failed",
      errorCode: code,
      errorMessage: message,
    });
  }

  private saveVerification(
    project: NonNullable<ReturnType<typeof getProject>>,
    batchId: string,
    completed: number,
    failed: number,
    indexedRows: number,
  ): void {
    const checkedAt = new Date().toISOString();
    for (const [checkKey, evidence] of [
      ["sheet_batch_write", { projectId: project.id, batchId, completed, failed }],
      ["sheet_attachment_readback", { projectId: project.id, batchId, completed, failed, indexedRows }],
    ] as const) {
      upsertVerification(this.db, {
        projectId: project.id,
        checkKey,
        source: "automatic",
        status: failed === 0 ? "pass" : "fail",
        evidenceJson: JSON.stringify(evidence),
        checkedAt,
      });
    }
    if (this.db.select().from(assets).where(and(
      eq(assets.projectId, project.id),
      eq(assets.batchId, batchId),
    )).all().some((asset) => asset.batchNumber >= 2)) {
      upsertVerification(this.db, {
        projectId: project.id,
        checkKey: "second_batch_same_link",
        source: "automatic",
        status: failed === 0 ? "pass" : "fail",
        evidenceJson: JSON.stringify({ projectId: project.id, url: project.spreadsheetUrl }),
        checkedAt,
      });
    }
  }
}
