import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const normalize = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
export const idFor = (platform, term) =>
  createHash("sha256")
    .update(platform + "\0" + normalize(term).toLocaleLowerCase())
    .digest("hex")
    .slice(0, 20);
export const now = () => new Date().toISOString();
export async function save(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  await fs.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(temp, file);
}
export function createState({ seeds, platforms, depth }) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 10)
    throw new Error("depth 必须为1—10的整数");
  const unique = [];
  const seenSeeds = new Set();
  for (const raw of seeds) {
    const seed = normalize(raw),
      key = seed.toLocaleLowerCase();
    if (seed && !seenSeeds.has(key)) {
      unique.push(seed);
      seenSeeds.add(key);
    }
  }
  if (!unique.length) throw new Error("至少提供一个起始词");
  if (platforms.some((x) => !["douyin", "xiaohongshu"].includes(x)))
    throw new Error("平台无效");
  const state = {
    version: 1,
    created: now(),
    updated: now(),
    config: { seeds: unique, platforms, depth },
    status: "pending",
    stopReason: null,
    nodes: [],
    edges: [],
    observations: [],
  };
  for (const platform of platforms)
    for (const term of unique)
      state.nodes.push({
        id: idFor(platform, term),
        platform,
        term,
        depth: 0,
        parent: null,
        status: "pending",
      });
  return state;
}
export function applyObservation(state, node, observation) {
  if (!Array.isArray(observation.suggestions) || !observation.source)
    throw new Error("联想词回执缺少真实来源");
  const seen = new Set(),
    nodes = new Map(state.nodes.map((n) => [n.id, n]));
  const edgeKeys = new Set(state.edges.map((e) => e.from + "\0" + e.to));
  observation.suggestions.forEach((raw, index) => {
    if (typeof raw !== "string") throw new Error("联想词必须为字符串");
    const term = normalize(raw);
    if (!term || term.length > 200) return;
    const id = idFor(node.platform, term);
    if (id === node.id || seen.has(id)) return;
    seen.add(id);
    if (!nodes.has(id)) {
      const child = {
        id,
        platform: node.platform,
        term,
        depth: node.depth + 1,
        parent: node.id,
        status:
          node.depth + 1 < state.config.depth ? "pending" : "depth_boundary",
      };
      state.nodes.push(child);
      nodes.set(id, child);
    }
    const edgeKey = node.id + "\0" + id;
    if (!edgeKeys.has(edgeKey)) {
      state.edges.push({
        from: node.id,
        to: id,
        rank: index + 1,
        discoveredDepth: node.depth + 1,
        observedAt: observation.observedAt || now(),
        source: observation.source,
      });
      edgeKeys.add(edgeKey);
    }
  });
  state.observations.push({
    nodeId: node.id,
    query: node.term,
    platform: node.platform,
    ...observation,
    observedAt: observation.observedAt || now(),
  });
  node.status = "done";
  delete node.error;
  delete node.errorCode;
  state.updated = now();
}
export function stats(state) {
  return {
    uniqueKeywords: state.nodes.length,
    relations: state.edges.length,
    completedQueries: state.nodes.filter((n) => n.status === "done").length,
    pendingQueries: state.nodes.filter((n) =>
      ["pending", "querying"].includes(n.status),
    ).length,
    unconfirmedQueries: state.nodes.filter(n => n.status === "unconfirmed").length,
    emptyQueries: state.observations.filter(o => o.suggestions.length === 0).length,
    depthBoundary: state.nodes.filter((n) => n.status === "depth_boundary")
      .length,
  };
}
export async function crawl(
  state,
  provider,
  {
    checkpoint,
    stopping = () => false,
    onProgress = () => {},
    onUnconfirmed = () => {},
  } = {},
) {
  for (const n of state.nodes)
    if (["querying", "unconfirmed"].includes(n.status)) n.status = "pending";
  state.status = "running";
  state.stopReason = null;
  let commits = Promise.resolve(), halted = false, failure = null;
  const fail = (error) => {
    halted = true;
    failure ||= String(error.message).slice(0, 1000);
  };
  // Browser waits run independently. All graph mutations, checkpoint writes and
  // progress exports share one queue, including their asynchronous file writes.
  const commit = (fn) => {
    const result = commits.then(fn);
    commits = result.catch(() => {});
    return result;
  };
  const worker = async (platform) => {
    try {
      while (true) {
        const node = await commit(async () => {
          if (halted || stopping()) return null;
          const next = state.nodes.filter(n => n.platform === platform && n.status === "pending")
            .sort((a,b) => a.depth - b.depth)[0];
          if (!next) return null;
          next.status = "querying";
          state.updated = now();
          if (checkpoint) await save(checkpoint, state);
          return next;
        });
        if (!node) return;
        let observation;
        try { observation = await provider.get(platform, node.term); }
        catch (error) {
          const deferred = error.code === "RESULT_UNCONFIRMED";
          if (!deferred) fail(error);
          await commit(async () => {
            node.status = deferred ? "unconfirmed" : "pending";
            node.error = String(error.message).slice(0, 1000);
            node.errorCode = error.code || null;
            if (checkpoint) await save(checkpoint, state);
            if (deferred) await onUnconfirmed(node,stats(state));
          });
          if (deferred) continue;
          return;
        }
        await commit(async () => {
          // An in-flight success still belongs to the checkpoint after pause
          // or another platform's failure; it must not be needlessly repeated.
          applyObservation(state, node, observation);
          if (checkpoint) await save(checkpoint, state);
          await onProgress(node, stats(state));
        });
      }
    } catch (error) {
      fail(error);
    }
  };
  await Promise.all(state.config.platforms.map(worker));
  await commits;
  for (const node of state.nodes)
    if (node.status === "querying") node.status = "pending";
  const unconfirmed = state.nodes.filter(n => n.status === "unconfirmed");
  state.status = failure || state.nodes.some(n => n.status === "pending") || stopping() ? "paused" :
    unconfirmed.length ? "partial" : "complete";
  state.stopReason = state.status === "complete" ? null : state.status === "partial" ?
    "本轮采集已结束：" + unconfirmed.length + "个词未确认，已跳过；其余可查询词已处理，结果已保存。可按需重试未确认词。" :
    failure || "用户停止";
  state.updated = now();
  if (checkpoint) await save(checkpoint, state);
  return state;
}

