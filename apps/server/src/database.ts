import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveDataRoot } from "./config.js";

const MIGRATION_1 = `
  CREATE TABLE books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    original_file_path TEXT NOT NULL,
    original_file_hash TEXT NOT NULL UNIQUE,
    encoding TEXT NOT NULL,
    import_status TEXT NOT NULL CHECK (import_status IN ('importing', 'ready', 'failed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;

  CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL CHECK (chapter_index >= 0),
    chapter_number TEXT,
    title TEXT NOT NULL,
    byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
    byte_end INTEGER NOT NULL CHECK (byte_end >= byte_start),
    char_count INTEGER NOT NULL CHECK (char_count >= 0),
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (book_id, chapter_index)
  ) STRICT;

  CREATE INDEX chapters_book_order ON chapters(book_id, chapter_index);
`;

const MIGRATION_2 = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    priority INTEGER NOT NULL DEFAULT 0,
    progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    run_after INTEGER NOT NULL,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    CHECK (
      (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    )
  ) STRICT;

  CREATE INDEX jobs_ready_queue ON jobs(status, run_after, priority DESC, created_at);
  CREATE INDEX jobs_expired_lease ON jobs(status, lease_expires_at);
`;

const MIGRATION_3 = `
  CREATE TABLE job_checkpoints (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (length(stage) > 0),
    scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
    input_hash TEXT NOT NULL CHECK (
      length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'
    ),
    completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
    PRIMARY KEY (job_id, stage, scope_key)
  ) STRICT;
`;

const MIGRATIONS = [MIGRATION_1, MIGRATION_2, MIGRATION_3];

export interface NarralumeDatabase {
  database: DatabaseSync;
  path: string;
  close(): void;
}

export function openDatabase(dataRoot?: string): NarralumeDatabase {
  const root = resolveDataRoot(dataRoot);
  mkdirSync(root, { recursive: true });

  const path = join(root, "narralume.sqlite3");
  const database = new DatabaseSync(path);

  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `);

    const applied = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    if (applied.length > MIGRATIONS.length ||
        applied.some((migration, index) => migration.version !== index + 1)) {
      throw new Error("数据库迁移版本不兼容");
    }

    for (let index = applied.length; index < MIGRATIONS.length; index += 1) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(MIGRATIONS[index]!);
        database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(index + 1);
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // 保留原始迁移错误；外层仍会关闭连接。
        }
        throw error;
      }
    }

    return {
      database,
      path,
      close: () => database.close(),
    };
  } catch (error) {
    try {
      database.close();
    } catch {
      // 抛出导致初始化失败的原始错误。
    }
    throw error;
  }
}
