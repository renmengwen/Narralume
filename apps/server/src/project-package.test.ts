import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "./database.js";
import { FINAL_VIDEO_MANIFEST_VERSION, type FinalVideoManifest } from "./final-video.js";
import { createProjectPackage, restoreProjectPackage } from "./project-package.js";
import { loadRenderPlanSnapshot, RENDER_CONTRACT } from "./render-chunk-job.js";

const TIMELINE = "a".repeat(64);
const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

async function put(root: string, relativePath: string, content: string | Buffer) {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return { path, relativePath, content: Buffer.from(content), bytes: Buffer.byteLength(content), fileHash: hash(content) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "narralume-package-test-"));
  const dataRoot = join(root, "data");
  const connection = openDatabase(dataRoot);
  const db = connection.database;
  const original = await put(dataRoot, "books/book/source.txt", "真实原文");
  db.prepare("INSERT INTO books (id,title,original_file_path,original_file_hash,encoding,import_status) VALUES ('book','书',?,?, 'UTF-8','ready')")
    .run(original.relativePath, original.fileHash);
  db.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('series','book','系列',1,1)").run();
  db.prepare("INSERT INTO episodes (id,series_project_id,episode_index,title,story_arc,target_duration_seconds,created_at,updated_at) VALUES ('episode','series',1,'集','弧',180,1,1)").run();
  db.prepare("INSERT INTO script_versions (id,episode_id,kind,version,content_json,content_hash,created_at) VALUES ('script','episode','packaged',1,'{}',?,1)").run("2".repeat(64));
  db.prepare("INSERT INTO script_approval_events (id,episode_id,revision,action,script_version_id,created_at) VALUES ('approval','episode',1,'approve','script',1)").run();
  db.prepare("INSERT INTO assets (id,series_project_id,asset_type,asset_role,canonical_name,normalized_name,created_at) VALUES ('asset','series','scene','master','场景','场景',1)").run();
  const image = await put(dataRoot, "assets/candidates/aa/image.png", "image");
  db.prepare(`INSERT INTO asset_candidates (id,asset_id,source_kind,source_identity_hash,source_json,file_hash,mime,width,height,bytes,relative_path,created_at)
    VALUES ('candidate','asset','upload',?,'{}',?,'image/png',1080,1920,?,?,1)`)
    .run("3".repeat(64), image.fileHash, image.bytes, image.relativePath);
  db.prepare("INSERT INTO asset_candidate_review_events (candidate_id,revision,action,created_at) VALUES ('candidate',1,'approve',1)").run();
  const audio = await put(dataRoot, "episodes/episode/audio/segments/audio.wav", "audio");
  db.prepare(`INSERT INTO audio_segments (timeline_hash,segment_index,episode_id,script_version_id,text,provider_id,voice,rate,input_hash,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,0,'episode','script','旁白','test','voice',0,?,?,?, ?,60000,1)`)
    .run(TIMELINE, "4".repeat(64), audio.relativePath, audio.fileHash, audio.bytes);
  db.prepare("INSERT INTO subtitle_cues (timeline_hash,cue_index,segment_index,episode_id,script_version_id,start_ms,end_ms,text) VALUES (?,0,0,'episode','script',0,60000,'旁白')").run(TIMELINE);
  db.prepare(`INSERT INTO visual_segments (id,episode_id,segment_index,script_version_id,approval_revision,timeline_hash,cue_start_index,cue_end_index,start_ms,end_ms,motion_kind,motion_amount_ppm,fade_ms,revision,created_at,updated_at)
    VALUES ('visual','episode',0,'script',1,?,0,0,0,60000,'none',0,0,1,1,1)`).run(TIMELINE);
  db.prepare("INSERT INTO visual_segment_assets (visual_segment_id,asset_index,asset_id,selected_candidate_id,candidate_review_revision) VALUES ('visual',0,'asset','candidate',1)").run();
  await put(dataRoot, `episodes/episode/audio/${TIMELINE}.srt`, "1\n00:00:00,000 --> 00:01:00,000\n旁白\n");
  await put(dataRoot, `episodes/episode/audio/${TIMELINE}.ass`, "[Script Info]\nPlayResX: 1080\nPlayResY: 1920\n");
  const planned = loadRenderPlanSnapshot(db, "episode", TIMELINE).chunks[0]!;
  const chunkRelativePath = `episodes/episode/renders/chunks/${planned.renderHash.slice(0, 2)}/${planned.renderHash}.mp4`;
  const chunk = await put(dataRoot, chunkRelativePath, "chunk");
  db.prepare(`INSERT INTO render_chunks (render_hash,episode_id,timeline_hash,chunk_index,script_version_id,approval_revision,start_ms,end_ms,relative_path,file_hash,bytes,duration_ms,created_at)
    VALUES (?,'episode',?,0,'script',1,0,60000,?,?,?,60000,1)`)
    .run(planned.renderHash, TIMELINE, chunk.relativePath, chunk.fileHash, chunk.bytes);
  const identity = {
    version: FINAL_VIDEO_MANIFEST_VERSION, contract: RENDER_CONTRACT, episodeId: "episode", scriptVersionId: "script",
    approvalRevision: 1, timelineHash: TIMELINE,
    chunks: [{ index: 0, startMs: 0, endMs: 60000, renderHash: planned.renderHash,
      fileHash: chunk.fileHash, bytes: chunk.bytes, durationMs: 60000 }],
  };
  const exportHash = hash(JSON.stringify(identity));
  const exportDirectory = `episodes/episode/exports/${exportHash.slice(0, 2)}/${exportHash}`;
  const video = await put(dataRoot, `${exportDirectory}/video.mp4`, "video");
  const finalManifest: FinalVideoManifest = {
    ...identity, exportHash,
    chunks: [{ ...identity.chunks[0]!, relativePath: chunk.relativePath }],
    finalVideo: { relativePath: video.relativePath, fileHash: video.fileHash, bytes: video.bytes, durationMs: 60000,
      streams: { video: "h264:1080x1920:25:yuv420p", audio: "aac" } },
  };
  const finalManifestRelativePath = `${exportDirectory}/manifest.json`;
  await put(dataRoot, finalManifestRelativePath, `${JSON.stringify(finalManifest, null, 2)}\n`);
  return { root, dataRoot, connection, finalManifestRelativePath };
}

