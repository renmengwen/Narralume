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

const MIGRATION_4 = `
  CREATE TABLE chapter_events (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurrence INTEGER NOT NULL CHECK (occurrence >= 0),
    event_type TEXT NOT NULL CHECK (
      event_type IN ('character', 'location', 'prop', 'causality', 'revelation', 'suspense')
    ),
    payload_json TEXT NOT NULL CHECK (length(payload_json) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (chapter_id, event_index)
  ) STRICT;

  CREATE TABLE chapter_event_sources (
    event_id TEXT NOT NULL REFERENCES chapter_events(id) ON DELETE CASCADE,
    source_index INTEGER NOT NULL CHECK (source_index >= 0),
    source_byte_start INTEGER NOT NULL CHECK (source_byte_start >= 0),
    source_byte_end INTEGER NOT NULL CHECK (source_byte_end > source_byte_start),
    source_hash TEXT NOT NULL CHECK (
      length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (event_id, source_index),
    UNIQUE (event_id, source_byte_start, source_byte_end)
  ) STRICT;

  CREATE INDEX chapter_events_chapter_order
    ON chapter_events(chapter_id, event_index);
`;

const MIGRATION_5 = `
  CREATE TABLE series_projects (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  CREATE INDEX series_projects_book_order
    ON series_projects(book_id, created_at, id);

  CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
    episode_index INTEGER NOT NULL CHECK (episode_index >= 1),
    title TEXT NOT NULL CHECK (length(title) > 0),
    story_arc TEXT NOT NULL CHECK (length(story_arc) > 0),
    target_duration_seconds INTEGER NOT NULL CHECK (target_duration_seconds BETWEEN 180 AND 300),
    recap TEXT,
    next_hook TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    UNIQUE (series_project_id, episode_index)
  ) STRICT;

  CREATE TABLE episode_sources (
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    source_index INTEGER NOT NULL CHECK (source_index >= 0),
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL,
    source_byte_start INTEGER NOT NULL CHECK (source_byte_start >= 0),
    source_byte_end INTEGER NOT NULL CHECK (source_byte_end > source_byte_start),
    source_hash TEXT NOT NULL CHECK (
      length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (episode_id, source_index)
  ) STRICT;
`;

const MIGRATION_6 = `
  CREATE TABLE script_versions (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('faithful', 'packaged')),
    version INTEGER NOT NULL CHECK (version >= 1),
    parent_version_id TEXT REFERENCES script_versions(id),
    content_json TEXT NOT NULL CHECK (length(content_json) > 0),
    content_hash TEXT NOT NULL CHECK (
      length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (episode_id, kind, version)
  ) STRICT;

  CREATE TABLE script_version_sources (
    script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    source_index INTEGER NOT NULL CHECK (source_index >= 0),
    episode_source_index INTEGER NOT NULL CHECK (episode_source_index >= 0),
    chapter_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_byte_start INTEGER NOT NULL CHECK (source_byte_start >= 0),
    source_byte_end INTEGER NOT NULL CHECK (source_byte_end > source_byte_start),
    source_hash TEXT NOT NULL CHECK (
      length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (script_version_id, segment_index, source_index)
  ) STRICT;

  CREATE INDEX script_versions_episode_order
    ON script_versions(episode_id, kind, version);
`;

const MIGRATION_7 = `
  CREATE TABLE script_approval_events (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    action TEXT NOT NULL CHECK (action IN ('approve', 'withdraw')),
    script_version_id TEXT NOT NULL REFERENCES script_versions(id),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (episode_id, revision)
  ) STRICT;

  CREATE INDEX script_approval_events_episode_revision
    ON script_approval_events(episode_id, revision DESC);
`;

