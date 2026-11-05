import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { normalize, now } from "./core.mjs";

export async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {}
  const roots = [
    process.cwd(),
    path.join(
      os.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node",
    ),
  ];
  if (process.env.PLAYWRIGHT_MODULE_PATH)
    return createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE_PATH);
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "package.json"))("playwright");
    } catch {}
  }
  throw new Error(
    "缺少playwright依赖，请在脚本目录执行 npm install。可用现有Edge，不需要下载浏览器。",
  );
}

export const SITES = {
  douyin: {
    url: "https://www.douyin.com/jingxuan",
    input: 'input[data-e2e="searchbar-input"]',
    panels: [
      '[data-e2e="search-suggest"]',
      '[data-e2e="search-sug"]',
      '[data-e2e="searchbar-suggest"]',
      '[class*="suggest"]',
      '[class*="Suggest"]',
      '[role="listbox"]',
    ],
    items: [
      '[data-e2e*="suggest-item"]',
      '[data-e2e*="sug-item"]',
      '[role="option"]',
      "li",
    ],
  },
  xiaohongshu: {
    url: "https://www.xiaohongshu.com/explore",
    input:
      'input#search-input,input[placeholder*="搜索小红书"],input[placeholder="搜索"]',
    panels: [
      ".sug-container",
      ".suggest-container",
      ".search-suggestion",
      ".search-suggest",
      '[class*="suggest"]',
      '[role="listbox"]',
    ],
    items: [
      ".sug-item",
      ".suggest-item",
      ".search-suggestion-item",
      '[role="option"]',
      "li",
    ],
  },
};

export function parseResponse(platform, body) {
  const code = body?.status_code ?? body?.code;
  // Observed XHS success envelope is code=1000 AND success=true. Failed
  // envelopes (including 3002/NULL) are not confirmed empty suggestions.
  if (body?.success === false) return null;
  if (code !== undefined && code !== 0 && code !== 200 &&
      !(platform === "xiaohongshu" && code === 1000 && body?.success === true)) return null;
  const arrays =
    platform === "douyin"
      ? [body?.sug_list, body?.data?.sug_list, body?.data?.sug_items]
      : [
          body?.data?.sug_items,
          body?.data?.items,
          body?.data?.queries,
          body?.data?.suggestions,
        ];
  const values = arrays.find(Array.isArray);
  if (!values) return null;
  const result = values
    .map((x) =>
      typeof x === "string"
        ? x
        : platform === "douyin"
          ? (x?.word ?? x?.content)
          : (x?.text ?? x?.query ?? x?.word),
    )
    .filter((x) => typeof x === "string");
  if (result.length !== values.length) return null;
  return result;
}

export async function assertRestrictions(page) {
  if (page.isClosed()) throw new Error("浏览器已关闭，断点已保留");
  const text = await page.locator("body").innerText({ timeout: 5000 });
  if (
    /\/website-login\/error/.test(page.url()) ||
    /当前网络存在风险|安全限制|操作过于频繁|访问过于频繁|访问受限/.test(text)
  )
    throw new Error(
      "平台限制：当前访问被限制，已暂停；请人工检查平台提示后再续跑",
    );
  for (const selector of [
    "iframe#nocaptcha-container",
    'iframe[src*="verifycenter"]',
    '[class*="captcha-verify"]',
  ]) {
    const els = page.locator(selector);
    for (let i = 0; i < (await els.count()); i++)
      if (await els.nth(i).isVisible())
        throw new Error("平台要求验证：已暂停，不能自动跳过验证码");
  }
  if (/请完成.{0,10}验证|拖动.{0,10}滑块|验证码验证/.test(text))
    throw new Error("平台要求验证：已暂停，请人工处理");
  return text;
}

const LOGIN_DIALOGS = '[id^="login-full-panel"],.login-container';
const LOGIN_CLOSE = [
  '[aria-label="关闭"]', '[aria-label="Close"]', '[title="关闭"]',
  '[data-e2e="login-close"]', '[data-e2e="login-close-button"]',
  '.close-button', '[class*="close"]', '[class*="Close"]', '.YoNA2Hyj',
  // Observed Douyin header: title followed by a div containing the X SVG.
  '#douyin_login_comp_flat_panel_header > div:has(> svg)',
];

