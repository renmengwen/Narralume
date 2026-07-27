import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.js";
import { getJob } from "./job-store.js";
import { JobWorker } from "./job-worker.js";
import {
  createTtsListeningReviewJobHandler, enqueueTtsListeningReview, getTtsListeningReviewWorkspace,
  representativeSegmentIndexes, TTS_LISTENING_REVIEW_JOB_TYPE,
} from "./tts-listening-review.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const TIMELINE = "a".repeat(64);

async function fixture(texts = ["开头", "张起灵来到墓道", "中段", "吴邪发现线索", "结尾"]) {
  const root = await mkdtemp(join(tmpdir(), "narralume-listening-"));
  const connection = openDatabase(root);
  const db = connection.database;
  db.prepare(`INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status)
    VALUES ('book','书','book.txt',?,'utf-8','ready')`).run("1".repeat(64));
  db.prepare(`INSERT INTO chapters (id,book_id,chapter_index,title,byte_start,byte_end,char_count,content_hash)
    VALUES ('chapter','book',0,'章',0,1,1,?)`).run("2".repeat(64));
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)").run();
  db.prepare(`INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at)
    VALUES ('episode','series',1,'一','弧',240,1,1)`).run();
  const contentJson = JSON.stringify({ paragraphs: [{ text: "稿", sourceIndexes: [0] }] });
  db.prepare(`INSERT INTO script_versions (id,episode_id,kind,version,parent_version_id,content_json,content_hash,created_at)
    VALUES ('script','episode','packaged',1,NULL,?,?,1)`).run(contentJson, hash(contentJson));
  db.prepare(`INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at)
    VALUES ('approval','episode',1,'approve','script',1)`).run();
  const bibleJson = JSON.stringify({ properNouns: [
    { term: "张起灵", pronunciation: "zhāng qǐ líng", aliases: ["小哥"] },
    { term: "吴邪", pronunciation: "wú xié", aliases: [] },
    { term: "未出现", pronunciation: "wèi chū xiàn", aliases: [] },
  ] });
  db.prepare(`INSERT INTO book_story_bibles
    (id,book_id,scope,source_start_chapter_id,source_end_chapter_id,source_event_ids_json,source_events_hash,
     parent_bible_ids_json,input_hash,contract_version,revision,provider_id,model,content_json,content_hash,created_at)
    VALUES ('bible','book','final','chapter','chapter','["event"]',?,'[]',?,'book-story-bible-v1',1,'provider','model',?,?,1)`)
    .run("3".repeat(64), "4".repeat(64), bibleJson, hash(bibleJson));
  db.prepare(`INSERT INTO series_pipeline_runs
    (id,series_project_id,status,episode_count,target_duration_seconds,source_start_chapter_id,source_end_chapter_id,
     config_hash,story_bible_id,created_at,updated_at)
    VALUES ('run','series','completed',1,240,'chapter','chapter',?,'bible',1,1)`).run("5".repeat(64));
  texts.forEach((text, index) => db.prepare(`INSERT INTO audio_segments
    (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,?, 'episode','script',?,'edge','voice',1,?,?,?,10,1000,1)`)
    .run(TIMELINE, index, text, String(index).padStart(64, "0"), `segment-${index}.wav`, String(index + 1).padStart(64, "0")));
  return { root, connection };
}

test("代表段支持任意数量并去重", () => {
  assert.deepEqual(representativeSegmentIndexes(1), [0]);
  assert.deepEqual(representativeSegmentIndexes(2), [0, 1]);
  assert.deepEqual(representativeSegmentIndexes(6), [0, 1, 2, 3, 5]);
});

test("专名命中加入首个片段，批准必须覆盖全部必听项", async () => {
  const { root, connection } = await fixture();
  try {
    const workspace = getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE);
    assert.deepEqual(workspace.requiredProperNouns.map(({ term, segmentIndex }) => ({ term, segmentIndex })), [
      { term: "张起灵", segmentIndex: 1 }, { term: "吴邪", segmentIndex: 3 },
    ]);
    assert.throws(() => enqueueTtsListeningReview(connection.database, {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve", checkedSegmentIndexes: [0], checkedProperNouns: [],
    }), /全部代表段和专名/);
    const job = enqueueTtsListeningReview(connection.database, {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve",
      checkedSegmentIndexes: workspace.requiredSegmentIndexes,
      checkedProperNouns: workspace.requiredProperNouns.map((item) => item.term),
    });
    const worker = new JobWorker(connection.database, { [TTS_LISTENING_REVIEW_JOB_TYPE]: createTtsListeningReviewJobHandler(connection.database) },
      { workerId: "reviewer", leaseMs: 5_000, heartbeatMs: 100 });
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(connection.database, job.id)?.status, "succeeded");
    assert.equal(getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE).latestReview?.action, "approve");
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});

test("执行前身份漂移会拒绝，旧成功也不匹配新身份", async () => {
  const { root, connection } = await fixture();
  try {
    const workspace = getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE);
    const first = enqueueTtsListeningReview(connection.database, {
      episodeId: "episode", timelineHash: TIMELINE, action: "approve",
      checkedSegmentIndexes: workspace.requiredSegmentIndexes,
      checkedProperNouns: workspace.requiredProperNouns.map((item) => item.term),
    });
    const handler = createTtsListeningReviewJobHandler(connection.database);
    const worker = () => new JobWorker(connection.database, { [TTS_LISTENING_REVIEW_JOB_TYPE]: handler },
      { workerId: `worker-${Math.random()}`, leaseMs: 5_000, heartbeatMs: 100 });
    assert.equal(await worker().runOne(), true);
    assert.equal(getJob(connection.database, first.id)?.status, "succeeded");
    connection.database.prepare("UPDATE audio_segments SET voice='new-voice' WHERE timeline_hash=?").run(TIMELINE);
    assert.equal(getTtsListeningReviewWorkspace(connection.database, "episode", TIMELINE).latestReview, null);
    const stale = enqueueTtsListeningReview(connection.database, {
      episodeId: "episode", timelineHash: TIMELINE, action: "reject", checkedSegmentIndexes: [], checkedProperNouns: [], notes: "不通过",
    });
    connection.database.prepare("UPDATE audio_segments SET rate=2 WHERE timeline_hash=?").run(TIMELINE);
    assert.equal(await worker().runOne(), true);
    assert.equal(getJob(connection.database, stale.id)?.status, "failed");
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});

test("拒绝无需伪装为批准覆盖", async () => {
  const { root, connection } = await fixture(["只有一段"]);
  try {
    const job = enqueueTtsListeningReview(connection.database, {
      episodeId: "episode", timelineHash: TIMELINE, action: "reject", checkedSegmentIndexes: [], checkedProperNouns: [],
    });
    const worker = new JobWorker(connection.database, { [TTS_LISTENING_REVIEW_JOB_TYPE]: createTtsListeningReviewJobHandler(connection.database) },
      { workerId: "rejecter", leaseMs: 5_000, heartbeatMs: 100 });
    assert.equal(await worker.runOne(), true);
    assert.equal(getJob(connection.database, job.id)?.result && (getJob(connection.database, job.id)!.result as { action: string }).action, "reject");
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});
