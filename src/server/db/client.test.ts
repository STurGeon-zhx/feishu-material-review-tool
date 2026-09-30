import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite 增量迁移", () => {
  it("为旧项目和素材表补齐电子表格字段且保留旧数据", () => {
    const directory = mkdtempSync(join(tmpdir(), "feishu-sheets-db-"));
    directories.push(directory);
    const filename = join(directory, "legacy.db");
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        create_key TEXT NOT NULL UNIQUE,
        local_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        requested_share_mode TEXT NOT NULL,
        effective_share_mode TEXT,
        app_token TEXT,
        table_id TEXT,
        feishu_url TEXT,
        default_table_id TEXT,
        default_table_deleted INTEGER NOT NULL DEFAULT 0,
        setup_status TEXT NOT NULL DEFAULT 'draft',
        setup_step TEXT NOT NULL DEFAULT 'draft',
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE assets (
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
        status TEXT NOT NULL DEFAULT 'queued',
        error_code TEXT,
        error_message TEXT,
        feishu_request_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO projects (id, create_key, local_user_id, name, requested_share_mode)
      VALUES ('legacy-base', 'legacy-key', 'service_app', '旧 Base', 'anyone_editable');
      INSERT INTO assets (id, project_id, batch_id, batch_number, material_sequence, material_number, file_name, mime_type, file_size)
      VALUES ('legacy-image', 'legacy-base', 'batch-1', 1, 1, '001', 'old.jpg', 'image/jpeg', 1024);
    `);
    legacy.close();

    const handle = createDatabase(filename);
    try {
      const projectColumns = handle.sqlite.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      const assetColumns = handle.sqlite.prepare("PRAGMA table_info(assets)").all() as Array<{ name: string }>;
      const project = handle.sqlite.prepare(
        "SELECT id, resource_type FROM projects WHERE id = 'legacy-base'",
      ).get() as { id: string; resource_type: string };

      expect(projectColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "resource_type", "spreadsheet_token", "spreadsheet_url",
      ]));
      expect(assetColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "sheet_id", "sheet_row_number", "import_mode",
      ]));
      expect(project).toEqual({ id: "legacy-base", resource_type: "base" });
      expect(handle.sqlite.prepare("SELECT import_mode FROM assets WHERE id = 'legacy-image'").get())
        .toEqual({ import_mode: "preview" });
    } finally {
      handle.close();
    }
  });
});
