import { describe, expect, it } from "vitest";
import type { assets, projects } from "../db/schema";
import { toAssetDto, toDestinationDto } from "./destination-dto";

describe("电子表格 API DTO", () => {
  it("目标响应只暴露公开链接，不包含任何资源 token", () => {
    const project = {
      id: "p1",
      name: "客户素材审核",
      resourceType: "sheet",
      requestedShareMode: "anyone_editable",
      effectiveShareMode: "anyone_editable",
      spreadsheetToken: "sht-secret",
      spreadsheetUrl: "https://example.feishu.cn/sheets/sht1",
      appToken: "base-secret",
      tableId: "table-secret",
      setupStatus: "ready",
      setupStep: "ready",
      errorCode: null,
      errorMessage: null,
    } as typeof projects.$inferSelect;

    const dto = toDestinationDto(project, "0821素材审核");

    expect(dto).toMatchObject({
      id: "p1",
      resourceType: "sheet",
      spreadsheetUrl: "https://example.feishu.cn/sheets/sht1",
      currentSheetName: "0821素材审核",
    });
    expect(dto).not.toHaveProperty("spreadsheetToken");
    expect(dto).not.toHaveProperty("appToken");
    expect(dto).not.toHaveProperty("tableId");
    expect(JSON.stringify(dto)).not.toContain("sht-secret");
  });

  it("素材响应包含业务状态和行号，但不泄漏附件或旧记录 token", () => {
    const asset = {
      id: "asset-1",
      batchId: "batch-1",
      batchNumber: 1,
      materialNumber: "001",
      fileName: "one.mp4",
      mimeType: "video/mp4",
      fileSize: 1024,
      status: "completed",
      errorCode: null,
      errorMessage: null,
      sheetId: "sheet-secret",
      sheetRowNumber: 2,
      fileToken: "file-secret",
      recordId: "record-secret",
    } as typeof assets.$inferSelect;

    const dto = toAssetDto(asset);

    expect(dto).toMatchObject({
      id: "asset-1",
      materialNumber: "001",
      fileName: "one.mp4",
      status: "completed",
      sheetRowNumber: 2,
    });
    expect(dto).not.toHaveProperty("fileToken");
    expect(dto).not.toHaveProperty("recordId");
    expect(dto).not.toHaveProperty("sheetId");
  });
});
