# 飞书电子表格素材审核导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有飞书 Base 素材审核 POC 的新导入链路完整切换为应用身份驱动的飞书电子表格，并保留旧 Base 作为只读历史归档。

**Architecture:** 保留 `TenantTokenProvider`、本地流式接收、文件校验和现有 HTTP 路由形状；新增独立 Sheets OpenAPI 适配器、Drive 附件上传器、每日工作表管理器和 Sheets 批次完成器。SQLite 只做增量迁移，电子表格使用独立 token、sheet 和行定位字段，UUID 作为远端幂等主键。

**Tech Stack:** Node.js 24、npm、Next.js 16、React 19、TypeScript 5.9、SQLite、Drizzle ORM、Vitest、Testing Library、CSS Modules、飞书 Sheets/Sheet AI/Drive OpenAPI。

**Spec:** `docs/superpowers/specs/2026-08-21-feishu-sheets-import-design.md`

## Global Constraints

- 直接在当前 `main` 分支实施，不创建 worktree；不得丢弃工作区已有修改。
- 运行时直接调用飞书 OpenAPI，不引入或调用 `lark-cli`。
- 只使用 `tenant_access_token`；不增加用户 OAuth、机器人、登录或账号系统。
- 现有 Base、Base token、表 ID 和历史数据不迁移、不删除、不覆盖。
- 日期边界固定为 `Asia/Shanghai`；同日追加，跨日创建新工作表。
- 只接受 JPEG、PNG、MP4，单文件最大 2GB，沿用 20MB 普通/分片上传边界。
- App Secret、访问令牌和文件内容不得进入前端响应或日志。
- 所有远端写操作必须回读；仅收到写接口成功响应不能点亮验证项。
- 每次提交只暂存任务列出的文件；若文件包含既有无关修改，必须按 hunks 暂存并保留无关修改在工作区。

## File Map

**Create:**

- `src/server/db/client.test.ts`：旧数据库增量迁移测试。
- `src/server/feishu/sheets-service.ts`：Sheets v3 与 Sheet AI v2 OpenAPI 适配器。
- `src/server/feishu/sheets-service.test.ts`：请求结构、响应解析和回读测试。
- `src/server/feishu/drive-attachment-uploader.ts`：Drive 根目录普通/分片附件上传。
- `src/server/feishu/drive-attachment-uploader.test.ts`：上传目标和分片测试。
- `src/server/sheets/daily-sheet-manager.ts`：日期命名、建 tab、排版和布局回读。
- `src/server/sheets/daily-sheet-manager.test.ts`：同日复用、跨日创建、跨年冲突和配置恢复测试。
- `src/server/projects/spreadsheet-setup.ts`：工作簿创建、权限配置和安全切换准备。
- `src/server/projects/spreadsheet-setup.test.ts`：创建恢复、策略受限和资源复用测试。
- `src/server/core/keyed-mutex.ts`：按工作表串行化不同行批次写入。
- `src/server/core/keyed-mutex.test.ts`：同 key 串行、不同 key 并行测试。
- `src/server/uploads/finalize-sheet-batch.ts`：UUID 幂等、追加行、附件回读和恢复。
- `src/server/uploads/finalize-sheet-batch.test.ts`：部分成功、不确定响应、排序后重定位和恢复测试。
- `src/server/projects/destination-dto.ts`：剥离 token 的前端 DTO。
- `src/server/projects/destination-dto.test.ts`：敏感字段不出现在响应中的测试。

**Modify:**

- `src/server/db/schema.ts`、`src/server/db/client.ts`、`src/server/db/repository.ts`、`src/server/db/repository.test.ts`
- `src/server/core/batching.ts`、`src/server/core/batching.test.ts`
- `src/server/projects/destination-manager.ts`、`src/server/projects/destination-manager.test.ts`
- `src/server/app-context.ts`
- `src/app/api/destination/route.ts`、`ensure/route.ts`、`rebuild/route.ts`、`retry/route.ts`
- `src/app/api/projects/[id]/route.ts`
- `src/app/api/projects/[id]/batches/route.ts`
- `src/app/api/projects/[id]/assets/[assetId]/content/route.ts`
- `src/app/api/projects/[id]/batches/[batchId]/finalize/route.ts`
- `src/server/verification/summary.ts`、`src/server/verification/summary.test.ts`
- `src/components/ReviewDemo.tsx`、`src/components/ReviewDemo.test.tsx`
- `.env.example`、`README.md`

