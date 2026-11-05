const $ = (s) => document.querySelector(s),
  NS = "http://www.w3.org/2000/svg";
const labels = {
  ready: "待开始",
  running: "采集中",
  pausing: "保存中",
  paused: "已暂停",
  complete: "已完成",
  error: "需处理",
  awaiting_verification: "等待验证",
  awaiting_browser: "等待处理",
  awaiting_result: "结果待确认",
};
const nodeLabels = {
  pending: "待查询",
  querying: "查询中",
  done: "已查询",
  depth_boundary: "已到指定层数",
  unconfirmed: "结果待确认",
};
const platformName = (p) =>
  p === "douyin" ? "抖音" : p === "both" ? "双平台" : "小红书";
const ui = {
  token: "",
  jobs: [],
  selected: localStorage.getItem("ssm-selected"),
  job: null,
  active: null,
  session: null,
  view: "map",
  query: "",
  selectedNode: null,
  collapsed: new Set(),
  autoFolded: false,
  transform: { x: 30, y: 40, k: 1 },
  positions: new Map(),
  tableLimit: 200,
  refreshing: false,
  refreshAgain: false,
  capabilities: {},
};
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function svg(tag, attrs = {}) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
let toastTimer;
function toast(message, error = false, undo = null) {
  const n = $("#toast");
  n.textContent = message;
  if (undo) {
    const button = el("button", "toast-action", "撤销");
    button.id = "undo-delete";
    button.onclick = () =>
      action(button, async () => {
        const restored = await api("/api/trash/" + undo + "/restore", {});
        await selectJob(restored.id);
        toast("任务与采集内容已恢复。");
      });
    n.append(button);
  }
  n.className = "toast" + (error ? " error" : "");
  n.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => (n.hidden = true),
    undo ? 12000 : error ? 9000 : 4200,
  );
}
async function api(url, body) {
  const res = await fetch(
    url,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-SSM-Token": ui.token,
          },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(data.error || "操作失败，请稍后再试。"), {
      status: res.status,
    });
  return data;
}
async function action(button, fn) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    button.disabled = false;
    await refresh().catch(() => {});
  }
}
function fileURL(name) {
  return "/api/jobs/" + ui.selected + "/files/" + encodeURIComponent(name);
}
function dateTime(value) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function dialog(title, paragraphs) {
  $("#dialog-title").textContent = title;
  const body = $("#dialog-body");
  body.replaceChildren();
  for (const [heading, text] of paragraphs) {
    const p = el("p");
    if (heading) p.append(el("strong", "", heading), el("br"));
    p.append(document.createTextNode(text));
    body.append(p);
  }
  $("#info-dialog").showModal();
}
async function refresh() {
  if (ui.refreshing) {
    ui.refreshAgain = true;
    return;
  }
  ui.refreshing = true;
  try {
    const boot = await api("/api/bootstrap");
    ui.token = boot.token;
    ui.jobs = boot.jobs;
    ui.active = boot.active;
    ui.session = boot.session;
    ui.capabilities = boot.capabilities || {};
    ui.paths = { data: boot.dataDir, work: boot.workDir };
    if (!ui.jobs.some((j) => j.id === ui.selected)) {
      ui.selected = ui.jobs[0]?.id || null;
      ui.selectedNode = null;
      ui.collapsed.clear();
      ui.positions.clear();
      ui.autoFolded = false;
      if (ui.selected) localStorage.setItem("ssm-selected", ui.selected);
      else localStorage.removeItem("ssm-selected");
    }
    const selected = ui.selected;
    if (selected) {
      let job;
      try {
        job = await api("/api/jobs/" + selected);
      } catch (e) {
        if (e.status === 404) {
          ui.selected = null;
          ui.job = null;
          ui.refreshAgain = true;
          return;
        }
        throw e;
      }
      if (ui.selected === selected) ui.job = job;
    } else ui.job = null;
    render();
    $("#connection").className = "connection online";
    $("#connection").lastChild.textContent = "本机已连接";
  } finally {
    ui.refreshing = false;
    if (ui.refreshAgain) {
      ui.refreshAgain = false;
      queueMicrotask(() => refresh().catch(() => {}));
    }
  }
}
async function selectJob(id) {
  ui.selected = id;
  localStorage.setItem("ssm-selected", id);
  ui.selectedNode = null;
  ui.collapsed = new Set();
  ui.autoFolded = false;
  ui.positions.clear();
  ui.tableLimit = 200;
  await refresh();
}
function render() {
  const j = ui.job,
    busy = !!(ui.active || ui.session);
  $("#session-bar").hidden = !ui.session;
  if (ui.session) {
    $("#session-text").textContent =
      platformName(ui.session.platform) +
      "浏览器已打开 · " +
      ui.session.message;
    $("#close-session").disabled = ui.session.opening;
  }
  $("#start-btn").disabled = busy;
  $("#open-browser").disabled = busy;
  $("#trash-btn").disabled = !ui.capabilities.trash;
  $("#history-count").textContent = ui.jobs.length;
  const history = $("#history-list");
  history.replaceChildren();
  if (!ui.jobs.length)
    history.append(el("p", "empty-history", "你的采集任务会保存在这里。"));
  for (const item of ui.jobs) {
    const b = el(
      "button",
      "history-item" + (item.id === ui.selected ? " selected" : ""),
    );
    b.type = "button";
    b.setAttribute(
      "aria-label",
      item.options.seeds.join("、") + " " + labels[item.status],
    );
    const line = el("div", "history-line");
    line.append(
      el("span", "history-name", item.options.seeds.join("、")),
      el(
        "span",
        "status " + (item.status === "ready" ? "neutral" : item.status),
        labels[item.status],
      ),
    );
    const meta = el("div", "history-meta");
    meta.append(
      el(
        "span",
        "",
        platformName(item.options.platform) +
          " · " +
          item.options.depth +
          "层 · " +
          item.uniqueKeywords +
          "词",
      ),
      el("time", "", dateTime(item.created)),
    );
    b.append(line, meta);
    b.onclick = () => selectJob(item.id).catch((e) => toast(e.message, true));
    const entry = el("div", "history-entry"),
      controls = el("div", "history-controls");
    entry.append(b, controls);
    if (ui.active === item.id) {
      const pause = el("button", "history-control", "暂停");
      pause.setAttribute(
        "aria-label",
        "暂停任务 " + item.options.seeds.join("、"),
      );
      pause.disabled = item.status === "pausing" || item.deleting;
      pause.onclick = () =>
        action(pause, () => api("/api/jobs/" + item.id + "/pause", {}));
      controls.append(pause);
    } else if (["paused", "ready", "error"].includes(item.status)) {
      const resume = el(
        "button",
        "history-control",
        item.status === "ready" ? "开始" : "继续",
      );
      resume.setAttribute(
        "aria-label",
        "继续任务 " + item.options.seeds.join("、"),
      );
      resume.disabled = busy || item.deleting || item.editing;
      resume.onclick = () =>
        action(resume, () => api("/api/jobs/" + item.id + "/start", {}));
      controls.append(resume);
    }
    const edit = el("button", "history-control", "编辑");
    edit.setAttribute("aria-label", "编辑任务 " + item.options.seeds.join("、"));
    edit.disabled = ui.active === item.id || item.deleting || item.editing || !ui.capabilities.editTask;
    edit.title = ui.active === item.id ? "请先暂停采集，再编辑设置" : "编辑层数与查询间隔";
    edit.onclick = () => openEditor(item.id);
    controls.append(edit);
    const remove = el("button", "history-control danger", "删除");
    remove.setAttribute(
      "aria-label",
      "删除任务 " + item.options.seeds.join("、"),
    );
    remove.disabled = item.deleting || item.editing || !ui.capabilities.deleteTask;
    remove.onclick = () => requestDelete(item.id, remove);
    controls.append(remove);
    history.append(entry);
  }
  $("#task-title").textContent = j ? j.options.seeds.join("、") : "关键词地图";
  $("#task-title").title = j ? j.options.seeds.join("、") : "";
  $("#task-status").textContent = j ? labels[j.status] : "等待开始";
  $("#task-status").className =
    "status " + (j?.status === "ready" || !j ? "neutral" : j.status);
  $("#task-subtitle").textContent = j
    ? platformName(j.options.platform) +
      " · 递归" +
      j.options.depth +
      "层 · " +
      dateTime(j.created) + (j.options.platform === "both" ? " · 双平台并发" : "") + " · 无查询次数限制"
    : "输入起始词，让搜索联想逐层生长。";
  $("#resume-btn").hidden =
    !j || !["ready", "paused", "error"].includes(j.status);
  $("#resume-btn").disabled = busy;
  $("#edit-btn").hidden = !j;
  $("#edit-btn").disabled = !j || ui.active === j.id || j.deleting || j.editing || !ui.capabilities.editTask;
  $("#edit-btn").title = j && ui.active === j.id ? "请先暂停采集，再编辑设置" : "编辑层数与查询间隔";
  $("#resume-btn").textContent =
    j?.status === "ready" ? "开始此任务" : "继续采集";
  $("#pause-btn").hidden = !j || ui.active !== j.id;
  $("#pause-btn").disabled = j?.status === "pausing";
  $("#pause-btn").textContent =
    j?.status === "pausing" ? "正在保存…" : "暂停采集";
  $("#delete-btn").hidden = !j;
  $("#delete-btn").disabled = !!j?.deleting || !ui.capabilities.deleteTask;
  $("#delete-btn").textContent = j?.deleting ? "正在删除…" : "删除任务";
  $("#zip-btn").hidden = !j || ui.active === j.id;
  if (j) {
    $("#zip-btn").href = "/api/jobs/" + j.id + "/download.zip";
    $("#zip-btn").setAttribute("download", "");
  }
  const waiting =
    j && ["awaiting_verification", "awaiting_browser", "awaiting_result"].includes(j.status);
  $("#manual-banner").hidden = !waiting;
  if (waiting) {
    $("#manual-title").textContent =
      j.status === "awaiting_verification"
        ? "请在浏览器完成验证"
        : j.status === "awaiting_result" ? "部分关键词的联想结果待确认" : "请查看平台浏览器提示";
    $("#manual-message").textContent =
      j.status === "awaiting_result" ? j.message + "。未检测到验证码或强制登录，未将这些词记为零结果。" :
      j.message + "。保留当前窗口，手动处理后点击继续。";
    $("#continue-btn").textContent = j.status === "awaiting_result" ? "重试未确认词" : "已处理，继续";
  }
  const notice =
    j && ["paused", "error", "complete", "pausing"].includes(j.status);
  $("#notice").hidden = !notice;
  $("#notice").textContent = notice ? j.message : "";
  $("#notice").className = "notice" + (j?.status === "error" ? " error" : "");
  for (const [id, key] of [
    ["words", "uniqueKeywords"],
    ["edges", "relations"],
    ["done", "completedQueries"],
    ["pending", "pendingQueries"],
  ])
    $("#stat-" + id).textContent = j ? Number(j[key]).toLocaleString() : "—";
  const depth = $("#depth-summary");
  depth.replaceChildren();
  if (j) {
    for (let i = 1; i < j.byDepth.length; i++) {
      const row = el("div");
      row.append(
        document.createTextNode("第" + i + "层 "),
        el("b", "", j.byDepth[i] + " 词"),
      );
      depth.append(row);
    }
  } else depth.textContent = "每个分支都可追溯到原始返回词";
  $("#empty-map").hidden = !!j;
  $("#activity-status").textContent = j ? labels[j.status] : "未运行";
  const activity = $("#activity-list");
  activity.replaceChildren();
  if (!j?.logs.length)
    activity.append(
      el(
        "li",
        "activity-empty",
        j
          ? "等待查询；导入任务的原始回执可在结果JSON中查看。"
          : "创建任务后，查询进度会显示在这里。",
      ),
    );
  else
    for (const log of [...j.logs].reverse().slice(0, 24)) {
      const li = el("li", "", log.message);
      li.append(
        el(
          "time",
          "",
          new Date(log.at).toLocaleTimeString("zh-CN", { hour12: false }),
        ),
      );
      activity.append(li);
    }
  renderGraph();
  renderDetails();
  if (ui.view === "words") renderWords();
  if (ui.view === "files") renderFiles();
}
function setView(view) {
  ui.view = view;
  for (const button of document.querySelectorAll("[data-view]")) {
    const selected = button.dataset.view === view;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  }
  for (const v of ["map", "words", "files"])
    $("#" + v + "-view").hidden = v !== view;
  if (view === "map") {
    renderGraph();
  }
  if (view === "words") renderWords();
  if (view === "files") renderFiles();
}
function renderGraph() {
  const layer = $("#map-layer");
  if (!ui.job) {
    layer.replaceChildren();
    return;
  }
  const nodes = ui.job.nodes,
    children = new Map(),
    by = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes)
    if (n.parent) {
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n);
    }
  if (nodes.length > 150 && !ui.autoFolded) {
    for (const n of nodes) if (n.depth === 1) ui.collapsed.add(n.id);
    ui.autoFolded = true;
  }
  const positions = new Map(),
    visible = [],
    links = [];
  let row = 0;
  function walk(n) {
    const kids = ui.collapsed.has(n.id) ? [] : children.get(n.id) || [];
    const ys = [];
    for (const child of kids) {
      walk(child);
      ys.push(positions.get(child.id).y);
      links.push([n, child]);
    }
    const y = ys.length ? (ys[0] + ys.at(-1)) / 2 : row++ * 58;
    positions.set(n.id, { x: n.depth * 290, y });
    visible.push(n);
  }
  for (const root of nodes.filter((n) => !n.parent)) {
    walk(root);
    row++;
  }
  const firstDraw = ui.positions.size === 0;
  ui.positions = positions;
  const fragment = document.createDocumentFragment();
  for (const [parent, child] of links) {
    const a = positions.get(parent.id),
      b = positions.get(child.id);
    fragment.append(
      svg("path", {
        class: "tree-edge",
        d: `M${a.x + 216},${a.y + 22} C${a.x + 252},${a.y + 22} ${b.x - 36},${b.y + 22} ${b.x},${b.y + 22}`,
      }),
    );
  }
  for (const n of visible) {
    const p = positions.get(n.id),
      g = svg("g", {
        class:
          "tree-node" +
          (n.depth === 0 ? " root" : "") +
          (n.status === "depth_boundary" ? " boundary" : "") +
          (ui.selectedNode === n.id ? " selected" : "") +
          (ui.query &&
          n.term.toLocaleLowerCase().includes(ui.query.toLocaleLowerCase())
            ? " match"
            : ""),
        transform: `translate(${p.x} ${p.y})`,
        "data-node": n.id,
        tabindex: "0",
        role: "button",
        "aria-label": n.term + "，第" + n.depth + "层，" + nodeLabels[n.status],
      });
    g.append(svg("rect", { width: 216, height: 44, rx: 8 }));
    const text = svg("text", { x: 14, y: 27 });
    const letters = Array.from(n.term);
    text.textContent =
      letters.length > 16 ? letters.slice(0, 16).join("") + "…" : n.term;
    g.append(text);
    const title = svg("title");
    title.textContent = n.term;
    g.append(title);
    if (children.has(n.id)) {
      const toggle = svg("g", {
        class: "toggle",
        "data-toggle": n.id,
        transform: "translate(216 22)",
        role: "button",
        "aria-label": (ui.collapsed.has(n.id) ? "展开" : "折叠") + n.term,
      });
      toggle.append(svg("circle", { r: 12 }));
      const t = svg("text", { "text-anchor": "middle", y: 3.5 });
      t.textContent = ui.collapsed.has(n.id)
        ? "+" + children.get(n.id).length
        : "−";
      toggle.append(t);
      g.append(toggle);
    }
    fragment.append(g);
  }
  layer.replaceChildren(fragment);
  $("#map-caption").textContent =
    `当前显示 ${visible.length} / ${nodes.length} 个词；点击节点右侧 ＋ 展开分支`;
  if (firstDraw) fitMap();
  else applyTransform();
}
function applyTransform() {
  $("#map-layer").setAttribute(
    "transform",
    `translate(${ui.transform.x} ${ui.transform.y}) scale(${ui.transform.k})`,
  );
}
function fitMap() {
  if (!ui.positions.size) return;
  const canvas = $("#map"),
    w = canvas.clientWidth || 700,
    h = canvas.clientHeight || 600,
    values = [...ui.positions.values()];
  const left = Math.min(...values.map((p) => p.x)),
    right = Math.max(...values.map((p) => p.x)) + 240,
    top = Math.min(...values.map((p) => p.y)),
    bottom = Math.max(...values.map((p) => p.y)) + 44;
  const k = Math.max(
    0.04,
    Math.min(1, (w - 70) / (right - left), (h - 130) / (bottom - top)),
  );
  ui.transform = {
    x: (w - (right - left) * k) / 2 - left * k,
    y: (h - (bottom - top) * k) / 2 - top * k - 15,
    k,
  };
  applyTransform();
}
function zoom(factor, point) {
  const canvas = $("#map"),
    x = point?.x ?? canvas.clientWidth / 2,
    y = point?.y ?? canvas.clientHeight / 2,
    t = ui.transform,
    k = Math.max(0.03, Math.min(3, t.k * factor));
  t.x = x - ((x - t.x) * k) / t.k;
  t.y = y - ((y - t.y) * k) / t.k;
  t.k = k;
  applyTransform();
}
function focusNode(id) {
  if (!ui.job) return;
  ui.selectedNode = id;
  const by = new Map(ui.job.nodes.map((n) => [n.id, n]));
  let n = by.get(id);
  while (n?.parent) {
    ui.collapsed.delete(n.parent);
    n = by.get(n.parent);
  }
  setView("map");
  renderGraph();
  renderDetails();
  const p = ui.positions.get(id);
  if (p) {
    const canvas = $("#map");
    ui.transform = {
      x: canvas.clientWidth / 2 - (p.x + 108) * 0.9,
      y: canvas.clientHeight / 2 - (p.y + 22) * 0.9,
      k: 0.9,
    };
    applyTransform();
  }
}
function renderDetails() {
  const box = $("#node-details"),
    j = ui.job,
    n = j?.nodes.find((n) => n.id === ui.selectedNode);
  box.replaceChildren();
  if (!n) {
    const empty = el("div", "detail-placeholder");
    empty.append(
      el("span", "", "⌁"),
      el("p", "", "选择地图中的词，查看它从哪里来、还能延伸到哪里。"),
    );
    box.append(empty);
    return;
  }
  box.append(
    el("div", "node-name", n.term),
    el(
      "div",
      "node-meta",
      platformName(n.platform) +
        " · 第" +
        n.depth +
        "层 · " +
        nodeLabels[n.status],
    ),
  );
  if (n.error) box.append(el("p", "detail-note", n.error));
  const by = new Map(j.nodes.map((n) => [n.id, n]));
  for (const [title, edges, key] of [
    ["来自这些词", j.edges.filter((e) => e.to === n.id), "from"],
    ["延伸到这些词", j.edges.filter((e) => e.from === n.id), "to"],
  ]) {
    box.append(el("div", "relation-title", title + "（" + edges.length + "）"));
    const words = el("div", "relation-words");
    if (!edges.length)
      words.append(
        el(
          "span",
          "detail-note",
          key === "from"
            ? "用户输入的起始词"
            : n.status === "depth_boundary"
              ? "已到本次指定层数，无需继续查询"
              : n.status === "done"
                ? "平台明确返回空建议"
                : n.status === "unconfirmed"
                  ? "平台未返回可确认结果，已保留待重试"
                : "尚未查询",
        ),
      );
    for (const edge of edges) {
      const node = by.get(edge[key]);
      if (!node) continue;
      const b = el("button", "relation-word", node.term);
      b.onclick = () => focusNode(node.id);
      words.append(b);
    }
    box.append(words);
  }
  box.append(
    el(
      "p",
      "detail-note",
      "主图按首次发现的关系排列。这里保留全部来源、跨分支关联与回指关系。",
    ),
  );
}
function renderWords() {
  const body = $("#words-body");
  body.replaceChildren();
  if (!ui.job) {
    $("#table-count").textContent = "暂无关键词，请先创建采集任务。";
    $("#more-words").hidden = true;
    return;
  }
  const nodes = ui.job.nodes.filter(
      (n) =>
        !ui.query ||
        n.term.toLocaleLowerCase().includes(ui.query.toLocaleLowerCase()),
    ),
    by = new Map(ui.job.nodes.map((n) => [n.id, n]));
  for (const n of nodes.slice(0, ui.tableLimit)) {
    const tr = el("tr"),
      word = el("td"),
      button = el("button", "table-word", n.term);
    button.onclick = () => focusNode(n.id);
    word.append(button);
    tr.append(
      word,
      el("td", "", platformName(n.platform)),
      el("td", "", String(n.depth)),
      el("td", "", by.get(n.parent)?.term || "—"),
      el("td", "", nodeLabels[n.status]),
    );
    body.append(tr);
  }
  $("#table-count").textContent =
    `共 ${nodes.length} 个词，当前显示 ${Math.min(ui.tableLimit, nodes.length)} 个`;
  $("#more-words").hidden = nodes.length <= ui.tableLimit;
}
function renderFiles() {
  const box = $("#file-list");
  box.replaceChildren();
  if (!ui.job) {
    box.append(el("p", "muted", "完成或暂停采集后，可在这里导出结果。"));
    return;
  }
  if (ui.active === ui.job.id) {
    box.append(
      el(
        "p",
        "muted",
        "采集过程中会自动保存。请先暂停，再下载稳定的结果文件。",
      ),
    );
    return;
  }
  const entries = [
    [
      "mindmap.html",
      "交互式思维导图",
      "离线打开，支持缩放、折叠、搜索与SVG导出。",
      "HTML",
    ],
    [
      "mindmap.mm",
      "可编辑思维导图",
      "FreeMind格式，保留跨分支关联箭头。",
      "MM",
    ],
    [
      "keywords.csv",
      "去重关键词表",
      "关键词、平台、最小层数、首次父词与查询状态。",
      "CSV",
    ],
    [
      "relations.csv",
      "完整关联关系",
      "父子关系、原下拉排序、采集时间与来源。",
      "CSV",
    ],
    ["mindmap.md", "树形大纲", "可读大纲与跨分支、回指关系。", "MD"],
    [
      "results.json",
      "完整采集回执",
      "原始平台返回、节点、关系与任务状态。",
      "JSON",
    ],
    [
      "checkpoint.json",
      "断点文件",
      "导入工作台后，可继续未完成的任务。",
      "JSON",
    ],
    [
      "完整性核验.json",
      "完整性核验",
      "检查指定层数内是否全部展开、有无遗漏关系。",
      "JSON",
    ],
  ];
  for (const [file, title, desc, type] of entries) {
    if (!ui.job.files.includes(file)) continue;
    const card = el("div", "file-item");
    card.append(el("b", "", type), el("strong", "", title), el("p", "", desc));
    const link = el("a", "", file === "mindmap.html" ? "打开导图" : "下载文件");
    link.href = fileURL(file);
    if (file === "mindmap.html") {
      link.target = "_blank";
      link.rel = "noopener";
    } else link.setAttribute("download", "");
    card.append(link);
    box.append(card);
  }
}
let editingId = null;
let savingEdit = false;
function openEditor(id) {
  const job = ui.jobs.find(j => j.id === id);
  if (!job) return;
  editingId = id;
  const hasResults = job.completedQueries > 0;
  $("#edit-seeds").value = job.options.seeds.join("\n");
  $("#edit-platform").value = job.options.platform;
  $("#edit-seeds").disabled = $("#edit-platform").disabled = hasResults;
  $("#edit-depth").value = job.options.depth;
  $("#edit-depth").min = hasResults ? job.options.depth : 1;
  $("#edit-delay").value = job.options.delayMs / 1000;
  $("#edit-preserve").textContent = hasResults
    ? "已保留" + job.uniqueKeywords + "个词、" + job.completedQueries + "次查询。可增加层数、调整间隔；已有结果的起始词和平台不变。"
    : "尚无成功查询，可修改起始词、平台、层数和间隔。";
  $("#edit-error").hidden = true;
  $("#edit-dialog").showModal();
  $(hasResults ? "#edit-depth" : "#edit-seeds").focus();
}
function closeEditor() {
  if (!savingEdit) $("#edit-dialog").close();
}
$("#edit-btn").onclick = () => openEditor(ui.selected);
$("#close-edit").onclick = $("#cancel-edit").onclick = closeEditor;
$("#edit-dialog").addEventListener("cancel", event => {
  if (savingEdit) event.preventDefault();
});
$("#edit-form").onsubmit = async event => {
  event.preventDefault();
  if (savingEdit) return;
  savingEdit = true;
  $("#save-edit").disabled = $("#cancel-edit").disabled = $("#close-edit").disabled = true;
  $("#save-edit").textContent = "保存中…";
  $("#edit-error").hidden = true;
  try {
    await api("/api/jobs/" + editingId + "/edit", {
      seeds: $("#edit-seeds").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
      platform: $("#edit-platform").value,
      depth: Number($("#edit-depth").value),
      delayMs: Math.round(Number($("#edit-delay").value) * 1000),
    });
    $("#edit-dialog").close();
    await selectJob(editingId);
    toast("设置已保存，已采集数据保留；点击继续采集即可续跑。");
  } catch (error) {
    $("#edit-error").textContent = error.message;
    $("#edit-error").hidden = false;
  } finally {
    savingEdit = false;
    $("#save-edit").disabled = $("#cancel-edit").disabled = $("#close-edit").disabled = false;
    $("#save-edit").textContent = "保存设置";
    await refresh().catch(() => {});
  }
};