const xml = (s) =>
  String(s).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const csv = (rows) =>
  "\ufeff" +
  rows
    .map((row) =>
      row
        .map((value) => '"' + String(value ?? "").replaceAll('"', '""') + '"')
        .join(","),
    )
    .join("\r\n");
export const platformName = (key) => (key === "douyin" ? "抖音" : "小红书");
export async function exportAll(state, dir, htmlTemplate) {
  await fs.mkdir(dir, { recursive: true });
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of state.nodes)
    if (n.parent) {
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n);
    }
  const roots = state.nodes.filter((n) => !n.parent),
    summary = stats(state);
  const firstEdges = new Set(
    state.nodes.filter((n) => n.parent).map((n) => n.parent + "\0" + n.id),
  );
  const cross = state.edges.filter(
    (e) => !firstEdges.has(e.from + "\0" + e.to),
  );
  const mmNode = (n) =>
    '<node ID="ID_' +
    n.id +
    '" TEXT="' +
    xml(n.term) +
    '"><attribute NAME="平台" VALUE="' +
    platformName(n.platform) +
    '"/><attribute NAME="层数" VALUE="' +
    n.depth +
    '"/><attribute NAME="查询状态" VALUE="' +
    xml(n.status) +
    '"/>' +
    (children.get(n.id) || []).map(mmNode).join("") +
    state.edges
      .filter((e) => e.from === n.id && !firstEdges.has(e.from + "\0" + e.to))
      .map((e) => '<arrowlink DESTINATION="ID_' + e.to + '"/>')
      .join("") +
    "</node>";
  const lines = [
    "# 搜索联想词思维导图",
    "",
    "状态：" +
      state.status +
      "；" +
      (state.stopReason || "已遍历本次指定深度内可发现的词。"),
    "",
    "起始词为第0层；最大深度：" +
      state.config.depth +
      "。词数：" +
      summary.uniqueKeywords +
      "；关系数：" +
      summary.relations +
      "；已查询：" +
      summary.completedQueries +
      "；待查询：" +
      summary.pendingQueries +
      "；未确认：" +
      summary.unconfirmedQueries +
      "；确认无衍生词：" +
      summary.emptyQueries +
      "。",
    "",
    "本图仅表示本次账号、时间和平台返回的搜索联想词，不是全平台所有长尾词，也不代表搜索量或热度。",
    "",
  ];
  const walk = (n, level) => {
    lines.push(
      "  ".repeat(level) +
        "- " +
        n.term.replace(/[\r\n]/g, " ") +
        "〔" +
        platformName(n.platform) +
        "，第" +
        n.depth +
        "层〕",
    );
    for (const child of children.get(n.id) || []) walk(child, level + 1);
  };
  for (const n of roots) walk(n, 0);
  if (cross.length) {
    lines.push("", "## 跨分支及回指关系", "");
    for (const e of cross)
      lines.push(
        "- " +
          byId.get(e.from).term +
          " → " +
          byId.get(e.to).term +
          "〔" +
          platformName(byId.get(e.from).platform) +
          "〕",
      );
  }
  await fs.writeFile(path.join(dir, "mindmap.md"), lines.join("\n"), "utf8");
  await fs.writeFile(
    path.join(dir, "mindmap.mm"),
    '<?xml version="1.0" encoding="UTF-8"?><map version="1.0.1"><node TEXT="' +
      xml("搜索联想词 · " + state.status) +
      '"><attribute NAME="状态" VALUE="' +
      xml(state.stopReason || state.status) +
      '"/>' +
      roots.map(mmNode).join("") +
      "</node></map>",
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "keywords.csv"),
    csv([
      ["关键词ID", "平台", "关键词", "最小层数", "首次父词", "查询状态"],
      ...state.nodes.map((n) => [
        n.id,
        platformName(n.platform),
        n.term,
        n.depth,
        byId.get(n.parent)?.term || "",
        n.status,
      ]),
    ]),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "relations.csv"),
    csv([
      ["平台", "父词", "联想词", "下拉排序", "发现层数", "采集时间", "来源"],
      ...state.edges.map((e) => [
        platformName(byId.get(e.from).platform),
        byId.get(e.from).term,
        byId.get(e.to).term,
        e.rank,
        e.discoveredDepth,
        e.observedAt,
        e.source,
      ]),
    ]),
    "utf8",
  );
  await save(path.join(dir, "results.json"), { ...state, summary });
  if (htmlTemplate)
    await fs.writeFile(
      path.join(dir, "mindmap.html"),
      htmlTemplate(state),
      "utf8",
    );
  return summary;
}
