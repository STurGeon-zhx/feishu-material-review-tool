import { describe, expect, it } from "vitest";
import { FeishuSheetsService, type SheetCell } from "./sheets-service";

interface RecordedCall {
  path: string;
  init?: RequestInit;
}

class FakeClient {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly responses: unknown[]) {}

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    this.calls.push({ path, init });
    if (this.responses.length === 0) return {} as T;
    return this.responses.shift() as T;
  }
}

function requestBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function toolInput(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(requestBody(call).input)) as Record<string, unknown>;
}

describe("飞书电子表格 OpenAPI 适配器", () => {
  it("创建电子表格并解析稳定 token 和链接", async () => {
    const client = new FakeClient([{
      spreadsheet: {
        spreadsheet_token: "sht1",
        url: "https://example.feishu.cn/sheets/sht1",
      },
    }]);
    const service = new FeishuSheetsService(client);

    await expect(service.createSpreadsheet("客户素材审核")).resolves.toEqual({
      spreadsheetToken: "sht1",
      url: "https://example.feishu.cn/sheets/sht1",
    });
    expect(client.calls[0]).toMatchObject({
      path: "/open-apis/sheets/v3/spreadsheets",
      init: { method: "POST", body: JSON.stringify({ title: "客户素材审核" }) },
    });
  });

  it("解析工作簿结构并通过稳定 sheet_id 创建和重命名工作表", async () => {
    const workbook = JSON.stringify({
      sheets: [{ sheet_id: "sheet1", title: "0821素材审核", row_count: 200, column_count: 9 }],
    });
    const client = new FakeClient([
      { output: workbook },
      { output: JSON.stringify({ ok: true }) },
      { output: workbook },
      { output: JSON.stringify({ ok: true }) },
    ]);
    const service = new FeishuSheetsService(client);

    await expect(service.getWorkbookInfo("sht1")).resolves.toEqual({
      sheets: [{ sheetId: "sheet1", title: "0821素材审核", rowCount: 200, columnCount: 9 }],
    });
    await expect(service.createSheet("sht1", "0821素材审核", 200, 9)).resolves.toMatchObject({
      sheetId: "sheet1",
    });
    await service.renameSheet("sht1", "sheet1", "0821素材审核");

    expect(requestBody(client.calls[0]).tool_name).toBe("get_workbook_structure");
    expect(toolInput(client.calls[1])).toMatchObject({
      excel_id: "sht1",
      operation: "create",
      sheet_name: "0821素材审核",
      rows: 200,
      columns: 9,
    });
    expect(toolInput(client.calls[3])).toMatchObject({
      excel_id: "sht1",
      operation: "rename",
      sheet_id: "sheet1",
      new_name: "0821素材审核",
    });
  });

  it("写入并回读附件富文本单元格", async () => {
    const cells: SheetCell[][] = [[{
      rich_text: [{
        type: "attachment",
        text: "demo.mp4",
        attachment_name: "demo.mp4",
        attachment_token: "file1",
        file_size: 123,
        mime_type: "video/mp4",
      }],
    }]];
    const client = new FakeClient([
      { output: JSON.stringify({ updated_range: "A2:A2" }) },
      { output: JSON.stringify({ ranges: [{ cells, current_region: "A1:A2" }] }) },
    ]);
    const service = new FeishuSheetsService(client);

    await service.setCellRange("sht1", "sheet1", "A2:A2", cells);
    await expect(service.getCellRange("sht1", "sheet1", "A2:A2")).resolves.toEqual({
      cells,
      currentRegion: "A1:A2",
    });

    expect(client.calls[0].path).toBe(
      "/open-apis/sheet_ai/v2/spreadsheets/sht1/tools/invoke_write",
    );
    expect(requestBody(client.calls[0]).tool_name).toBe("set_cell_range");
    expect(toolInput(client.calls[0])).toMatchObject({
      excel_id: "sht1",
      sheet_id: "sheet1",
      range: "A2:A2",
      cells,
    });
    expect(requestBody(client.calls[1]).tool_name).toBe("get_cell_ranges");
  });

  it("扩容、冻结、隐藏、调整尺寸并回读工作表结构", async () => {
    const client = new FakeClient([
      { output: JSON.stringify({ ok: true }) },
      { output: JSON.stringify({ ok: true }) },
      { output: JSON.stringify({ ok: true }) },
      { output: JSON.stringify({ ok: true }) },
      { output: JSON.stringify({ frozen_rows: 1, hidden_cols: ["D:I"] }) },
    ]);
    const service = new FeishuSheetsService(client);

    await service.insertRows("sht1", "sheet1", 201, 200);
    await service.freezeRows("sht1", "sheet1", 1);
    await service.hideColumns("sht1", "sheet1", "D:I");
    await service.resizeRanges("sht1", "sheet1", [
      { range: "A:A", width: 400 },
      { range: "1:1", height: 32 },
    ]);
    await expect(service.getSheetStructure("sht1", "sheet1")).resolves.toMatchObject({
      frozen_rows: 1,
    });

    expect(toolInput(client.calls[0])).toMatchObject({ operation: "insert", position: "201", count: 200 });
    expect(toolInput(client.calls[1])).toMatchObject({ operation: "freeze", freeze_rows: 1 });
    expect(toolInput(client.calls[2])).toMatchObject({ operation: "hide", range: "D:I" });
    expect(requestBody(client.calls[3]).tool_name).toBe("batch_update");
    expect(requestBody(client.calls[4]).tool_name).toBe("get_sheet_structure");
  });

  it("公开权限接口固定使用 sheet 文档类型", async () => {
    const client = new FakeClient([
      {},
      { permission_public: { link_share_entity: "anyone_editable" } },
    ]);
    const service = new FeishuSheetsService(client);

    await service.setPublicPermission("sht1", "anyone_editable");
    await expect(service.getPublicPermission("sht1")).resolves.toBe("anyone_editable");

    expect(client.calls.map((call) => call.path)).toEqual([
      "/open-apis/drive/v1/permissions/sht1/public?type=sheet",
      "/open-apis/drive/v1/permissions/sht1/public?type=sheet",
    ]);
  });
});