async function requestDelete(id, button) {
  const job = ui.jobs.find((j) => j.id === id);
  if (!job) return;
  const running = ui.active === id;
  $("#delete-title").textContent =
    "删除“" + job.options.seeds.join("、") + "”？";
  $("#delete-message").textContent =
    (running ? "将先停止当前任务并等待查询结束，再将" : "将") +
    "该任务及已采集的" +
    job.uniqueKeywords +
    "个关键词、" +
    job.relations +
    "条关系和导出内容移入回收区。删除后可撤销，也可在回收区恢复。";
  const d = $("#delete-dialog");
  d.returnValue = "cancel";
  const confirmed = new Promise((resolve) =>
    d.addEventListener("close", () => resolve(d.returnValue === "delete"), {
      once: true,
    }),
  );
  d.showModal();
  if (!(await confirmed)) return;
  await action(button, async () => {
    const removed = await api("/api/jobs/" + id + "/delete", {});
    await refresh();
    toast("任务与采集内容已移入回收区。", false, removed.trashId);
  });
}
async function renderTrash() {
  const records = await api("/api/trash"),
    box = $("#trash-list");
  box.replaceChildren();
  if (!records.length) {
    box.append(el("p", "hint", "回收区为空。"));
    return;
  }
  for (const record of records) {
    const row = el("div", "trash-row"),
      info = el("div");
    info.append(
      el("strong", "", record.seeds.join("、")),
      el(
        "p",
        "hint",
        record.uniqueKeywords +
          "词 · " +
          record.relations +
          "条关系 · " +
          dateTime(record.deletedAt),
      ),
    );
    const restore = el("button", "button small", "恢复");
    restore.setAttribute("aria-label", "恢复任务 " + record.seeds.join("、"));
    restore.onclick = () =>
      action(restore, async () => {
        const j = await api("/api/trash/" + record.trashId + "/restore", {});
        await selectJob(j.id);
        await renderTrash();
        toast("任务与采集内容已恢复。");
      });
    row.append(info, restore);
    box.append(row);
  }
}
$("#delete-btn").onclick = () => requestDelete(ui.selected, $("#delete-btn"));
$("#trash-btn").onclick = () =>
  action($("#trash-btn"), async () => {
    await renderTrash();
    $("#trash-dialog").showModal();
  });
