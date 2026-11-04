// Offline end-to-end tests use an injected provider only. Production GUI has
// no fixture mode and never substitutes generated words for platform results.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JobManager } from "../jobs.mjs";
import { createApp } from "../server.mjs";
import { loadPlaywright } from "../browser.mjs";
import { unzipSync } from "fflate";
const base = path.join(
  process.env.SSM_TEST_DIR ||
    path.join(
      process.platform === "win32" ? "E:/Codex/temp" : os.tmpdir(),
      "search-suggest-map-ui",
      String(process.pid),
    ),
  "run-" + Date.now(),
);
const shots = process.env.SSM_SCREENSHOT_DIR || path.join(base, "screenshots");
await fs.mkdir(shots, { recursive: true });
let verification = true,
  instances = 0;
const successes = [];
const manager = new JobManager({
  dataDir: path.join(base, "data"),
  workDir: path.join(base, "work"),
  providerFactory: () => {
    instances++;
    return {
      get: async (platform, term) => {
        if (verification) {
          verification = false;
          throw new Error("平台要求验证：离线测试人工确认流程");
        }
        await new Promise((r) => setTimeout(r, 110));
        successes.push(term);
        return {
          source: "visible_search_dropdown",
          suggestions: Array.from(
            { length: 5 },
            (_, i) => term + "-" + (i + 1),
          ),
        };
      },
      close: async () => {},
    };
  },
});
await manager.init();
const app = await createApp({ manager, port: 0 });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
      viewport: { width: 1500, height: 1000 },
      acceptDownloads: true,
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.url);
  await page.waitForSelector(".connection.online");
  await page.screenshot({
    path: path.join(shots, "workbench-empty.png"),
    fullPage: true,
  });
  await page.locator("#help-btn").click();
  assert(await page.locator("#info-dialog").isVisible());
  await page.locator("#dialog-done").click();
  await page.locator("#seeds").fill("界面回归样本");
  await page.locator("#start-btn").click();
  await page.locator("#manual-banner").waitFor({ state: "visible" });
  assert.equal(instances, 1);
  await page.screenshot({
    path: path.join(shots, "workbench-verification.png"),
    fullPage: true,
  });
  await page.locator("#continue-btn").click();
  await page.waitForFunction(
    () => Number(document.querySelector("#stat-done").textContent) >= 2,
  );
  await page.locator("#pause-btn").click();
  await page.waitForFunction(
    () => document.querySelector("#task-status").textContent === "已暂停",
  );
  const finishedBefore = successes.length;
  assert(finishedBefore >= 2 && finishedBefore < 31);
  assert.equal(await page.locator('#max-queries').count(), 0);
  await page.getByRole('button', {name:'编辑任务 界面回归样本', exact:true}).click();
  await page.locator('#edit-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#edit-seeds').isDisabled(),true);
  await page.locator('#edit-delay').fill('8');
  await page.locator('#cancel-edit').click();
  assert.equal(manager.list()[0].options.delayMs,5000);
  await page.locator('#edit-btn').click();
  await page.locator('#edit-delay').fill('3');
  await page.screenshot({path:path.join(shots,'edit-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const box = await page.locator('#edit-dialog').boundingBox();
  assert(box.x>=0 && box.x+box.width<=390);
  await page.screenshot({path:path.join(shots,'edit-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1500,height:1000});
  await page.locator('#save-edit').click();
  await page.locator('#edit-dialog').waitFor({state:'hidden'});
  assert.equal(manager.list()[0].options.delayMs,3000);
  assert.equal(successes.length,finishedBefore);
  await page.reload();
  await page.waitForSelector('.connection.online');
  await page.locator('#edit-btn').click();
  assert.equal(await page.locator('#edit-delay').inputValue(),'3');
  await page.locator('#cancel-edit').click();
  await page.locator("#resume-btn").click();
  await page.waitForFunction(
    () => document.querySelector("#task-status").textContent === "已完成",
    {},
    { timeout: 20000 },
  );
  assert.equal(successes.length, 31);
  assert.equal(new Set(successes).size, 31);
  assert.equal(instances, 2);
  assert.equal(await page.locator("#stat-words").innerText(), "156");
  await page.locator("#expand-map").click();
  assert.equal(await page.locator(".tree-node").count(), 156);
  await page.locator("#collapse-map").click();
  assert.equal(await page.locator(".tree-node").count(), 6);
  await page.locator("#search").fill("界面回归样本-5-5-5");
  await page.locator("#search").press("Enter");
  assert(
    (await page.locator("#node-details").innerText()).includes(
      "界面回归样本-5-5-5",
    ),
  );
  assert((await page.locator(".tree-node.match").count()) > 0);
  await page.locator("#words-tab").click();
  assert.equal(await page.locator("#words-body tr").count(), 1);
  await page.locator("#search").fill("");
  assert.equal(await page.locator("#words-body tr").count(), 156);
  await page.locator("#files-tab").click();
  assert.equal(await page.locator(".file-item").count(), 8);
  const downloading = page.waitForEvent("download");
  await page.locator("#zip-btn").click();
  const download = await downloading;
  await download.saveAs(path.join(base, "result.zip"));
  assert(
    unzipSync(new Uint8Array(await fs.readFile(path.join(base, "result.zip"))))[
      "完整性核验.json"
    ],
  );
  const imported =
    process.env.SSM_REAL_RESULT ||
    path.join(manager.get(manager.list()[0].id).dir, "checkpoint.json");
  await page.locator("#import-file").setInputFiles(imported);
  await page.waitForFunction(
    () => document.querySelector("#history-count").textContent === "2",
  );
  if (process.env.SSM_REAL_RESULT) {
    await page.locator("#seeds").fill("考研");
    await page.locator("#search").fill("考研英语作文");
    await page.locator("#search").press("Enter");
    await page.locator("#search").fill("");
  }
  await page.locator("#map-tab").click();
  await page.locator("#collapse-map").click();
  await page.locator("#toast").waitFor({ state: "hidden" });
  await page.screenshot({
    path: path.join(shots, "workbench-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "mobile document overflows",
  );
  await page.screenshot({
    path: path.join(shots, "workbench-mobile.png"),
    fullPage: true,
  });
  await page.locator("#words-tab").click();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.reload();
  await page.waitForSelector(".connection.online");
  assert.equal(await page.locator("#history-count").innerText(), "2");
  await page.locator("#help-btn").click();
  assert(await page.locator("#info-dialog").isVisible());
  await page.locator("#close-dialog").click();
  await page.locator("#delete-btn").click();
  await page.locator("#delete-dialog").waitFor({ state: "visible" });
  await page.locator("#delete-dialog button[value=cancel]").click();
  assert.equal(await page.locator("#history-count").innerText(), "2");
  await page.locator("#delete-btn").click();
  await page.locator("#confirm-delete").click();
  await page.waitForFunction(
    () => document.querySelector("#history-count").textContent === "1",
  );
  await page.locator("#undo-delete").click();
  await page.waitForFunction(
    () => document.querySelector("#history-count").textContent === "2",
  );
  await page.locator("#history-list .history-control.danger").first().click();
  await page.locator("#confirm-delete").click();
  await page.waitForFunction(
    () => document.querySelector("#history-count").textContent === "1",
  );
  await page.locator("#trash-btn").click();
  await page.locator("#trash-dialog").waitFor({ state: "visible" });
  await page.locator("#trash-list button").first().click();
  await page.waitForFunction(
    () => document.querySelector("#history-count").textContent === "2",
  );
  await page.locator("#close-trash").click();
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    offlineProvider: true,
    captchaManualContinue: true,
    pauseResume: true,
    editPausePreservesProgress: true,
    editCancelAndReload: true,
    noQueryCountLimit: true,
    successfulQueries: successes.length,
    duplicateSuccessfulQueries: 0,
    downloadZip: true,
    importCheckpoint: true,
    reloadHistory: true,
    deleteConfirmation: true,
    deleteCancel: true,
    undoDelete: true,
    restoreFromTrash: true,
    mobileWidth: 390,
    horizontalOverflow: false,
    consoleErrors: errors,
    screenshots: shots,
  };
  await fs.writeFile(
    path.join(base, "ui-verification.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await app.close();
}
