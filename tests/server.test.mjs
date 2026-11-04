import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { unzipSync, strFromU8 } from "fflate";
import { JobManager } from "../jobs.mjs";
import { createApp } from "../server.mjs";

test("HTTP workflow: local security, task creation, collection, safe exports, ZIP", async () => {
  const dir = path.join(
    process.platform === "win32" ? "E:/Codex/temp" : os.tmpdir(),
    "search-suggest-map-tests",
    String(process.pid),
    "http",
  );
  const m = new JobManager({
    dataDir: path.join(dir, "data"),
    workDir: path.join(dir, "work"),
    providerFactory: () => ({
      get: async () => ({
        source: "visible_search_dropdown",
        suggestions: ["测试分支"],
      }),
      close: async () => {},
    }),
  });
  await m.init();
  const app = await createApp({ manager: m, port: 0 });
  try {
    const boot = await (await fetch(app.url + "/api/bootstrap")).json();
    const headers = {
      "Content-Type": "application/json",
      Origin: app.url,
      "X-SSM-Token": boot.token,
    };
    const post = (url, body) =>
      fetch(app.url + url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    assert.equal((await fetch(app.url)).status, 200);
    assert.equal((await fetch(app.url + "/style.css")).status, 200);
    assert.equal(
      (
        await fetch(app.url + "/api/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(app.url + "/api/jobs", {
          method: "POST",
          headers: { ...headers, Origin: "https://example.com" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await post("/api/jobs", { seeds: [] })).status, 400);
    const response = await post("/api/jobs", { seeds: ["界面测试"], depth: 1 });
    assert.equal(response.status, 201);
    const j = await response.json();
    assert.equal((await post("/api/jobs/" + j.id + "/start", {})).status, 200);
    await m.get(j.id).promise;
    const result = await (await fetch(app.url + "/api/jobs/" + j.id)).json();
    assert.equal(result.status, "complete");
    assert.equal(result.uniqueKeywords, 2);
    assert.equal(
      (
        await fetch(
          app.url +
            "/api/jobs/" +
            j.id +
            "/files/" +
            encodeURIComponent("../task.json"),
        )
      ).status,
      404,
    );
    const html = await fetch(
      app.url + "/api/jobs/" + j.id + "/files/mindmap.html",
    );
    assert.equal(html.status, 200);
    assert((await html.text()).includes("界面测试"));
    const archive = await fetch(
      app.url + "/api/jobs/" + j.id + "/download.zip",
    );
    assert.equal(archive.status, 200);
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    assert(files["完整性核验.json"]);
    assert(!files["task.json"]);
    assert.equal(
      JSON.parse(strFromU8(files["results.json"])).status,
      "complete",
    );
    assert.equal((await post("/api/import", { version: 1 })).status, 400);
    const deleted = await post("/api/jobs/" + j.id + "/delete", {});
    assert.equal(deleted.status, 200);
    const record = await deleted.json();
    assert.equal((await fetch(app.url + "/api/jobs/" + j.id)).status, 404);
    const trash = await (await fetch(app.url + "/api/trash")).json();
    assert.equal(trash.length, 1);
    const restored = await post(
      "/api/trash/" + record.trashId + "/restore",
      {},
    );
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).id, j.id);
  } finally {
    await app.close();
  }
});
