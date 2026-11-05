#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createState, crawl, exportAll, save, stats, now } from "./core.mjs";
import { BrowserProvider } from "./browser.mjs";
import { mindmapHTML } from "./mindmap-template.mjs";
import { defaultDataRoot, defaultWorkRoot } from "./paths.mjs";

const HELP = `搜索联想词递归采集（Node.js 20+；默认使用本机Edge）

node collect.mjs crawl --seed "茶百道" --platform douyin --depth 3
node collect.mjs crawl --seed "茶百道" --platform xiaohongshu --depth 3
node collect.mjs crawl --seed "茶百道" --platform both --depth 3
node collect.mjs crawl --seed-file seeds.txt --platform douyin --depth 3
node collect.mjs login --platform douyin
node collect.mjs crawl --resume "E:/Codex/outputs/.../checkpoint.json"
node collect.mjs export --resume "E:/Codex/outputs/.../checkpoint.json"

--seed 可重复使用；--seed-file 每行一词，UTF-8。
--depth 3：起始词第0层，采集到第3层，只查询第0—2层。
无查询次数限制；按指定关键词层数遍历全部可达分支。
--delay-ms 3000：两次查询至少间隔毫秒数，默认3000，最小1500。
--timeout-ms 12000：每词下拉结果等待时间，最小4000。
--output 路径：本次输出目录；新任务必须使用新目录。
--work-dir 路径：诊断、下载位置，默认E:/Codex/work/search-suggestions。
--profile-dir 路径：专用浏览器登录目录，默认上述work目录的profiles。
--channel msedge：也可chrome或chromium；后者需要另行安装浏览器。
--headless：无窗口运行；平台可能不提供联想，首次建议有窗口运行。
--resume 恢复原目录和原始平台、起始词、深度，不改变已成功结果。
验证码/风险提示/未确认结果均暂停；Ctrl+C安全停止并导出已有结果。
`;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seed: { type: "string", multiple: true },
    "seed-file": { type: "string" },
    platform: { type: "string" },
    depth: { type: "string" },
    resume: { type: "string" },
    output: { type: "string" },
    "work-dir": { type: "string" },
    "profile-dir": { type: "string" },
    "delay-ms": { type: "string" },
    "timeout-ms": { type: "string" },
    channel: { type: "string" },
    headless: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