$("#close-trash").onclick = () => $("#trash-dialog").close();
$("#task-form").onsubmit = (e) => {
  e.preventDefault();
  action($("#start-btn"), async () => {
    const seeds = $("#seeds")
      .value.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!seeds.length) throw new Error("请先输入起始词。");
    const job = await api("/api/jobs", {
      seeds,
      platform: document.querySelector("[name=platform]:checked").value,
      depth: Number($("#depth").value),
      delayMs: Number($("#delay").value),
    });
    await selectJob(job.id);
    await api("/api/jobs/" + job.id + "/start", {});
    toast("已开始采集，平台浏览器即将打开。");
  });
};
$("#pause-btn").onclick = () =>
  action($("#pause-btn"), () => api("/api/jobs/" + ui.selected + "/pause", {}));
$("#resume-btn").onclick = () =>
  action($("#resume-btn"), () =>
    api("/api/jobs/" + ui.selected + "/start", {}),
  );
$("#continue-btn").onclick = () =>
  action($("#continue-btn"), () =>
    api("/api/jobs/" + ui.selected + "/continue", {}),
  );
$("#open-browser").onclick = () =>
  action($("#open-browser"), async () => {
    const p = document.querySelector("[name=platform]:checked").value;
    if (p === "both") throw new Error("请先选择一个平台，分别完成登录。");
    await api("/api/browser/open", { platform: p });
  });
