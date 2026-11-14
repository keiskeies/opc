#!/usr/bin/env node
// 审计台两个 report-only 开放项的【可复算校验】—— 不注册为守卫，仅给 CEO/owner 复算。
// round188 生成。跑法：node docs/review/verify-open-invariants.mjs
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "hub");
const ROOT = join(HUB, "..", "..");
const HASHLIST = ["1877e8e", "2126e1e", "c633cda", "fff255b", "ff08762", "4dfe197"];
let fail = 0;
const ok = (name, pass, detail) => { console.log((pass ? "PASS  " : "FAIL  ") + name + (detail ? "   -> " + detail : "")); if (!pass) fail++; };
const extractFn = (src) => (src.match(/function isPidAlive[\s\S]*?\n\}/) || [""])[0];
const fx = extractFn(readFileSync(join(HUB, "test", "fixtures", "fixture-dir.ts"), "utf8"));
const lk = extractFn(readFileSync(join(HUB, "src", "serve", "lock.ts"), "utf8"));
const n = (re, s) => (s.match(re) || []).length;
const has = (re, s) => re.test(s);
ok("isPidAlive 前置守卫(整数/正数)", has(/Number\.isInteger\(pid\) \|\| pid <= 0/, fx) && has(/Number\.isInteger\(pid\) \|\| pid <= 0/, lk));
ok("isPidAlive EPERM->true", has(/EPERM[\s\S]{0,40}return true/, fx) && has(/EPERM[\s\S]{0,40}return true/, lk));
ok("isPidAlive ESRCH->false", has(/ESRCH[\s\S]{0,40}return false/, fx) && has(/ESRCH[\s\S]{0,40}return false/, lk));
ok("isPidAlive 意外->true(判错代价非对称)", n(/return true/g, fx) >= 3 && n(/return true/g, lk) >= 3, "fx returns=" + n(/return true/g, fx) + " lock returns=" + n(/return true/g, lk));
for (const h of HASHLIST) {
  const r = spawnSync("git", ["cat-file", "-e", h + "^{commit}"], { cwd: ROOT, encoding: "utf8" });
  ok("哈希 " + h, r.status === 0);
}
console.log("\n" + (fail === 0 ? "SUCCESS: 两个开放项当前与台账记录一致" : fail + " FAIL: 台账需更新"));
process.exit(fail === 0 ? 0 : 1);
