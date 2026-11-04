import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { loadPlaywright } from "./browser.mjs";
const dir = process.argv[2];
if (!dir) throw new Error("result directory required");
const s = JSON.parse(await fs.readFile(path.join(dir, "results.json"), "utf8"));
assert.equal(s.status, "complete");
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
      viewport: { width: 1600, height: 1050 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(dir, "mindmap.html")).href);
  const initiallyVisible = await page.locator(".node").count();
  assert(
    (await page.locator("#meta").innerText()).includes("指定深度遍历完成"),
  );
  const target = s.nodes.find((n) => n.depth === 3);
  assert(target);
  await page.locator("#search").fill(target.term);
  await page.locator("#find").click();
  assert((await page.locator("#info").innerText()).includes(target.term));
  assert((await page.locator(".node.match").count()) > 0);
  await page.locator("#expand").click();
  assert.equal(await page.locator(".node").count(), s.nodes.length);
  const fullSVG = await page.locator("svg").evaluate((svg) => {
    const copy = svg.cloneNode(true),
      g = copy.querySelector("g"),
      box = svg.querySelector("g").getBBox();
    g.removeAttribute("transform");
    copy.setAttribute(
      "viewBox",
      [box.x - 20, box.y - 20, box.width + 40, box.height + 40].join(" "),
    );
    copy.setAttribute("width", String(box.width + 40));
    copy.setAttribute("height", String(box.height + 40));
    const style = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "style",
    );
    style.textContent = document.querySelector("style").textContent;
    copy.prepend(style);
    return new XMLSerializer().serializeToString(copy);
  });
  await fs.writeFile(path.join(dir, "mindmap-full.svg"), fullSVG, "utf8");
  await page.locator("#search").fill("");
  await page.locator("#find").click();
  await page.locator("#collapse").click();
  await page.screenshot({ path: path.join(dir, "完整导图预览.png") });
  assert.deepEqual(errors, []);
  const report = {
    status: "passed",
    initiallyVisible,
    expandedNodes: s.nodes.length,
    searchTarget: target.term,
    scriptErrors: errors,
    fullSVG: true,
  };
  await fs.writeFile(
    path.join(dir, "导图交互核验.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
