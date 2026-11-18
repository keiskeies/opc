// round305 · 三种「起不了进程」的形状各自给什么 errno —— retryableWithoutCost 的输入事实。
// 跑法：node .workbuddy/round305-spawn.mjs
// ⚠ 目标是【系统临时目录】里的文件而不是仓库里的：第一版往 .workbuddy/ 写了一份
//   probe305-target.txt 当「普通文件」样本，跑完不删 ⇒ 一份只为探针存在的垃圾
//   留在工作区里，下一轮分不清它是证据还是残留。形状读数与路径无关，没必要占用仓库。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "opc-spawn-shape-"));
const file = join(dir, "not-an-executable.txt");
writeFileSync(file, "not an executable\n");

function once(bin) {
  return new Promise((res) => {
    let p;
    try {
      p = spawn(bin, ["-p"], { cwd: process.cwd(), env: process.env });
    } catch (e) {
      // 【同步】抛出：这一型 runRole 拿不到任何 result（Promise 构造器吞成 rejection）。
      res({ bin: label(bin), syncThrew: e.code ?? String(e) });
      return;
    }
    p.stdin.end();
    p.on("error", (e) => res({ bin: label(bin), asyncErrno: e.code ?? String(e) }));
    p.on("close", (c) => res({ bin: label(bin), close: c }));
  });
}
const label = (b) =>
  b === file ? "<临时目录里的普通文件>" : b === dir ? "<目录>" : "<不存在的路径>";

try {
  for (const b of [file, dir, join(dir, "no-such-claude-xyz")]) {
    console.log(JSON.stringify(await once(b)));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
