import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobManager, validateOptions, validateCheckpoint } from "../jobs.mjs";
import { auditState } from "../audit.mjs";
import { createState, crawl } from "../core.mjs";

const root =
  process.env.SSM_TEST_DIR ||
  path.join(
    process.platform === "win32" ? "E:/Codex/temp" : os.tmpdir(),
    "search-suggest-map-tests",
    String(process.pid),
  );
await fs.mkdir(root, { recursive: true });
const fixture = {
  研究: ["研究方法", "研究工具"],
  研究方法: ["访谈"],
  研究工具: ["问卷"],
};
const observe = (term) => ({
  source: "visible_search_dropdown",
  suggestions: fixture[term] || [],
  observedAt: new Date().toISOString(),
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const limit = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > limit) throw new Error("test timed out");
    await pause(10);
  }
}
async function manager(name, factory) {
  const m = new JobManager({
    dataDir: path.join(root, name, "data"),
    workDir: path.join(root, name, "work"),
    providerFactory:
      factory ||
      (() => ({ get: async (p, t) => observe(t), close: async () => {} })),
  });
  await m.init();
  return m;
}

test("GUI options reject malformed or explosive configuration inputs", () => {
  assert.deepEqual(validateOptions({ seeds: "  研究\n研究\n 工具 " }).seeds, [
    "研究",
    "工具",
  ]);
  for (const bad of [
    null,
    [],
    { seeds: [{}] },
    { seeds: [] },
    { seeds: ["a"], depth: 0 },
    { seeds: ["a"], delayMs: 1 },
    { seeds: ["a"], platform: "evil" },
    { seeds: ["a"], maxQueries: -1 },
  ])
    assert.throws(() => validateOptions(bad));
});
test("complete run produces an audited export, never queries boundary nodes", async () => {
  const calls = [],
    m = await manager("complete", () => ({
      get: async (p, t) => {
        calls.push(t);
        return observe(t);
      },
      close: async () => {},
    }));
  const job = await m.create({ seeds: ["研究"], depth: 2 });
  m.start(job.id);
  await m.get(job.id).promise;
  const j = m.get(job.id);
  assert.equal(j.meta.status, "complete");
  assert.equal(j.meta.audit.complete, true);
  assert.equal(calls.length, 3);
  assert.equal(m.active, null);
  assert((await fs.stat(path.join(j.dir, "完整性核验.json"))).size > 0);
  assert.equal(j.state.nodes.length, 5);
  auditState(j.state);
  const reloaded = new JobManager({ dataDir: m.dataDir, workDir: m.workDir });
  await reloaded.init();
  assert.equal(reloaded.list()[0].status, "complete");
});
test("CAPTCHA stays in same session; no retry until explicit continue", async () => {
  let attempts = 0,
    closed = 0,
    instances = 0;
  const m = await manager("captcha", () => {
    instances++;
    return {
      get: async (p, t) => {
        attempts++;
        if (attempts === 1) throw new Error("平台要求验证：请人工处理");
        return observe(t);
      },
      close: async () => {
        closed++;
      },
    };
  });
  const j = await m.create({ seeds: ["研究"], depth: 1 });
  m.start(j.id);
  await until(() => m.get(j.id).meta.status === "awaiting_verification");
  await pause(50);
  assert.equal(attempts, 1);
  assert.equal(closed, 0);
  assert.equal(instances, 1);
  assert.throws(() => m.start(j.id));
  m.continue(j.id);
  await m.get(j.id).promise;
  assert.equal(m.get(j.id).meta.status, "complete");
  assert.equal(attempts, 2);
  assert.equal(instances, 1);
  assert.equal(closed, 1);
});
test("pause while waiting saves checkpoint and frees browser for another task", async () => {
  let closed = false;
  const m = await manager("pause-verification", () => ({
    get: async () => {
      throw new Error("平台要求验证");
    },
    close: async () => {
      closed = true;
    },
  }));
  const j = await m.create({ seeds: ["研究"], depth: 2 });
  m.start(j.id);
  await until(() => m.get(j.id).gate);
  m.pause(j.id);
  await m.get(j.id).promise;
  assert.equal(m.get(j.id).meta.status, "paused");
  assert.equal(m.get(j.id).state.observations.length, 0);
  assert(closed);
  assert.equal(m.active, null);
});
test("pause after current query and resume do not repeat successful queries", async () => {
  let release;
  const calls = [],
    m = await manager("pause-resume", () => ({
      get: async (p, t) => {
        calls.push(t);
        if (calls.length === 1) await new Promise((r) => (release = r));
        return observe(t);
      },
      close: async () => {},
    }));
  const j = await m.create({ seeds: ["研究"], depth: 2 });
  m.start(j.id);
  await until(() => release);
  m.pause(j.id);
  release();
  await m.get(j.id).promise;
  assert.equal(calls.length, 1);
  assert.equal(m.get(j.id).meta.status, "paused");
  m.start(j.id);
  await m.get(j.id).promise;
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls).size, 3);
  assert.equal(m.get(j.id).meta.status, "complete");
});
test("query cap is counted across manual verification within one invocation", async () => {
  let attempts = 0;
  const m = await manager("cap", () => ({
    get: async (p, t) => {
      attempts++;
      if (attempts === 2) throw new Error("平台要求验证");
      return observe(t);
    },
    close: async () => {},
  }));
  const j = await m.create({ seeds: ["研究"], depth: 2, maxQueries: 2 });
  m.start(j.id);
  await until(() => m.get(j.id).gate);
  m.continue(j.id);
  await m.get(j.id).promise;
  assert.equal(m.get(j.id).meta.status, "paused");
  assert.equal(m.snapshot(m.get(j.id)).completedQueries, 2);
  m.start(j.id);
  await m.get(j.id).promise;
  assert.equal(m.get(j.id).meta.status, "complete");
});
test("single running task / manual platform session excludes competing jobs", async () => {
  let release;
  const m = await manager("exclusive", () => ({
    get: async (p, t) => {
      await new Promise((r) => (release = r));
      return observe(t);
    },
    close: async () => {},
    open: async () => {},
  }));
  const a = await m.create({ seeds: ["研究"], depth: 1 }),
    b = await m.create({ seeds: ["工具"], depth: 1 });
  m.start(a.id);
  await until(() => release);
  assert.throws(() => m.start(b.id), /已有/);
  await assert.rejects(m.openSession("douyin"), /已有/);
  release();
  await m.get(a.id).promise;
  await m.openSession("douyin");
  assert.throws(() => m.start(b.id), /已有/);
  await m.closeSession();
  assert.equal(m.sessionInfo(), null);
});
test("import validates live receipts and rejects corrupted IDs or missing relations", async () => {
  const state = createState({
    seeds: ["研究"],
    platforms: ["douyin"],
    depth: 2,
  });
  await crawl(state, { get: async (p, t) => observe(t) });
  validateCheckpoint(state);
  for (const mutate of [
    (s) => (s.nodes[0].id = "x"),
    (s) => s.edges.pop(),
    (s) => (s.observations[0].source = "offline_test_fixture"),
    (s) => (s.nodes[1].parent = s.nodes[1].id),
  ]) {
    const bad = structuredClone(state);
    mutate(bad);
    assert.throws(() => validateCheckpoint(bad));
  }
  const m = await manager("import");
  const j = await m.import(state);
  assert.equal(j.status, "complete");
  assert(j.audit.complete);
});
test("service restart recovers interrupted nodes without claiming completion", async () => {
  const m = await manager("restart");
  const j = await m.create({ seeds: ["研究"], depth: 2 }),
    internal = m.get(j.id);
  internal.meta.status = "running";
  internal.state.status = "running";
  internal.state.nodes[0].status = "querying";
  await m.persist(internal);
  const reloaded = new JobManager({ dataDir: m.dataDir, workDir: m.workDir });
  await reloaded.init();
  assert.equal(reloaded.get(j.id).meta.status, "paused");
  assert.equal(reloaded.get(j.id).state.nodes[0].status, "pending");
});
test("audit refuses partial or malformed results", async () => {
  const s = createState({ seeds: ["研究"], platforms: ["douyin"], depth: 2 });
  assert.throws(() => auditState(s));
  await crawl(s, { get: async (p, t) => observe(t) });
  s.observations.pop();
  assert.throws(() => auditState(s));
});