async function visibleLogin(page) {
  const dialogs = page.locator(LOGIN_DIALOGS);
  for (let i = 0; i < await dialogs.count(); i++)
    if (await loginVisible(dialogs.nth(i))) return dialogs.nth(i);
  return null;
}

export async function dismissLoginPopup(page, { maxClose = 2, controlTimeoutMs = 3000 } = {}) {
  // Only normal UI clicks on a visible login dialog's close control. Never
  // remove an overlay, force-click through it, or close verification prompts.
  await assertRestrictions(page);
  let closed = 0;
  for (let attempt = 0; attempt < maxClose; attempt++) {
    let dialog = await visibleLogin(page);
    if (!dialog) return closed;
    let clicked = false;
    const deadline = Date.now() + controlTimeoutMs;
    // The portal mounts before its close control on some platform builds.
    // Wait for the ordinary UI instead of immediately requesting manual help.
    while (Date.now() < deadline && !clicked) {
      await assertRestrictions(page);
      dialog = await visibleLogin(page);
      if (!dialog) return closed;
      for (const selector of LOGIN_CLOSE) {
        const controls = dialog.locator(selector);
        for (let i = 0; i < (await controls.count()); i++) {
          const control = controls.nth(i);
          if (!(await control.isVisible())) continue;
          try {
            await control.click({ timeout: Math.min(700, Math.max(1, deadline - Date.now())) });
            clicked = true;
            break;
          } catch {
            await assertRestrictions(page);
          }
        }
        if (clicked || Date.now() >= deadline) break;
      }
      if (!clicked) await page.waitForTimeout(100);
    }
    if (!clicked)
      throw new Error(
        "登录弹窗未找到可正常点击的关闭按钮，已保留断点；请人工关闭",
      );
    // A successful click is not yet proof that the modal disappeared.
    const disappearDeadline = Date.now() + 2000;
    while (await loginVisible(dialog)) {
      await assertRestrictions(page);
      if (Date.now() >= disappearDeadline)
        throw new Error("登录弹窗关闭按钮已点击但弹窗未消失，已保留断点");
      await page.waitForTimeout(100);
    }
    closed++;
  }
  if (await visibleLogin(page))
      throw new Error("登录弹窗关闭后仍持续出现，已暂停；请检查是否要求登录");
  return closed;
}

async function loginVisible(dialog) {
  // Portals can mount fixed overlays inside a zero-size host div. Visibility
  // of the host alone misses a modal that still intercepts normal clicks.
  if (!await dialog.count()) return false;
  return dialog.evaluate((root) =>
    [root, ...root.querySelectorAll("*")].some((e) => {
      const r = e.getBoundingClientRect(),
        s = getComputedStyle(e);
      for (let ancestor = e; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || Number(style.opacity) === 0) return false;
      }
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.display !== "none" &&
        s.visibility !== "hidden" &&
        Number(s.opacity) !== 0
      );
    }),
  );
}

export async function assertAccess(page) {
  const text = await assertRestrictions(page);
  if (/登录后(?:即可|才能|方可)搜索|请登录后搜索/.test(text))
    throw new Error("平台明确要求登录后搜索：关闭普通登录提示后仍需人工登录");
  for (const selector of ['[id^="login-full-panel"]', ".login-container"]) {
    const els = page.locator(selector);
    for (let i = 0; i < (await els.count()); i++)
      if (await loginVisible(els.nth(i)))
        throw new Error(
          "需要人工登录：登录弹窗阻挡搜索框，请先运行 login 命令完成登录",
        );
  }
}

