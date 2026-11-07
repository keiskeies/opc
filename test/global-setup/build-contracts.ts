import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
