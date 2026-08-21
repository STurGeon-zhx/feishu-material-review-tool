import type { assets, projects } from "../db/schema";

type Project = typeof projects.$inferSelect;
type Asset = typeof assets.$inferSelect;

export function toDestinationDto(project: Project, currentSheetName?: string) {
  return {
    id: project.id,
    name: project.name,
    resourceType: project.resourceType,
    requestedShareMode: project.requestedShareMode,
    effectiveShareMode: project.effectiveShareMode,
    spreadsheetUrl: project.spreadsheetUrl,
    currentSheetName: currentSheetName ?? null,
    setupStatus: project.setupStatus,
    setupStep: project.setupStep,
    errorCode: project.errorCode,
    errorMessage: project.errorMessage,
  };
}

export function toAssetDto(asset: Asset) {
  return {
    id: asset.id,
    batchId: asset.batchId,
    batchNumber: asset.batchNumber,
    materialNumber: asset.materialNumber,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    fileSize: asset.fileSize,
    status: asset.status,
    errorCode: asset.errorCode,
    errorMessage: asset.errorMessage,
    sheetRowNumber: asset.sheetRowNumber,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}