test("delete moves only task contents to trash; restore preserves data across restart", async () => {
  const m = await manager("trash-roundtrip"),
    j = await m.create({ seeds: ["研究"], depth: 2 });
  m.start(j.id);
  await m.get(j.id).promise;
  await fs.mkdir(path.join(m.workDir, "profiles"), { recursive: true });
  await fs.writeFile(path.join(m.workDir, "profiles", "sentinel"), "keep");
  const removed = await m.delete(j.id);
  assert.throws(() => m.get(j.id));
  await assert.rejects(fs.stat(j.outputDir), { code: "ENOENT" });
  const list = await m.trashList();
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, j.id);
  assert.equal(
    await fs.readFile(path.join(m.workDir, "profiles", "sentinel"), "utf8"),
    "keep",
  );
  const reloaded = new JobManager({ dataDir: m.dataDir, workDir: m.workDir });
  await reloaded.init();
  assert.equal(reloaded.list().length, 0);
  const restored = await reloaded.restore(removed.trashId);
  assert.equal(restored.id, j.id);
  assert.equal(restored.uniqueKeywords, 5);
  assert.equal(restored.status, "complete");
  assert.equal((await reloaded.trashList()).length, 0);
});
test("delete running task waits for current query, then closes browser before moving files", async () => {
  let release,
    closed = false;
  const m = await manager("delete-active", () => ({
    get: async (p, t) => {
      await new Promise((r) => (release = r));
      return observe(t);
    },
    close: async () => {
      closed = true;
    },
  }));
  const j = await m.create({ seeds: ["研究"], depth: 2 });
  m.start(j.id);
  await until(() => release);
  let deleted = false;
  const removal = m.delete(j.id).then((r) => {
    deleted = true;
    return r;
  });
  assert.throws(() => m.start(j.id), /删除/);
  await pause(30);
  assert(!deleted);
  release();
  const record = await removal;
  assert(closed);
  assert.equal(m.active, null);
  const restored = await m.restore(record.trashId);
  assert.equal(restored.status, "paused");
  assert.equal(restored.completedQueries, 1);
  assert.equal(restored.pendingQueries, 2);
});
test("delete refuses a foreign run lock and a directory outside the task root", async () => {
  const m = await manager("delete-boundary"),
    j = await m.create({ seeds: ["研究"], depth: 1 });
  const lock = path.join(j.outputDir, "run.lock");
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(m.delete(j.id), /其他程序/);
  await fs.unlink(lock);
  assert(m.get(j.id));
  const actual = m.get(j.id),
    original = actual.dir;
  actual.dir = m.workDir;
  await assert.rejects(m.delete(j.id), /目录/);
  actual.dir = original;
  assert((await fs.stat(m.workDir)).isDirectory());
  assert.equal((await m.trashList()).length, 0);
});