async function cleanup(value: Awaited<ReturnType<typeof fixture>>) {
  value.connection.close();
  await rm(value.root, { recursive: true, force: true });
}

async function mutateManifest(packagePath: string, mutate: (manifest: any) => void) {
  const path = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  mutate(manifest);
  const { packageHash: _old, ...identity } = manifest;
  manifest.packageHash = hash(JSON.stringify(identity));
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("创建 WAL 一致项目包并恢复到不存在的数据根", async () => {
  const current = await fixture();
  try {
    current.connection.database.prepare(`INSERT INTO jobs (id,type,payload_json,status,run_after,created_at,updated_at)
      VALUES ('wal-latest','test','{}','queued',1,1,1)`).run();
    const packagePath = join(current.root, "project-package");
    const first = await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    assert.equal(first.manifest.version, "narralume-project-package-v1");
    assert.deepEqual(first.manifest.files, [...first.manifest.files].sort((a, b) => a.path.localeCompare(b.path, "en")));
    assert.equal(JSON.stringify(first.manifest).includes(current.dataRoot), false);
    for (const forbidden of ["mtime", "generatedAt", "machine", "randomUUID"]) {
      assert.equal(JSON.stringify(first.manifest).includes(forbidden), false);
    }
    const restored = join(current.root, "restored");
    await restoreProjectPackage(packagePath, restored);
    const restoredDb = new DatabaseSync(join(restored, "narralume.sqlite3"), { readOnly: true });
    try {
      assert.equal((restoredDb.prepare("SELECT status FROM jobs WHERE id='wal-latest'").get() as { status: string }).status, "queued");
      assert.equal((restoredDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
    } finally { restoredDb.close(); }
    assert.equal(await readFile(join(restored, "books", "book", "source.txt"), "utf8"), "真实原文");
    const second = await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath: join(current.root, "project-package-2"), finalManifestRelativePath: current.finalManifestRelativePath });
    assert.equal(second.manifest.packageHash, first.manifest.packageHash, "相同输入的包身份与排序必须稳定");
  } finally { await cleanup(current); }
});

test("恢复拒绝不安全、重复、缺失、额外和被篡改的 payload", async (t) => {
  const cases: Array<[string, (packagePath: string) => Promise<void>]> = [
    ["dotdot", async (path) => mutateManifest(path, (value) => { value.files[0].path = "../escape"; })],
    ["反斜杠", async (path) => mutateManifest(path, (value) => { value.files[0].path = "bad\\path"; })],
    ["Windows ADS", async (path) => mutateManifest(path, (value) => { value.files[0].path = "safe:stream"; })],
    ["设备名", async (path) => mutateManifest(path, (value) => { value.files[0].path = "CON"; })],
    ["大小写重复", async (path) => mutateManifest(path, (value) => { value.files.push({ ...value.files[0], path: value.files[0].path.toUpperCase() }); })],
    ["缺失", async (path) => rm(join(path, "payload", "books", "book", "source.txt"))],
    ["额外", async (path) => writeFile(join(path, "payload", "extra.txt"), "extra")],
    ["bytes/hash", async (path) => writeFile(join(path, "payload", "books", "book", "source.txt"), "tampered")],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, "package");
      await createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
      await mutate(packagePath);
      const target = join(current.root, "target");
      await assert.rejects(restoreProjectPackage(packagePath, target));
      await assert.rejects(readFile(target));
    } finally { await cleanup(current); }
  });
});

