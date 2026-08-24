import { retryOperation } from "../core/retry";
import type { ShareMode } from "../db/repository";

interface FeishuJsonClient {
  json<T>(path: string, init?: RequestInit): Promise<T>;
}

interface ToolResponse<T> {
  output?: string | T;
  result?: string | T;
  data?: string | T;
}

export interface SheetAttachmentSegment {
  type: "attachment";
  text: string;
  attachment_name: string;
  attachment_token: string;
  file_size: number;
  mime_type: string;
}

export interface SheetEmbedImageSegment {
  type: "embed-image";
  text: string;
  image_name: string;
  image_token: string;
  image_width: number;
  image_height: number;
}

export interface SheetCell {
  value?: string | number | boolean;
  rich_text?: Array<SheetAttachmentSegment | SheetEmbedImageSegment>;
  cell_styles?: Record<string, string | number>;
  data_validation?: {
    type: "list";
    items: string[];
    highlight_colors: string[];
    support_multiple_values?: boolean;
  };
}

export interface WorkbookSheet {
  sheetId: string;
  title: string;
  rowCount: number;
  columnCount: number;
}

export interface CellRangeRead {
  cells: SheetCell[][];
  currentRegion?: string;
}

export interface ResizeOperation {
  range: string;
  width?: number;
  height?: number;
}

