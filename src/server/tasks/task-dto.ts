import type { assets, projects, taskSheets } from "../db/schema";

export function toTaskSheetDto(sheet: typeof taskSheets.$inferSelect) {
  return {
    id: sheet.id,
    name: sheet.name,
    sheetId: sheet.sheetId,
    setupStatus: sheet.setupStatus,
    setupError: sheet.setupError,
    nextRow: sheet.nextRow,
  };
}

export function toTaskDto(task: typeof projects.$inferSelect) {
  return {
    id: task.id,
    accountId: task.accountId,
    name: task.name,
    spreadsheetUrl: task.spreadsheetUrl,
    requestedShareMode: task.requestedShareMode,
    effectiveShareMode: task.effectiveShareMode,
    activeTaskSheetId: task.activeTaskSheetId,
    setupStatus: task.setupStatus,
    setupStep: task.setupStep,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    createdAt: task.createdAt,
  };
}

export function toTaskAssetDto(asset: typeof assets.$inferSelect) {
  return {
    id: asset.id,
    batchId: asset.batchId,
    batchNumber: asset.batchNumber,
    materialNumber: asset.materialNumber,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    fileSize: asset.fileSize,
    taskSheetId: asset.taskSheetId,
    status: asset.status,
    errorCode: asset.errorCode,
    errorMessage: asset.errorMessage,
    sheetRowNumber: asset.sheetRowNumber,
    createdAt: asset.createdAt,
  };
}