**Preserve as legacy:**

- `src/server/feishu/service.ts`
- `src/server/feishu/uploader.ts`
- `src/server/projects/project-setup.ts`
- `src/server/uploads/finalize-batch.ts`

---

### Task 1: 增量数据库模型与电子表格仓储

**Files:**
- Create: `src/server/db/client.test.ts`
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/client.ts`
- Modify: `src/server/db/repository.ts`
- Test: `src/server/db/repository.test.ts`

**Interfaces:**
- Produces: `ResourceType = "base" | "sheet"`
- Produces: `getSheetTabByDate(db, projectId, localDate)`
- Produces: `upsertSheetTab(db, value)`
- Produces: `updateSheetTab(db, id, values)`
- Produces: `setAssetSheetLocation(db, assetId, sheetId, rowNumber)`
- Changes: `createOrGetProject(..., resourceType?: ResourceType)`，新建目标显式传 `sheet`

- [ ] **Step 1: 写旧库兼容和活动目标失败测试**

在 `client.test.ts` 创建旧版 `projects/assets` 表后调用 `createDatabase(filename)`，断言新增列存在且旧项目为 `base`。在 `repository.test.ts` 加入：

```ts
it("只把成功的 sheet 项目选为活动目标", () => {
  const { db } = database();
  createOrGetProject(db, {
    id: "legacy-base", createKey: "base", localUserId: "service_app",
    name: "旧 Base", requestedShareMode: "anyone_editable", resourceType: "base",
  });
  updateProject(db, "legacy-base", { setupStatus: "ready", appToken: "app", tableId: "tbl" });
  expect(getActiveProject(db)).toBeUndefined();

  createOrGetProject(db, {
    id: "sheet-1", createKey: "sheet", localUserId: "service_app",
    name: "新电子表格", requestedShareMode: "anyone_editable", resourceType: "sheet",
  });
  updateProject(db, "sheet-1", {
    setupStatus: "ready", spreadsheetToken: "sht1", spreadsheetUrl: "https://example.feishu.cn/sheets/sht1",
  });
  expect(getActiveProject(db)?.id).toBe("sheet-1");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/server/db/client.test.ts src/server/db/repository.test.ts`

Expected: FAIL，提示 `resourceType`、`spreadsheetToken` 或 `sheetTabs` 尚不存在。

- [ ] **Step 3: 实现非破坏性增量迁移**

在 `schema.ts` 增加：

```ts
export type ResourceType = "base" | "sheet";

resourceType: text("resource_type", { enum: ["base", "sheet"] }).notNull().default("base"),
spreadsheetToken: text("spreadsheet_token"),
spreadsheetUrl: text("spreadsheet_url"),

export const sheetTabs = sqliteTable(
  "sheet_tabs",
  {
    id: text().primaryKey(),
    projectId: text("project_id").notNull(),
    localDate: text("local_date").notNull(),
    sheetId: text("sheet_id").notNull(),
    sheetName: text("sheet_name").notNull(),
    nextRow: integer("next_row").notNull().default(2),
    setupStatus: text("setup_status", { enum: ["creating", "ready", "failed"] }).notNull().default("creating"),
    setupError: text("setup_error"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [uniqueIndex("sheet_tabs_project_date_unique").on(table.projectId, table.localDate)],
);
```

给 `assets` 增加 `sheetId` 和 `sheetRowNumber`。在 `client.ts` 的新库 DDL 中加入这些列和 `sheet_tabs`，并在 `CREATE TABLE IF NOT EXISTS` 后用 `PRAGMA table_info` 精确补齐旧库缺失列：

```ts
function ensureColumn(sqlite: Database.Database, table: string, column: string, ddl: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn(sqlite, "projects", "resource_type", "resource_type TEXT NOT NULL DEFAULT 'base'");
ensureColumn(sqlite, "projects", "spreadsheet_token", "spreadsheet_token TEXT");
ensureColumn(sqlite, "projects", "spreadsheet_url", "spreadsheet_url TEXT");
ensureColumn(sqlite, "assets", "sheet_id", "sheet_id TEXT");
ensureColumn(sqlite, "assets", "sheet_row_number", "sheet_row_number INTEGER");
```

仓储查询必须同时过滤 `local_user_id='service_app'`、`resource_type='sheet'` 和允许状态。实现 `sheet_tabs` 的 get/upsert/update，并让 `setAssetSheetLocation` 只修改 `sheet_id/sheet_row_number`，不写 `record_id`。

- [ ] **Step 4: 运行数据库测试**

Run: `npm test -- src/server/db/client.test.ts src/server/db/repository.test.ts`

Expected: PASS，旧库数据保留，旧 Base 不再成为活动导入目标。

- [ ] **Step 5: 提交**

```bash
git add src/server/db/schema.ts src/server/db/client.ts src/server/db/client.test.ts src/server/db/repository.ts src/server/db/repository.test.ts
git commit -m "feat: add spreadsheet persistence model"
```

---

### Task 2: Sheets OpenAPI 适配器

**Files:**
- Create: `src/server/feishu/sheets-service.ts`
- Test: `src/server/feishu/sheets-service.test.ts`

**Interfaces:**
- Consumes: `FeishuHttpClient.json<T>(path, init?)`
- Produces: `SheetCell`, `WorkbookSheet`, `CellRangeRead`
- Produces: `FeishuSheetsService.createSpreadsheet(title)`
- Produces: `getWorkbookInfo`、`createSheet`、`renameSheet`、`insertRows`、`setCellRange`、`getCellRange`
- Produces: `freezeRows`、`hideColumns`、`resizeRanges`、`getSheetStructure`
- Produces: `setPublicPermission`、`getPublicPermission`

- [ ] **Step 1: 写请求契约测试**

使用只记录 `path/init` 的 fake client，断言：

```ts
await service.createSpreadsheet("客户素材审核");
expect(calls[0]).toMatchObject({
  path: "/open-apis/sheets/v3/spreadsheets",
  method: "POST",
  body: JSON.stringify({ title: "客户素材审核" }),
});

await service.setCellRange("sht1", "sheet1", "A2:A2", [[{
  rich_text: [{
    type: "attachment", text: "demo.mp4", attachment_name: "demo.mp4",
    attachment_token: "file1", file_size: 123, mime_type: "video/mp4",
  }],
}]]);
expect(JSON.parse(calls[1].body)).toMatchObject({ tool_name: "set_cell_range" });
expect(JSON.parse(JSON.parse(calls[1].body).input)).toMatchObject({
  excel_id: "sht1", sheet_id: "sheet1", range: "A2:A2",
});
```

另加测试验证 `get_workbook_structure` 和 `get_cell_ranges` 的 `output` JSON 字符串被规范化为类型化结果，并断言 `insertRows("sht1", "sheet1", 201, 200)` 使用 `modify_sheet_structure`，输入为 `{ operation: "insert", position: "201", count: 200 }`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/server/feishu/sheets-service.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现类型和通用 Sheet AI 调用器**

定义最小公开契约：

```ts
export interface SheetCell {
  value?: string | number | boolean;
  rich_text?: Array<{
    type: "attachment";
    text: string;
    attachment_name: string;
    attachment_token: string;
    file_size: number;
    mime_type: string;
  }>;
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
```

所有 Sheet AI 调用固定为：

```ts
private invoke<T>(token: string, mode: "invoke_read" | "invoke_write", toolName: string, input: object) {
  return this.client.json<{ output?: string | T; result?: string | T }>(
    `/open-apis/sheet_ai/v2/spreadsheets/${encodeURIComponent(token)}/tools/${mode}`,
    {
      method: "POST",
      body: JSON.stringify({
        tool_name: toolName,
        input: JSON.stringify({ excel_id: token, ...input }),
      }),
    },
  ).then(decodeToolOutput<T>);
}
```

实现以下 tool_name：`get_workbook_structure`、`modify_workbook_structure`、`set_cell_range`、`get_cell_ranges`、`modify_sheet_structure`、`resize_range`、`batch_update`、`get_sheet_structure`。公开权限继续使用 Drive 权限接口，但查询参数改成 `type=sheet`。

- [ ] **Step 4: 运行适配器测试**

Run: `npm test -- src/server/feishu/sheets-service.test.ts src/server/feishu/http-client.test.ts`

Expected: PASS，请求使用 `sheets/v3` 或 `sheet_ai/v2`，权限请求使用 `type=sheet`。

- [ ] **Step 5: 提交**

```bash
git add src/server/feishu/sheets-service.ts src/server/feishu/sheets-service.test.ts
git commit -m "feat: add Feishu Sheets OpenAPI adapter"
```

---

### Task 3: Drive 附件上传器

**Files:**
- Create: `src/server/feishu/drive-attachment-uploader.ts`
- Test: `src/server/feishu/drive-attachment-uploader.test.ts`
- Modify: `src/server/core/batching.ts`
- Test: `src/server/core/batching.test.ts`

**Interfaces:**
- Produces: `DriveAttachmentUploader.upload(filePath, originalName): Promise<string>`
- Changes: `chunkRecords<T>(records, chunkSize = 200): T[][]`

- [ ] **Step 1: 写上传目标和分块失败测试**

复制现有 uploader 测试的临时文件模式，但断言普通上传 FormData 为：

```ts
expect(form.get("parent_type")).toBe("explorer");
expect(form.get("parent_node")).toBe("");
expect(form.get("file_name")).toBe("demo.mp4");
```

分片 prepare JSON 同样必须包含 `parent_type: "explorer"`、`parent_node: ""`，且 finish 前恰好上传 `block_num` 个 part。给 `chunkRecords` 增加 `chunkSize=50` 的断言。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/server/feishu/drive-attachment-uploader.test.ts src/server/core/batching.test.ts`

Expected: FAIL，新上传器不存在，`chunkRecords` 不接受第二个参数。

- [ ] **Step 3: 实现上传器和可配置分块**

保留旧 `FeishuUploader` 不动。新上传器复用原普通/分片端点，但完全移除 `appToken` 参数：

```ts
async upload(filePath: string, originalName: string): Promise<string> {
  const fileSize = (await stat(filePath)).size;
  return chooseUploadMode(fileSize) === "simple"
    ? this.simpleUpload(filePath, originalName, fileSize)
    : this.multipartUpload(filePath, originalName, fileSize);
}

const parent = { parent_type: "explorer", parent_node: "" } as const;
```

普通上传使用 `/open-apis/drive/v1/medias/upload_all`；分片依次使用 `upload_prepare`、`upload_part`、`upload_finish`。每个端点沿用 `retryOperation`，读取分片后及时释放文件句柄。

把 `chunkRecords` 改为验证 `chunkSize > 0` 后按传入大小切分，默认值保持 200，避免影响历史 Base 测试。

- [ ] **Step 4: 运行测试**

Run: `npm test -- src/server/feishu/drive-attachment-uploader.test.ts src/server/feishu/uploader.test.ts src/server/core/batching.test.ts`

Expected: PASS，Base 上传器仍使用 `bitable_file`，新上传器只使用 `explorer`。

- [ ] **Step 5: 提交**

```bash
git add src/server/feishu/drive-attachment-uploader.ts src/server/feishu/drive-attachment-uploader.test.ts src/server/core/batching.ts src/server/core/batching.test.ts
git commit -m "feat: upload spreadsheet attachments to Drive"
```

---

### Task 4: 每日工作表创建与排版

**Files:**
- Create: `src/server/sheets/daily-sheet-manager.ts`
- Test: `src/server/sheets/daily-sheet-manager.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `sheet_tabs` 仓储
- Consumes: Task 2 的 `FeishuSheetsService`
- Produces: `formatLocalDate(date): string`
- Produces: `DailySheetManager.ensure(projectId, spreadsheetToken, date, reusableSheetId?)`

- [ ] **Step 1: 写日期与幂等测试**

覆盖四个行为：

```ts
expect(formatLocalDate(new Date("2026-08-20T16:30:00Z"))).toBe("2026-08-21");
await expect(manager.ensure("p1", "sht1", date)).resolves.toMatchObject({ sheetName: "0821素材审核" });
await manager.ensure("p1", "sht1", date);
expect(api.createSheet).toHaveBeenCalledTimes(1);
await manager.ensure("p1", "sht1", new Date("2026-08-22T02:00:00+08:00"));
expect(api.createSheet).toHaveBeenCalledTimes(2);
```

另测：工作簿已经存在同名旧年份工作表时使用 `20270821素材审核`；配置中途失败时 `sheet_tabs.setup_status='failed'`，重试复用远端 `sheet_id` 而不重复创建。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/server/sheets/daily-sheet-manager.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现创建、布局和真实回读**

工作表表头固定为：

```ts
export const REVIEW_HEADERS = [
  "素材", "审核", "客户意见", "素材编号", "批次", "素材UUID", "类型", "文件Token", "上传时间",
] as const;
```

创建/复用后依次执行：

1. `setCellRange(token, sheetId, "A1:I1", headerCells)`，表头加粗、浅蓝底、居中、垂直居中。
2. `resizeRanges`：A=400px、B=120px、C=320px、D:I=100px；第 1 行 32px。
3. `freezeRows(token, sheetId, 1)`。
4. `hideColumns(token, sheetId, "D:I")`。
5. 回读 `A1:I1` 和工作表结构，确认表头、冻结和隐藏列真实生效。

首次新建工作簿时允许把唯一默认 sheet 重命名为当天名称；正常跨日只允许创建新 sheet，不重命名或删除历史 sheet。只有全部回读通过才将 tab 标为 `ready`。

- [ ] **Step 4: 运行测试**

Run: `npm test -- src/server/sheets/daily-sheet-manager.test.ts src/server/feishu/sheets-service.test.ts`

Expected: PASS，同日不会创建第二张工作表，失败重试不会丢失远端 ID。

- [ ] **Step 5: 提交**

```bash
git add src/server/sheets/daily-sheet-manager.ts src/server/sheets/daily-sheet-manager.test.ts
git commit -m "feat: manage daily review sheets"
```

---

### Task 5: 电子表格目标创建与安全切换

**Files:**
- Create: `src/server/projects/spreadsheet-setup.ts`
- Test: `src/server/projects/spreadsheet-setup.test.ts`
- Modify: `src/server/projects/destination-manager.ts`
- Test: `src/server/projects/destination-manager.test.ts`

**Interfaces:**
- Consumes: `DailySheetManager.ensure`
- Produces: `SpreadsheetResourceApi`
- Produces: `SpreadsheetSetup.run(projectId)`
- Changes: `DestinationManager` 创建项目时传 `resourceType: "sheet"`

- [ ] **Step 1: 写首次创建、恢复和策略测试**

测试必须断言：创建失败后保留 `spreadsheet_token`；重试不再次创建工作簿；公开权限拒绝后返回 `partial`；重建失败时旧 sheet 项目仍为活动目标；旧 Base 永不被切回活动目标。

核心断言：

```ts
expect(getProject(db, "p1")).toMatchObject({
  resourceType: "sheet",
  spreadsheetToken: "sht1",
  spreadsheetUrl: "https://example.feishu.cn/sheets/sht1",
  setupStatus: "partial",
  setupStep: "share_permission_failed",
});
expect(createSpreadsheetCalls).toBe(1);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/server/projects/spreadsheet-setup.test.ts src/server/projects/destination-manager.test.ts`

Expected: FAIL，仍在创建 Base 或没有 spreadsheet 字段。

- [ ] **Step 3: 实现可恢复设置状态机**

定义接口：

```ts
export interface SpreadsheetResourceApi {
  createSpreadsheet(name: string): Promise<{ spreadsheetToken: string; url: string }>;
  getWorkbookInfo(token: string): Promise<{ sheets: WorkbookSheet[] }>;
  setPublicPermission(token: string, mode: ShareMode): Promise<void>;
  getPublicPermission(token: string): Promise<string>;
}
```

`SpreadsheetSetup` 的步骤固定为：`draft -> spreadsheet_created -> daily_sheet_ready -> ready`。保存 token 后立即持久化；每日工作表完成后记录 `create_spreadsheet`、`configure_review_sheet`、`share_link` 自动证据；权限不匹配或错误码 `1063003` 时保存实际权限并进入 `partial/share_permission_failed`。其他错误保存当前步骤的 `_failed` 后缀并抛出。

修改 `DestinationManager.ensure/rebuild`，所有新项目显式传 `resourceType: "sheet"`。重建只在新项目为 `ready` 或允许的 `partial` 后，由 `getActiveProject` 的最新更新时间规则自然切换；创建失败项目不能覆盖旧活动目标。

- [ ] **Step 4: 运行目标管理测试**

Run: `npm test -- src/server/projects/spreadsheet-setup.test.ts src/server/projects/destination-manager.test.ts src/server/db/repository.test.ts`

Expected: PASS，Base 项目保留但不参与活动目标选择。

- [ ] **Step 5: 提交**

```bash
git add src/server/projects/spreadsheet-setup.ts src/server/projects/spreadsheet-setup.test.ts src/server/projects/destination-manager.ts src/server/projects/destination-manager.test.ts
git commit -m "feat: create fixed spreadsheet destination"
```

---

### Task 6: Sheets 批次写入、UUID 幂等和并发控制

**Files:**
- Create: `src/server/core/keyed-mutex.ts`
- Test: `src/server/core/keyed-mutex.test.ts`
- Create: `src/server/uploads/finalize-sheet-batch.ts`
- Test: `src/server/uploads/finalize-sheet-batch.test.ts`

**Interfaces:**
- Consumes: `DailySheetManager.ensure`
- Consumes: `FeishuSheetsService.getWorkbookInfo/insertRows/getCellRange/setCellRange`
- Consumes: `chunkRecords(rows, 50)`
- Produces: `KeyedMutex.run(key, operation)`
- Produces: `SheetBatchFinalizer.run(projectId, batchId)`
- Produces: `SheetBatchFinalizer.resumeProject(projectId)`

- [ ] **Step 1: 写并发、幂等和部分成功测试**

覆盖：同一 sheet 的不同 batch 串行；不同 sheet 可并行；UUID 已存在时不写；写接口抛错但回读发现 UUID 时标记完成；只回读到部分 UUID 时保留成功项；客户排序后按 UUID 更新最新行号；已有 `file_token` 的重启批次直接完成；写入终点超过当前 `rowCount` 时先按 200 行为单位扩容且不越界写入。

附件行的期望对象：

```ts
expect(write.cells[0]).toEqual([
  { rich_text: [{
    type: "attachment", text: "one.mp4", attachment_name: "one.mp4",
    attachment_token: "file-1", file_size: 1024, mime_type: "video/mp4",
  }] },
  { value: "待审核", data_validation: {
    type: "list", items: ["待审核", "审核通过", "需修改"],
    highlight_colors: ["#E5E7EB", "#BFF7D9", "#FFB3B3"], support_multiple_values: false,
  } },
  { value: "" }, { value: "001" }, { value: "第 1 批" },
  { value: "asset-uuid" }, { value: "视频" }, { value: "file-1" },
  { value: "2026-08-21T12:00:00.000+08:00" },
]);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/server/core/keyed-mutex.test.ts src/server/uploads/finalize-sheet-batch.test.ts`

Expected: FAIL，新模块不存在。

- [ ] **Step 3: 实现稳定行定位和写入算法**

`KeyedMutex` 为每个 key 维护尾 promise，并在 finally 删除已完成尾节点。`SheetBatchFinalizer`：

1. 校验项目是活动 `sheet`，且状态可导入。
2. 从批次第一条资产 `createdAt` 计算北京时间日期，确保对应 tab。
3. 在 `projectId:sheetId` 锁内读取 `F2:H50000`，构造 `uuid -> { rowNumber, fileToken }`。
4. 对已存在 UUID 的行读取对应 A 单元格，确认附件 token 后直接完成。
5. 以远端 `currentRegion` 末行、最大 UUID 行、`sheet_tabs.next_row` 三者最大值加一作为起始行，最小为 2。
6. 从 `getWorkbookInfo` 取得当前 `rowCount`；如果本批终点超过容量，调用 `insertRows` 在末行之后按 200 行整数倍扩容，并回读确认新容量。
7. 每 50 行调用一次 `setCellRange` 写 A:I。
8. 每块写后回读该块 A:I；附件 token、UUID 和默认审核状态全部相符才标记完成。
9. 写入异常时重新读取 UUID 列并逐项 reconcile；仅缺失项进入 `SHEET_WRITE_FAILED`。
10. 保存 `sheet_id/sheet_row_number`，保持 `record_id=null`。

自动证据使用 `sheet_batch_write`、`sheet_attachment_readback` 和 `second_batch_same_link`；证据包含 spreadsheet token 的哈希或项目 ID，不把原始 token 返回前端。

- [ ] **Step 4: 运行批次测试**

Run: `npm test -- src/server/core/keyed-mutex.test.ts src/server/uploads/finalize-sheet-batch.test.ts src/server/uploads/finalize-batch.test.ts`

Expected: PASS，新旧 finalizer 测试互不影响。

- [ ] **Step 5: 提交**

```bash
git add src/server/core/keyed-mutex.ts src/server/core/keyed-mutex.test.ts src/server/uploads/finalize-sheet-batch.ts src/server/uploads/finalize-sheet-batch.test.ts
git commit -m "feat: append review assets to daily sheets"
```

---

### Task 7: 应用装配、上传路由和安全 DTO

**Files:**
- Create: `src/server/projects/destination-dto.ts`
- Test: `src/server/projects/destination-dto.test.ts`
- Modify: `src/server/app-context.ts`
- Modify: `src/app/api/destination/route.ts`
- Modify: `src/app/api/destination/ensure/route.ts`
- Modify: `src/app/api/destination/rebuild/route.ts`
- Modify: `src/app/api/destination/retry/route.ts`
- Modify: `src/app/api/projects/[id]/route.ts`
- Modify: `src/app/api/projects/[id]/batches/route.ts`
- Modify: `src/app/api/projects/[id]/assets/[assetId]/content/route.ts`
- Modify: `src/app/api/projects/[id]/batches/[batchId]/finalize/route.ts`

**Interfaces:**
- Consumes: Tasks 2 至 6 的服务
- Produces: `toDestinationDto(project, currentSheetName?)`
- Produces: `toAssetDto(asset)`
- Changes: `getAppContext().sheetFinalizer`

- [ ] **Step 1: 写 DTO 泄漏与路由装配测试**

```ts
const dto = toDestinationDto(project, "0821素材审核");
expect(dto).toMatchObject({
  id: "p1", resourceType: "sheet", spreadsheetUrl: "https://example.feishu.cn/sheets/sht1",
  currentSheetName: "0821素材审核",
});
expect(dto).not.toHaveProperty("spreadsheetToken");
expect(dto).not.toHaveProperty("appToken");
```

为 `toAssetDto` 断言不包含 `fileToken`、`recordId`，但包含 `sheetRowNumber` 和业务展示字段。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/server/projects/destination-dto.test.ts`

Expected: FAIL，DTO 模块不存在。

- [ ] **Step 3: 装配新服务并切换路由**

`app-context.ts` 创建同一个 token provider，每次 API 调用用其 token 构造 `FeishuHttpClient` 和 `FeishuSheetsService`。装配 `DailySheetManager`、`SpreadsheetSetup`、`DestinationManager` 和 `SheetBatchFinalizer`。

内容上传路由改为：

```ts
if (!project.spreadsheetToken || project.resourceType !== "sheet" || !importable) {
  return fail(new Error("电子表格尚未完成配置"), "PROJECT_NOT_READY", 409);
}
const fileToken = await new DriveAttachmentUploader(new FeishuHttpClient(accessToken))
  .upload(received.filePath, asset.fileName);
```

finalize 路由调用 `sheetFinalizer.run`。目标表和项目详情路由统一经过 DTO，不再返回数据库原始行。批次路由继续使用项目 ID，但必须拒绝非活动 `sheet` 目标。

- [ ] **Step 4: 运行服务和路由相关测试**

Run: `npm test -- src/server/projects/destination-dto.test.ts src/server/config.test.ts src/server/db/repository.test.ts src/server/uploads/finalize-sheet-batch.test.ts`

Expected: PASS，序列化响应没有认证 token 或附件 token。

- [ ] **Step 5: 提交**

```bash
git add src/server/projects/destination-dto.ts src/server/projects/destination-dto.test.ts src/server/app-context.ts src/app/api/destination src/app/api/projects
git commit -m "feat: wire spreadsheet import API"
```

---

### Task 8: 页面文案、验证项与交互契约

**Files:**
- Modify: `src/components/ReviewDemo.tsx`
- Test: `src/components/ReviewDemo.test.tsx`
- Modify: `src/server/verification/summary.ts`
- Test: `src/server/verification/summary.test.ts`

**Interfaces:**
- Consumes: `DestinationDto` 中的 `spreadsheetUrl/currentSheetName/resourceType`
- Produces: 新验证 key 集合

- [ ] **Step 1: 写页面和验证状态失败测试**

页面测试使用 sheet DTO，并断言：

```ts
expect(await screen.findByText("固定审核电子表格")).toBeInTheDocument();
expect(screen.getByText("当前工作表：0821素材审核")).toBeInTheDocument();
expect(screen.queryByText(/Base|多维表格/)).not.toBeInTheDocument();
expect(screen.getByText("创建电子表格")).toBeInTheDocument();
expect(screen.getByText("写入附件单元格")).toBeInTheDocument();
```

验证 summary 覆盖公开权限失败为 `partial`、附件回读失败为 `fail`、全部新 key 通过为 `pass`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/components/ReviewDemo.test.tsx src/server/verification/summary.test.ts`

Expected: FAIL，页面仍含 Base 文案和旧验证 key。

- [ ] **Step 3: 切换页面 DTO 与验证 key**

验证项固定为：

```ts
export const REQUIRED_CHECK_KEYS = [
  "create_spreadsheet", "configure_review_sheet", "share_permission",
  "upload_jpg", "upload_png", "upload_video_small", "upload_video_50mb", "upload_video_200mb",
  "sheet_attachment_readback", "sheet_batch_write", "share_link",
  "anonymous_view", "anonymous_edit", "second_batch_same_link",
] as const;
```

页面将固定目标区域改名为“固定审核电子表格”，展示当前日期工作表；打开和复制按钮使用 `spreadsheetUrl`。保留上传、进度、失败重试、重建确认和人工匿名验收，不增加导航或账号入口。

- [ ] **Step 4: 运行页面测试**

Run: `npm test -- src/components/ReviewDemo.test.tsx src/server/verification/summary.test.ts`

Expected: PASS，页面不再出现 Base/多维表格业务文案。

- [ ] **Step 5: 提交**

```bash
git add src/components/ReviewDemo.tsx src/components/ReviewDemo.test.tsx src/server/verification/summary.ts src/server/verification/summary.test.ts
git commit -m "feat: present spreadsheet review workflow"
```

---

### Task 9: 配置文档、全量回归与真实验收入口

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Documents: 飞书后台能力、环境变量、运行命令和验收步骤

- [ ] **Step 1: 更新管理员配置清单**

README 明确要求企业自建应用开启以下应用身份能力：

- 创建、读取、编辑和管理飞书电子表格。
- 使用 Sheet AI 工具读取和写入工作簿、工作表结构及单元格。
- 上传文件到飞书云空间。
- 读取和修改电子表格公开权限。

明确不启用机器人、网页应用和 OAuth 回调。环境变量只保留：

```dotenv
FEISHU_APP_ID=
FEISHU_APP_SECRET=
DATABASE_URL=file:./data/poc.db
```

README 同时记录旧 Base 不迁移、同日/跨日 tab 规则、公开编辑风险和 `PARTIAL` 含义。

- [ ] **Step 2: 运行全量自动验证**

Run: `npm test`

Expected: 所有 Vitest 测试 PASS。

Run: `npm run typecheck`

Expected: 退出码 0，无 TypeScript 错误。

Run: `npm run build`

Expected: Next.js production build 成功，所有 API 路由编译通过。

- [ ] **Step 3: 检查无 OAuth、Base 新写入和敏感信息泄漏**

Run: `rg -n "feishu/connect|feishu/callback|user_access_token" src README.md`

Expected: 无运行时 OAuth 路由或用户 token 引用。

Run: `rg -n "createBase|batchCreateRecords|bitable_file" src/server/app-context.ts src/app/api`

Expected: 新应用装配和 API 路由中没有 Base 创建、Base 记录写入或 `bitable_file`。

Run: `rg -n "appSecret|accessToken|fileToken" src/components src/app/api`

Expected: 前端组件和 API DTO 不序列化这些字段；服务端内部局部变量可以存在。

- [ ] **Step 4: 进行真实两批验收**

启动：`npm run dev`，打开 `http://localhost:3000`。依次导入 JPG、PNG、约 10MB MP4、约 50MB MP4 和约 200MB MP4，并验证：

1. 第一批创建电子表格和当天工作表。
2. A 列附件可点击预览，B 列下拉可编辑，C 列可填写。
3. 第二批写入相同 spreadsheet token 和同日工作表，公开链接不变。
4. 通过注入次日时间的集成测试确认跨日新建 tab；不修改本机系统时间。
5. 无痕窗口完成匿名查看和编辑；企业策略阻止匿名编辑时登记 `PARTIAL`。
6. 数据库中的历史 Base token、table ID 和 14 条旧记录保持不变。

- [ ] **Step 5: 提交文档并记录验收结果**

```bash
git add .env.example README.md
git commit -m "docs: document spreadsheet import setup"
```

- [ ] **Step 6: 最终状态检查**

Run: `git status --short`

Expected: 只剩实施前已存在且未纳入本功能的修改；本计划列出的新文件均已提交。

Run: `git log --oneline -10`

Expected: 能看到 Task 1 至 Task 9 的小步提交，且没有包含密钥文件。
