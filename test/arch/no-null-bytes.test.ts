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
import { walkFiles } from "./harness-invariants.js";
import {
  describeNullHit,
  describeReplacementHit,
  findNullBytes,
  findReplacementChars,
  nullByteHits,
  REPLACEMENT_CHAR,
  replacementCharHits,
  SCANNED_SUFFIXES,
} from "./no-null-bytes.js";

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

/**
 * 取材结果：读到的内容 + **当场消失**的那些。
 *
 * 分成两个数而不是静默跳过，是为了让「跳过」这件事能被断言 ——
 * 一条会跳过的扫描，如果没人管它跳了多少，就等于一条会跳过的扫描谁都不报。
 */
type Collected = { files: Map<string, Buffer>; vanished: string[] };

/**
 * 采集。
 *
 * ⚠ 只宽容「readdir 之后、read 之前文件被删掉」这一类（ENOENT / ENOTDIR）。
 * 实测形状：`dependency-boundary.test.ts` 会往 `packages/<pkg>/src/` 现场写一个越界
 * import 探针再删掉，并行的本守卫撞上它 ⇒ `ENOENT <探针名>`，
 * 而这条守卫那一刻**什么都没判**就红了。同一个竞态在 `test-inventory.ts` 的
 * 文件头记过（那里是 stat，这里是 read），所以这不是新形状，是**第二次出现**。
 * （探针名故意不写在这里：`production-deps.test.ts` 有一条普查判的是「那个字面量
 * 只许出现在 `run-fixtures.ts` 里」，它扫的是整个文件的字节、分不清代码与注释 ——
 * 改名时那些提到它的注释同样会失效，所以这条普查把注释也算进去是有道理的。）
 *
 * 其他错误照旧抛：权限类错误若也被吞，等于把一个真存在的文件静默移出射程，
 * 那是真的假绿（本仓对「豁免必须被数据约束」的一贯口径）。
 * 目录级的缺失也照旧抛（`walkFiles` 的 readdirSync 会抛）—— 扫描根少一棵树
 * 是判据失效，不是「少读了一个文件」。
 */
