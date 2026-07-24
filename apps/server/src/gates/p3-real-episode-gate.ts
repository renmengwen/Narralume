import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { buildApp } from "../app.js";
import type { ChapterEventInput } from "../chapter-event-store.js";
import { openDatabase } from "../database.js";
import {
  requireApprovedScriptForProduction,
  ScriptApprovalStoreError,
} from "../script-approval-store.js";

const SOURCE_URL = "https://www.gutenberg.org/cache/epub/24264/pg24264.txt";
const SOURCE_SHA256 = "ff1526996bf4b81807651921a85e5c1c0f1d1d123c9fa4553057ba6a3ec72011";

interface ChapterRow {
  id: string;
  chapter_index: number;
  byte_start: number;
  byte_end: number;
}

interface EventTask {
  chapter: ChapterRow;
  events: ChapterEventInput[];
}

interface EpisodeSource {
  sourceIndex: number;
  chapterId: string;
  sourceEventId: string;
  byteStart: number;
  byteEnd: number;
  sourceHash: string;
  sourceText: string;
}

interface ScriptSource {
  episodeSourceIndex: number;
  chapterId: string;
  sourceEventId: string;
  byteStart: number;
  byteEnd: number;
  sourceHash: string;
}

interface ScriptVersion {
  id: string;
  episodeId: string;
  kind: "faithful" | "packaged";
  versionNumber: number;
  parentVersionId: string | null;
  contentHash: string;
  paragraphs: Array<{ text: string; sources: ScriptSource[] }>;
}

function expectProductionBlocked(fn: () => unknown) {
  assert.throws(fn, (error) => {
    assert(error instanceof ScriptApprovalStoreError);
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /未人工批准/);
    return true;
  });
}

function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function evidence(source: Buffer, chapter: ChapterRow, phrase: string) {
  const needle = Buffer.from(phrase, "utf8");
  const chapterBytes = source.subarray(chapter.byte_start, chapter.byte_end);
  const relativeStart = chapterBytes.indexOf(needle);
  assert(relativeStart >= 0, `第 ${chapter.chapter_index} 章缺少冻结证据：${phrase}`);
  assert.equal(chapterBytes.indexOf(needle, relativeStart + 1), -1, `冻结证据在章节内不唯一：${phrase}`);
  const byteStart = chapter.byte_start + relativeStart;
  return { byteStart, byteEnd: byteStart + needle.length };
}

function eventTasks(source: Buffer, chapters: ChapterRow[]): EventTask[] {
  const chapter = (index: number) => {
    const found = chapters.find((item) => item.chapter_index === index);
    assert(found, `真实输入缺少 chapter_index=${index}`);
    return found;
  };
  const first = chapter(1);
  const second = chapter(2);
  const third = chapter(3);
  return [
    {
      chapter: first,
      events: [
        {
          type: "character",
          payload: { name: "甄士隱" },
          sources: [evidence(source, first, "甄士隱夢幻識通靈")],
        },
        {
          type: "prop",
          payload: { name: "頑石" },
          sources: [evidence(source, first, "頑石三万六千五百零一塊")],
        },
      ],
    },
    {
      chapter: second,
      events: [
        {
          type: "causality",
          payload: { cause: "偶然一顧", effect: "弄出這段事來" },
          sources: [evidence(source, second, "因偶然一顧，便弄出這段事來")],
        },
        {
          type: "suspense",
          payload: { question: "賈府目下興衰如何" },
          sources: [evidence(source, second, "欲知目下興衰兆，須問旁觀冷眼人")],
        },
      ],
    },
    {
      chapter: third,
      events: [
        {
          type: "revelation",
          payload: { fact: "黛玉依傍外祖母及舅氏姊妹" },
          sources: [evidence(source, third, "今依傍外祖母及舅氏姊妹去")],
        },
        {
          type: "location",
          payload: { name: "榮國府" },
          sources: [evidence(source, third, "方是榮國府了")],
        },
      ],
    },
  ];
}

async function downloadSource(path: string) {
  const response = await fetch(SOURCE_URL);
  assert(response.ok && response.body, `真实原文下载失败：HTTP ${response.status}`);
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    createWriteStream(path, { flush: true }),
  );
}

