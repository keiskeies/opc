// round335 一次性：check-commit-msg 的 argv 版在 Windows 上撑不住 272 个路径
// （命令行长度上限），这台包装只做一件事 —— 文件列表从文件读，判据仍然 import
// 同一份 check()/EXEMPT/existingIds/reservedIds/loadEntries，与那台逐字同口径。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, EXEMPT, existingIds, loadEntries, reservedIds } from "../test/arch/commit-msg-refs.js";
const ROOT = process.cwd();
const existing = new Set(existingIds(join(ROOT, "docs", "decisions")));
const reserved = new Set(reservedIds(readFileSync(join(ROOT, "docs", "INDEX.md"), "utf8")));
const text = readFileSync(process.argv[2], "utf8");
const lines = text.split("\n");
const files = readFileSync(process.argv[3], "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const problems = check([{ hash: "0".repeat(40), subject: (lines[0] ?? "").trim(), body: lines.slice(1).join("\n").trim(), files }], existing, reserved, EXEMPT);
const history = loadEntries(ROOT).filter((e) => check([e], existing, reserved, EXEMPT).length > 0);
console.log("标题：" + (lines[0] ?? "").trim().slice(0, 72));
console.log("这次会碰：" + files.length + " 个文件");
console.log(problems.length === 0 ? "✓ 落进历史后【不红】" : "✗ 会红：" + problems.map((p) => p.why).join(" / "));
if (history.length > 0) console.log("⚠ 历史另有 " + history.length + " 发红（非本发造成）");
