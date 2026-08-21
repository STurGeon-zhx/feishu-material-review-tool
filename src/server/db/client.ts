import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "./schema";

const DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS feishu_connections (
  local_user_id TEXT PRIMARY KEY,
  feishu_open_id TEXT NOT NULL,
  feishu_name TEXT,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER,
  scopes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  create_key TEXT NOT NULL UNIQUE,
  local_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  resource_type TEXT NOT NULL DEFAULT 'base',
  requested_share_mode TEXT NOT NULL,
  effective_share_mode TEXT,
  app_token TEXT,
  table_id TEXT,
  feishu_url TEXT,
  default_table_id TEXT,
  default_table_deleted INTEGER NOT NULL DEFAULT 0,
  spreadsheet_token TEXT,
  spreadsheet_url TEXT,
  setup_status TEXT NOT NULL DEFAULT 'draft',
  setup_step TEXT NOT NULL DEFAULT 'draft',
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  batch_number INTEGER NOT NULL,
  material_sequence INTEGER NOT NULL,
  material_number TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_token TEXT,
  record_id TEXT,
  sheet_id TEXT,
  sheet_row_number INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  error_code TEXT,
  error_message TEXT,
  feishu_request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, material_number),
  UNIQUE(project_id, batch_id, id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS sheet_tabs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  next_row INTEGER NOT NULL DEFAULT 2,
  setup_status TEXT NOT NULL DEFAULT 'creating',
  setup_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, local_date),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS verification_checks (
  project_id TEXT NOT NULL,
  check_key TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  evidence_json TEXT,
  note TEXT,
  checked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(project_id, check_key),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS destination_locks (
  project_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
`;

function ensureColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

export function createDatabase(filename: string) {
  const sqlite = new Database(filename);
  sqlite.exec(DDL);
  ensureColumn(sqlite, "projects", "resource_type", "resource_type TEXT NOT NULL DEFAULT 'base'");
  ensureColumn(sqlite, "projects", "spreadsheet_token", "spreadsheet_token TEXT");
  ensureColumn(sqlite, "projects", "spreadsheet_url", "spreadsheet_url TEXT");
  ensureColumn(sqlite, "assets", "sheet_id", "sheet_id TEXT");
  ensureColumn(sqlite, "assets", "sheet_row_number", "sheet_row_number INTEGER");
  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => sqlite.close(),
  };
}

export type AppDatabaseHandle = ReturnType<typeof createDatabase>;
export type AppDatabase = AppDatabaseHandle["db"];

let singleton: AppDatabaseHandle | undefined;

export function getDatabase(): AppDatabaseHandle {
  if (singleton) return singleton;
  const configured = process.env.DATABASE_URL?.replace(/^file:/, "") ?? "./data/poc.db";
  const filename = resolve(/* turbopackIgnore: true */ configured);
  mkdirSync(dirname(filename), { recursive: true });
  singleton = createDatabase(filename);
  return singleton;
}
