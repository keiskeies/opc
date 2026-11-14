#!/usr/bin/env node
// 审计台两个 report-only 开放项的【可复算校验】—— 不注册为守卫，仅给 CEO/owner 复算。
// round188 生成初版；round206 扩展：把 docs/.workbuddy 里所有 7-hex 引用都纳入 `git cat-file`
// 解析校验（此前只有 6 个钉住，其余 60+ 真实引用无机械覆盖，amend/改写会静默腐烂）。
// 跑法：node docs/review/verify-open-invariants.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages", "hub");
const ROOT = join(HUB, "..", "..");
const WORKBUDDY = join(ROOT, ".workbuddy");
const DOCS = join(ROOT, "docs");
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

// ── round206 扩展：全量 prose 引用扫描 ─────────────────────────────
// round209 确认：docs/_source-deepseek-share-raw.json 是外部导出的聊天原稿，
//   其中 hash(如 3fde188)属于外部 OSS 项目（搜索摘要里的引文），非本仓提交，不应纳入扫描；
//   故只扫 .txt/.md/.mjs（作者 prose），排除 raw 数据。40-hex 全 hash 无使用，7-hex 短形式足够。
const FAKE = new Set(["1234567","1111111","2222222","3333333","4444444","5555555","6666666","8888888","9999999","0123456","deadbee","deadbea","deadfac","beef00d","feedbac","cafe123","cceeded","abc1234","aaaaaaa","bbbbbbb","ccccccc","ddddddd","eeeeeee","ffffff0","0000000","a1b2c3d","83697c4"]);
const walk = (dir, acc, depth) => {
  if (depth > 6) return acc;
  let ents; try { ents = readdirSync(dir); } catch { return acc; }
  for (const e of ents) {
    const full = join(dir, e);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) { if (!/node_modules|\.git|\.tmp|dist/.test(full)) walk(full, acc, depth + 1); }
    else if (/\.(txt|md|mjs)$/.test(e)) acc.push(full);
  }
  return acc;
};
const citeByFile = new Map();
for (const base of [WORKBUDDY, DOCS]) {
  for (const f of walk(base, [], 0)) {
    let src; try { src = readFileSync(f, "utf8"); } catch { continue; }
    const mm = src.match(/\b[0-9a-f]{7}\b/g) || [];
    for (const h of mm) {
      if (FAKE.has(h) || /^[0-9]{7}$/.test(h)) continue;
      if (!citeByFile.has(f)) citeByFile.set(f, new Set());
      citeByFile.get(f).add(h.slice(0, 7));
    }
  }
}
const distinct = [...new Set([...citeByFile.values()].flatMap((s) => [...s]))];
let bad = 0;
for (const h of distinct) {
  const r = spawnSync("git", ["cat-file", "-e", h + "^{commit}"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) { bad++; ok("引用可解析 " + h, false, "腐烂"); }
}
ok("全量 prose hash 引用(" + distinct.length + " 个去重)均可 git 解析", bad === 0, bad ? bad + " 个不可解析" : "全部解析(" + distinct.length + ")");
console.log("\n" + (fail === 0 ? "SUCCESS: 两个开放项当前与台账记录一致（含全量 prose hash 扫描）" : fail + " FAIL: 台账需更新"));
process.exit(fail === 0 ? 0 : 1);