const MIGRATION_8 = `
  CREATE TABLE audio_segments (
    timeline_hash TEXT NOT NULL CHECK (
      length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'
    ),
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
    text TEXT NOT NULL CHECK (length(text) > 0),
    provider_id TEXT NOT NULL CHECK (length(provider_id) > 0),
    voice TEXT NOT NULL CHECK (length(voice) > 0),
    rate INTEGER NOT NULL CHECK (rate BETWEEN -10 AND 10),
    input_hash TEXT NOT NULL CHECK (
      length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'
    ),
    relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
    file_hash TEXT NOT NULL CHECK (
      length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*'
    ),
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (timeline_hash, segment_index),
    UNIQUE (timeline_hash, segment_index, episode_id, script_version_id)
  ) STRICT;

  CREATE INDEX audio_segments_episode_script_order
    ON audio_segments(episode_id, script_version_id, timeline_hash, segment_index);

  CREATE TABLE subtitle_cues (
    timeline_hash TEXT NOT NULL CHECK (
      length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'
    ),
    cue_index INTEGER NOT NULL CHECK (cue_index >= 0),
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    text TEXT NOT NULL CHECK (length(text) > 0),
    PRIMARY KEY (timeline_hash, cue_index),
    FOREIGN KEY (timeline_hash, segment_index, episode_id, script_version_id)
      REFERENCES audio_segments(timeline_hash, segment_index, episode_id, script_version_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX subtitle_cues_episode_script_order
    ON subtitle_cues(episode_id, script_version_id, timeline_hash, cue_index);
`;

const MIGRATION_9 = `
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('character', 'scene', 'prop')),
    asset_role TEXT NOT NULL CHECK (asset_role IN ('master', 'state')),
    canonical_name TEXT NOT NULL CHECK (length(canonical_name) > 0),
    normalized_name TEXT NOT NULL CHECK (length(normalized_name) > 0),
    parent_asset_id TEXT,
    state_label TEXT,
    description TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (series_project_id, id),
    UNIQUE (series_project_id, asset_type, id),
    CHECK (
      (asset_role = 'master' AND parent_asset_id IS NULL AND state_label IS NULL)
      OR
      (asset_role = 'state' AND parent_asset_id IS NOT NULL AND length(state_label) > 0)
    ),
    CHECK (parent_asset_id IS NULL OR parent_asset_id <> id),
    FOREIGN KEY (series_project_id, asset_type, parent_asset_id)
      REFERENCES assets(series_project_id, asset_type, id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE INDEX assets_series_type_role
    ON assets(series_project_id, asset_type, asset_role, created_at, id);

  CREATE TRIGGER assets_state_parent_is_master
  BEFORE INSERT ON assets
  WHEN NEW.asset_role = 'state'
  BEGIN
    SELECT RAISE(ABORT, 'state asset parent must be master')
    WHERE NOT EXISTS (
      SELECT 1
      FROM assets AS parent
      WHERE parent.id = NEW.parent_asset_id
        AND parent.series_project_id = NEW.series_project_id
        AND parent.asset_type = NEW.asset_type
        AND parent.asset_role = 'master'
    );
  END;

  CREATE TRIGGER assets_state_parent_is_master_on_update
  BEFORE UPDATE ON assets
  WHEN NEW.asset_role = 'state'
  BEGIN
    SELECT RAISE(ABORT, 'state asset parent must be master')
    WHERE NOT EXISTS (
      SELECT 1
      FROM assets AS parent
      WHERE parent.id = NEW.parent_asset_id
        AND parent.series_project_id = NEW.series_project_id
        AND parent.asset_type = NEW.asset_type
        AND parent.asset_role = 'master'
    );
  END;

  CREATE TRIGGER assets_master_with_states_keeps_identity
  BEFORE UPDATE ON assets
  WHEN OLD.asset_role = 'master'
    AND (
      NEW.asset_role <> 'master'
      OR NEW.id <> OLD.id
      OR NEW.series_project_id <> OLD.series_project_id
      OR NEW.asset_type <> OLD.asset_type
    )
    AND EXISTS (
      SELECT 1
      FROM assets AS child
      WHERE child.parent_asset_id = OLD.id
        AND child.series_project_id = OLD.series_project_id
        AND child.asset_type = OLD.asset_type
        AND child.asset_role = 'state'
    )
  BEGIN
    SELECT RAISE(ABORT, 'master asset with state children cannot change hierarchy');
  END;

  CREATE TABLE asset_aliases (
    series_project_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    alias TEXT NOT NULL CHECK (length(alias) > 0),
    normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) > 0),
    is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (series_project_id, normalized_alias),
    FOREIGN KEY (series_project_id, asset_id)
      REFERENCES assets(series_project_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX asset_aliases_asset_order
    ON asset_aliases(series_project_id, asset_id, is_primary DESC, normalized_alias);

  CREATE UNIQUE INDEX asset_aliases_one_primary_per_asset
    ON asset_aliases(series_project_id, asset_id)
    WHERE is_primary = 1;
`;

const MIGRATIONS = [
  MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8,
  MIGRATION_9,
];

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
      PRAGMA busy_timeout = 5000;
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
