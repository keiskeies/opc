import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * Task 0.2 验收：越界 import SQLite 会被 lint 挡住（规格 §5.6.1 / 计划 §2）。
 *
 * 往 desktop / web 塞越界探针跑 biome check，断言失败；往 hub 塞同样的 import
 * 断言通过 —— 边界既挡住外面，也放行里面。
 *
 * 三条防假通过（本轮实测踩出来的，别改回去）：
 *  1. Windows 上 npx 是 .cmd：spawnSync("npx") 报 ENOENT；
 *     spawnSync("npx.cmd", shell:false) 被 Node 的 .cmd 安全策略 EINVAL 拦掉。
 *     曾用 npx 导致 biomeCheck 返回空串，而 hub 允许那条对空输出也成立 —— 假通过。
 *  2. 故直接定位 biome 平台二进制，shell:false 调用（也避开 shell:true 的 DEP0190）。
 *  3. 探针语法必须合法，且断言前先确认输出含 Checked —— 否则 parse error 或调用
 *     失败都会冒充拦截成功。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function platformSuffixes(): string[] {
  if (process.platform === "win32") return ["win32-x64", "win32-arm64"];
  if (process.platform === "darwin") return ["darwin-x64", "darwin-arm64"];
  return ["linux-x64", "linux-arm64", "linux-x64-musl"];
}

/** 在 pnpm 的 .pnpm 布局里找 biome 平台二进制；版本号不写死，升版不碎。 */
function findBiomeBinary(): string {
  const exe = process.platform === "win32" ? "biome.exe" : "biome";
  const suffixes = platformSuffixes();
  const pnpmRoot = join(ROOT, "node_modules", ".pnpm");

  if (existsSync(pnpmRoot)) {
    for (const dir of readdirSync(pnpmRoot)) {
      for (const sfx of suffixes) {
        if (!dir.startsWith("@biomejs+cli-" + sfx + "@")) continue;
        const cand = join(
          pnpmRoot,
          dir,
          "node_modules",
          "@biomejs",
          "cli-" + sfx,
          exe,
        );
        if (existsSync(cand)) return cand;
      }
    }
  }
  for (const sfx of suffixes) {
    const flat = join(ROOT, "node_modules", "@biomejs", "cli-" + sfx, exe);
    if (existsSync(flat)) return flat;
  }
  throw new Error(
    "找不到 biome 平台二进制（平台后缀 " +
      suffixes.join(", ") +
      "）。测试宁可直接抛错，也不空跑成假通过。",
  );
}

let BIOME = "";
beforeAll(() => {
  BIOME = findBiomeBinary();
});

function biomeCheck(paths: string[]): { code: number; out: string } {
  const r = spawnSync(BIOME, ["check", ...paths], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (r.error) throw new Error("biome 调用失败：" + r.error.message);
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** 空输出等于调用失败，绝不可当作检查通过。 */
function assertReallyChecked(out: string): void {
  expect(
    out,
    "biome 未产生 Checked 行，调用失败不能当作检查通过：" + JSON.stringify(out),
  ).toMatch(/Checked \d+ files?/);
}

const staticProbe = [
  'import { DatabaseSync } from "node:sqlite";',
  'import Database from "better-sqlite3";',
  "export const a = DatabaseSync;",
  "export const b = Database;",
].join("\n");

const dynamicProbe = [
  'const mod: unknown = await import("node:sqlite");',
  "export const probed = mod;",
].join("\n");

const PROBE = "__boundary_probe.ts";
const probePath = (pkg: string) => join(ROOT, "packages", pkg, "src", PROBE);
const probeArg = (pkg: string) => "packages/" + pkg + "/src/" + PROBE;

afterAll(() => {
  for (const p of ["desktop", "web", "hub"])
    rmSync(probePath(p), { force: true });
});

for (const pkg of ["desktop", "web"]) {
  it("packages/" + pkg + " 禁止依赖 SQLite（静态 import 被挡）", () => {
    writeFileSync(probePath(pkg), staticProbe + "\n");
    const r = biomeCheck([probeArg(pkg)]);
    assertReallyChecked(r.out);
    expect(r.out).toContain("noRestrictedImports");
    expect(r.code, "越界 import 必须让 lint 失败：" + r.out).not.toBe(0);
    rmSync(probePath(pkg), { force: true });
  });
}

// 动态 import 是真实绕过路径。若 biome 不覆盖它，本测试会红 —— 那就是必须补
// 源码扫描守卫的信号（计划 §12：核心防线不能只有一层）。
it("动态 import 越界同样被挡（否则需补源码扫描守卫）", () => {
  writeFileSync(probePath("desktop"), dynamicProbe + "\n");
  const r = biomeCheck([probeArg("desktop")]);
  assertReallyChecked(r.out);
  expect(
    r.out,
    "若此测试失败说明 biome 不覆盖动态 import，须补源码扫描测试" + r.out,
  ).toContain("noRestrictedImports");
  rmSync(probePath("desktop"), { force: true });
});

it("packages/hub 允许依赖 SQLite（边界不误伤）", () => {
  writeFileSync(probePath("hub"), staticProbe + "\n");
  const r = biomeCheck([probeArg("hub")]);
  assertReallyChecked(r.out);
  expect(r.out).not.toContain("noRestrictedImports");
  expect(r.code, "hub 内允许 SQLite，lint 不该报错：" + r.out).toBe(0);
  rmSync(probePath("hub"), { force: true });
});