export async function readDropdown(page, platform, inputSelector) {
  return page.evaluate(
    ({ site, inputSelector, platform }) => {
      const visible = (e) => {
        const style = getComputedStyle(e);
        return (
          e.getClientRects().length > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity) !== 0
        );
      };
      const input = [...document.querySelectorAll(inputSelector)].find(visible);
      if (!input) return null;
      const box = input.getBoundingClientRect(),
        panels = [];
      for (const selector of site.panels)
        for (const e of document.querySelectorAll(selector))
          if (visible(e)) panels.push({ e, selector });
      // Some Douyin builds use hashed classes. Limit fallback to the search-input
      // ancestor: never scan result cards or the whole page for short text.
      let ancestor = input.parentElement;
      for (
        let level = 0;
        ancestor && level < 4;
        level++, ancestor = ancestor.parentElement
      ) {
        if (ancestor === document.body || ancestor.clientHeight > 600) break;
        for (const e of ancestor.children) {
          if (e.contains(input) || !visible(e)) continue;
          const r = e.getBoundingClientRect(),
            style = getComputedStyle(e);
          if (
            ["absolute", "fixed"].includes(style.position) &&
            r.top >= box.bottom - 20 &&
            r.width > 160 &&
            r.height > 30
          )
            panels.push({ e, selector: "search-input-ancestor-dropdown" });
        }
      }
      for (const { e, selector } of panels) {
        const r = e.getBoundingClientRect();
        if (
          r.bottom < box.bottom ||
          r.top > box.bottom + 120 ||
          r.left > box.right + 100 ||
          r.right < box.left
        )
          continue;
        if (
          /^(?:搜索历史|历史记录|猜你想搜|搜索发现)/.test(
            (e.innerText || "").trim(),
          )
        )
          continue;
        let items = [];
        for (const itemSelector of site.items) {
          const found = [...e.querySelectorAll(itemSelector)].filter(visible);
          if (found.length) {
            items = found;
            break;
          }
        }
        if (!items.length) {
          items = [...e.children].filter(
            (x) => visible(x) && (x.innerText || "").trim(),
          );
          if (items.length === 1 && items[0].children.length > 1)
            items = [...items[0].children].filter(visible);
        }
        const values = items
          .map((x) => {
            // XHS renders highlighted suggestions as one span per character.
            // innerText inserts line breaks between these spans. Read only
            // the verified word wrapper, not the whole row (badges/counts).
            const word =
              platform === "xiaohongshu" && x.matches(".sug-item")
                ? x.querySelector(".sug-text-wrapper")
                : null;
            if (word && visible(word)) return [(word.textContent || "").trim()];
            return (x.innerText || "").trim().split("\n").filter(Boolean);
          })
          .filter((lines) => lines.length === 1)
          .map((lines) => lines[0])
          .filter(
            (x) =>
              x.length <= 100 &&
              !/^(历史记录|猜你想搜|搜索发现|清空|删除|查看更多|搜索历史)$/.test(
                x,
              ),
          );
        if (values.length)
          return {
            suggestions: values,
            selector,
            inputValue: input.value,
            panelText: e.innerText.slice(0, 4000),
          };
        if (/暂无(?:相关|搜索)?(?:联想|建议|结果)|无搜索建议/.test(e.innerText))
          return {
            suggestions: [],
            selector,
            inputValue: input.value,
            panelText: e.innerText,
          };
      }
      return null;
    },
    { site: SITES[platform], inputSelector, platform },
  );
}

