import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { zipSync } from "fflate";
import { JobManager, EXPORTS } from "./jobs.mjs";
import { defaultDataRoot, defaultWorkRoot } from "./paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ["/", "index.html"],
  ["/app.js", "app.js"],
  ["/style.css", "style.css"],
  ["/favicon.svg", "favicon.svg"],
]);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mm": "application/x-freemind",
};
export async function createApp({
  dataDir,
  workDir,
  manager,
  port = 4177,
} = {}) {
  const jobs =
    manager ||
    new JobManager({
      dataDir: dataDir || defaultDataRoot(),
      workDir: workDir || defaultWorkRoot(),
    });
  if (!manager) await jobs.init();
  const token = randomBytes(32).toString("hex"),
    clients = new Set();
  let allowedHosts = new Set();
  const send = (res, code, data) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const publish = () => {
    for (const res of clients) res.write("event: update\ndata: {}\n\n");
  };
  jobs.on("update", publish);
  jobs.on("session", publish);
  async function readJSON(req) {
    let count = 0;
    const chunks = [];
    for await (const chunk of req) {
      count += chunk.length;
      if (count > 24 * 1024 * 1024)
        throw Object.assign(new Error("文件超过24MB上限。"), {
          statusCode: 413,
        });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("请求内容不是有效JSON。"), {
        statusCode: 400,
      });
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    try {
      if (!allowedHosts.has(req.headers.host)) {
        send(res, 403, { error: "仅允许通过本机地址访问。" });
        return;
      }
      const url = new URL(req.url, "http://" + req.headers.host);
      if (req.method !== "GET") {
        if (
          req.headers.origin !== "http://" + req.headers.host ||
          req.headers["x-ssm-token"] !== token
        ) {
          send(res, 403, { error: "页面会话已失效，请刷新后重试。" });
          return;
        }
        if (
          !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")
        ) {
          send(res, 415, { error: "仅接受JSON请求。" });
          return;
        }
      }
      if (req.method === "GET" && staticFiles.has(url.pathname)) {
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
        );
        const file = path.join(HERE, "public", staticFiles.get(url.pathname));
        res.writeHead(200, {
          "Content-Type": mime[path.extname(file)],
          "Cache-Control": "no-cache",
        });
        res.end(await fs.readFile(file));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        send(res, 200, {
          token,
          version: "2.4.0",
          capabilities: { deleteTask: true, trash: true, editTask: true, parallelPlatforms: true },
          dataDir: jobs.dataDir,
          workDir: jobs.workDir,
          jobs: jobs.list(),
          active: jobs.active,
          session: jobs.sessionInfo(),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        clients.add(res);
        const heartbeat = setInterval(
          () => res.write(": heartbeat\n\n"),
          20000,
        );
        req.on("close", () => {
          clients.delete(res);
          clearInterval(heartbeat);
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/jobs") {
        send(res, 201, await jobs.create(await readJSON(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/import") {
        send(res, 201, await jobs.import(await readJSON(req)));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/browser/open") {
        send(res, 200, await jobs.openSession((await readJSON(req)).platform));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/trash") {
        send(res, 200, await jobs.trashList());
        return;
      }
      const restoreMatch = url.pathname.match(
        /^\/api\/trash\/([0-9a-f-]{36})\/restore$/,
      );
      if (req.method === "POST" && restoreMatch) {
        await readJSON(req);
        send(res, 200, await jobs.restore(restoreMatch[1]));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/browser/close") {
        await readJSON(req);
        await jobs.closeSession();
        send(res, 200, { ok: true });
        return;
      }
      const match = url.pathname.match(
        /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(.*))?$/,
      );
      if (match) {
        const [, id, action] = match,
          j = jobs.get(id);
        if (req.method === "POST" && action === "edit") {
          send(res, 200, await jobs.update(id, await readJSON(req)));
          return;
        }
        if (req.method === "POST" && action === "delete") {
          await readJSON(req);
          send(res, 200, await jobs.delete(id));
          return;
        }
        if (req.method === "GET" && !action) {
          send(res, 200, jobs.snapshot(j, { graph: true }));
          return;
        }
        if (
          req.method === "POST" &&
          ["start", "pause", "continue"].includes(action)
        ) {
          await readJSON(req);
          send(res, 200, jobs[action](id));
          return;
        }
        if (req.method === "GET" && action === "download.zip") {
          // Completed downloads are immutable; refuse mixed snapshots mid-query.
          if (jobs.active === id || j.editing) {
            send(res, 409, { error: "请先暂停采集，再下载完整结果包。" });
            return;
          }
          const files = {};
          let bytes = 0;
          for (const file of EXPORTS) {
            try {
              const buffer = await fs.readFile(path.join(j.dir, file));
              bytes += buffer.length;
              if (bytes > 128 * 1024 * 1024)
                throw Object.assign(
                  new Error("结果较大，请从本机输出目录获取。"),
                  { statusCode: 413 },
                );
              files[file] = buffer;
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
          }
          const filename =
            "搜索联想词_" +
            j.meta.options.seeds[0].replace(/[\r\n"\\/]/g, "_") +
            "_" +
            j.meta.options.depth +
            "层.zip";
          res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Disposition":
              "attachment; filename=search-suggest-map.zip; filename*=UTF-8''" +
              encodeURIComponent(filename),
            "Cache-Control": "no-store",
          });
          res.end(zipSync(files, { level: 6 }));
          return;
        }
        if (req.method === "GET" && action?.startsWith("files/")) {
          let filename;
          try {
            filename = decodeURIComponent(action.slice(6));
          } catch {
            throw Object.assign(new Error("文件名无效。"), { statusCode: 400 });
          }
          if (!EXPORTS.has(filename)) {
            send(res, 404, { error: "文件不存在。" });
            return;
          }
          const data = await fs.readFile(path.join(j.dir, filename));
          res.writeHead(200, {
            "Content-Type":
              mime[path.extname(filename)] || "application/octet-stream",
            "Cache-Control": "no-store",
            ...(filename === "mindmap.html"
              ? {}
              : {
                  "Content-Disposition":
                    "attachment; filename*=UTF-8''" +
                    encodeURIComponent(filename),
                }),
          });
          res.end(data);
          return;
        }
      }
      send(res, 404, { error: "未找到此页面或接口。" });
    } catch (error) {
      if (!res.headersSent)
        send(res, error.statusCode || (error.code === "ENOENT" ? 404 : 500), {
          error: String(error.message).slice(0, 1500),
        });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const actualPort = server.address().port;
  allowedHosts = new Set([
    "127.0.0.1:" + actualPort,
    "localhost:" + actualPort,
  ]);
  return {
    server,
    manager: jobs,
    url: "http://127.0.0.1:" + actualPort,
    async close() {
      jobs.off("update", publish);
      jobs.off("session", publish);
      for (const res of clients) res.end();
      await jobs.shutdown();
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
    },
  };
}
function openURL(url) {
  const command =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => console.log("请在浏览器打开：" + url));
  child.unref();
}
async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      "data-dir": { type: "string" },
      "work-dir": { type: "string" },
      "no-open": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "npm start -- [--port 4177] [--data-dir 路径] [--work-dir 路径] [--no-open]",
    );
    return;
  }
  const port = Number(values.port || process.env.SSM_PORT || 4177);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口应为1至65535。");
  const dataDir = path.resolve(values["data-dir"] || defaultDataRoot()),
    workDir = path.resolve(values["work-dir"] || defaultWorkRoot());
  await fs.mkdir(workDir, { recursive: true });
  const lockFile = path.join(workDir, "gui-server.lock");
  let lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lock = await fs.open(lockFile, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const old = JSON.parse(await fs.readFile(lockFile, "utf8"));
      let alive = false;
      try {
        process.kill(old.pid, 0);
        alive = true;
      } catch (error) {
        if (error.code !== "ESRCH") alive = true;
      }
      if (alive) {
        console.log("工作台已在运行：" + old.url);
        if (!values["no-open"]) openURL(old.url);
        return;
      }
      await fs.unlink(lockFile);
    }
  }
  if (!lock) throw new Error("无法取得工作目录锁。");
  let app;
  try {
    app = await createApp({ dataDir, workDir, port });
    await lock.writeFile(JSON.stringify({ pid: process.pid, url: app.url }));
  } catch (error) {
    await lock.close();
    await fs.unlink(lockFile).catch(() => {});
    throw error;
  }
  console.log(
    "SearchSuggestMap 工作台：" +
      app.url +
      "\n结果目录：" +
      dataDir +
      "\n浏览器资料与诊断：" +
      workDir +
      "\n按 Ctrl+C 保存进度并退出。",
  );
  if (!values["no-open"]) openURL(app.url);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("正在保存任务并退出…");
    try {
      await app.close();
    } finally {
      await lock.close();
      await fs.unlink(lockFile).catch(() => {});
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  main().catch((e) => {
    console.error(
      e.code === "EADDRINUSE"
        ? "端口已占用，请通过 --port 指定其他端口。"
        : e.message,
    );
    process.exitCode = 1;
  });