function collect(): Collected {
  const out = new Map<string, Buffer>();
  const vanished: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const rel of walkFiles(join(ROOT, root), (n) =>
      SCANNED_SUFFIXES.some((s) => n.endsWith(s)),
    )) {
      const key = root + "/" + rel;
      try {
        out.set(key, readFileSync(join(ROOT, root, rel)));
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          vanished.push(key);
          continue;
        }
        throw e;
      }
    }
  }
  return { files: out, vanished };
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
    const cjk = Buffer.from('const 提示 = "不可逆操作";\n', "utf8");
    expect(findNullBytes(cjk)).toEqual([]);
  });

  it("取材非空（一条扫不到任何文件的守卫，报【干净】是假的）", () => {
    const c = collect();
    const files = c.files;
    // 量过一次：这几棵树加起来几百个文件。写死一个下界而不是 > 0，
    // 因为「> 0」在一个只扫到一个空目录的世界里也成立。
    expect(files.size).toBeGreaterThan(200);
    // 反向对照：确实读到了内容（路径拼错时 readFileSync 会抛，
    // 但「拼对了一半」那种错只会读到空 Buffer，所以这里看字节总量）。
    let bytes = 0;
    for (const b of files.values()) bytes += b.length;
    expect(bytes).toBeGreaterThan(1_000_000);
    // ⚠ 「跳过当场消失的文件」这个容错**必须被计数**，否则它会变成一条
    // 把整棵树静静跳过的通道。上界钉死在个位数：正常并发只会有那一发探针，
    // 一旦跳过数量成规模，说的是取材坏了，不是探针变多了。
    // 这条断言本身在极端并发下偶发红（探针写得勤）—— 到那时该做的是把探针名
    // 加进排除名单（run-fixtures.ts 那个唯一真相），不是把这个上界调大。
    expect(
      c.vanished.length,
      "有文件在读取瞬间消失：" + c.vanished.join(", "),
    ).toBeLessThanOrEqual(5);
  });

  it("⭐ 真仓库：一个 NUL 字节都没有", () => {
    const hits = nullByteHits(collect().files);
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

/*
 * 第二型静默坏字节：U+FFFD。判据本体在 no-null-bytes.ts 下半部，那里把
 * 「为什么最直觉的实现（fatal 解码）测不到本次真事故」写全了，这里不重复。
 *
 * ⚠ 本文件【在扫描根里】（SCAN_ROOTS 含 "test"），所以全文不许出现那个字符的
 * 字面量 —— 出现了就是守卫把自己判红。下面一律用 Buffer.from([0xef,0xbf,0xbd])
 * 与 String.fromCharCode(REPLACEMENT_CHAR) 现造。这与 NUL 那一侧同形：
 * 那边的用例写的也是 Buffer.from([0x00])。
 */
describe("源码与文档里不许出现 U+FFFD 替换字符（0056 §5 留给下一轮的那一格）", () => {
  /** 现造一段「中文里坏了一个字」的字节，形状与 0047 那处事故一致。 */
  const withBadChar = (before: string, after: string): Buffer =>
    Buffer.concat([
      Buffer.from(before, "utf8"),
      Buffer.from([0xef, 0xbf, 0xbd]),
      Buffer.from(after, "utf8"),
    ]);

  it("判据本身有判别力（否则本节是恒绿装饰）", () => {
    // ① 干净文本 0 命中 —— 而且中文【不能】被判成坏字符（编码往返是 utf8）。
    const clean = Buffer.from('const 提示 = "不可逆操作";\n第二行\n', "utf8");
    expect(findReplacementChars(clean.toString("utf8"))).toEqual([]);
    expect(replacementCharHits(new Map([["a/b.ts", clean]]))).toEqual([]);

    // ② 真坏一个字符：命中数、行号、可定位的上下文，三样都得对。
    const dirty = withBadChar("   本篇修的", "「一轮之内 hub」\n下一行\n");
    const hits = replacementCharHits(new Map([["d/x.md", dirty]]));
    expect(hits.length).toBe(1);
    expect(hits[0]?.line).toBe(1);
    expect(hits[0]?.path).toBe("d/x.md");
    expect(hits[0]?.context).toContain("<FFFD>");
    // 上下文得带上【周围的好字】，否则报出来只剩一个 <FFFD>，人还是得自己写脚本定位。
    expect(hits[0]?.context).toContain("本篇修的");

    // ③ 行号：坏字符在第三行就该报 3。指错行的守卫与漏报一样没用。
    const lines = Buffer.concat([
      Buffer.from("一\n二\n三", "utf8"),
      Buffer.from([0xef, 0xbf, 0xbd]),
      Buffer.from("、\n", "utf8"),
    ]);
    expect(
      replacementCharHits(new Map([["x.md", lines]])).map((h) => h.line),
    ).toEqual([3]);

    // ④ 多个坏字符是【多条】命中，不是一个文件报一条。
    //    ⚠ 必须走 replacementCharHits 而不是只调 findReplacementChars：变异实测把
    //    下面那个循环写成 `.slice(0, 1)` 时，只测 findReplacementChars 的那一版【全绿】
    //    —— 一个「每个文件只报第一处」的判据，行号仍然是对的、文件仍然是对的，
    //    只有【第二处以后的】丢了，而文档里一句坏两个字的写法很常见。
    //    两处故意隔开 40 个字符：挨着写的话两个 ±30 的上下文窗口会【落在同一段文字上】，
    //    那时「上下文不同」这条断言就是错的（我第一版两处只隔一个字，红在这上面 ——
    //    红得对，是断言写得不对，不是判据坏）。
    const gap = "A".repeat(40);
    const many = Buffer.concat([
      Buffer.from("甲", "utf8"),
      Buffer.from([0xef, 0xbf, 0xbd]),
      Buffer.from(gap + "乙", "utf8"),
      Buffer.from([0xef, 0xbf, 0xbd]),
      Buffer.from("丙\n", "utf8"),
    ]);
    const manyHits = replacementCharHits(new Map([["m.md", many]]));
    expect(manyHits.length).toBe(2);
    expect(findReplacementChars(many.toString("utf8")).length).toBe(2);
    // 每条命中的上下文锚在【它自己那一处】：第一条看得见「甲」看不见「乙」，反之亦然。
    expect(manyHits[0]?.context).toContain("甲");
    expect(manyHits[0]?.context).not.toContain("乙");
    expect(manyHits[1]?.context).toContain("乙");
    expect(manyHits[1]?.context).not.toContain("甲");
  });

  it("两类坏法都抓得到，而【直觉实现只抓到其中一类】", () => {
    // A 类：原始字节【非法】—— 多字节汉字被截断在中间。
    // 「值」的 UTF-8 是 e5 80 bc，这里只交出前两个字节 ⇒ 序列不完整。
    const truncated = Buffer.concat([
      Buffer.from("值=", "utf8").subarray(0, 2),
      Buffer.from([0x0a]),
    ]);
    expect(replacementCharHits(new Map([["A.ts", truncated]])).length).toBe(1);

    // B 类：字节【完全合法】，内容就是 U+FFFD —— 0047 那处事故就是这一类。
    const legal = withBadChar("修的", "「");
    // 先坐实「它是合法 UTF-8」，否则这一发测的就不是 B 类而是 A 类了。
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(legal),
    ).not.toThrow();
    expect(replacementCharHits(new Map([["B.md", legal]])).length).toBe(1);

    // ⇒ 这就是「为什么不用 fatal 解码当判据」的可执行版本：fatal 对 B 类不抛，
    //   拿它当判据会把 0047 那处读成【干净】。实测全仓：fatal 报 0、扫内容报 1。
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(() => decoder.decode(legal)).not.toThrow(); // ← 直觉实现：判成干净
    expect(() => decoder.decode(truncated)).toThrow(); // ← 只有 A 类它看得见
  });

  it("取材非空且真仓库【一个都没有】（0047 那处已就地修回）", () => {
    const c = collect();
    expect(c.files.size).toBeGreaterThan(200);
    const hits = replacementCharHits(c.files);
    expect(
      hits.map((h) => h.path + ":" + h.line + "  " + h.context).join("\n"),
      "文档/源码正文里有坏字符：它不炸任何编译与测试，只让那一个字变成乱码",
    ).toBe("");
  });

  it("0047 那一处【确实修回去了】，且修回的是【那一个字】而不是整句", () => {
    // 这一发是回归，不只是「文件干净了」：它钉住那句【读得通】。
    // 我修它时连错两次（先多删一个「的」，再把「是」「的」顺序放反），
    // 两次都是【U+FFFD 数为 0】的 —— 只验「没有坏字符」会全部放行。
    const p = join(
      ROOT,
      "docs/decisions/0047-topmost-asks-its-name-when-it-should-ask-its-shape.md",
    );
    const line = readFileSync(p, "utf8")
      .split(/\r?\n/u)
      .find((l) => l.includes("一轮之内 hub 不再自己把 CEO"));
    expect(line).toBeDefined();
    expect(line).toContain("本篇修的是「");
    // 反面：不许有人把它修成【另一个读得通的词】（比如删掉「的」或换成「修是」），
    // 那种写法同样没有坏字符，上面那发扫不出来，只有这一发会红。
    expect(line).not.toMatch(/本篇修是「|本篇修「/u);
    // 与下一句的【对仗】也在：那一句是「不修「…」」，被修的这一句必须还是「修的是「…」」。
    expect(readFileSync(p, "utf8")).toContain("不修「谁来按下一轮」");
  });

  it("describeReplacementHit 对【文末的】坏字符不越界（与 NUL 那侧同一条边界）", () => {
    const buf = Buffer.concat([
      Buffer.from("ab\n", "utf8"),
      Buffer.from([0xef, 0xbf, 0xbd]),
    ]);
    const hits = replacementCharHits(new Map([["y.md", buf]]));
    expect(hits.length).toBe(1);
    expect(hits[0]?.line).toBe(2);
    expect(hits[0]?.context).toContain("<FFFD>");
    // 直接调用时给一个越界边缘的下标也不许抛（判据里不会发生，但抛了更难查）。
    const h: ReturnType<typeof describeReplacementHit> = describeReplacementHit(
      "y.md",
      "",
      0,
    );
    expect(h.line).toBe(1);
    expect(REPLACEMENT_CHAR).toBe(0xfffd);
  });
});