export class BrowserProvider {
  constructor(options) {
    this.options = options;
    this.contexts = new Map();
    this.pages = new Map();
    this.lastQuery = new Map();
    this.transportErrors = [];
    this.loginPopupsClosed = 0;
  }
  async ready(page) {
    const closed = await dismissLoginPopup(page);
    this.loginPopupsClosed += closed;
    try {
      await assertAccess(page);
    } catch (error) {
      // One late-mounted ordinary dialog can appear between the two checks.
      if (!/登录弹窗阻挡/.test(error.message)) throw error;
      const lateClosed = await dismissLoginPopup(page);
      this.loginPopupsClosed += lateClosed;
      await assertAccess(page);
    }
  }
  async open(platform) {
    if (this.pages.has(platform)) return this.pages.get(platform);
    const { chromium } = await loadPlaywright();
    const profile = path.join(this.options.profileDir, platform);
    await fs.mkdir(profile, { recursive: true });
    const context = await chromium.launchPersistentContext(profile, {
      channel: this.options.channel || "msedge",
      headless: !!this.options.headless,
      viewport: { width: 1440, height: 1000 },
      downloadsPath: path.join(this.options.workDir, "downloads"),
      timeout: 45000,
    });
    this.contexts.set(platform, context);
    const page = context.pages()[0] || (await context.newPage());
    this.pages.set(platform, page);
    // Video playback is irrelevant to the visible autocomplete list.
    await context.route(/\.(?:mp4|webm)(?:\?|$)/i, (route) => route.abort());
    await page.goto(SITES[platform].url, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page.waitForTimeout(1800);
    if (this.options.manualLogin) await assertRestrictions(page);
    else await this.ready(page);
    return page;
  }
  async get(platform, term) {
    const startedAt = Date.now();
    const diagnostics = { platform, term, startedAt: now(), network: [], recovery: null };
    const page = await this.open(platform);
    await this.ready(page);
    const input = page
      .locator(SITES[platform].input)
      .filter({ visible: true })
      .first();
    if (!(await input.count()))
      throw new Error("没有可用搜索框：请先人工登录或检查页面；未当作无联想词");
    const gap = this.options.delayMs - (Date.now() - (this.lastQuery.get(platform) || 0));
    if (gap > 0) await page.waitForTimeout(gap);
    const inputMax = await input.getAttribute("maxlength");
    if (inputMax && term.length > Number(inputMax))
      throw new Error("联想词超过平台输入上限，已保留该词并暂停，不截断原词");
    const oldDropdown = await readDropdown(
      page,
      platform,
      SITES[platform].input,
    );
    const oldSignature = oldDropdown
      ? JSON.stringify(oldDropdown.suggestions)
      : null;
    const responses = [];
    let active = true;
    const pending = new Set();
    const listener = (response) => {
      const task = (async () => {
        const url = new URL(response.url());
        const domain = platform === "douyin" ? "douyin.com" : "xiaohongshu.com";
        if (url.hostname !== domain && !url.hostname.endsWith("." + domain))
          return;
        if (
          !/suggest|sugrec|sug\/|search\/(?:sug|recommend)/i.test(url.pathname)
        )
          return;
        const request = response.request();
        let body = {};
        try {
          body = request.postDataJSON() || {};
        } catch {}
        const query =
          url.searchParams.get("keyword") ??
          url.searchParams.get("query") ??
          url.searchParams.get("word") ??
          body.keyword ??
          body.query ??
          body.word;
        if (typeof query !== "string" || normalize(query) !== normalize(term))
          return;
        if (response.status() === 429) {
          responses.push({ blocked: true });
          diagnostics.network.push({ elapsedMs: Date.now() - startedAt, httpStatus: 429 });
          return;
        }
        if (!response.ok()) {
          const problem = { unconfirmed: true, httpStatus: response.status() };
          responses.push(problem);
          diagnostics.network.push({ elapsedMs: Date.now() - startedAt, ...problem });
          return;
        }
        try {
          const body = await response.json();
          const suggestions = parseResponse(platform, body);
          const envelope = { elapsedMs: Date.now() - startedAt, httpStatus: response.status(),
            code: body?.status_code ?? body?.code, success: body?.success,
            message: String(body?.msg ?? body?.message ?? "").slice(0,200),
            suggestionCount: suggestions === null ? null : suggestions.length };
          diagnostics.network.push(envelope);
          if (active && suggestions !== null)
            responses.push({
              suggestions,
              endpoint: url.origin + url.pathname,
            });
          else if (active) responses.push({ unconfirmed: true, ...envelope });
        } catch {}
      })();
      pending.add(task);
      task.finally(() => pending.delete(task));
    };
    page.on("response", listener);
    try {
      // A marketing login popup may appear after the page has settled. Close it
      // before retrying this one UI click; do not repeat a successful query.
      try {
        await input.click({ timeout: 2500 });
      } catch (error) {
        const count = await dismissLoginPopup(page);
        this.loginPopupsClosed += count;
        if (!count) throw error;
        await input.click({ timeout: 3000 });
      }
      await input.fill("");
      // Sequential key events trigger builds that do not open suggestions on
      // an input event alone. Do not submit a search or open video results.
      await input.pressSequentially(term, { delay: 80 });
      this.lastQuery.set(platform, Date.now());
      let deadline = Date.now() + this.options.timeoutMs;
      let generationStart = 0;
      let generationStartedAt = Date.now();
      let previous = "",
        stable = 0;
      const unconfirmed = () => {
        const latest = diagnostics.network.at(-1);
        const detail = latest?.message ? "；平台响应：" + latest.code + "（" + latest.message + "）" : "";
        const error = new Error("等待联想结果超时：" + (platform === "douyin" ? "抖音" : "小红书") +
          "「" + term + "」经等待和一次重新输入，仍未取得可确认的联想结果" + detail);
        error.code = "RESULT_UNCONFIRMED";
        return error;
      };
      const recover = async (reason) => {
        await this.ready(page);
        const gap = this.options.delayMs - (Date.now() - this.lastQuery.get(platform));
        if (gap > 0) await page.waitForTimeout(gap);
        diagnostics.recovery = { reason, elapsedMs: Date.now() - startedAt };
        generationStart = responses.length;
        await input.click({timeout:3000});
        await input.fill("");
        await input.pressSequentially(term, {delay:80});
        this.lastQuery.set(platform,Date.now());
        generationStartedAt = Date.now();
        deadline = Date.now() + (this.options.recoveryTimeoutMs ?? this.options.timeoutMs);
        previous = ""; stable = 0;
      };
      while (true) {
        await page.waitForTimeout(400);
        await this.ready(page);
        if (normalize(await input.inputValue()) !== normalize(term))
          throw new Error("搜索框词发生变化，拒绝把其它词的联想结果混入");
        if (responses.some((x) => x.blocked))
          throw new Error("平台限流429：已暂停，不继续请求");
        const dom = await readDropdown(page, platform, SITES[platform].input);
        if (dom && normalize(dom.inputValue) === normalize(term)) {
          const signature = JSON.stringify(dom.suggestions);
          stable = signature === previous ? stable + 1 : 0;
          previous = signature;
          if (
            stable >= 2 &&
            (signature !== oldSignature ||
              responses.some((x) => Array.isArray(x.suggestions)))
          )
            return {
              suggestions: dom.suggestions,
              source: "visible_search_dropdown",
              pageUrl: page.url(),
              selector: dom.selector,
              observedAt: now(),
              loginPopupsClosed: this.loginPopupsClosed,
            };
        } else { previous = ""; stable = 0; }
        // Passive observation only: use the site's own autocomplete response,
        // matched to the exact full query. Never call an unsigned private API.
        const network = responses.find((x) => Array.isArray(x.suggestions));
        if (network && Date.now() - generationStartedAt >= 1800)
          return {
            ...network,
            source: "browser_autocomplete_response",
            pageUrl: page.url(),
            observedAt: now(),
            loginPopupsClosed: this.loginPopupsClosed,
          };
        const backendFailure = !network && responses.slice(generationStart).some(x => x.unconfirmed);
        if (backendFailure || Date.now() >= deadline) {
          if (!diagnostics.recovery) await recover(backendFailure ? "platform_response_unconfirmed" : "result_wait_timeout");
          else throw unconfirmed();
        }
      }
    } catch (error) {
      const dir = path.join(this.options.workDir, "diagnostics");
      await fs.mkdir(dir, { recursive: true });
      try {
        await page.screenshot({
          path: path.join(dir, platform + "-latest.png"),
        });
      } catch {}
      try {
        diagnostics.elapsedMs = Date.now() - startedAt;
        diagnostics.error = error.message;
        diagnostics.errorCode = error.code || null;
        diagnostics.input = await input.evaluate(e => ({value:e.value,focused:document.activeElement === e,documentFocused:document.hasFocus()}));
        await fs.writeFile(path.join(dir,platform+"-latest.json"),JSON.stringify(diagnostics,null,2));
      } catch {}
      try {
        await assertAccess(page);
      } catch (accessError) {
        throw accessError;
      }
      throw error;
    } finally {
      active = false;
      page.off("response", listener);
      await Promise.allSettled([...pending]);
    }
  }
  async close() {
    for (const c of this.contexts.values())
      try {
        await c.close();
      } catch {}
    this.contexts.clear();
    this.pages.clear();
  }
}
