import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkHarness,
  readBiomeIncludes,
  readVitestInclude,
} from "../arch/harness-invariants.js";

/**
 * 构建 @opc/contracts，早于【任何】测试模块被解析。
 *
 * 为什么必须是 globalSetup 而不是测试文件里的 beforeAll：实测过 —— 顶层 import 在
 * 钩子之前就解析失败了，vitest 直接报 "Failed to resolve entry for package"，一个测试
 * 都不会跑（Tests: no tests），beforeAll 根本没有机会执行。把构建写进测试文件是死代码。
 *
 * 为什么不能【只看 dist 是否存在】就跳过：那会在 contracts/src 改过而 dist 是旧的时，
 * 拿旧 schema 去测新代码 —— 全绿但测的是上一版。tsc -b 自己是增量的（.tsbuildinfo），
 * 正确性交给编译器判断，不靠「文件在不在」猜。
 */
export default function setup(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  /* 测试装置自检：判据在 test/arch/harness-invariants.ts，那边有 canary 钉着，条数以那个文件当场为准。
     为什么放这里而不是写进某个 it 里：任何【由测试执行】的检查都防不住【测试不被执行】
     —— 把 vitest 的 include 改窄，做这种检查的守卫自己就先不跑了（0006 §7-41 实测）。
     globalSetup 在测试发现之前执行，且不受 include 管辖（同一轮实测：include 只剩三个
     文件时它照样跑），是目前唯一能报警【测试面被改窄】的位置。 */
  const problems = checkHarness({
    vitestInclude: readVitestInclude(
      readFileSync(join(root, "vitest.config.ts"), "utf8"),
    ),
    biomeIncludes: readBiomeIncludes(
      readFileSync(join(root, "biome.json"), "utf8"),
    ),
    diskTestFiles: listTestFiles(root),
  });
  if (problems.length > 0) {
    throw new Error(
      "测试装置自检失败（globalSetup）：\n" +
        problems.map((p) => "  - " + p.why).join("\n"),
    );
  }

  const project = join(root, "packages", "contracts");
  try {
    execFileSync("npx", ["tsc", "-b", project], {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as {
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    /* 构建失败必须把【真实原因】抛出去。若只留一句 "setup failed"，下一次别人 clone
       下来看不到 contracts 编译错在哪，只会怀疑测试写错了。 */
    throw new Error(
      "@opc/contracts 构建失败（globalSetup）：exit=" +
        (err.status ?? "?") +
        "\n" +
        String(err.stdout ?? "") +
        String(err.stderr ?? err.message ?? ""),
    );
  }
}

/**
 * 列出仓库里的 *.test.ts(x)，返回相对路径。跳过依赖与产物目录。
 * 只用于给 checkHarness 的规模下限喂数，不做任何判断。
 */
function listTestFiles(rootDir: string): string[] {
  const SKIP = new Set<string>([
    "node_modules",
    ".git",
    "dist",
    ".tmp",
    "coverage",
    ".next",
  ]);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = dir
        .slice(rootDir.length + 1)
        .split("\\")
        .join("/");
      const relPath = rel === "" ? e.name : rel + "/" + e.name;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(join(dir, e.name));
        continue;
      }
      if (/\.test\.[cm]?[jt]sx?$/.test(e.name)) out.push(relPath);
    }
  };
  walk(rootDir);
  return out;
}
