import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "./database.js";

test("数据库迁移可重复执行并在重启后保留书库数据", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-"));

  try {
    const first = openDatabase(dataRoot);
    first.database
      .prepare(
        `INSERT INTO books (
          id, title, original_file_path, original_file_hash, encoding, import_status
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("book_sha256", "测试书", "books/book_sha256/source.txt", "sha256", "UTF-8", "ready");
    first.database
      .prepare(
        `INSERT INTO chapters (
          id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("chapter_1", "book_sha256", 0, "第一章", 0, 12, 6, "chapter_hash");
    assert.throws(
      () =>
        first.database
          .prepare(
            `INSERT INTO chapters (
              id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("chapter_duplicate", "book_sha256", 0, "重复章", 12, 20, 4, "duplicate_hash"),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () =>
        first.database
          .prepare(
            `INSERT INTO chapters (
              id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("chapter_invalid_range", "book_sha256", 1, "无效范围", 20, 12, 4, "bad_hash"),
      /CHECK constraint failed/,
    );
    first.database.prepare(
      `INSERT INTO chapter_events (
         id, chapter_id, event_index, occurrence, event_type, payload_json, created_at
       ) VALUES ('event_1', 'chapter_1', 0, 0, 'character', '{"name":"人物"}', 1)`,
    ).run();
    first.database.prepare(
      `INSERT INTO chapter_event_sources (
         event_id, source_index, source_byte_start, source_byte_end, source_hash
       ) VALUES ('event_1', 0, 0, 3, ?)`,
    ).run("a".repeat(64));
    assert.throws(
      () => first.database.prepare(
        `INSERT INTO chapter_events (
           id, chapter_id, event_index, occurrence, event_type, payload_json, created_at
         ) VALUES ('event_bad', 'chapter_1', 1, 0, 'unknown', '{}', 1)`,
      ).run(),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => first.database.prepare(
        `INSERT INTO chapter_event_sources (
           event_id, source_index, source_byte_start, source_byte_end, source_hash
         ) VALUES ('event_1', 1, 3, 4, 'ABC')`,
      ).run(),
      /CHECK constraint failed/,
    );
    first.close();

    const reopened = openDatabase(dataRoot);
    const book = reopened.database.prepare("SELECT id, title FROM books").get();
    const migration = reopened.database
      .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
      .get();
    reopened.database.prepare("DELETE FROM books WHERE id = ?").run("book_sha256");
    const chapterCount = reopened.database.prepare("SELECT COUNT(*) AS count FROM chapters").get();
    const eventCount = reopened.database.prepare("SELECT COUNT(*) AS count FROM chapter_events").get();
    const sourceCount = reopened.database.prepare("SELECT COUNT(*) AS count FROM chapter_event_sources").get();
    reopened.close();

    assert.equal(book?.id, "book_sha256");
    assert.equal(book?.title, "测试书");
    assert.equal(migration?.version, 10);
    assert.equal(chapterCount?.count, 0);
    assert.equal(eventCount?.count, 0);
    assert.equal(sourceCount?.count, 0);
    assert.equal((await readFile(join(dataRoot, "narralume.sqlite3"))).length > 0, true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("初始化失败会关闭 SQLite 文件", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-invalid-"));
  const databasePath = join(dataRoot, "narralume.sqlite3");

  try {
    const malformed = new DatabaseSync(databasePath);
    malformed.exec("CREATE TABLE schema_migrations (bad_column INTEGER) STRICT");
    malformed.close();

    assert.throws(() => openDatabase(dataRoot), /no such column: version/);
    await rm(databasePath);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("未来迁移版本或版本断层会失败关闭", async () => {
  for (const mode of ["future", "gap"] as const) {
    const dataRoot = await mkdtemp(join(tmpdir(), `narralume-database-${mode}-`));
    const databasePath = join(dataRoot, "narralume.sqlite3");
    try {
      openDatabase(dataRoot).close();
      const malformed = new DatabaseSync(databasePath);
      if (mode === "future") malformed.prepare("INSERT INTO schema_migrations (version) VALUES (11)").run();
      else malformed.prepare("DELETE FROM schema_migrations WHERE version = 1").run();
      malformed.close();

      assert.throws(() => openDatabase(dataRoot), /数据库迁移版本不兼容/);
      await rm(databasePath);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
});

test("既有 migration v2 数据库可原地升级 checkpoint、章节事件与分集表", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v2-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    current.database.exec("DROP TABLE asset_candidate_review_events; DROP TABLE asset_candidates; DROP TABLE asset_aliases; DROP TABLE assets");
    current.database.exec("DROP TABLE subtitle_cues; DROP TABLE audio_segments");
    current.database.exec("DROP TABLE script_approval_events");
    current.database.exec("DROP TABLE script_version_sources");
    current.database.exec("DROP TABLE script_versions");
    current.database.exec("DROP TABLE episode_sources");
    current.database.exec("DROP TABLE episodes");
    current.database.exec("DROP TABLE series_projects");
    current.database.exec("DROP TABLE chapter_event_sources");
    current.database.exec("DROP TABLE chapter_events");
    current.database.exec("DROP TABLE job_checkpoints");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 3").run();
    current.close();

    const upgraded = openDatabase(dataRoot);
    const migration = upgraded.database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    const checkpointTable = upgraded.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_checkpoints'")
      .get();
    const eventTable = upgraded.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chapter_events'")
      .get();
    assert.equal(migration?.version, 10);
    assert.equal(checkpointTable?.name, "job_checkpoints");
    assert.equal(eventTable?.name, "chapter_events");
    upgraded.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v5 数据库可升级批准事件且删除分集会完整级联", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v5-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    current.database.exec("DROP TABLE asset_candidate_review_events; DROP TABLE asset_candidates; DROP TABLE asset_aliases; DROP TABLE assets");
    current.database.exec("DROP TABLE subtitle_cues; DROP TABLE audio_segments");
    current.database.exec("DROP TABLE script_approval_events; DROP TABLE script_version_sources; DROP TABLE script_versions");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 6").run();
    current.database.prepare(
      `INSERT INTO books (
         id, title, original_file_path, original_file_hash, encoding, import_status
       ) VALUES ('book_v5', '旧书', 'books/book_v5/source.txt', ?, 'UTF-8', 'ready')`,
    ).run("c".repeat(64));
    current.database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('series_v5', 'book_v5', '系列', 1, 1)`,
    ).run();
    current.database.prepare(
      `INSERT INTO episodes (
         id, series_project_id, episode_index, title, story_arc,
         target_duration_seconds, created_at, updated_at
       ) VALUES ('episode_v5', 'series_v5', 1, '第一集', '开端', 180, 1, 1)`,
    ).run();
    current.close();

    const upgraded = openDatabase(dataRoot);
    assert.equal(
      upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
      10,
    );
    upgraded.database.prepare(
      `INSERT INTO script_versions (
         id, episode_id, kind, version, content_json, content_hash, created_at
       ) VALUES ('script_v5', 'episode_v5', 'faithful', 1, '{}', ?, 1)`,
    ).run("d".repeat(64));
    upgraded.database.prepare(
      `INSERT INTO script_version_sources (
         script_version_id, segment_index, source_index, episode_source_index,
         chapter_id, source_event_id, source_byte_start, source_byte_end, source_hash
       ) VALUES ('script_v5', 0, 0, 0, 'chapter', 'event', 0, 1, ?)`,
    ).run("e".repeat(64));
    upgraded.database.prepare(
      `INSERT INTO script_approval_events (
         id, episode_id, revision, action, script_version_id, created_at
       ) VALUES ('approval_v5', 'episode_v5', 1, 'approve', 'script_v5', 1)`,
    ).run();
    upgraded.database.prepare("DELETE FROM episodes WHERE id = 'episode_v5'").run();
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM script_versions").get()?.count, 0);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM script_version_sources").get()?.count, 0);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM script_approval_events").get()?.count, 0);
    upgraded.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v7 数据库可升级音频段与字幕并约束不可变历史", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v7-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    current.database.exec("DROP TABLE asset_candidate_review_events; DROP TABLE asset_candidates; DROP TABLE asset_aliases; DROP TABLE assets");
    current.database.exec("DROP TABLE subtitle_cues; DROP TABLE audio_segments");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 8").run();
    current.database.prepare(
      `INSERT INTO books (
         id, title, original_file_path, original_file_hash, encoding, import_status
       ) VALUES ('book_v7', '旧书', 'books/book_v7/source.txt', ?, 'UTF-8', 'ready')`,
    ).run("1".repeat(64));
    current.database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('series_v7', 'book_v7', '系列', 1, 1)`,
    ).run();
    current.database.prepare(
      `INSERT INTO episodes (
         id, series_project_id, episode_index, title, story_arc,
         target_duration_seconds, created_at, updated_at
       ) VALUES ('episode_v7', 'series_v7', 1, '第一集', '开端', 180, 1, 1)`,
    ).run();
    current.database.prepare(
      `INSERT INTO script_versions (
         id, episode_id, kind, version, content_json, content_hash, created_at
       ) VALUES ('script_v7', 'episode_v7', 'packaged', 1, '{}', ?, 1)`,
    ).run("2".repeat(64));
    current.close();

    const upgraded = openDatabase(dataRoot);
    assert.equal(
      upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
      10,
    );
    const audioTables = upgraded.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'audio_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    assert.deepEqual(audioTables.map((table) => table.name), ["audio_segments"]);

    const insertSegment = upgraded.database.prepare(
      `INSERT INTO audio_segments (
         timeline_hash, segment_index, episode_id, script_version_id, text,
         provider_id, voice, rate, input_hash, relative_path, file_hash,
         bytes, duration_ms, created_at
       ) VALUES (?, ?, 'episode_v7', 'script_v7', ?, 'system-speech', 'Huihui', ?, ?, ?, ?, ?, ?, 1)`,
    );
    const runSegment = (overrides: {
      timelineHash?: string;
      segmentIndex?: number;
      text?: string;
      rate?: number;
      inputHash?: string;
      relativePath?: string;
      fileHash?: string;
      bytes?: number;
      durationMs?: number;
    } = {}) => insertSegment.run(
      overrides.timelineHash ?? "3".repeat(64),
      overrides.segmentIndex ?? 0,
      overrides.text ?? "第一段旁白",
      overrides.rate ?? 0,
      overrides.inputHash ?? "4".repeat(64),
      overrides.relativePath ?? "episodes/episode_v7/audio/segment.wav",
      overrides.fileHash ?? "5".repeat(64),
      overrides.bytes ?? 1024,
      overrides.durationMs ?? 1200,
    );

    runSegment();
    for (const invalid of [
      { timelineHash: "ABC" },
      { segmentIndex: 1, text: "" },
      { segmentIndex: 1, rate: 11 },
      { segmentIndex: 1, bytes: 0 },
      { segmentIndex: 1, durationMs: 0 },
    ]) {
      assert.throws(() => runSegment(invalid), /CHECK constraint failed/);
    }

    upgraded.database.prepare(
      `INSERT INTO subtitle_cues (
         timeline_hash, cue_index, segment_index, episode_id, script_version_id,
         start_ms, end_ms, text
       ) VALUES (?, 0, 0, 'episode_v7', 'script_v7', 0, 1200, '第一段旁白')`,
    ).run("3".repeat(64));
    assert.throws(
      () => upgraded.database.prepare(
        `INSERT INTO subtitle_cues (
           timeline_hash, cue_index, segment_index, episode_id, script_version_id,
           start_ms, end_ms, text
         ) VALUES (?, 1, 99, 'episode_v7', 'script_v7', 1200, 1300, '不存在的段')`,
      ).run("3".repeat(64)),
      /FOREIGN KEY constraint failed/,
    );

    upgraded.database.prepare("DELETE FROM episodes WHERE id = 'episode_v7'").run();
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM audio_segments").get()?.count, 0);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM subtitle_cues").get()?.count, 0);
    upgraded.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v4 数据库可升级 v5 且删除书籍会级联分集数据", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v4-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    current.database.exec("DROP TABLE asset_candidate_review_events; DROP TABLE asset_candidates; DROP TABLE asset_aliases; DROP TABLE assets");
    current.database.exec("DROP TABLE subtitle_cues; DROP TABLE audio_segments");
    current.database.exec("DROP TABLE script_approval_events; DROP TABLE script_version_sources; DROP TABLE script_versions");
    current.database.exec("DROP TABLE episode_sources; DROP TABLE episodes; DROP TABLE series_projects");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 5").run();
    current.database.prepare(
      `INSERT INTO books (
         id, title, original_file_path, original_file_hash, encoding, import_status
       ) VALUES ('book_v4', '旧书', 'books/book_v4/source.txt', ?, 'UTF-8', 'ready')`,
    ).run("b".repeat(64));
    current.close();

    const upgraded = openDatabase(dataRoot);
    assert.equal(
      upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
      10,
    );
    upgraded.database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('series_v4', 'book_v4', '系列', 1, 1)`,
    ).run();
    upgraded.database.prepare(
      `INSERT INTO chapters (
         id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
       ) VALUES ('chapter_v4', 'book_v4', 0, '第一章', 0, 1, 1, 'hash')`,
    ).run();
    upgraded.database.prepare(
      `INSERT INTO episodes (
         id, series_project_id, episode_index, title, story_arc,
         target_duration_seconds, created_at, updated_at
       ) VALUES ('episode_v4', 'series_v4', 1, '第一集', '开端', 180, 1, 1)`,
    ).run();
    upgraded.database.prepare(
      `INSERT INTO episode_sources (
         episode_id, source_index, chapter_id, source_event_id,
         source_byte_start, source_byte_end, source_hash
       ) VALUES ('episode_v4', 0, 'chapter_v4', 'event_snapshot', 0, 1, ?)`,
    ).run("a".repeat(64));
    upgraded.database.prepare("DELETE FROM books WHERE id = 'book_v4'").run();
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM series_projects").get()?.count, 0);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM episodes").get()?.count, 0);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS count FROM episode_sources").get()?.count, 0);
    upgraded.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("既有 migration v8 数据库可升级资产合同并保持关系约束", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-database-v8-upgrade-"));
  try {
    const current = openDatabase(dataRoot);
    current.database.exec("DROP TABLE asset_candidate_review_events; DROP TABLE asset_candidates; DROP TABLE asset_aliases; DROP TABLE assets");
    current.database.prepare("DELETE FROM schema_migrations WHERE version >= 9").run();
    current.database.prepare(
      `INSERT INTO books (
         id, title, original_file_path, original_file_hash, encoding, import_status
       ) VALUES ('book_assets', '资产测试', 'books/book_assets/source.txt', ?, 'UTF-8', 'ready')`,
    ).run("6".repeat(64));
    current.database.prepare(
      `INSERT INTO series_projects (id, book_id, title, created_at, updated_at)
       VALUES ('series_assets', 'book_assets', '系列一', 1, 1),
              ('series_other', 'book_assets', '系列二', 1, 1)`,
    ).run();
    current.close();

    const upgraded = openDatabase(dataRoot);
    assert.equal(
      upgraded.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version,
      10,
    );
    const tables = upgraded.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('assets', 'asset_aliases') ORDER BY name",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((table) => table.name), ["asset_aliases", "assets"]);

    const insertAsset = upgraded.database.prepare(
      `INSERT INTO assets (
         id, series_project_id, asset_type, asset_role, canonical_name, normalized_name,
         parent_asset_id, state_label, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    insertAsset.run(
      "asset_master", "series_assets", "character", "master", "林黛玉", "林黛玉", null, null,
    );
    insertAsset.run(
      "asset_state", "series_assets", "character", "state", "林黛玉·病中", "林黛玉·病中",
      "asset_master", "病中",
    );

    for (const invalid of [
      ["bad_type", "series_assets", "sound", "master", "声音", "声音", null, null],
      ["bad_master", "series_assets", "character", "master", "错误主资产", "错误主资产", "asset_master", null],
      ["bad_state", "series_assets", "character", "state", "错误状态", "错误状态", null, "病中"],
      ["bad_self", "series_assets", "character", "state", "自指", "自指", "bad_self", "自指"],
      ["bad_series", "series_other", "character", "state", "跨系列", "跨系列", "asset_master", "病中"],
      ["bad_type_parent", "series_assets", "scene", "state", "跨类型", "跨类型", "asset_master", "夜景"],
    ] as const) {
      assert.throws(
        () => insertAsset.run(...invalid),
        /(CHECK|FOREIGN KEY) constraint failed|state asset parent must be master/,
      );
    }
    assert.throws(
      () => insertAsset.run(
        "bad_nested_state", "series_assets", "character", "state", "状态套状态", "状态套状态",
        "asset_state", "二级状态",
      ),
      /state asset parent must be master/,
    );
    insertAsset.run(
      "asset_master_2", "series_assets", "character", "master", "薛宝钗", "薛宝钗", null, null,
    );
    assert.throws(
      () => upgraded.database.prepare(
        `UPDATE assets
         SET asset_role = 'state', parent_asset_id = 'asset_state', state_label = '错误嵌套'
         WHERE id = 'asset_master_2'`,
      ).run(),
      /state asset parent must be master/,
    );
    assert.throws(
      () => upgraded.database.prepare(
        `UPDATE assets
         SET asset_role = 'state', parent_asset_id = 'asset_master_2', state_label = '错误降级'
         WHERE id = 'asset_master'`,
      ).run(),
      /master asset with state children cannot change hierarchy/,
    );
    upgraded.database.prepare(
      "UPDATE assets SET description = '允许更新描述' WHERE id = 'asset_master'",
    ).run();
    assert.equal(
      upgraded.database.prepare("SELECT description FROM assets WHERE id = 'asset_master'").get()?.description,
      "允许更新描述",
    );

    const insertAlias = upgraded.database.prepare(
      `INSERT INTO asset_aliases (
         series_project_id, asset_id, alias, normalized_alias, is_primary, created_at
       ) VALUES (?, ?, ?, ?, ?, 1)`,
    );
    insertAlias.run("series_assets", "asset_master", "林黛玉", "林黛玉", 1);
    insertAlias.run("series_assets", "asset_master", "黛玉", "黛玉", 0);
    assert.throws(
      () => insertAlias.run("series_assets", "asset_state", "黛玉", "黛玉", 0),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insertAlias.run("series_assets", "asset_master", "林姑娘", "林姑娘", 1),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insertAlias.run("series_assets", "asset_master", "无效", "无效", 2),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => upgraded.database.prepare("DELETE FROM assets WHERE id = 'asset_master'").run(),
      /FOREIGN KEY constraint failed/,
    );

    upgraded.database.prepare(
      `INSERT INTO asset_candidates (
         id, asset_id, source_kind, source_identity_hash, source_json, file_hash,
         mime, width, height, bytes, relative_path, created_at
       ) VALUES ('candidate_v10', 'asset_master', 'upload', ?, '{"kind":"upload","originalName":"a.png"}', ?,
         'image/png', 32, 32, 100, 'assets/candidates/aa/aa.png', 1)`,
    ).run("7".repeat(64), "8".repeat(64));
    upgraded.database.prepare(
      `INSERT INTO asset_candidate_review_events (candidate_id, revision, action, note, created_at)
       VALUES ('candidate_v10', 1, 'approve', NULL, 1)`,
    ).run();
    assert.throws(
      () => upgraded.database.prepare(
        `INSERT INTO asset_candidates (
           id, asset_id, source_kind, source_identity_hash, source_json, file_hash,
           mime, width, height, bytes, relative_path, created_at
         ) VALUES ('candidate_bad', 'asset_master', 'upload', ?, '{}', ?,
           'image/gif', 32, 32, 100, 'bad.gif', 1)`,
      ).run("9".repeat(64), "a".repeat(64)),
      /CHECK constraint failed/,
    );

    upgraded.close();
    const reopened = openDatabase(dataRoot);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM assets").get()?.count, 3);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_aliases").get()?.count, 2);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get()?.count, 1);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_candidate_review_events").get()?.count, 1);
    reopened.database.prepare("DELETE FROM series_projects WHERE id = 'series_assets'").run();
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM assets").get()?.count, 0);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_aliases").get()?.count, 0);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_candidates").get()?.count, 0);
    assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM asset_candidate_review_events").get()?.count, 0);
    reopened.close();
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
