import assert from "node:assert/strict";
import { idFor, normalize, stats } from "./core.mjs";

export function auditState(s, { requireLive = true } = {}) {
  assert.equal(s.status, "complete", "指定深度仍有未完成查询");
  const by = new Map(s.nodes.map((n) => [n.id, n]));
  const edges = new Map(s.edges.map((e) => [e.from + "\0" + e.to, e]));
  assert.equal(by.size, s.nodes.length, "关键词ID重复");
  assert.equal(edges.size, s.edges.length, "关系重复");
  const queries = new Set();
  for (const n of s.nodes) {
    assert.equal(n.id, idFor(n.platform, n.term), "关键词ID与内容不一致");
    assert(n.depth <= s.config.depth, "节点超出指定层数");
    assert.equal(
      n.status,
      n.depth < s.config.depth ? "done" : "depth_boundary",
    );
    if (n.parent) assert(edges.has(n.parent + "\0" + n.id), "首次父词关系缺失");
  }
  assert.equal(
    s.observations.length,
    s.nodes.filter((n) => n.depth < s.config.depth).length,
    "存在未展开分支",
  );
  for (const o of s.observations) {
    assert(!queries.has(o.nodeId), "重复查询");
    queries.add(o.nodeId);
    assert.equal(o.query, by.get(o.nodeId)?.term, "查询回执与词不一致");
    assert.equal(o.platform, by.get(o.nodeId)?.platform);
    if (requireLive)
      assert(
        ["visible_search_dropdown", "browser_autocomplete_response"].includes(
          o.source,
        ),
        "包含非实采数据",
      );
    const seen = new Set();
    for (let i = 0; i < o.suggestions.length; i++) {
      const term = normalize(o.suggestions[i]);
      if (!term || term.length > 200) continue;
      const to = idFor(o.platform, term);
      if (to === o.nodeId || seen.has(to)) continue;
      seen.add(to);
      assert.equal(
        edges.get(o.nodeId + "\0" + to)?.rank,
        i + 1,
        "原始联想词或顺序缺失",
      );
    }
  }
  for (const e of s.edges) {
    assert(by.has(e.from) && by.has(e.to), "关系引用缺失节点");
    assert(by.get(e.to).depth <= by.get(e.from).depth + 1);
  }
  const firstLevel = s.nodes
    .filter((n) => n.depth === 1)
    .map((n) => ({
      keyword: n.term,
      queried: n.status === "done" || s.config.depth === 1,
      outgoing: s.edges.filter((e) => e.from === n.id).length,
    }));
  return {
    complete: true,
    ...stats(s),
    depth: s.config.depth,
    byDepth: Object.fromEntries(
      Array.from({ length: s.config.depth + 1 }, (_, d) => [
        d,
        s.nodes.filter((n) => n.depth === d).length,
      ]),
    ),
    allFirstLevelExpanded: firstLevel.every((x) => x.queried),
    firstLevel,
    actualPlatformSources: requireLive,
    duplicateQueries: 0,
    missingRelations: 0,
    finishedAt: s.updated,
  };
}
