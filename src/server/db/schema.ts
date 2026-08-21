import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => text(name).notNull().default(sql`(datetime('now'))`);

export type ResourceType = "base" | "sheet";

export const feishuAccounts = sqliteTable(
  "feishu_accounts",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    appId: text("app_id").notNull(),
    appSecretCiphertext: text("app_secret_ciphertext").notNull(),
    validationStatus: text("validation_status", { enum: ["valid", "invalid", "unverified"] })
      .notNull()
      .default("unverified"),
    lastValidatedAt: text("last_validated_at"),
    activeTaskId: text("active_task_id"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [uniqueIndex("feishu_accounts_app_id_unique").on(table.appId)],
);

export const appState = sqliteTable("app_state", {
  id: text().primaryKey(),
  activeAccountId: text("active_account_id"),
  updatedAt: timestamp("updated_at"),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text().primaryKey(),
    createKey: text("create_key").notNull(),
    localUserId: text("local_user_id").notNull(),
    name: text().notNull(),
    resourceType: text("resource_type", { enum: ["base", "sheet"] }).notNull().default("base"),
    requestedShareMode: text("requested_share_mode", { enum: ["anyone_readable", "anyone_editable"] }).notNull(),
    effectiveShareMode: text("effective_share_mode"),
    appToken: text("app_token"),
    tableId: text("table_id"),
    feishuUrl: text("feishu_url"),
    defaultTableId: text("default_table_id"),
    defaultTableDeleted: integer("default_table_deleted", { mode: "boolean" }).notNull().default(false),
    spreadsheetToken: text("spreadsheet_token"),
    spreadsheetUrl: text("spreadsheet_url"),
    accountId: text("account_id"),
    activeTaskSheetId: text("active_task_sheet_id"),
    initialSheetName: text("initial_sheet_name"),
    setupStatus: text("setup_status", { enum: ["draft", "creating", "ready", "partial", "failed"] })
      .notNull()
      .default("draft"),
    setupStep: text("setup_step").notNull().default("draft"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [uniqueIndex("projects_create_key_unique").on(table.createKey)],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text().primaryKey(),
    projectId: text("project_id").notNull(),
    batchId: text("batch_id").notNull(),
    batchNumber: integer("batch_number").notNull(),
    materialSequence: integer("material_sequence").notNull(),
    materialNumber: text("material_number").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    fileToken: text("file_token"),
    recordId: text("record_id"),
    sheetId: text("sheet_id"),
    taskSheetId: text("task_sheet_id"),
    sheetRowNumber: integer("sheet_row_number"),
    status: text({ enum: ["queued", "receiving", "uploading", "uploaded", "recording", "completed", "failed"] })
      .notNull()
      .default("queued"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    feishuRequestId: text("feishu_request_id"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("assets_project_material_unique").on(table.projectId, table.materialNumber),
    uniqueIndex("assets_project_batch_asset_unique").on(table.projectId, table.batchId, table.id),
  ],
);

export const taskSheets = sqliteTable(
  "task_sheets",
  {
    id: text().primaryKey(),
    taskId: text("task_id").notNull(),
    createKey: text("create_key").notNull(),
    sheetId: text("sheet_id"),
    name: text().notNull(),
    normalizedName: text("normalized_name").notNull(),
    nextRow: integer("next_row").notNull().default(2),
    setupStatus: text("setup_status", { enum: ["creating", "ready", "failed"] }).notNull().default("creating"),
    setupError: text("setup_error"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("task_sheets_task_create_key_unique").on(table.taskId, table.createKey),
    uniqueIndex("task_sheets_task_name_unique").on(table.taskId, table.normalizedName),
  ],
);

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

export const verificationChecks = sqliteTable(
  "verification_checks",
  {
    projectId: text("project_id").notNull(),
    checkKey: text("check_key").notNull(),
    source: text({ enum: ["automatic", "manual"] }).notNull(),
    status: text({ enum: ["pending", "pass", "fail"] }).notNull().default("pending"),
    evidenceJson: text("evidence_json"),
    note: text(),
    checkedAt: text("checked_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.checkKey] })],
);

export const destinationLocks = sqliteTable("destination_locks", {
  projectId: text("project_id").primaryKey(),
  kind: text().notNull(),
  createdAt: timestamp("created_at"),
});

export const schema = {
  feishuAccounts,
  appState,
  projects,
  assets,
  sheetTabs,
  taskSheets,
  verificationChecks,
  destinationLocks,
};
