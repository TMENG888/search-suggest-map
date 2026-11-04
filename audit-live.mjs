import fs from "node:fs/promises";
import path from "node:path";
import { auditState } from "./audit.mjs";
const dir = process.argv[2];
if (!dir) throw new Error('用法：node audit-live.mjs "结果目录"');
const report = auditState(
  JSON.parse(await fs.readFile(path.join(dir, "results.json"), "utf8")),
);
await fs.writeFile(
  path.join(dir, "完整性核验.json"),
  JSON.stringify(report, null, 2),
  "utf8",
);
console.log(JSON.stringify(report, null, 2));
