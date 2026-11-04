import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createState,
  crawl,
  stats,
  normalize,
  idFor,
  exportAll,
} from "./core.mjs";
import {
  parseResponse,
  readDropdown,
  loadPlaywright,
  assertAccess,
  dismissLoginPopup,
} from "./browser.mjs";
import { mindmapHTML } from "./mindmap-template.mjs";
const TEMP =
  process.env.SSM_TEST_DIR ||
  path.join(
    process.platform === "win32" ? "E:/Codex/temp" : os.tmpdir(),
    "search-suggest-map-tests",
    String(process.pid),
  );
await fs.mkdir(TEMP, { recursive: true });
const fixture = {
  A: ["A", "A1", "A2", "A1"],
  A1: ["A11", "A2", "A"],
  A2: ["A11", "A21"],
  A11: ["A111"],
  A21: ["A211"],
};
function provider() {
  const calls = [];
  return {
    calls,
    async get(platform, word) {
      calls.push(platform + ":" + word);
      return {
        suggestions: fixture[word] || [],
        source: "offline_test_fixture",
      };
    },
  };
}
test("three layers: query depths 0–2 only; preserve cycles and shared edges without duplicate expansion", async () => {
  const state = createState({ seeds: ["A"], platforms: ["douyin"], depth: 3 }),
    p = provider();
  await crawl(state, p);
  assert.equal(state.status, "complete");
  assert.equal(p.calls.length, 5);
  assert.equal(new Set(p.calls).size, 5);
  assert.equal(state.nodes.length, 7);
  assert.equal(state.nodes.find((n) => n.term === "A111").depth, 3);
  assert.equal(
    state.nodes.find((n) => n.term === "A111").status,
    "depth_boundary",
  );
  assert(
    state.edges.some(
      (e) => e.from === idFor("douyin", "A1") && e.to === idFor("douyin", "A"),
    ),
  );
  assert(
    state.edges.some(
      (e) =>
        e.from === idFor("douyin", "A2") && e.to === idFor("douyin", "A11"),
    ),
  );
});
test("optional login popup closes with a normal UI click; real restrictions remain", async () => {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<input id="search"><div id="login-full-panel-test" style="position:fixed;inset:0;background:white"><button aria-label="关闭" onclick="this.parentElement.remove()">×</button>扫码登录</div>',
    );
    assert.equal(await dismissLoginPopup(page), 1);
    await assertAccess(page);
    await page.locator("#search").click();
    await page.setContent(
      '<input id="search"><div id="login-full-panel-zero" style="width:0;height:0"><div style="position:fixed;inset:0;background:white"><button aria-label="关闭" onclick="document.getElementById(\'login-full-panel-zero\').remove()">×</button>扫码登录</div></div>',
    );
    assert.equal(
      await page.locator('[id^="login-full-panel"]').isVisible(),
      false,
    );
    assert.equal(await dismissLoginPopup(page), 1);
    await page.locator("#search").click();
    await page.setContent(
      '<div id="login-full-panel-test"><div class="YoNA2Hyj" onclick="this.parentElement.remove()"><svg width="37" height="36"></svg></div>扫码登录</div>',
    );
    assert.equal(await dismissLoginPopup(page), 1);
    await page.setContent(
      '<div id="login-full-panel-test"><button aria-label="关闭" onclick="this.parentElement.remove()">×</button>扫码登录</div><p>请完成安全验证</p>',
    );
    await assert.rejects(dismissLoginPopup(page), /验证/);
    assert.equal(await page.locator('[id^="login-full-panel"]').count(), 1);
    await page.setContent('<div id="login-full-panel-test">没有关闭按钮</div>');
    await assert.rejects(dismissLoginPopup(page), /未找到/);
    await page.setContent("<p>请登录后搜索</p>");
    await assert.rejects(assertAccess(page), /明确要求/);
  } finally {
    await browser.close();
  }
});
test("login recovery waits for delayed controls and disappearance, ignores transparent ancestors", async () => {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input id="search"><div class="login-container" style="position:fixed;inset:0;background:white">扫码登录</div>
      <script>setTimeout(()=>{const b=document.createElement('button');b.className='close-button';b.textContent='×';b.onclick=()=>setTimeout(()=>b.parentElement.remove(),650);document.querySelector('.login-container').append(b)},500)</script>`);
    assert.equal(await dismissLoginPopup(page), 1);
    await page.locator('#search').click({timeout:1000});
    await assertAccess(page);
    await page.setContent(`<input id="search"><div style="opacity:0"><div class="login-container" style="position:fixed;inset:0">扫码登录<button class="close-button" onclick="window.clicked=true">×</button></div></div>`);
    assert.equal(await dismissLoginPopup(page), 0);
    await assertAccess(page);
    assert.equal(await page.evaluate(()=>!!window.clicked), false);
    // Stable header structure still works when the site's hashed class changes.
    await page.setContent(`<input id="search"><div id="login-full-panel-new"><div id="douyin_login_comp_flat_panel_header"><div>登录后免费畅享高清视频</div><div class="new-hash" onclick="document.getElementById('login-full-panel-new').remove()"><svg width="37" height="36"></svg></div></div></div>`);
    assert.equal(await dismissLoginPopup(page), 1);
    await page.locator('#search').click();
    await page.setContent(`<div class="login-container">扫码登录<button class="close-button">×</button></div>`);
    await assert.rejects(dismissLoginPopup(page), /未消失/);
    await page.setContent(`<div class="login-container">扫码登录</div>`);
    await assert.rejects(dismissLoginPopup(page,{controlTimeoutMs:300}), /未找到/);
  } finally { await browser.close(); }
});

test("cap is paused, checkpoint resume does not repeat successful work", async () => {
  const state = createState({ seeds: ["A"], platforms: ["douyin"], depth: 3 }),
    p = provider();
  const cp = path.join(TEMP, "resume.json");
  await crawl(state, p, { checkpoint: cp, maxQueries: 2 });
  assert.equal(state.status, "paused");
  assert.match(state.stopReason, /上限/);
  const resumed = JSON.parse(await fs.readFile(cp, "utf8"));
  await crawl(resumed, p, { checkpoint: cp });
  assert.equal(resumed.status, "complete");
  assert.equal(p.calls.length, 5);
  assert.equal(new Set(p.calls).size, 5);
});
test("case-equivalent seed words share one query identity", async () => {
  const state = createState({
    seeds: ["Ａ", "a", " A "],
    platforms: ["douyin"],
    depth: 1,
  });
  assert.equal(state.nodes.length, 1);
  const p = provider();
  await crawl(state, p);
  assert.equal(p.calls.length, 1);
});

test("same word on two platforms must be queried independently", async () => {
  const state = createState({
      seeds: ["A"],
      platforms: ["douyin", "xiaohongshu"],
      depth: 1,
    }),
    p = provider();
  await crawl(state, p);
  assert.deepEqual(p.calls, ["douyin:A", "xiaohongshu:A"]);
  assert.equal(state.nodes.length, 6);
});
test("normalize whitespace/width without forcing children to be longer or to contain parent", async () => {
  assert.equal(normalize("  Ａ  B  "), "A B");
  const state = createState({
    seeds: ["起始词"],
    platforms: ["douyin"],
    depth: 1,
  });
  await crawl(state, {
    get: async () => ({
      source: "offline_test_fixture",
      suggestions: ["相关", "  相关  ", "更短"],
    }),
  });
  assert.equal(state.nodes.length, 3);
});
test("blocked and malformed responses leave query pending, never fabricate zero results", async () => {
  for (const p of [
    {
      get: async () => {
        throw new Error("平台要求验证");
      },
    },
    { get: async () => ({ suggestions: [] }) },
  ]) {
    const state = createState({
      seeds: ["A"],
      platforms: ["douyin"],
      depth: 2,
    });
    await crawl(state, p);
    assert.equal(state.status, "paused");
    assert.equal(state.nodes[0].status, "pending");
    assert.equal(state.observations.length, 0);
  }
});
test("confirmed empty suggestions are a successful terminal branch", async () => {
  const state = createState({ seeds: ["A"], platforms: ["douyin"], depth: 3 });
  await crawl(state, {
    get: async () => ({ source: "offline_test_fixture", suggestions: [] }),
  });
  assert.equal(state.status, "complete");
  assert.equal(stats(state).completedQueries, 1);
});
test("interrupted querying nodes are recovered as pending", async () => {
  const state = createState({ seeds: ["A"], platforms: ["douyin"], depth: 1 });
  state.nodes[0].status = "querying";
  const p = provider();
  await crawl(state, p);
  assert.equal(p.calls.length, 1);
});
test("response parser requires supported schema and successful status", () => {
  assert.deepEqual(
    parseResponse("douyin", {
      status_code: 0,
      sug_list: [{ word: "茶百道好喝" }],
    }),
    ["茶百道好喝"],
  );
  assert.deepEqual(
    parseResponse("xiaohongshu", {
      code: 0,
      data: { sug_items: [{ text: "茶百道推荐" }] },
    }),
    ["茶百道推荐"],
  );
  assert.equal(
    parseResponse("douyin", { status_code: 429, sug_list: [] }),
    null,
  );
  assert.equal(parseResponse("douyin", { message: "login required" }), null);
  assert.equal(
    parseResponse("xiaohongshu", { code: 0, data: { sug_items: [{}] } }),
    null,
  );
});
test("export preserves cross-edges, completion state and safe embedded data", async () => {
  const state = createState({
    seeds: ["A", "</script><img src=x>"],
    platforms: ["douyin"],
    depth: 3,
  });
  await crawl(state, provider(), { maxQueries: 2 });
  const dir = path.join(TEMP, "export");
  await exportAll(state, dir, mindmapHTML);
  for (const name of [
    "mindmap.html",
    "mindmap.md",
    "mindmap.mm",
    "keywords.csv",
    "relations.csv",
    "results.json",
  ])
    assert((await fs.stat(path.join(dir, name))).size > 0);
  const html = await fs.readFile(path.join(dir, "mindmap.html"), "utf8");
  assert(!html.includes("</script><img"));
  assert(html.includes("\\u003c/script"));
  const xml = await fs.readFile(path.join(dir, "mindmap.mm"), "utf8");
  assert(xml.includes("&lt;/script&gt;"));
  assert(xml.includes("paused"));
});
test("real browser DOM extraction and offline map rendering", async () => {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
    });
    await page.setContent(
      '<input data-e2e="searchbar-input" value="茶百道" style="margin-left:300px;width:500px;height:30px"><ul role="listbox" style="position:absolute;left:308px;top:38px;width:500px"><li role="option">茶百道好喝</li><li role="option">茶百道团购</li></ul><div class="video-card">不能采集视频标题</div>',
    );
    assert.deepEqual(
      (await readDropdown(page, "douyin", "input")).suggestions,
      ["茶百道好喝", "茶百道团购"],
    );
    await page.locator("ul").evaluate((e) => (e.style.display = "none"));
    assert.equal(await readDropdown(page, "douyin", "input"), null);
    await page.setContent("<h1>安全限制</h1><p>当前网络存在风险</p>");
    await assert.rejects(assertAccess(page), /平台限制/);
    await page.setContent('<div id="login-full-panel-test">扫码登录</div>');
    await assert.rejects(assertAccess(page), /需要人工登录/);
    const state = createState({
      seeds: ["A"],
      platforms: ["douyin"],
      depth: 3,
    });
    await crawl(state, provider());
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(mindmapHTML(state));
    assert.equal(await page.locator(".node").count(), 7);
    await page.getByText("只看第一层", { exact: true }).click();
    assert.equal(await page.locator(".node").count(), 3);
    await page.locator("#search").fill("A111");
    await page.locator("#find").click();
    assert((await page.locator(".node.match").count()) > 0);
    assert((await page.locator("#info").innerText()).includes("A111"));
    await page.screenshot({ path: path.join(TEMP, "map-fixture-preview.png") });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("XHS guest autocomplete joins highlighted characters without badges or login", async () => {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
    });
    await page.setContent(`<input id="search-input" value="老年" placeholder="登录探索更多内容" style="margin-left:300px;width:500px;height:30px">
      <button class="login-btn">登录</button>
      <div class="login-container" style="position:fixed;inset:0;background:white;z-index:9"><div class="icon-btn-wrapper close-button" onclick="this.parentElement.remove()">关闭</div>扫码登录</div>
      <div class="sug-container" style="position:absolute;left:308px;top:38px;width:500px">
        <div class="sug-item"><div class="sug-text-wrapper"><span style="display:block">老</span><span style="display:block">年</span><span style="display:block">人</span><span style="display:block">头像</span></div><span>热门</span></div>
        <div class="sug-item"><div class="sug-text-wrapper">老年人 AI 手机</div><span>1000</span></div>
        <div class="sug-item" style="display:none"><div class="sug-text-wrapper">隐藏词</div></div>
      </div><div class="video-card">不得采集推荐视频标题</div>`);
    assert.equal(await dismissLoginPopup(page), 1);
    await assertAccess(page);
    const found = await readDropdown(page, "xiaohongshu", "#search-input");
    assert.deepEqual(found.suggestions, ["老年人头像", "老年人 AI 手机"]);
    assert.equal(
      await page.getByRole("button", { name: "登录", exact: true }).isVisible(),
      true,
    );
    await page
      .locator(".sug-container")
      .evaluate((x) => (x.style.display = "none"));
    assert.equal(
      await readDropdown(page, "xiaohongshu", "#search-input"),
      null,
    );
  } finally {
    await browser.close();
  }
});
