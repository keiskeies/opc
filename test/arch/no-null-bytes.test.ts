/**
 * 源码里不许出现字面 NUL 字节 —— 判据的用例，本体在 no-null-bytes.ts。
 *
 * 触发：`harness/gateway.ts:380` 那两处 NUL 是**已经 commit 之后**才发现的，
 * 而且它没让任何守卫变红（编译过、测试全绿、跑起来也对）。
 * 所以这一节的存在理由不是「又找到一个 bug」，是**那一类 bug 今天没有守卫**。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeNullHit,
  findNullBytes,
  nullByteHits,
  SCANNED_SUFFIXES,
} from "./no-null-bytes.js";
import { walkFiles } from "./harness-invariants.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 扫哪些目录。只扫**会被 grep 普查扫到**的那几类，其余扫了是噪声。 */
const SCAN_ROOTS: readonly string[] = [
  "packages/hub/src",
  "packages/contracts/src",
  "packages/desktop/src",
  "packages/web/src",
  "packages/hub/resources",
  "packages/hub/test",
  "test",
  "docs",
];

function collect(): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const root of SCAN_ROOTS) {
    for (const rel of walkFiles(join(ROOT, root), (n) =>
      SCANNED_SUFFIXES.some((s) => n.endsWith(s)),
    )) {
      out.set(root + "/" + rel, readFileSync(join(ROOT, root, rel)));
    }
  }
  return out;
}

describe("源码里不许出现字面 NUL 字节", () => {
  it("判据本身有判别力（否则本节是恒绿装饰）", () => {
    const clean = Buffer.from("const a = 1;\nconst b = 2;\n", "utf8");
    expect(findNullBytes(clean)).toEqual([]);
    // 一个真 NUL 夹在两个正常行之间。
    const dirty = Buffer.concat([
      Buffer.from("line one\n", "utf8"),
      Buffer.from([0x61, 0x00, 0x62]),
      Buffer.from("\nline three\n", "utf8"),
    ]);
    const hits = nullByteHits(new Map([["a/b.ts", dirty]]));
    expect(hits.length).toBe(1);
    // 行号必须指得准（这一格是这条守卫唯一「可操作」的信息：
    // 只报「有 NUL」的话，下一次的人还得自己写一遍扫描脚本）。
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.context).toContain("<NUL>");
    expect(hits[0]?.path).toBe("a/b.ts");
    // 反向：中文不能被判成 NUL（编码往返在这里是 utf8，而找的是字节 0x00）。
    const cjk = Buffer.from("const 提示 = \"不可逆操作\";\n", "utf8");
    expect(findNullBytes(cjk)).toEqual([]);
  });

  it("取材非空（一条扫不到任何文件的守卫，报【干净】是假的）", () => {
    const files = collect();
    // 量过一次：这几棵树加起来几百个文件。写死一个下界而不是 > 0，
    // 因为「> 0」在一个只扫到一个空目录的世界里也成立。
    expect(files.size).toBeGreaterThan(200);
    // 反向对照：确实读到了内容（路径拼错时 readFileSync 会抛，
    // 但「拼对了一半」那种错只会读到空 Buffer，所以这里看字节总量）。
    let bytes = 0;
    for (const b of files.values()) bytes += b.length;
    expect(bytes).toBeGreaterThan(1_000_000);
  });

  it("⭐ 真仓库：一个 NUL 字节都没有", () => {
    const hits = nullByteHits(collect());
    // 报错时把行号与前后文字打出来 —— 这条守卫唯一的价值就是让人不用再手写脚本。
    expect(
      hits.map((h) => h.path + ":" + h.line + "  " + h.context).join("\n"),
    ).toBe("");
  });

  it("gateway.ts 那一处【确实被修掉了】，而它当初是被 grep 漏掉的形状", () => {
    // 这一发不只是回归：它钉的是「那个文件现在**能被 grep 扫到**」。
    // 判据不是「文本里有没有 NUL」（上面那发管了），而是**这一行的语义没变**：
    // 源码里写的必须是 6 字节的转义 `\u0000`，运行时求值成同一个字符。
    const p = join(ROOT, "packages/hub/src/harness/gateway.ts");
    const text = readFileSync(p, "utf8");
    expect(text).toContain('tool + "\\u0000" + JSON.stringify');
    // 反向：不许有人把它换成一个**可打印**分隔符（那是另一件事，不是这个修复）。
    // 键的分隔符必须是不可打印字符 —— `tool` 与 `JSON.stringify(args)` 里都可能
    // 出现可打印字符，用 `:` 之类拼键能被拼出碰撞，后果是**两次不同的工具调用
    // 共享同一个审批判决**（第一次批过的放行第二次的 `git push --force`）。
    expect(text).not.toMatch(/tool \+ ["'][^"'\\]+["'] \+ JSON\.stringify/u);
  });

  it("describeNullHit 对【文件末尾的】NUL 不越界", () => {
    // 边界：偏移在最后一个字节时，`subarray(offset, offset+31)` 会短于预期，
    // 而一个抛错的守卫与一个漏报的守卫一样糟（0018 那条「检查自己会抛」同族）。
    const buf = Buffer.concat([Buffer.from("ab\n", "utf8"), Buffer.from([0])]);
    const hit = describeNullHit("x.ts", buf, 3);
    expect(hit.line).toBe(2);
    expect(hit.context).toContain("<NUL>");
    // 连续两个 NUL 是两条命中而不是一个。
    expect(findNullBytes(Buffer.from([0, 0, 1]))).toEqual([0, 1]);
  });
});
