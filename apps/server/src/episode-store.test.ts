import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import {
  createSeriesProject, EpisodeStoreError, getEpisode, listSeriesProjects, replaceEpisode,
} from "./episode-store.js";

async function fixture() {
  const dataRoot = await mkdtemp(join(tmpdir(), "narralume-episodes-"));
  const connection = openDatabase(dataRoot);
  const first = Buffer.from("第一章：宝玉初见黛玉。", "utf8");
  const second = Buffer.from("第二章：众人入住荣国府。", "utf8");
  const other = Buffer.from("别书章节：无关事件。", "utf8");
  const relativePath = "books/book_episode/source.txt";
  const otherRelativePath = "books/book_other/source.txt";
  await mkdir(dirname(join(dataRoot, relativePath)), { recursive: true });
  await mkdir(dirname(join(dataRoot, otherRelativePath)), { recursive: true });
  await writeFile(join(dataRoot, relativePath), Buffer.concat([first, second]));
  await writeFile(join(dataRoot, otherRelativePath), other);
  connection.database.prepare(
    `INSERT INTO books (
       id, title, original_file_path, original_file_hash, encoding, import_status
     ) VALUES (?, ?, ?, ?, 'UTF-8', 'ready')`,
  ).run("book_episode", "红楼梦", relativePath,
    createHash("sha256").update(Buffer.concat([first, second])).digest("hex"));
  connection.database.prepare(
    `INSERT INTO books (
       id, title, original_file_path, original_file_hash, encoding, import_status
     ) VALUES (?, ?, ?, ?, 'UTF-8', 'ready')`,
  ).run("book_other", "别书", otherRelativePath, createHash("sha256").update(other).digest("hex"));
  const chapters = [
    ["chapter_1", "book_episode", 0, "第一章", 0, first.length, first],
    ["chapter_2", "book_episode", 1, "第二章", first.length, first.length + second.length, second],
    ["chapter_other", "book_other", 0, "别章", 0, other.length, other],
  ] as const;
  for (const [id, bookId, index, title, start, end, bytes] of chapters) {
    connection.database.prepare(
      `INSERT INTO chapters (
         id, book_id, chapter_index, title, byte_start, byte_end, char_count, content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, bookId, index, title, start, end, bytes.toString("utf8").length,
      createHash("sha256").update(bytes).digest("hex"));
  }
  const evidence = [
    ["event_1", "chapter_1", 0, 0, first.indexOf(Buffer.from("宝玉")), Buffer.byteLength("宝玉")],
    ["event_2", "chapter_2", 0, first.length, second.indexOf(Buffer.from("荣国府")), Buffer.byteLength("荣国府")],
    ["event_other", "chapter_other", 0, 0, other.indexOf(Buffer.from("无关")), Buffer.byteLength("无关")],
  ] as const;
  for (const [eventId, chapterId, eventIndex, chapterStart, relativeStart, length] of evidence) {
    const start = chapterStart + relativeStart;
    const source = chapterId === "chapter_1" ? first : chapterId === "chapter_2" ? second : other;
    const sourceBytes = source.subarray(relativeStart, relativeStart + length);
    connection.database.prepare(
      `INSERT INTO chapter_events (
         id, chapter_id, event_index, occurrence, event_type, payload_json, created_at
       ) VALUES (?, ?, ?, 0, 'character', '{}', 1)`,
    ).run(eventId, chapterId, eventIndex);
    connection.database.prepare(
      `INSERT INTO chapter_event_sources (
         event_id, source_index, source_byte_start, source_byte_end, source_hash
       ) VALUES (?, 0, ?, ?, ?)`,
    ).run(eventId, start, start + length, createHash("sha256").update(sourceBytes).digest("hex"));
  }
  return { dataRoot, connection };
}

test("系列项目可创建并按书籍列出", async () => {
  const context = await fixture();
  try {
    const project = createSeriesProject(
      context.connection.database, { bookId: "book_episode", title: "红楼梦短剧" }, 10,
    );
    assert.equal(project.title, "红楼梦短剧");
    assert.deepEqual(listSeriesProjects(context.connection.database, "book_episode"), [project]);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("分集复制两章证据且相同序号幂等替换", async () => {
  const context = await fixture();
  try {
    const project = createSeriesProject(
      context.connection.database, { bookId: "book_episode", title: "红楼梦短剧" }, 10,
    );
    const input = {
      index: 1, title: "初入荣府", storyArc: "人物相遇并进入新环境",
      targetDurationSeconds: 240, recap: null, nextHook: "府中还有何人？",
      sourceEventIds: ["event_1", "event_2"],
    };
    assert.throws(
      () => replaceEpisode(context.connection.database, project.id, { ...input, index: 0 }, 20),
      /分集序号必须从 1 开始/,
    );
    const first = replaceEpisode(context.connection.database, project.id, input, 20);
    const second = replaceEpisode(
      context.connection.database, project.id, { ...input, title: "初入荣国府" }, 30,
    );
    assert.equal(second.id, first.id);
    assert.equal(context.connection.database.prepare("SELECT COUNT(*) AS count FROM episodes").get()?.count, 1);
    assert.equal(context.connection.database.prepare("SELECT COUNT(*) AS count FROM episode_sources").get()?.count, 2);
    const saved = await getEpisode(context.connection.database, context.dataRoot, project.id, 1);
    assert.equal(saved.title, "初入荣国府");
    assert.deepEqual(saved.sources.map((source) => source.chapterId), ["chapter_1", "chapter_2"]);
    assert.deepEqual(saved.sources.map((source) => source.sourceText), ["宝玉", "荣国府"]);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});

test("跨书事件在事务前被拒绝且旧分集保持不变", async () => {
  const context = await fixture();
  try {
    const project = createSeriesProject(
      context.connection.database, { bookId: "book_episode", title: "红楼梦短剧" }, 10,
    );
    replaceEpisode(context.connection.database, project.id, {
      index: 1, title: "旧标题", storyArc: "旧故事弧", targetDurationSeconds: 180,
      sourceEventIds: ["event_1"],
    }, 20);
    assert.throws(
      () => replaceEpisode(context.connection.database, project.id, {
        index: 1, title: "不应保存", storyArc: "错误故事弧", targetDurationSeconds: 200,
        sourceEventIds: ["event_1", "event_other"],
      }, 30),
      (error: unknown) => error instanceof EpisodeStoreError && error.statusCode === 409,
    );
    const saved = await getEpisode(context.connection.database, context.dataRoot, project.id, 1);
    assert.equal(saved.title, "旧标题");
    assert.deepEqual(saved.sources.map((source) => source.sourceEventId), ["event_1"]);
  } finally {
    context.connection.close();
    await rm(context.dataRoot, { recursive: true, force: true });
  }
});