test("链接、Junction 或硬链接不能进入项目包", async (t) => {
  await t.test("硬链接", async () => {
    const current = await fixture();
    try {
      await link(join(current.dataRoot, "books", "book", "source.txt"), join(current.root, "source-link.txt"));
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath }), /普通独占文件/);
    } finally { await cleanup(current); }
  });
  await t.test("符号链接或 Junction", async (context) => {
    const current = await fixture();
    try {
      const source = join(current.dataRoot, "books", "book", "source.txt");
      await rm(source);
      try { await symlink(join(current.root, "outside.txt"), source, "file"); } catch (error) {
        context.skip(`当前平台不能创建符号链接：${(error as Error).message}`); return;
      }
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath }));
    } finally { await cleanup(current); }
  });
  await t.test("父目录 Junction", async (context) => {
    const current = await fixture();
    const bookDirectory = join(current.dataRoot, "books", "book");
    let linked = false;
    try {
      const outside = join(current.root, "outside-book");
      await mkdir(outside);
      await writeFile(join(outside, "source.txt"), "真实原文");
      await rm(bookDirectory, { recursive: true });
      try { await symlink(outside, bookDirectory, "junction"); linked = true; } catch (error) {
        context.skip(`当前平台不能创建 Junction：${(error as Error).message}`); return;
      }
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath }), /父目录/);
    } finally {
      if (linked) await unlink(bookDirectory);
      await cleanup(current);
    }
  });
});

test("首版拒绝混有第二个系列项目的数据根", async () => {
  const current = await fixture();
  try {
    current.connection.database.prepare("INSERT INTO series_projects (id,book_id,title,created_at,updated_at) VALUES ('other','book','其他项目',2,2)").run();
    await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath }), /恰好一个系列项目/);
  } finally { await cleanup(current); }
});

test("发布写入、同步或 rename 失败不泄漏且覆盖失败恢复旧包", async (t) => {
  await t.test("写入阶段失败", async () => {
    const current = await fixture();
    try {
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath },
        { afterCopy: async () => { throw new Error("write-fault"); } }), /write-fault/);
      assert.deepEqual((await readdir(current.root)).filter((name) => name.includes(".tmp") || name.endsWith(".backup")), []);
    } finally { await cleanup(current); }
  });
  await t.test("同步失败", async () => {
    const current = await fixture();
    try {
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath: join(current.root, "package"), finalManifestRelativePath: current.finalManifestRelativePath },
        { syncDirectory: async () => { throw new Error("sync-fault"); } }), /sync-fault/);
      assert.deepEqual((await readdir(current.root)).filter((name) => name.includes(".tmp") || name.endsWith(".backup")), []);
    } finally { await cleanup(current); }
  });
  await t.test("覆盖 rename 失败", async () => {
    const current = await fixture();
    try {
      const packagePath = join(current.root, "package");
      await mkdir(packagePath);
      await writeFile(join(packagePath, "old.txt"), "old");
      await assert.rejects(createProjectPackage(current.connection.database, current.dataRoot,
        { packagePath, finalManifestRelativePath: current.finalManifestRelativePath }, {
          rename: async (source, target) => {
            if (String(source).includes(".tmp") && target === packagePath) throw new Error("rename-fault");
            await rename(source, target);
          },
        }), /rename-fault/);
      assert.equal(await readFile(join(packagePath, "old.txt"), "utf8"), "old");
      assert.deepEqual((await readdir(current.root)).filter((name) => name.includes(".tmp") || name.endsWith(".backup")), []);
    } finally { await cleanup(current); }
  });
});

test("恢复拒绝已存在目标，发布失败也不创建半成品目标", async () => {
  const current = await fixture();
  try {
    const packagePath = join(current.root, "package");
    await createProjectPackage(current.connection.database, current.dataRoot,
      { packagePath, finalManifestRelativePath: current.finalManifestRelativePath });
    const existing = join(current.root, "existing");
    await mkdir(existing);
    await assert.rejects(restoreProjectPackage(packagePath, existing), /完全不存在/);
    const target = join(current.root, "target");
    await assert.rejects(restoreProjectPackage(packagePath, target, {
      rename: async () => { throw new Error("restore-rename-fault"); },
    }), /restore-rename-fault/);
    await assert.rejects(readFile(target));
    assert.deepEqual((await readdir(current.root)).filter((name) => name.includes(".tmp") || name.endsWith(".backup")), []);
  } finally { await cleanup(current); }
});
