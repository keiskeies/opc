#!/usr/bin/env node
/**
 * round351 变异机器 —— 12 个顶层纯函数补进白名单后的自我证伪。
 *
 * 测什么：这 12 个函数（esc/money/banner/notesHtml/ideaBox/decideRow/
 * batchPicked/rejectHtml/linesOf/enumSel/replayTimeline/safe）改坏输出，
 * 新的 describe 必须红。每个突变【真抹字节】，跑完【原样回滚】，next!==before。
 *
 * 方法照抄 round350-util-fns-mut.mjs 那一套（spawnSync vitest + 预检锚点 +
 * 失败名解析 + M0/M9 对照/还原）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const APP_JS = join(REPO, "packages/web/public/app.js");
const TEST = join(REPO, "test/web/app-pure.test.ts");
const VITEST = join(REPO, "node_modules/vitest/vitest.mjs");

function runVitest(testFile) {
  const r = spawnSync(process.execPath, [VITEST, "run", testFile], {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.stdout + r.stderr;
}

function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;]*m/gu, "");
}

/** 取失败测试名（vitest FAIL 行的 `> 链`：describe > it）。失败行为空数组。 */
function failedTests(out) {
  const clean = stripAnsi(out);
  const names = [];
  // 默认 reporter 的失败行形如：
  //   FAIL test/web/app-pure.test.ts:2827:3 > esc —— … > ⭐ 五个特殊字符逐一转义
  // 新版 vitest 在文件名后带 `:行:列`；用 `[^>]*?` 吃掉它（不吞 `>`）。
  const re = /FAIL\s+\S+\.test\.ts(?::\d+:\d+)?\s*>\s*(.+)$/gmu;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const name = m[1].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function anchor(text, needle) {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`锚点没命中: ${needle}`);
  return i;
}

const MUTATIONS = [
  {
    id: "M1-esc",
    expectRed: ["esc —— 全页唯一转义层（round351 补执行证据：144 次调用零直接断言）"],
    anchor: `"&": "&amp;"`,
    mutate: (src) => {
      const at = src.indexOf(`"&": "&amp;"`);
      if (at < 0) throw new Error("M1 锚定失败");
      return src.slice(0, at) + src.slice(at).replace(`"&": "&amp;"`, `"&": "&"`);
    },
  },
  {
    id: "M2-money",
    expectRed: ["money —— §19.3 金额等宽（round351 补执行证据：11 次调用零直接断言）"],
    anchor: `(Number(cents ?? 0) / 100).toFixed(2)`,
    mutate: (src) => {
      const needle = "Number(cents ?? 0)";
      const at = src.indexOf(needle);
      if (src.indexOf(needle, at + 1) >= 0) throw new Error("M2 锚点不唯一");
      return src.replace(needle, "Number(cents ?? 999)");
    },
  },
  {
    id: "M3-banner-empty",
    expectRed: ["banner —— 提示条（round351 补执行证据：37 次调用零直接断言）"],
    mutate: (src) => {
      const at = src.indexOf("const banner");
      if (at < 0) throw new Error("M3 锚定 banner 失败");
      const seg = src.slice(at, at + 200);
      const off = seg.indexOf(': ""');
      if (off < 0) throw new Error("M3 锚定空串分支失败");
      return src.slice(0, at + off) + ': "!"' + src.slice(at + off + 4);
    },
  },
  {
    id: "M4-save-earliest",
    expectRed: ["safe —— JSON 容错解析（round351 补执行证据）"],
    anchor: `catch {`,
    mutate: (src) => {
      const needle = "return JSON.parse(s)";
      const at = src.indexOf(needle);
      if (at < 0) throw new Error("M4 锚点缺失");
      if (src.indexOf(needle, at + 1) >= 0) throw new Error("M4 锚点不唯一");
      return src.replace(needle, 'return JSON.parse(s + "!")');
    },
  },
  {
    id: "M5-notesHtml-empty",
    expectRed: ["notesHtml —— 口径说明（round351 补执行证据）"],
    anchor: `notes && notes.length`,
    mutate: (src) => {
      // 翻转条件：有 notes 时不渲染（details 整个消失）⇒ a1 红；无 notes 时照旧空串 ⇒ a2 绿。
      const needle = "notes && notes.length";
      const at = src.indexOf(needle);
      if (src.indexOf(needle, at + 1) >= 0) throw new Error("M5 锚点不唯一");
      return src.replace(needle, "false");
    },
  },
  {
    id: "M6-linesOf-trim",
    expectRed: ["linesOf —— 多行 textarea 取值（round351 补执行证据）"],
    anchor: `el.value`,
    mutate: (src) => {
      const needle = '.split("\\n")';
      const at = src.indexOf(needle, src.indexOf("const linesOf"));
      if (at < 0) throw new Error("M6 锚定 linesOf 的 split 失败");
      return src.slice(0, at) + '.splt("\\n")' + src.slice(at + needle.length);
    },
  },
];

// 控制组：只改注释，必须全绿
const M0 = {
  id: "M0-control",
  expectRed: [],
  mutate: (src) => src.replace("round351", "round351~control"),
};

const orig = readFileSync(APP_JS, "utf8");
const before = orig;

function apply(m) {
  writeFileSync(APP_JS, m.mutate(orig));
}
function restore() {
  writeFileSync(APP_JS, orig);
}

const lines = () => readFileSync(APP_JS, "utf8").split("\n");

let hits = 0;
const results = [];

// M0 控制组先跑
apply(M0);
const controlOut = runVitest(TEST);
const controlFailed = failedTests(controlOut);
restore();
const controlPass = controlFailed.length === 0;
results.push({ id: M0.id, expectRed: 0, got: controlFailed.length, ok: controlPass });
if (!controlPass) {
  console.error("控制组就不干净，本轮变异证据作废：", controlFailed);
  process.exit(2);
}

// 逐个变异
for (const m of MUTATIONS) {
  apply(m);
  const out = runVitest(TEST);
  const failed = failedTests(out);
  restore();
  const next = readFileSync(APP_JS, "utf8");
  const sameBytes = next === before;
  if (!sameBytes) {
    console.error(`${m.id} 回滚后字节不一致 —— 变异机自己坏了`);
    process.exit(3);
  }
  const redAll = m.expectRed.every((n) => failed.some((f) => f.includes(n)));
  const ok = redAll;
  if (ok) hits += 1;
  results.push({ id: m.id, expectRed: m.expectRed, got: failed, ok });
}

console.log(`\n命中 ${hits}/${MUTATIONS.length}`);
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.id} 期望红 ${r.expectRed.length} 实际红 ${r.got.length}`);
  if (!r.ok) {
    console.log(`    期望（子串）: ${r.expectRed.join("; ")}`);
  }
}

process.exit(hits === MUTATIONS.length && controlPass ? 0 : 1);
