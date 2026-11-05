import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobManager, validateOptions, validateCheckpoint, pauseKind } from "../jobs.mjs";
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
    { seeds: ["a"], depth: 11 },
  ])
    assert.throws(() => validateOptions(bad));
});

test("unconfirmed dropdown text never implies a CAPTCHA or login",()=>{
  assert.equal(pauseKind("未确认联想结果：当前页面未返回可验证下拉词；可能需要登录"),"result");
  assert.equal(pauseKind("等待联想结果超时：小红书「验证码」仍未返回"),"result");
  assert.equal(pauseKind("平台要求验证：已暂停，请人工处理"),"verification");
  assert.equal(pauseKind("平台限流429：已暂停，不继续请求"),"restriction");
  assert.equal(pauseKind("平台明确要求登录后搜索：关闭普通登录提示后仍需人工登录"),"login");
  assert.equal(pauseKind("普通保存失败，错误文本提到了验证"),null);
});

test("unconfirmed words are deferred while remaining words finish, then use a result gate and retry only failures",async()=>{
  let fail=true,attempts=0;
  const calls=[];
  const m=await manager("deferred-results",()=>({get:async(platform,term)=>{
    calls.push(term);
    if(term==="研究方法"&&fail){attempts++;const error=new Error("等待联想结果超时：平台响应3002");error.code="RESULT_UNCONFIRMED";throw error;}
    return observe(term);
  },close:async()=>{}}));
  const task=await m.create({seeds:["研究"],depth:2});
  m.start(task.id);
  await until(()=>m.get(task.id).gate);
  const result=m.snapshot(m.get(task.id));
  assert.equal(result.status,"awaiting_result");
  assert.equal(result.completedQueries,2);
  assert.equal(result.unconfirmedQueries,1);
  assert.equal(result.pendingQueries,1);
  assert.equal(attempts,1);
  assert(calls.includes("研究工具"));
  const cp=JSON.parse(await fs.readFile(path.join(task.outputDir,"checkpoint.json"),"utf8"));
  validateCheckpoint(cp);
  fail=false;m.continue(task.id);
  await m.get(task.id).promise;
  assert.equal(m.get(task.id).meta.status,"complete");
  assert.equal(calls.filter(t=>t==="研究").length,1);
  assert.equal(calls.filter(t=>t==="研究工具").length,1);
  assert.equal(calls.filter(t=>t==="研究方法").length,2);
  auditState(m.get(task.id).state);
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
test("legacy query cap cannot stop a run, including after manual verification", async () => {
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
  assert.equal(m.get(j.id).meta.status, "complete");
  assert.equal(m.snapshot(m.get(j.id)).completedQueries, 3);
  assert.equal(m.get(j.id).meta.options.maxQueries, undefined);
});

test("editing depth extends completed branches without repeating successful queries", async () => {
  const calls = [];
  const m = await manager("edit-depth", () => ({
    get: async (p, t) => { calls.push(t); return observe(t); }, close: async () => {},
  }));
  const task = await m.create({ seeds: ["研究"], depth: 1 });
  m.start(task.id);
  await m.get(task.id).promise;
  const before = structuredClone(m.get(task.id).state.observations);
  const edited = await m.update(task.id, { depth: 2, delayMs: 3000 });
  assert.equal(edited.status, "paused");
  assert.equal(edited.pendingQueries, 2);
  assert.equal(edited.audit, undefined);
  assert.deepEqual(m.get(task.id).state.observations, before);
  await assert.rejects(fs.stat(path.join(task.outputDir, "完整性核验.json")), {code:"ENOENT"});
  await assert.rejects(m.update(task.id, { depth: 1 }), /减少层数/);
  await assert.rejects(m.update(task.id, { seeds: ["别的词"] }), /新建任务/);
  await assert.rejects(m.update(task.id, { maxQueries: 7 }), /仅可编辑/);
  await assert.rejects(m.update(task.id, { delayMs: 1 }), /间隔/);
  const reloaded = new JobManager({ dataDir: m.dataDir, workDir: m.workDir,
    providerFactory: m.providerFactory });
  await reloaded.init();
  assert.equal(reloaded.get(task.id).meta.options.depth, 2);
  assert.equal(reloaded.get(task.id).meta.options.delayMs, 3000);
  reloaded.start(task.id);
  await reloaded.get(task.id).promise;
  assert.equal(reloaded.get(task.id).meta.status, "complete");
  assert.deepEqual(calls, ["研究", "研究方法", "研究工具"]);
  auditState(reloaded.get(task.id).state);
});

test("edit preflight protects active tasks and foreign locks; unsampled scope can change", async () => {
  let release;
  const m = await manager("edit-boundaries", () => ({ get: async (p,t) => {
    await new Promise(r => release = r); return observe(t);
  }, close: async () => {} }));
  const task = await m.create({ seeds: ["初始"], depth: 3 });
  await m.update(task.id, { seeds: ["研究"], platform: "both", depth: 1 });
  assert.equal(m.get(task.id).state.nodes.length, 2);
  assert.equal(m.get(task.id).state.nodes[0].term, "研究");
  const lock = path.join(task.outputDir, "run.lock");
  await fs.writeFile(lock, JSON.stringify({pid: process.pid}));
  const before = structuredClone(m.get(task.id).meta.options);
  await assert.rejects(m.update(task.id, {delayMs: 3000}), /其他程序/);
  assert.deepEqual(m.get(task.id).meta.options, before);
  assert.equal(m.get(task.id).editing, false);
  await fs.unlink(lock);
  const saving = m.update(task.id, {platform: "douyin"});
  assert.throws(() => m.start(task.id), /保存编辑/);
  await assert.rejects(m.delete(task.id), /保存编辑/);
  await saving;
  m.start(task.id);
  await until(() => release);
  await assert.rejects(m.update(task.id, {depth: 2}), /先暂停/);
  release();
  await m.get(task.id).promise;
});

test("restart removes old query caps while retaining paused task data", async () => {
  const m = await manager("migrate-cap");
  const task = await m.create({seeds: ["研究"], depth: 2});
  const job = m.get(task.id);
  job.meta.options.maxQueries = 7;
  job.meta.status = job.state.status = "paused";
  job.meta.message = job.state.stopReason = "达到本次查询上限（并非遍历完成）";
  await m.persist(job);
  const reloaded = new JobManager({dataDir:m.dataDir,workDir:m.workDir,providerFactory:m.providerFactory});
  await reloaded.init();
  assert.equal(reloaded.get(task.id).meta.options.maxQueries, undefined);
  assert.equal(reloaded.get(task.id).meta.status, "paused");
  assert.match(reloaded.get(task.id).meta.message, /限制已移除/);
  reloaded.start(task.id);
  await reloaded.get(task.id).promise;
  assert.equal(reloaded.get(task.id).meta.status, "complete");
  assert.equal(reloaded.snapshot(reloaded.get(task.id)).completedQueries, 3);
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
