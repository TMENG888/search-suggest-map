import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  createState,
  crawl,
  exportAll,
  save,
  stats,
  idFor,
  normalize,
  now,
} from "./core.mjs";
import { mindmapHTML } from "./mindmap-template.mjs";
import { BrowserProvider } from "./browser.mjs";
import { auditState } from "./audit.mjs";

export const EXPORTS = new Set([
  "mindmap.html",
  "mindmap.mm",
  "mindmap.md",
  "keywords.csv",
  "relations.csv",
  "results.json",
  "checkpoint.json",
  "完整性核验.json",
]);
const idleStatuses = new Set(["ready", "paused", "error", "partial"]);
export function pauseKind(reason) {
  // Match explicit error categories, never the word 验证 inside 可验证下拉词.
  if (/^平台要求验证(?:[：:]|$)/.test(reason)) return "verification";
  if (/^(?:平台限制[：:]|平台限流429[：:])/.test(reason)) return "restriction";
  if (/^(?:平台明确要求登录后搜索|需要人工登录|登录弹窗)/.test(reason)) return "login";
  if (/^(?:未确认联想结果|等待联想结果超时|部分联想结果未确认)/.test(reason)) return "result";
  return null;
}
function invalid(message) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}
export function validateOptions(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    invalid("任务配置应为一个对象。");
  if (Array.isArray(raw.seeds) && raw.seeds.some((s) => typeof s !== "string"))
    invalid("起始词必须是文本。");
  const seeds = [],
    seenSeeds = new Set();
  for (const value of Array.isArray(raw.seeds)
    ? raw.seeds
    : String(raw.seeds || "").split(/\r?\n/)) {
    const seed = normalize(value),
      key = seed.toLocaleLowerCase();
    if (seed && !seenSeeds.has(key)) {
      seeds.push(seed);
      seenSeeds.add(key);
    }
  }
  if (!seeds.length || seeds.length > 30 || seeds.some((s) => s.length > 200))
    invalid("请输入1至30个起始词，每词不超过200字。");
  const platform = raw.platform || "douyin";
  if (!["douyin", "xiaohongshu", "both"].includes(platform))
    invalid("平台参数无效。");
  const depth = Number(raw.depth ?? 3),
    delayMs = Number(raw.delayMs ?? 5000);
  if (!Number.isInteger(depth) || depth < 1 || depth > 10)
    invalid("递归层数应为1至10。");
  if (!Number.isInteger(delayMs) || delayMs < 1500 || delayMs > 60000)
    invalid("查询间隔应为1500至60000毫秒。");
  return { seeds, platform, depth, delayMs };
}
export function validateCheckpoint(s) {
  if (
    !s ||
    s.version !== 1 ||
    !s.config ||
    !Array.isArray(s.nodes) ||
    !Array.isArray(s.edges) ||
    !Array.isArray(s.observations)
  )
    invalid("不是受支持的checkpoint.json或results.json。");
  if (
    !Array.isArray(s.config.seeds) ||
    !s.config.seeds.length ||
    s.config.seeds.some((s) => typeof s !== "string" || normalize(s) !== s) ||
    new Set(s.config.seeds.map((s) => s.toLocaleLowerCase())).size !==
      s.config.seeds.length
  )
    invalid("检查点起始词无效。");
  if (
    !Array.isArray(s.config.platforms) ||
    !s.config.platforms.length ||
    new Set(s.config.platforms).size !== s.config.platforms.length ||
    s.config.platforms.some((p) => !["douyin", "xiaohongshu"].includes(p))
  )
    invalid("检查点的平台无效。");
  validateOptions({
    ...s.config,
    platform: s.config.platforms.length === 2 ? "both" : s.config.platforms[0],
  });
  if (
    s.nodes.length > 100000 ||
    s.edges.length > 1000000 ||
    s.observations.length > 100000
  )
    invalid("检查点过大。");
  const ids = new Set();
  for (const n of s.nodes) {
    if (
      typeof n.term !== "string" ||
      !normalize(n.term) ||
      n.term.length > 200 ||
      !s.config.platforms.includes(n.platform) ||
      n.id !== idFor(n.platform, n.term) ||
      ids.has(n.id) ||
      !Number.isInteger(n.depth) ||
      n.depth < 0 ||
      n.depth > s.config.depth ||
      !["pending", "querying", "unconfirmed", "done", "depth_boundary"].includes(n.status)
    )
      invalid("检查点包含非法节点。");
    if (n.depth === s.config.depth && n.status !== "depth_boundary")
      invalid("检查点的深度边界状态无效。");
    if (n.depth < s.config.depth && n.status === "depth_boundary")
      invalid("检查点存在未完成的内部节点。");
    ids.add(n.id);
  }
  if (!s.nodes.length) invalid("检查点没有关键词。");
  const roots = s.nodes.filter((n) => n.depth === 0);
  if (
    roots.length !== s.config.seeds.length * s.config.platforms.length ||
    roots.some((n) => n.parent || !s.config.seeds.includes(n.term))
  )
    invalid("起始词与检查点不一致。");
  for (const n of s.nodes)
    if (n.depth > 0 && !ids.has(n.parent)) invalid("检查点缺少父词。");
  const by = new Map(s.nodes.map((n) => [n.id, n]));
  const edgeSet = new Set();
  for (const e of s.edges) {
    const from = by.get(e.from),
      to = by.get(e.to),
      key = e.from + "\0" + e.to;
    if (
      !from ||
      !to ||
      from.platform !== to.platform ||
      from.depth >= s.config.depth ||
      to.depth > from.depth + 1 ||
      edgeSet.has(key) ||
      !Number.isInteger(e.rank) ||
      e.rank < 1
    )
      invalid("检查点的关系无效。");
    edgeSet.add(key);
  }
  for (const n of s.nodes)
    if (
      n.parent &&
      (!edgeSet.has(n.parent + "\0" + n.id) ||
        by.get(n.parent).depth !== n.depth - 1)
    )
      invalid("检查点的树形层数不一致。");
  const queried = new Set();
  for (const o of s.observations) {
    const n = by.get(o.nodeId);
    if (
      !n ||
      n.status !== "done" ||
      n.term !== o.query ||
      n.platform !== o.platform ||
      queried.has(n.id) ||
      !Array.isArray(o.suggestions) ||
      o.suggestions.some((t) => typeof t !== "string") ||
      !["visible_search_dropdown", "browser_autocomplete_response"].includes(
        o.source,
      )
    )
      invalid("检查点查询回执无效，不能混入非实采数据。");
    queried.add(n.id);
  }
  if (s.nodes.some((n) => n.status === "done" && !queried.has(n.id)))
    invalid("已完成节点缺少采集回执。");
  // Validate observation relations even on a partially completed task.
  for (const o of s.observations)
    for (const term of o.suggestions) {
      const normalized = normalize(term);
      if (!normalized || normalized.length > 200) continue;
      const to = idFor(o.platform, normalized);
      if (to !== o.nodeId && !edgeSet.has(o.nodeId + "\0" + to))
        invalid("检查点遗漏原始联想关系。");
    }
  return structuredClone(s);
}

