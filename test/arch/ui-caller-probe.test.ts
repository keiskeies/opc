/**
 * ui-caller-probe 的分母。判据本体是纯函数（吃串与命中表），这里负责开盘 +
 * 把 0067 那次真实误用的【两个洞各自】复演一遍：探针在正确的形状上有牙齿，
 * 在错的形状上必须当场暴露为「不可信」，而不是跟着报绿。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ProbeResult,
  probeTrustCheck,
  UI_ROOT,
  uiPathTail,
} from "./ui-caller-probe.js";

const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** vendor 是第三方库（quill / xspreadsheet），不是本仓渲染侧代码，不进扫描面。 */
const SKIP = new Set(["node_modules", ".git", ".tmp", "dist", "vendor"]);

function walk(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

/** 在给定目录下逐文件数 needle 的命中次数（相对路径回报，便于人话报警）。 */
function countHits(dir: string, needle: string): ProbeResult[] {
  const abs = join(ROOT, dir);
  return walk(abs, []).map((file) => {
    const text = readFileSync(file, "utf8");
    let hits = 0;
    let at = text.indexOf(needle);
    while (at !== -1) {
      hits += 1;
      at = text.indexOf(needle, at + needle.length);
    }
    return { file: relative(ROOT, file).split(sep).join("/"), hits };
  });
}

/** app.js 真在调的一条端点：组织页的提交口（app.js 里 api("POST", "/org")）。 */
const KNOWN_CALLED = "/api/v1/org";

describe("探针在正确形状上有牙齿", () => {
  it("渲染侧扫描面认得运行前缀之外的尾串 ⇒ 已知有调用方的端点非零命中", () => {
    const tail = uiPathTail(KNOWN_CALLED);
    expect(tail).toBe("/org");
    const res = countHits(UI_ROOT, tail);
    expect(res.length).toBeGreaterThan(0);
    expect(probeTrustCheck(tail, res)).toBe("");
    // 命中确实落在渲染侧那份真控制室里，不是别处撞名。
    expect(res.some((r) => r.file.endsWith("app.js") && r.hits > 0)).toBe(true);
  });

  it("⭐ 反向对照：把整条 /api/v1/… 当查询串 ⇒ 同一批文件 0 命中 ⇒ 判「不可信」", () => {
    // 这一发复演 0067 那次的【查错串】：app.js 拼 fetch("/api" + path)、
    // group.js 拼 `${API}${path}`（API = "/api/v1"），字面量里没有整串。
    // 删掉传输层那一格 ⇒ 这一发翻红（探针从此不再需要尾串口径）。
    const whole = countHits(UI_ROOT, KNOWN_CALLED);
    expect(whole.every((r) => r.hits === 0)).toBe(true);
    expect(probeTrustCheck(uiPathTail(KNOWN_CALLED), whole)).not.toBe("");
  });

  it("⭐ 反向对照：扫 packages/web/src ⇒ 同一尾串 0 命中 ⇒ 判「不可信」", () => {
    // 这一发复演 0067 那次的【扫错面】：渲染侧不住在 web/src，那份目录里
    // 任何端点都是零命中。将来 web/src 真长出渲染代码 ⇒ 这一发翻红，
    // 届时正确动作是把扫描面扩成两处（并在 0067 与本文件头同步口径）。
    const wrongSurface = countHits(
      "packages/web/src",
      uiPathTail(KNOWN_CALLED),
    );
    expect(wrongSurface.length).toBeGreaterThan(0);
    expect(wrongSurface.every((r) => r.hits === 0)).toBe(true);
    expect(probeTrustCheck(uiPathTail(KNOWN_CALLED), wrongSurface)).not.toBe(
      "",
    );
  });
});

describe("判据本体：恒真的探针要自己报出来", () => {
  const hit: ProbeResult[] = [{ file: "packages/web/public/app.js", hits: 3 }];
  const miss: ProbeResult[] = [{ file: "packages/web/public/app.js", hits: 0 }];

  it("有命中 ⇒ 可信（空串）", () => {
    expect(probeTrustCheck("/org", hit)).toBe("");
  });

  it("零命中 ⇒ 报警里带扫描面读数，不只说「不可信」", () => {
    const msg = probeTrustCheck("/org", miss);
    expect(msg).toContain("app.js=0");
  });

  it("⭐ 空串与纯前缀查询 ⇒ 即使有命中也报警（恒真探针不许替「零命中」作证）", () => {
    // 这一发同时打两种变异：摘掉空串那格（三枚都该报警却只剩两枚），
    // 以及把顺序挪到「先查命中」（有命中就早退 ⇒ 空串那格被短路）。
    for (const needle of ["", "/api", "/api/v1"]) {
      expect(probeTrustCheck(needle, hit)).not.toBe("");
    }
  });

  it("一个文件命中即算有牙齿（不要求每份文件都命中）", () => {
    const mixed: ProbeResult[] = [...miss, ...hit];
    expect(probeTrustCheck("/org", mixed)).toBe("");
  });
});

describe("今天的读数（登记事实，不钉成会红的判据）", () => {
  it("分发规则两条端点在渲染侧 0 命中：配置页没做，属排期而非探针失灵", () => {
    // 这一发【不】断言「必须永远是 0」—— 那等于把产品排期钉死。
    // 它断的是「此刻的 0 是用可信探针量出来的」：同一发里先自证探针有牙齿。
    expect(
      probeTrustCheck(uiPathTail(KNOWN_CALLED), countHits(UI_ROOT, "/org")),
    ).toBe("");
    const rules = countHits(UI_ROOT, uiPathTail("/api/v1/dispatch/rules"));
    expect(rules.reduce((n, r) => n + r.hits, 0)).toBe(0);
  });
});
