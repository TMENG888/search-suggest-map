import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Explicit configuration wins. On this Windows machine all generated data
// stays on E:, and an unavailable E: must not silently fill up C:.
export function defaultDataRoot() {
  if (process.env.SSM_DATA_DIR) return path.resolve(process.env.SSM_DATA_DIR);
  if (process.platform === "win32") {
    if (!fs.existsSync("E:/"))
      throw new Error(
        "E盘不可用。请连接E盘，或通过 --data-dir 明确指定数据目录。",
      );
    return "E:/Codex/outputs/search-suggest-map";
  }
  return path.join(os.homedir(), ".local", "share", "search-suggest-map");
}
export function defaultWorkRoot() {
  if (process.env.SSM_WORK_DIR) return path.resolve(process.env.SSM_WORK_DIR);
  if (process.platform === "win32") {
    if (!fs.existsSync("E:/"))
      throw new Error("E盘不可用。请通过 --work-dir 明确指定工作目录。");
    return "E:/Codex/work/search-suggest-map";
  }
  return path.join(defaultDataRoot(), "runtime");
}