export class JobManager extends EventEmitter {
  constructor({
    dataDir,
    workDir,
    providerFactory = (opts) => new BrowserProvider(opts),
  }) {
    super();
    this.dataDir = dataDir;
    this.workDir = workDir;
    this.providerFactory = providerFactory;
    this.jobs = new Map();
    this.active = null;
    this.session = null;
    this.closing = false;
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.workDir, { recursive: true });
    for (const name of await fs.readdir(this.dataDir)) {
      if (!/^[0-9a-f-]{36}$/.test(name)) continue;
      try {
        const dir = path.join(this.dataDir, name),
          meta = JSON.parse(
            await fs.readFile(path.join(dir, "task.json"), "utf8"),
          );
        if (meta.id !== name) continue;
        const state = validateCheckpoint(
          JSON.parse(
            await fs.readFile(path.join(dir, "checkpoint.json"), "utf8"),
          ),
        );
        const lockFile = path.join(dir, "run.lock");
        try {
          const lock = JSON.parse(await fs.readFile(lockFile, "utf8"));
          let alive = false;
          try {
            process.kill(lock.pid, 0);
            alive = true;
          } catch (e) {
            if (e.code !== "ESRCH") alive = true;
          }
          if (alive) continue;
          await fs.unlink(lockFile);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        for (const n of state.nodes)
          if (n.status === "querying") n.status = "pending";
        // Migrate old test caps without changing manual pause or saved results.
        const hadLegacyCap = Object.hasOwn(meta.options, "maxQueries");
        meta.options = validateOptions(meta.options);
        if (/达到本次查询上限/.test(meta.message || "")) {
          meta.message = "查询次数限制已移除，可继续遍历至第" + meta.options.depth + "层。";
          state.stopReason = meta.message;
        }
        const legacyResultWait = meta.status === "awaiting_result" &&
          !state.nodes.some(n => ["pending", "querying"].includes(n.status)) &&
          state.nodes.some(n => n.status === "unconfirmed");
        if (legacyResultWait) {
          meta.status = state.status = "partial";
          meta.message = state.stopReason = "本轮采集已结束，未确认词已保留，可按需重试；无需继续等待。";
        }
        if (!["complete", "paused", "ready", "error", "partial"].includes(meta.status)) {
          meta.status = "paused";
          meta.message = "上次服务已停止，可从断点继续。";
          state.status = "paused";
          state.stopReason = meta.message;
        }
        const job = {
          meta,
          state,
          dir,
          logs: [],
          provider: null,
          gate: null,
          stop: false,
        };
        this.jobs.set(name, job);
        await this.persist(job);
        if (hadLegacyCap || legacyResultWait) await exportAll(state, dir, mindmapHTML);
      } catch (error) {
        this.emit("warning", {
          message: "跳过损坏或仍被占用的任务：" + name + " " + error.message,
        });
      }
    }
  }
  snapshot(job, { graph = false } = {}) {
    return {
      ...job.meta,
      deleting: !!job.deleting,
      editing: !!job.editing,
      ...stats(job.state),
      byDepth: Array.from(
        { length: job.state.config.depth + 1 },
        (_, d) => job.state.nodes.filter((n) => n.depth === d).length,
      ),
      current: job.state.nodes.filter(n => n.status === "querying")
        .map(n => (n.platform === "douyin" ? "抖音：" : "小红书：") + n.term).join(" · ") || null,
      logs: job.logs.slice(-100),
      ...(graph
        ? {
            nodes: job.state.nodes.map(
              ({ id, platform, term, depth, parent, status, error }) => ({
                id,
                platform,
                term,
                depth,
                parent,
                status,
                error,
              }),
            ),
            edges: job.state.edges,
          }
        : {}),
      files: job.meta.updated
        ? [
            "mindmap.html",
            "mindmap.mm",
            "mindmap.md",
            "keywords.csv",
            "relations.csv",
            "results.json",
            "checkpoint.json",
            ...(job.meta.audit ? ["完整性核验.json"] : []),
          ]
        : [],
    };
  }
  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.meta.created.localeCompare(a.meta.created))
      .map((j) => this.snapshot(j));
  }
  get(id) {
    const j = this.jobs.get(id);
    if (!j) throw Object.assign(new Error("任务不存在。"), { statusCode: 404 });
    return j;
  }
  async persist(j) {
    j.meta.updated = now();
    await save(path.join(j.dir, "task.json"), j.meta);
    await save(path.join(j.dir, "checkpoint.json"), j.state);
  }
  async checkedTaskDirectory(id, directory) {
    if (!/^[0-9a-f-]{36}$/.test(id)) invalid("任务编号无效。");
    const root = await fs.realpath(this.dataDir),
      expected = path.join(root, id),
      actual = await fs.realpath(directory),
      info = await fs.lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      path.relative(expected, actual) !== ""
    )
      throw new Error("任务目录不在预期的数据目录内，操作已停止。");
    return actual;
  }
  async trashRoot() {
    const root = await fs.realpath(this.dataDir),
      trash = path.join(root, ".trash");
    await fs.mkdir(trash, { recursive: true });
    const info = await fs.lstat(trash),
      actual = await fs.realpath(trash);
    if (info.isSymbolicLink() || path.relative(trash, actual) !== "")
      throw new Error("回收区目录异常，操作已停止。");
    return actual;
  }
  async trashList() {
    const root = await this.trashRoot(),
      records = [];
    for (const id of await fs.readdir(root)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      try {
        const record = JSON.parse(
          await fs.readFile(path.join(root, id, "deleted.json"), "utf8"),
        );
        if (record.trashId === id) records.push(record);
      } catch {}
    }
    return records.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }
  async delete(id) {
    const j = this.get(id);
    if (j.editing) throw Object.assign(new Error("正在保存编辑，请稍候。"), { statusCode: 409 });
    if (j.deleting)
      throw Object.assign(new Error("任务正在删除，请稍候。"), {
        statusCode: 409,
      });
    j.deleting = true;
    this.notify(j);
    let locked = false,
      original;
    try {
      if (this.active === id) {
        this.pause(id);
        await j.promise;
      }
      original = await this.checkedTaskDirectory(id, j.dir);
      const trash = await this.trashRoot(),
        trashId = randomUUID(),
        target = path.join(trash, trashId);
      // Resolve and verify both directory boundaries before moving a subtree.
      if (path.dirname(target) !== trash)
        throw new Error("回收区目标路径无效。");
      const lock = await fs.open(path.join(original, "run.lock"), "wx");
      locked = true;
      try {
        await lock.writeFile(
          JSON.stringify({
            pid: process.pid,
            action: "delete",
            started: now(),
          }),
        );
      } finally {
        await lock.close();
      }
      const record = {
        trashId,
        taskId: id,
        seeds: j.meta.options.seeds,
        platform: j.meta.options.platform,
        depth: j.meta.options.depth,
        deletedAt: now(),
        ...stats(j.state),
      };
      await save(path.join(original, "deleted.json"), record);
      await fs.rename(original, target);
      this.jobs.delete(id);
      locked = false;
      await fs.unlink(path.join(target, "run.lock")).catch(() => {});
      this.emit("update", { id, deleted: true });
      return { id, trashId, message: "任务和采集内容已移入回收区" };
    } catch (error) {
      if (error.code === "EEXIST")
        throw Object.assign(new Error("任务正被其他程序使用，暂不能删除。"), {
          statusCode: 409,
        });
      throw error;
    } finally {
      if (locked)
        await fs.unlink(path.join(original, "run.lock")).catch(() => {});
      j.deleting = false;
      if (this.jobs.has(id)) this.notify(j);
    }
  }
  async restore(trashId) {
    if (!/^[0-9a-f-]{36}$/.test(trashId)) invalid("回收记录编号无效。");
    const root = await fs.realpath(this.dataDir),
      trash = await this.trashRoot(),
      directory = path.join(trash, trashId),
      actual = await fs.realpath(directory),
      info = await fs.lstat(directory);
    if (info.isSymbolicLink() || path.relative(directory, actual) !== "")
      throw new Error("回收记录目录异常。");
    const record = JSON.parse(
      await fs.readFile(path.join(actual, "deleted.json"), "utf8"),
    );
    if (record.trashId !== trashId || !/^[0-9a-f-]{36}$/.test(record.taskId))
      invalid("回收记录无效。");
    const id = record.taskId,
      target = path.join(root, id);
    if (this.jobs.has(id))
      throw Object.assign(new Error("同一任务已经存在。"), { statusCode: 409 });
    try {
      await fs.access(target);
      throw Object.assign(new Error("原任务目录已存在，未覆盖。"), {
        statusCode: 409,
      });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const state = validateCheckpoint(
        JSON.parse(
          await fs.readFile(path.join(actual, "checkpoint.json"), "utf8"),
        ),
      ),
      meta = JSON.parse(
        await fs.readFile(path.join(actual, "task.json"), "utf8"),
      );
    if (meta.id !== id) invalid("任务记录编号不一致。");
    meta.options = validateOptions(meta.options);
    const lock = await fs.open(path.join(actual, "run.lock"), "wx");
    try {
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, action: "restore" }),
      );
    } finally {
      await lock.close();
    }
    try {
      await fs.rename(actual, target);
    } catch (e) {
      await fs.unlink(path.join(actual, "run.lock")).catch(() => {});
      throw e;
    }
    await fs.unlink(path.join(target, "run.lock")).catch(() => {});
    await fs.unlink(path.join(target, "deleted.json")).catch(() => {});
    for (const n of state.nodes)
      if (n.status === "querying") n.status = "pending";
    if (!["complete", "ready", "paused", "error", "partial"].includes(meta.status)) {
      meta.status = "paused";
      state.status = "paused";
    }
    meta.outputDir = target;
    meta.message = "已从回收区恢复";
    const j = {
      meta,
      state,
      dir: target,
      logs: [],
      provider: null,
      gate: null,
      stop: false,
    };
    this.jobs.set(id, j);
    await this.persist(j);
    this.notify(j);
    return this.snapshot(j, { graph: true });
  }
  notify(j, message) {
    if (message) {
      j.logs.push({ at: now(), message });
      if (j.logs.length > 300) j.logs.shift();
    }
    this.emit("update", {
      id: j.meta.id,
      status: j.meta.status,
      ...stats(j.state),
      message: j.meta.message,
    });
  }
  async create(raw) {
    const options = validateOptions(raw),
      id = randomUUID(),
      dir = path.join(this.dataDir, id);
    const state = createState({
      seeds: options.seeds,
      platforms:
        options.platform === "both"
          ? ["douyin", "xiaohongshu"]
          : [options.platform],
      depth: options.depth,
    });
    const meta = {
      id,
      created: now(),
      status: "ready",
      message: "准备就绪",
      options,
      outputDir: dir,
    };
    const j = {
      meta,
      state,
      dir,
      logs: [],
      provider: null,
      gate: null,
      stop: false,
    };
    this.jobs.set(id, j);
    try {
      await this.persist(j);
      await exportAll(state, dir, mindmapHTML);
    } catch (e) {
      this.jobs.delete(id);
      throw e;
    }
    this.notify(j, "已创建任务");
    return this.snapshot(j, { graph: true });
  }
  async import(raw) {
    const state = validateCheckpoint(raw),
      options = {
        seeds: state.config.seeds,
        platform:
          state.config.platforms.length === 2
            ? "both"
            : state.config.platforms[0],
        depth: state.config.depth,
        delayMs: 5000,
      };
    let audit = null;
    if (state.status === "complete") audit = auditState(state);
    for (const n of state.nodes)
      if (n.status === "querying") n.status = "pending";
    if (!audit && state.status !== "partial") {
      state.status = "paused";
      state.stopReason = "导入断点，可继续采集";
    }
    const id = randomUUID(),
      dir = path.join(this.dataDir, id),
      meta = {
        id,
        created: now(),
        status: audit ? "complete" : state.status === "partial" ? "partial" : "paused",
        message: audit ? "已导入，完整性检查通过" : state.status === "partial" ? state.stopReason : "已导入断点",
        options,
        outputDir: dir,
        audit,
      };
    const j = {
      meta,
      state,
      dir,
      logs: [],
      provider: null,
      gate: null,
      stop: false,
    };
    this.jobs.set(id, j);
    try {
      await this.persist(j);
      await exportAll(state, dir, mindmapHTML);
      if (audit) await save(path.join(dir, "完整性核验.json"), audit);
    } catch (e) {
      this.jobs.delete(id);
      throw e;
    }
    this.notify(j, "已导入实采结果");
    return this.snapshot(j, { graph: true });
  }
  async update(id, patch) {
    const j = this.get(id);
    if (this.closing || this.active === id || j.deleting || j.editing ||
        !["ready", "paused", "error", "complete", "partial"].includes(j.meta.status))
      throw Object.assign(new Error("请先暂停任务，等待保存完成后再编辑。"), { statusCode: 409 });
    if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
        Object.keys(patch).some(key => !["seeds", "platform", "depth", "delayMs"].includes(key)))
      invalid("仅可编辑起始词、平台、递归层数和查询间隔。");
    const options = validateOptions({ ...j.meta.options, ...patch });
    const scopeChanged = JSON.stringify(options.seeds) !== JSON.stringify(j.meta.options.seeds) ||
      options.platform !== j.meta.options.platform;
    const hasResults = j.state.observations.length > 0;
    if (hasResults && scopeChanged)
      invalid("已有采集结果，起始词和平台保持不变；更换请新建任务。");
    if (hasResults && options.depth < j.state.config.depth)
      invalid("已有采集结果时可增加层数；减少层数请新建任务，避免丢失已有数据。");
    j.editing = true;
    let lock;
    try {
      await this.checkedTaskDirectory(id, j.dir);
      try { lock = await fs.open(path.join(j.dir, "run.lock"), "wx"); }
      catch (error) {
        if (error.code === "EEXIST")
          throw Object.assign(new Error("任务被其他程序占用，不能编辑。"), { statusCode: 409 });
        throw error;
      }
      await lock.writeFile(JSON.stringify({ pid: process.pid, started: now(), operation: "edit" }));
      const depthChanged = options.depth !== j.state.config.depth;
      if (!hasResults && (scopeChanged || depthChanged)) {
        j.state = createState({ seeds: options.seeds, platforms: options.platform === "both"
          ? ["douyin", "xiaohongshu"] : [options.platform], depth: options.depth });
        j.meta.status = "ready";
      } else if (depthChanged) {
        j.state.config.depth = options.depth;
        for (const node of j.state.nodes)
          if (node.status === "depth_boundary" && node.depth < options.depth) node.status = "pending";
        j.state.status = "paused";
        j.meta.status = "paused";
        delete j.meta.audit;
        await fs.unlink(path.join(j.dir, "完整性核验.json")).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      j.meta.options = options;
      if (j.meta.status !== "complete" && j.meta.status !== "partial") {
        j.meta.message = "采集设置已保存，继续后遍历至第" + options.depth + "层，无查询次数限制。";
        j.state.stopReason = j.meta.message;
      }
      await this.persist(j);
      await exportAll(j.state, j.dir, mindmapHTML);
    } finally {
      try {
        if (lock) {
          await lock.close();
          await fs.unlink(path.join(j.dir, "run.lock"));
        }
      } finally {
        j.editing = false;
        this.notify(j);
      }
    }
    this.notify(j, "任务设置已更新，保留已采集数据");
    return this.snapshot(j, { graph: true });
  }
  reserve(id) {
    if (this.closing)
      throw Object.assign(new Error("服务正在退出。"), { statusCode: 409 });
    if (this.active || this.session)
      throw Object.assign(
        new Error(
          "已有采集任务或平台浏览器正在使用。请先暂停任务或关闭平台会话。",
        ),
        { statusCode: 409 },
      );
    this.active = id;
  }
  start(id) {
    const j = this.get(id);
    if (j.editing) throw Object.assign(new Error("正在保存编辑，请稍候。"), { statusCode: 409 });
    if (j.deleting)
      throw Object.assign(new Error("任务正在删除，请稍候。"), {
        statusCode: 409,
      });
    if (!idleStatuses.has(j.meta.status))
      throw Object.assign(new Error("当前任务不能启动。"), { statusCode: 409 });
    this.reserve(id);
    j.stop = false;
    j.meta.status = "running";
    j.meta.message = "正在打开平台浏览器";
    this.notify(j);
    j.promise = this.run(j);
    return this.snapshot(j);
  }
  async run(j) {
    let lock;
    try {
      lock = await fs.open(path.join(j.dir, "run.lock"), "wx");
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, started: now() }),
      );
      const workDir = path.join(this.workDir, "tasks", j.meta.id);
      await fs.mkdir(workDir, { recursive: true });
      j.provider = this.providerFactory({
        workDir,
        profileDir: path.join(this.workDir, "profiles"),
        channel: "msedge",
        headless: false,
        delayMs: j.meta.options.delayMs,
        timeoutMs: 12000,
      });
      await this.persist(j);
      while (!j.stop) {
        j.meta.status = "running";
        j.meta.message = "正在查询搜索联想词";
        this.notify(j);
        await crawl(j.state, j.provider, {
          checkpoint: path.join(j.dir, "checkpoint.json"),
          stopping: () => j.stop,
          onProgress: async (node) => {
            j.meta.message = (node.platform === "douyin" ? "抖音" : "小红书") + "已采集：" + node.term;
            await this.persist(j);
            await exportAll(j.state, j.dir, mindmapHTML);
            this.notify(j, (node.platform === "douyin" ? "抖音" : "小红书") + "完成查询：" + node.term);
          },
          onUnconfirmed: async (node) => {
            j.meta.message = (node.platform === "douyin" ? "抖音" : "小红书") + "「" + node.term + "」结果待确认，继续其他词";
            await this.persist(j);
            await exportAll(j.state,j.dir,mindmapHTML);
            this.notify(j,j.meta.message);
          },
        });
        if (j.state.status === "complete") {
          j.meta.audit = auditState(j.state);
          await save(path.join(j.dir, "完整性核验.json"), j.meta.audit);
          j.meta.status = "complete";
          j.meta.message = "指定深度遍历完成，完整性检查通过";
          break;
        }
        if (j.state.status === "partial") {
          j.meta.status = "partial";
          j.meta.message = j.state.stopReason;
          delete j.meta.audit;
          await fs.unlink(path.join(j.dir, "完整性核验.json")).catch(error => {
            if (error.code !== "ENOENT") throw error;
          });
          this.notify(j, j.meta.message);
          break;
        }
        if (j.stop) break;
        const reason = j.state.stopReason || "采集已暂停";
        const kind = pauseKind(reason);
        if (kind && kind !== "result") {
          j.meta.status = kind === "verification" ? "awaiting_verification" : "awaiting_browser";
          j.meta.message = kind === "login"
            ? "登录提示仍挡住搜索框。请在平台窗口关闭提示，或按平台要求登录"
            : reason;
          // Keep exactly this browser context alive. No automated CAPTCHA attempt,
          // page reload loop, profile switching or retries without a human action.
          const wait = new Promise((resolve) => {
            j.gate = resolve;
          });
          await this.persist(j);
          await exportAll(j.state, j.dir, mindmapHTML);
          this.notify(j, "请在浏览器处理平台提示，完成后点击「已处理，继续」");
          const proceed = await wait;
          j.gate = null;
          if (!proceed || j.stop) break;
        } else {
          j.meta.status = "paused";
          j.meta.message = reason;
          break;
        }
      }
      if (j.stop) {
        j.meta.status = "paused";
        j.meta.message = "已暂停，进度已保存";
        j.state.status = "paused";
        j.state.stopReason = "用户暂停";
      }
    } catch (error) {
      j.meta.status = "error";
      j.meta.message =
        error.code === "EEXIST"
          ? "任务被其他程序占用，请先关闭原任务。"
          : String(error.message).slice(0, 1200);
      j.state.status = "paused";
      j.state.stopReason = j.meta.message;
      this.notify(j, j.meta.message);
    } finally {
      try {
        await j.provider?.close();
      } catch {}
      j.provider = null;
      j.gate = null;
      try {
        await this.persist(j);
        await exportAll(j.state, j.dir, mindmapHTML);
      } catch (e) {
        j.meta.status = "error";
        j.meta.message = "保存结果失败：" + e.message;
      }
      if (lock) {
        await lock.close();
        await fs.unlink(path.join(j.dir, "run.lock")).catch(() => {});
      }
      if (this.active === j.meta.id) this.active = null;
      this.notify(j);
    }
  }
  pause(id) {
    const j = this.get(id);
    if (this.active !== id)
      throw Object.assign(new Error("该任务当前没有运行。"), {
        statusCode: 409,
      });
    j.stop = true;
    j.meta.status = "pausing";
    j.meta.message = "正在保存，当前查询结束后暂停";
    j.gate?.(false);
    this.notify(j);
    return this.snapshot(j);
  }
  continue(id) {
    const j = this.get(id);
    if (
      !j.gate ||
      !["awaiting_verification", "awaiting_browser"].includes(j.meta.status)
    )
      throw Object.assign(new Error("当前没有等待人工处理的任务。"), {
        statusCode: 409,
      });
    j.meta.status = "running";
    j.meta.message = "已收到确认，继续原浏览器会话";
    const resolve = j.gate;
    j.gate = null;
    resolve(true);
    this.notify(j);
    return this.snapshot(j);
  }
  async openSession(platform) {
    if (!["douyin", "xiaohongshu"].includes(platform))
      invalid("请选择一个平台。");
    this.reserve("browser-session");
    this.active = null;
    const provider = this.providerFactory({
      workDir: path.join(this.workDir, "login"),
      profileDir: path.join(this.workDir, "profiles"),
      channel: "msedge",
      headless: false,
      delayMs: 5000,
      timeoutMs: 12000,
      manualLogin: true,
    });
    this.session = {
      platform,
      provider,
      message: "请在浏览器完成登录或查看平台提示",
      opening: true,
    };
    this.emit("session");
    try {
      await provider.open(platform);
    } catch (e) {
      if (this.session) this.session.message = e.message;
    } finally {
      if (this.session) this.session.opening = false;
      this.emit("session");
    }
    return this.sessionInfo();
  }
  sessionInfo() {
    return this.session
      ? {
          platform: this.session.platform,
          message: this.session.message,
          opening: this.session.opening,
        }
      : null;
  }
  async closeSession() {
    if (!this.session) return;
    if (this.session.opening)
      throw Object.assign(new Error("浏览器仍在打开，请稍候。"), {
        statusCode: 409,
      });
    await this.session.provider.close();
    this.session = null;
    this.emit("session");
  }
  async shutdown() {
    this.closing = true;
    for (const j of this.jobs.values())
      if (this.active === j.meta.id) {
        j.stop = true;
        j.gate?.(false);
      }
    await Promise.allSettled(
      [...this.jobs.values()].map((j) => j.promise).filter(Boolean),
    );
    if (this.session) {
      await this.session.provider.close();
      this.session = null;
    }
  }
}