function decodeToolOutput<T>(response: ToolResponse<T>): T {
  const value = response.output ?? response.result ?? response.data ?? response;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export class FeishuSheetsService {
  constructor(private readonly client: FeishuJsonClient) {}

  private invoke<T>(
    spreadsheetToken: string,
    mode: "invoke_read" | "invoke_write",
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<T> {
    return retryOperation(async () => {
      const response = await this.client.json<ToolResponse<T>>(
        `/open-apis/sheet_ai/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/tools/${mode}`,
        {
          method: "POST",
          body: JSON.stringify({
            tool_name: toolName,
            input: JSON.stringify({ excel_id: spreadsheetToken, ...input }),
          }),
        },
      );
      return decodeToolOutput(response);
    });
  }

  async createSpreadsheet(title: string): Promise<{ spreadsheetToken: string; url: string }> {
    const data = await retryOperation(() => this.client.json<{
      spreadsheet?: { spreadsheet_token?: string; token?: string; url?: string };
      spreadsheet_token?: string;
      token?: string;
      url?: string;
    }>("/open-apis/sheets/v3/spreadsheets", {
      method: "POST",
      body: JSON.stringify({ title }),
    }));
    const spreadsheet = data.spreadsheet ?? data;
    const spreadsheetToken = spreadsheet.spreadsheet_token ?? spreadsheet.token;
    if (!spreadsheetToken) throw new Error("飞书创建电子表格成功，但响应缺少 spreadsheet_token");
    return {
      spreadsheetToken,
      url: spreadsheet.url ?? `https://feishu.cn/sheets/${spreadsheetToken}`,
    };
  }

  async getWorkbookInfo(spreadsheetToken: string): Promise<{ sheets: WorkbookSheet[] }> {
    const data = await this.invoke<{
      sheets?: Array<{
        sheet_id?: string;
        id?: string;
        title?: string;
        sheet_name?: string;
        row_count?: number;
        column_count?: number;
      }>;
      workbook?: { sheets?: Array<Record<string, unknown>> };
    }>(spreadsheetToken, "invoke_read", "get_workbook_structure", {});
    const rows = data.sheets ?? data.workbook?.sheets ?? [];
    return {
      sheets: rows.flatMap((row) => {
        const sheetId = typeof row.sheet_id === "string"
          ? row.sheet_id
          : typeof row.id === "string"
            ? row.id
            : undefined;
        const title = typeof row.title === "string"
          ? row.title
          : typeof row.sheet_name === "string"
            ? row.sheet_name
            : undefined;
        if (!sheetId || !title) return [];
        return [{
          sheetId,
          title,
          rowCount: typeof row.row_count === "number" ? row.row_count : 0,
          columnCount: typeof row.column_count === "number" ? row.column_count : 0,
        }];
      }),
    };
  }

  async createSheet(
    spreadsheetToken: string,
    title: string,
    rowCount = 200,
    columnCount = 9,
  ): Promise<WorkbookSheet> {
    await this.invoke(spreadsheetToken, "invoke_write", "modify_workbook_structure", {
      operation: "create",
      sheet_name: title,
      rows: rowCount,
      columns: columnCount,
    });
    const workbook = await this.getWorkbookInfo(spreadsheetToken);
    const sheet = workbook.sheets.find((item) => item.title === title);
    if (!sheet) throw new Error("飞书创建工作表成功，但回读时未找到对应 sheet_id");
    return sheet;
  }

  async renameSheet(spreadsheetToken: string, sheetId: string, title: string): Promise<void> {
    await this.invoke(spreadsheetToken, "invoke_write", "modify_workbook_structure", {
      operation: "rename",
      sheet_id: sheetId,
      new_name: title,
    });
  }

  async insertRows(
    spreadsheetToken: string,
    sheetId: string,
    position: number,
    count: number,
  ): Promise<void> {
    if (!Number.isInteger(position) || position < 1 || !Number.isInteger(count) || count < 1) {
      throw new Error("工作表扩容位置和行数必须为正整数");
    }
    await this.invoke(spreadsheetToken, "invoke_write", "modify_sheet_structure", {
      operation: "insert",
      sheet_id: sheetId,
      position: String(position),
      count,
    });
  }

  async setCellRange(
    spreadsheetToken: string,
    sheetId: string,
    range: string,
    cells: SheetCell[][],
  ): Promise<void> {
    await this.invoke(spreadsheetToken, "invoke_write", "set_cell_range", {
      sheet_id: sheetId,
      range,
      cells,
    });
  }

  async getCellRange(
    spreadsheetToken: string,
    sheetId: string,
    range: string,
  ): Promise<CellRangeRead> {
    const data = await this.invoke<{
      ranges?: Array<{ cells?: SheetCell[][]; current_region?: string }>;
      cells?: SheetCell[][];
      current_region?: string;
    }>(spreadsheetToken, "invoke_read", "get_cell_ranges", {
      sheet_id: sheetId,
      ranges: [range],
      cell_limit: 1_000_000_000,
      max_chars: 500_000,
      include_styles: true,
    });
    const first = data.ranges?.[0] ?? data;
    return {
      cells: first.cells ?? [],
      currentRegion: first.current_region,
    };
  }

  async freezeRows(spreadsheetToken: string, sheetId: string, count: number): Promise<void> {
    await this.invoke(spreadsheetToken, "invoke_write", "modify_sheet_structure", {
      operation: "freeze",
      sheet_id: sheetId,
      freeze_rows: count,
    });
  }

  async hideColumns(spreadsheetToken: string, sheetId: string, range: string): Promise<void> {
    await this.invoke(spreadsheetToken, "invoke_write", "modify_sheet_structure", {
      operation: "hide",
      sheet_id: sheetId,
      range,
    });
  }

  async resizeRanges(
    spreadsheetToken: string,
    sheetId: string,
    operations: ResizeOperation[],
  ): Promise<void> {
    const requests = operations.map((operation) => {
      if ((operation.width === undefined) === (operation.height === undefined)) {
        throw new Error("每个尺寸操作必须且只能设置 width 或 height");
      }
      return {
        tool_name: "resize_range",
        input: {
          excel_id: spreadsheetToken,
          sheet_id: sheetId,
          range: operation.range,
          ...(operation.width === undefined
            ? { resize_height: { type: "pixel", value: operation.height } }
            : { resize_width: { type: "pixel", value: operation.width } }),
        },
      };
    });
    await this.invoke(spreadsheetToken, "invoke_write", "batch_update", { operations: requests });
  }

  getSheetStructure(spreadsheetToken: string, sheetId: string): Promise<Record<string, unknown>> {
    return this.invoke(spreadsheetToken, "invoke_read", "get_sheet_structure", {
      sheet_id: sheetId,
      info_type: "all",
    });
  }

  async setPublicPermission(spreadsheetToken: string, requestedShareMode: ShareMode): Promise<void> {
    await retryOperation(() => this.client.json(
      `/open-apis/drive/v1/permissions/${encodeURIComponent(spreadsheetToken)}/public?type=sheet`,
      {
        method: "PATCH",
        body: JSON.stringify({ external_access: true, link_share_entity: requestedShareMode }),
      },
    ));
  }

  async getPublicPermission(spreadsheetToken: string): Promise<string> {
    const permission = await retryOperation(() => this.client.json<{
      permission_public?: { link_share_entity?: string };
      link_share_entity?: string;
    }>(`/open-apis/drive/v1/permissions/${encodeURIComponent(spreadsheetToken)}/public?type=sheet`));
    return permission.permission_public?.link_share_entity ?? permission.link_share_entity ?? "closed";
  }
}