const root = await mkdtemp(join(tmpdir(), "narralume-p3-real-"));
const dataRoot = join(root, "data");
const sourcePath = process.env.NARRALUME_LONG_TEXT_PATH ?? join(root, "pg24264.txt");
let app: ReturnType<typeof buildApp> | undefined;

try {
  if (!process.env.NARRALUME_LONG_TEXT_PATH) await downloadSource(sourcePath);
  const source = await readFile(sourcePath);
  assert.equal(source.length, 2_663_455, "真实原文大小与冻结值不一致");
  assert.equal(hash(source), SOURCE_SHA256, "真实原文 SHA-256 与冻结值不一致");

  app = buildApp({ dataRoot, logger: false });
  const imported = await app.inject({
    method: "POST",
    url: "/api/books/import",
    headers: { "content-type": "text/plain", "x-file-name": encodeURIComponent("红楼梦.txt") },
    payload: createReadStream(sourcePath),
  });
  assert.equal(imported.statusCode, 201, `真实原文导入失败：${imported.body}`);
  const bookId = imported.json().book.id as string;

  const chaptersResponse = await app.inject({
    method: "GET",
    url: `/api/books/${bookId}/chapters?limit=100&offset=0`,
  });
  assert.equal(chaptersResponse.statusCode, 200, `章节查询失败：${chaptersResponse.body}`);
  const tasks = eventTasks(source, chaptersResponse.json().items as ChapterRow[]);
  const sourceEventIds: string[] = [];
  for (const task of tasks) {
    const response: { statusCode: number; body: string; json(): any } = await app.inject({
      method: "PUT",
      url: `/api/books/${bookId}/chapters/${task.chapter.id}/events`,
      payload: { events: task.events },
    });
    assert.equal(response.statusCode, 200, `真实章节事件写入失败：${response.body}`);
    sourceEventIds.push(...(response.json().items as Array<{ id: string }>).map((item) => item.id));
  }
  assert.equal(new Set(sourceEventIds).size, 6, "三章必须形成六个不重复事件");

  const seriesResponse = await app.inject({
    method: "POST",
    url: `/api/books/${bookId}/series`,
    payload: { title: "红楼梦视觉说书" },
  });
  assert.equal(seriesResponse.statusCode, 201, `系列建立失败：${seriesResponse.body}`);
  const seriesId = seriesResponse.json().series.id as string;
  const episodeBody = {
    title: "甄士隐梦幻识通灵",
    storyArc: "从通灵宝玉降世到黛玉初入荣国府，建立人物、因果与家族悬念。",
    targetDurationSeconds: 240,
    recap: "顽石入世，甄士隐与贾雨村的命运由此展开。",
    nextHook: "黛玉进入荣国府后，将遇见怎样的贾府众人？",
    sourceEventIds,
  };
  const episodeResponse = await app.inject({
    method: "PUT",
    url: `/api/series/${seriesId}/episodes/1`,
    payload: episodeBody,
  });
  assert.equal(episodeResponse.statusCode, 200, `分集建立失败：${episodeResponse.body}`);

  await app.close();
  app = buildApp({ dataRoot, logger: false });

  const seriesList = await app.inject({ method: "GET", url: `/api/books/${bookId}/series` });
  assert.equal(seriesList.statusCode, 200, `重启后系列查询失败：${seriesList.body}`);
  assert.equal(seriesList.json().items.length, 1, "重启后必须只存在一个系列");

  const getEpisode = async () => {
    const response = await app!.inject({ method: "GET", url: `/api/series/${seriesId}/episodes/1` });
    assert.equal(response.statusCode, 200, `重启后分集查询失败：${response.body}`);
    return response.json().episode as { index: number; sources: EpisodeSource[] };
  };
  const episode = await getEpisode() as { id: string; index: number; sources: EpisodeSource[] };
  assert.equal(episode.index, 1);
  assert.equal(episode.sources.length, 6, "分集必须保存六份独立证据快照");
  assert.deepEqual(new Set(episode.sources.map((item) => item.sourceEventId)), new Set(sourceEventIds));
  assert.deepEqual(
    new Set(episode.sources.map((item) => item.chapterId)),
    new Set(tasks.map((task) => task.chapter.id)),
    "证据快照必须归属选定的三章",
  );
  for (const item of episode.sources) {
    const bytes = source.subarray(item.byteStart, item.byteEnd);
    assert.equal(hash(bytes), item.sourceHash, `证据快照哈希不一致：${item.sourceEventId}`);
    assert.equal(bytes.toString("utf8"), item.sourceText, `证据快照文本不一致：${item.sourceEventId}`);
  }

  const beforeRepeat = JSON.stringify(episode.sources);
  const repeated = await app.inject({
    method: "PUT",
    url: `/api/series/${seriesId}/episodes/1`,
    payload: episodeBody,
  });
  assert.equal(repeated.statusCode, 200, `重复保存分集失败：${repeated.body}`);
  assert.equal(JSON.stringify((await getEpisode()).sources), beforeRepeat, "重复 PUT 不得复制或改写证据快照");

  const scriptsUrl = `/api/series/${seriesId}/episodes/1/scripts`;
  const faithfulV1Body = {
    kind: "faithful",
    paragraphs: [
      { text: "甄士隱夢中识得通灵顽石，故事由一段超尘因缘展开。", sourceIndexes: [0, 1] },
      { text: "贾府兴衰已埋下因果与悬念，旁观者将见证其起落。", sourceIndexes: [2, 3] },
      { text: "黛玉投奔外祖母，初入荣国府，人物命运开始交汇。", sourceIndexes: [4, 5] },
    ],
  } as const;
  const createScript = async (body: object) => {
    const response = await app!.inject({ method: "POST", url: scriptsUrl, payload: body });
    assert.equal(response.statusCode, 201, `稿件版本创建失败：${response.body}`);
    return response.json().script as ScriptVersion;
  };
  const faithfulV1 = await createScript(faithfulV1Body);
  const packagedV1 = await createScript({
    kind: "packaged",
    parentVersionId: faithfulV1.id,
    paragraphs: [
      { text: "一块顽石，如何牵动红楼众人的命运？", sourceIndexes: [0, 1] },
      { text: "盛极之时，衰败的伏笔早已写下。", sourceIndexes: [2, 3] },
      { text: "当黛玉走进荣国府，真正的故事才刚刚开始。", sourceIndexes: [4, 5] },
    ],
  });
  const faithfulV2 = await createScript({
    kind: "faithful",
    paragraphs: [
      { text: "甄士隱梦遇通灵顽石，顽石入世的因缘由此显现。", sourceIndexes: [0, 1] },
      { text: "贾府的兴衰藏在因果与冷眼旁观者的预言之中。", sourceIndexes: [2, 3] },
      { text: "黛玉依傍外祖母，来到荣国府，走入家族命运的中心。", sourceIndexes: [4, 5] },
    ],
  });
  const repeatedFaithfulV1 = await createScript(faithfulV1Body);
  assert.equal(repeatedFaithfulV1.id, faithfulV1.id, "重复 POST 忠实稿 v1 必须幂等复用原版本");
  assert.equal(repeatedFaithfulV1.contentHash, faithfulV1.contentHash, "幂等稿件的内容哈希不得变化");

  assert.equal(faithfulV1.versionNumber, 1);
  assert.equal(packagedV1.versionNumber, 1);
  assert.equal(faithfulV2.versionNumber, 2);
  assert.equal(faithfulV1.parentVersionId, null);
  assert.equal(packagedV1.parentVersionId, faithfulV1.id);
  assert.equal(faithfulV2.parentVersionId, null);
  const createdScripts = new Map([faithfulV1, packagedV1, faithfulV2].map((script) => [script.id, script]));

  let productionSideEffects = 0;
  const probeProduction = (purpose: "tts" | "image") => {
    const connection = openDatabase(dataRoot);
    try {
      const permit = requireApprovedScriptForProduction(connection.database, episode.id, purpose);
      productionSideEffects += 1;
      return permit;
    } finally {
      connection.close();
    }
  };
  expectProductionBlocked(() => probeProduction("tts"));
  expectProductionBlocked(() => probeProduction("image"));
  assert.equal(productionSideEffects, 0, "未批准时不得触发任何生产副作用");

  const approvalUrl = `/api/series/${seriesId}/episodes/1/approval`;
  const approvedResponse = await app.inject({
    method: "PUT",
    url: approvalUrl,
    payload: { action: "approve", expectedRevision: 0, scriptVersionId: packagedV1.id },
  });
  assert.equal(approvedResponse.statusCode, 200, `人工批准失败：${approvedResponse.body}`);
  const ttsPermit = probeProduction("tts");
  const imagePermit = probeProduction("image");
  assert.equal(ttsPermit.scriptVersionId, packagedV1.id);
  assert.equal(ttsPermit.contentHash, packagedV1.contentHash);
  assert.deepEqual(imagePermit, ttsPermit);
  assert.equal(productionSideEffects, 2, "批准后语音与图片生产探针应各通过一次");

  const withdrawnResponse = await app.inject({
    method: "PUT",
    url: approvalUrl,
    payload: { action: "withdraw", expectedRevision: 1 },
  });
  assert.equal(withdrawnResponse.statusCode, 200, `撤回批准失败：${withdrawnResponse.body}`);
  expectProductionBlocked(() => probeProduction("tts"));
  expectProductionBlocked(() => probeProduction("image"));
  assert.equal(productionSideEffects, 2, "撤回后不得继续触发生产副作用");

  await app.close();
  app = buildApp({ dataRoot, logger: false });
  const scriptsResponse = await app.inject({ method: "GET", url: scriptsUrl });
  assert.equal(scriptsResponse.statusCode, 200, `重启后稿件版本查询失败：${scriptsResponse.body}`);
  const scripts = scriptsResponse.json().items as ScriptVersion[];
  assert.equal(scripts.length, 3, "幂等提交后必须只保留三个不可变稿件版本");
  const episodeSources = new Map(episode.sources.map((item) => [item.sourceIndex, item]));
  for (const script of scripts) {
    const created = createdScripts.get(script.id);
    assert(created, `重启后出现未知稿件版本：${script.id}`);
    assert.equal(script.contentHash, created.contentHash, `重启后旧稿哈希变化：${script.id}`);
    assert.equal(JSON.stringify(script.paragraphs), JSON.stringify(created.paragraphs), `重启后旧稿内容变化：${script.id}`);
    assert.equal(script.parentVersionId, created.parentVersionId, `重启后稿件父链变化：${script.id}`);
    for (const paragraph of script.paragraphs) {
      assert(paragraph.text.length > 0, `稿件段落文本不能为空：${script.id}`);
      assert(paragraph.sources.length > 0, `稿件段落必须保留来源快照：${script.id}`);
      for (const snapshot of paragraph.sources) {
        const episodeSource = episodeSources.get(snapshot.episodeSourceIndex);
        assert(episodeSource, `稿件引用未知分集来源：${snapshot.episodeSourceIndex}`);
        assert.deepEqual(
          snapshot,
          {
            episodeSourceIndex: episodeSource.sourceIndex,
            chapterId: episodeSource.chapterId,
            sourceEventId: episodeSource.sourceEventId,
            byteStart: episodeSource.byteStart,
            byteEnd: episodeSource.byteEnd,
            sourceHash: episodeSource.sourceHash,
          },
          `稿件来源快照与分集证据不一致：${script.id}`,
        );
        assert.equal(
          hash(source.subarray(snapshot.byteStart, snapshot.byteEnd)),
          snapshot.sourceHash,
          `稿件来源原文字节哈希不一致：${script.id}`,
        );
      }
    }
  }
  const restartedApproval = await app.inject({ method: "GET", url: approvalUrl });
  assert.equal(restartedApproval.statusCode, 200, `重启后批准状态查询失败：${restartedApproval.body}`);
  assert.equal(restartedApproval.json().approval.status, "withdrawn");
  assert.equal(restartedApproval.json().approval.revision, 2);
  expectProductionBlocked(() => probeProduction("tts"));
  expectProductionBlocked(() => probeProduction("image"));
  assert.equal(productionSideEffects, 2, "重启后撤回状态仍必须阻断生产");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    source_bytes: source.length,
    source_sha256: hash(source),
    chapters: tasks.length,
    source_events: sourceEventIds.length,
    episode_index: episode.index,
    evidence_snapshots: episode.sources.length,
    restart_query: true,
    idempotent_put: true,
    script_versions: scripts.length,
    idempotent_script_post: true,
    script_restart_query: true,
    approval_revision: restartedApproval.json().approval.revision,
    production_guard: true,
    production_side_effects: productionSideEffects,
  }, null, 2)}\n`);
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