let stop = false;
process.on("SIGINT", () => {
  stop = true;
  console.log("\n已请求安全停止，当前查询结束后保存进度。");
});
function numberOption(key, fallback, min) {
  const n = Number(values[key] ?? fallback);
  if (!Number.isInteger(n) || n < min)
    throw new Error("--" + key + " 必须为不小于" + min + "的整数");
  return n;
}
async function main() {
  if (values.help) {
    console.log(HELP);
    return;
  }
  const command = positionals[0] || "crawl";
  if (!["crawl", "login", "export"].includes(command))
    throw new Error("命令只能为crawl、login、export");
  if (
    values.resume &&
    ["seed", "seed-file", "platform", "depth", "output"].some(
      (x) => values[x] !== undefined,
    )
  )
    throw new Error("续跑不接受新起始词/平台/层数/输出目录；请新建任务");
  let previous = {};
  if (values.resume) {
    try {
      previous = JSON.parse(
        await fs.readFile(
          path.join(
            path.dirname(path.resolve(values.resume)),
            "run-options.json",
          ),
          "utf8",
        ),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const workDir = path.resolve(
    values["work-dir"] || previous.workDir || defaultWorkRoot(),
  );
  const profileDir = path.resolve(
    values["profile-dir"] ||
      previous.profileDir ||
      path.join(workDir, "profiles"),
  );
  await fs.mkdir(workDir, { recursive: true });
  let platform = values.platform || "douyin",
    seeds = values.seed || [],
    depth = numberOption("depth", 3, 1);
  if (values["seed-file"])
    seeds.push(
      ...(await fs.readFile(values["seed-file"], "utf8"))
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .filter((x) => x.trim()),
    );
  if (!values.resume && !seeds.length && command === "crawl") {
    if (!process.stdin.isTTY)
      throw new Error("请通过 --seed 或 --seed-file 提供起始词");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      seeds = [await rl.question("起始词：")];
      platform =
        (
          await rl.question("平台（douyin / xiaohongshu / both，默认douyin）：")
        ).trim() || platform;
      depth = Number((await rl.question("递归层数（默认3）：")).trim() || "3");
    } finally {
      rl.close();
    }
  }
  if (!["douyin", "xiaohongshu", "both"].includes(platform))
    throw new Error("平台只能为douyin、xiaohongshu或both");
  const provider = new BrowserProvider({
    workDir,
    profileDir,
    channel: values.channel || previous.channel || "msedge",
    headless: values.headless ?? previous.headless,
    manualLogin: command === "login",
    delayMs: numberOption("delay-ms", previous.delayMs || 3000, 1500),
    timeoutMs: numberOption("timeout-ms", previous.timeoutMs || 12000, 4000),
  });
  if (command === "login") {
    if (values.headless) throw new Error("login不能使用headless");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      for (const p of platform === "both"
        ? ["douyin", "xiaohongshu"]
        : [platform]) {
        try {
          await provider.open(p);
        } catch (e) {
          console.log(String(e.message));
        }
        await rl.question(
          p + "：请在专用浏览器人工登录/查看提示，完成后回到终端按Enter保存。",
        );
      }
    } finally {
      rl.close();
      await provider.close();
    }
    console.log(
      "登录目录保存在 " + profileDir + "；不会复制或修改现有爬虫的登录目录。",
    );
    return;
  }
  if (command === "export" && !values.resume)
    throw new Error("export需要 --resume checkpoint.json");
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const output = values.resume
    ? path.dirname(path.resolve(values.resume))
    : path.resolve(
        values.output || path.join(defaultDataRoot(), "cli-" + stamp),
      );
  await fs.mkdir(output, { recursive: true });
  const checkpoint = values.resume
    ? path.resolve(values.resume)
    : path.join(output, "checkpoint.json");
  if (!values.resume) {
    try {
      await fs.access(checkpoint);
      throw new Error("该目录已有任务，请使用 --resume 或指定新目录");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const state = values.resume
    ? JSON.parse(await fs.readFile(checkpoint, "utf8"))
    : createState({
        seeds,
        platforms: platform === "both" ? ["douyin", "xiaohongshu"] : [platform],
        depth,
      });
  if (state.version !== 1) throw new Error("检查点版本不兼容");
  const lockPath = path.join(output, "run.lock");
  let lock;
  try {
    lock = await fs.open(lockPath, "wx");
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: now() }));
  } catch (e) {
    if (e.code === "EEXIST")
      throw new Error(
        "该任务已有run.lock，请勿重复启动；若上次异常退出，请先核实锁内PID已结束再移除锁",
      );
    throw e;
  }
  try {
    if (command === "crawl") {
      await save(path.join(output, "run-options.json"), {
        workDir,
        profileDir,
        channel: provider.options.channel,
        headless: !!provider.options.headless,
        delayMs: provider.options.delayMs,
        timeoutMs: provider.options.timeoutMs,
      });
      console.log("输出目录：" + output);
      console.log(
        "仅采集真实搜索联想；跨平台并发、单平台依次查询，指定深度：" + state.config.depth,
      );
      await crawl(state, provider, {
        checkpoint,
        stopping: () => stop,
        onProgress: (node, s) =>
          console.log(
            JSON.stringify({
              platform: node.platform,
              term: node.term,
              depth: node.depth,
              ...s,
            }),
          ),
      });
    }
  } finally {
    try {
      await exportAll(state, output, mindmapHTML);
    } finally {
      await provider.close();
      await lock.close();
      await fs.unlink(lockPath);
    }
  }
  console.log(
    JSON.stringify(
      {
        status: state.status,
        stopReason: state.stopReason,
        ...stats(state),
        output,
      },
      null,
      2,
    ),
  );
  if (["paused", "partial"].includes(state.status)) process.exitCode = 2;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((e) => {
    console.error(String(e.message));
    process.exitCode = 1;
  });