$("#close-session").onclick = () =>
  action($("#close-session"), () => api("/api/browser/close", {}));
$("#import-btn").onclick = () => $("#import-file").click();
$("#import-file").onchange = () =>
  action($("#import-btn"), async () => {
    const file = $("#import-file").files[0];
    if (!file) return;
    if (file.size > 24 * 1024 * 1024) throw new Error("文件超过24MB上限。");
    let state;
    try {
      state = JSON.parse(await file.text());
    } catch {
      throw new Error("文件不是有效的JSON。");
    }
    const j = await api("/api/import", state);
    $("#import-file").value = "";
    await selectJob(j.id);
    toast("已导入，可查看结果或继续未完成的采集。");
  });
$("#paths-btn").onclick = () =>
  dialog("本机保存位置", [
    ["采集结果", ui.paths?.data || "连接后显示"],
    ["浏览器资料与诊断", ui.paths?.work || "连接后显示"],
    [
      "数据与源代码分开保存",
      "Cookie、登录资料和本地采集结果不会随源码上传到GitHub。结果包也不包含浏览器登录资料。",
    ],
  ]);
$("#help-btn").onclick = () =>
  dialog("从起始词到关键词地图", [
    [
      "1. 创建任务",
      "选择平台，输入一个或多个起始词，再选择递归层数。起始词是第0层，三层采集会查询第0至2层，记录到第3层。",
    ],
    [
      "2. 查看采集进度",
      "每个词每个平台只查询一次。可随时暂停，下一次从断点继续；提高层数会显著增加查询量。",
    ],
    [
      "3. 处理平台验证",
      "普通登录提示会自动关闭。验证码或平台限制出现时，采集暂停并保留当前浏览器。请手动处理后点击「已处理，继续」。",
    ],
    [
      "4. 使用结果",
      "展开或搜索导图中的词，查看完整来源关系。下载结果包含离线导图、CSV词表、完整关系及JSON断点。",
    ],
    [
      "平台支持范围",
      "抖音已完成真实三层采集；小红书已完成未登录状态下的两层递归采集。普通登录框自动关闭，侧栏登录按钮不影响采集。联想词不代表搜索量或全平台全部长尾词。",
    ],
  ]);
$("#close-dialog").onclick = $("#dialog-done").onclick = () =>
  $("#info-dialog").close();
for (const button of document.querySelectorAll("[data-view]"))
  button.onclick = () => setView(button.dataset.view);
for (const [id, change] of [
  ["depth-less", -1],
  ["depth-more", 1],
])
  $("#" + id).onclick = () => {
    const n = $("#depth");
    n.value = Math.max(1, Math.min(10, Number(n.value) + change));
    n.dispatchEvent(new Event("input"));
  };
$("#depth").oninput = () => {
  const n = Number($("#depth").value);
  $("#depth-hint").textContent =
    "起始词为第0层，采集到第" +
    n +
    "层。" +
    (n > 3 ? "层数较高，查询量可能快速增加。" : "");
};
$("#search").oninput = () => {
  ui.query = $("#search").value.trim();
  ui.tableLimit = 200;
  if (ui.view === "words") renderWords();
  else renderGraph();
};
$("#search").onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const node = ui.job?.nodes.find((n) =>
      n.term.toLocaleLowerCase().includes(ui.query.toLocaleLowerCase()),
    );
    if (node && ui.query) focusNode(node.id);
    else if (ui.query) toast("没有找到这个关键词。");
  }
};
$("#more-words").onclick = () => {
  ui.tableLimit += 200;
  renderWords();
};
$("#fit-map").onclick = fitMap;
$("#zoom-in").onclick = () => zoom(1.2);
$("#zoom-out").onclick = () => zoom(1 / 1.2);
$("#expand-map").onclick = () => {
  ui.autoFolded = true;
  ui.collapsed.clear();
  renderGraph();
  fitMap();
};
$("#collapse-map").onclick = () => {
  ui.autoFolded = true;
  ui.collapsed = new Set(
    ui.job?.nodes.filter((n) => n.depth === 1).map((n) => n.id) || [],
  );
  renderGraph();
  fitMap();
};
$("#map").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-toggle]");
  if (toggle) {
    const id = toggle.dataset.toggle;
    ui.collapsed.has(id) ? ui.collapsed.delete(id) : ui.collapsed.add(id);
    renderGraph();
    return;
  }
  const n = e.target.closest("[data-node]");
  if (n) {
    ui.selectedNode = n.dataset.node;
    renderGraph();
    renderDetails();
  }
});
$("#map").addEventListener("keydown", (e) => {
  if (["Enter", " "].includes(e.key)) {
    const n = e.target.closest("[data-node]");
    if (n) {
      e.preventDefault();
      focusNode(n.dataset.node);
    }
  }
});
let drag = null;
$("#map").addEventListener("pointerdown", (e) => {
  if (e.target.closest("[data-node]") || e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, tx: ui.transform.x, ty: ui.transform.y };
  e.currentTarget.setPointerCapture(e.pointerId);
});
$("#map").addEventListener("pointermove", (e) => {
  if (drag) {
    ui.transform.x = drag.tx + e.clientX - drag.x;
    ui.transform.y = drag.ty + e.clientY - drag.y;
    applyTransform();
  }
});
for (const event of ["pointerup", "pointercancel"])
  $("#map").addEventListener(event, () => (drag = null));
$("#map").addEventListener(
  "wheel",
  (e) => {
    if (!ui.job) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    zoom(Math.exp(-e.deltaY * 0.001), {
      x: e.clientX - box.left,
      y: e.clientY - box.top,
    });
  },
  { passive: false },
);
new ResizeObserver(() => {
  if (ui.view === "map") fitMap();
}).observe($("#map-view"));
let refreshTimer;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh().catch(() => {});
  }, 200);
}
const events = new EventSource("/api/events");
events.addEventListener("update", scheduleRefresh);
events.onopen = () => {
  scheduleRefresh();
};
events.onerror = () => {
  $("#connection").className = "connection";
  $("#connection").lastChild.textContent = "连接中断，自动重连";
};
refresh().catch((e) => {
  toast("无法连接本机服务：" + e.message, true);
  $("#connection").lastChild.textContent = "未连接";
});
