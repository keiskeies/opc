// 文档正文提到的决策编号，要么真实存在，要么在 docs/INDEX.md 里被明确预约。
//
// 这一类此前【零覆盖】，是实测出来的：往 0006 注入一条指向不存在编号（0009）的引用，
// doc-coords、doc-refs、decision-index 三条文档守卫全部恒绿。查过全仓：只有
// commit-msg-refs.ts 带决策编号正则，而它只作用于提交消息 —— 文档正文不在任何守卫射程内。
// 提交消息那一类在 0006 §7-37 补上了，文档正文这一类当时漏了。
//
// 判据不新造：提取编号、枚举现有编号、读预约号，三件事全部复用 commit-msg-refs.ts 已导出的
// 函数 —— 它们各自在那边已被 canary 钉住（含【路径里的编号不算引用】这条，很关键：
// 否则 INDEX 里的 0002-no-personal-wechat.md 这个路径会被当成一次引用）。
// 预约号只认 docs/INDEX.md 这一处权威出处，本文件【不带任何豁免表】—— 见 §7-37 修正后的设计。
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { docIds, existingIds, reservedIds } from "./commit-msg-refs.js";

const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS_DIR: string = join(ROOT, "docs");
const DECISIONS: string = join(DOCS_DIR, "decisions");
const INDEX_FILE: string = join(DOCS_DIR, "INDEX.md");

/** 找出提到【既不存在、也未被预约】编号的 文档>编号 清单。 */
function findMissing(
  docs: Map<string, string>,
  existing: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const [name, text] of docs) {
    // docIds 已内建【路径里的编号不算引用】：INDEX 写 0002-no-personal-wechat.md 不算一次引用。
    for (const id of docIds(text)) {
      if (existing.has(id)) continue;
      if (reserved.has(id)) continue;
      out.push(name + ">" + id);
    }
  }
  return out.sort();
}

/** 失败时把违规编号原样打出来：toEqual([]) 只会显示 Array(1)，不点名。 */
function joined(
  docs: Map<string, string>,
  existing: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): string {
  return findMissing(docs, existing, reserved).join(" ");
}

/**
 * 被扫描的文档：决策文档全体 + 索引本身（索引里也写编号，一并盯住）
 * + **迁移文件** + **docs/ 顶层其余文档**（功能优化设计 / 设计文档 / 附录A）。
 *
 * ⚠ 迁移这一类是 0061 那一轮加进来的，而且它进来的方式是【先让它红】：
 * 我在 `0006_approval_dedup_pending_only.sql` 的注释里写了「详见 0061」，
 * 写完当天 0061 还不存在，而全套 2543 发【一发都没红】—— 因为本守卫的取材
 * 从来只有 `docs/`。也就是说「文档正文的编号不许指空号」这条判据，
 * 在迁移文件这一类上【从来没有生效过】，而迁移文件恰恰是最爱引用决策记录的一类
 * （0004 里有 7 个编号、0005 里有 11 个）。
 * 加进来之后先红在 0061 上（实测），再靠写出 0061 变绿 —— 顺序是有意的：
 * 一条守卫在它能红之前，我不能说自己加了它（0055 那条「搬进 vitest 才算被执行」
 * 是同一个形状：判据存在于但不被执行，与没有判据不可区分）。
 * 迁移的编号【不会】与本文件名冲突：`docIds` 内建「路径里的编号不算引用」，
 * 而我这里给的 key 带目录前缀（`migrations/0004_….sql`），前缀那格正好被同一条
 * 规则放过 —— 不需要为迁移另开一条豁免。
 *
 * ⚠ 顶层文档这一类是 0062 那一轮加进来的，进来方式与迁移【完全同形】：
 * 我在 `docs/OPC-OS-功能优化设计.md` 的 O4 落点表里引用「0062」，当天 0062 不存在，
 * 守卫照绿 —— 它的取材是「decisions/ 全体 + INDEX.md + migrations/」，
 * 而 O1–O14 的落点与读数恰恰全写在顶层那份【功能优化设计】里（实测它引用 16 个编号）。
 * 顶层其余两份（设计文档 / 附录A）今天 0 引用，一并扫进来：现在零成本，将来有人
 * 在正文里写编号时不用再踩一遍同一个洞。
 */
function repoDocs(): Map<string, string> {
  const m: Map<string, string> = new Map();
  for (const f of readdirSync(DECISIONS)
    .filter((x: string): boolean => x.endsWith(".md"))
    .sort()) {
    m.set(f, readFileSync(join(DECISIONS, f), "utf8"));
  }
  m.set("INDEX.md", readFileSync(INDEX_FILE, "utf8"));
  const migDir = join(ROOT, "packages", "hub", "resources", "migrations");
  const migs = readdirSync(migDir).filter((x: string): boolean =>
    x.endsWith(".sql"),
  );
  // 迁移目录空了 = 取材通路坏了，而不是"迁移没引用决策"。必须红，不能静默少一类。
  if (migs.length === 0) throw new Error("迁移目录为空：" + migDir);
  for (const f of migs.sort()) {
    m.set("migrations/" + f, readFileSync(join(migDir, f), "utf8"));
  }
  for (const f of readdirSync(DOCS_DIR)
    .filter((x: string): boolean => x.endsWith(".md") && x !== "INDEX.md")
    .sort()) {
    m.set(f, readFileSync(join(DOCS_DIR, f), "utf8"));
  }
  return m;
}

describe("文档正文提到的决策编号不指空号", () => {
  it("扫描器本身有判别力（否则本节是恒绿装饰）", () => {
    // 插入顺序【故意与期望输出相反】：否则判据不排序也能过，排序就成了没被测到的死代码。
    const docs: Map<string, string> = new Map([
      ["b.md", "见 0001 与 0098 两个号都不在允许集里。"],
      ["a.md", "见 0001 这个号存在，见 0099 这个号不存在。"],
    ]);
    const existing: Set<string> = new Set(["0001"]);
    const reserved: Set<string> = new Set(["0002"]);
    // 缺失项必须被点名，且按名字排序 —— 断言精确内容，不写 toBeNotEmpty 那种弱断言。
    expect(findMissing(docs, existing, reserved)).toEqual([
      "a.md>0099",
      "b.md>0098",
    ]);
    // 反向：全部允许时必须为空。它防【判据恒返回非空】让上面那条退化成永真。
    expect(
      joined(new Map([["c.md", "提到 0001"]]), existing, reserved),
    ).toEqual("");
    // 预约号必须放行，否则文档里每一句【0002 被预约】的合法叙述都会假红。
    expect(
      joined(new Map([["d.md", "0002 已预约给 Task 4.6"]]), existing, reserved),
    ).toEqual("");
  });

  it("真实文档：正文提到的每个编号要么存在、要么被 INDEX 预约", () => {
    const docs: Map<string, string> = repoDocs();
    // 输入规模自检：扫描悄悄退化成空集时上面那条会假绿（本轮回归验证学到的教训）。
    expect(docs.size).toBeGreaterThanOrEqual(7);
    // ⭐ 而【规模】自检不足以守住【迁移】这一类：docs 那一类有 60+ 个文件，
    // 迁移那 6 个整个不见了，size 仍然 >> 7 ⇒ 判据退回"只扫 docs"而没人知道
    //（这正是本轮加这一类之前【已经持续了几轮】的状态，只不过当时是设计如此）。
    // 三层各管一种退化：
    //   ① key 在场 —— 防「repoDocs 里根本没加这一类」；
    //   ② 内容非空 —— 防 readFileSync 被换成恒返回 ""（那会让下面 toEqual("") 永远成立）；
    //   ③ 空允许集下【判据真的从迁移里抽出编号】—— 防"加了 key 而取材是空的"，
    //      也就是这一类整个【不可判】（vacuous）：0 个编号永远不违反任何规则。
    const migKeys = [...docs.keys()].filter((k: string): boolean =>
      k.startsWith("migrations/"),
    );
    expect(migKeys.length).toBeGreaterThanOrEqual(6);
    for (const k of migKeys) {
      expect((docs.get(k) as string).length).toBeGreaterThan(0);
    }
    const everything = findMissing(
      docs,
      new Set<string>(),
      new Set<string>(),
    ).filter((x: string): boolean => x.startsWith("migrations/"));
    // 实测今天的读数：0004 那份 7 个、0005 那份 11 个，所以这个下限留得很松，
    // 它防的是通路坏掉，不充当账本。
    expect(everything.length).toBeGreaterThanOrEqual(6);
    // 0061 是这一节存在的原因：0006 那份迁移在 0061 写出来之前引用它，
    // 加进扫描集的【当天】它就红（实测），写完 0061 才绿。
    expect(migKeys).toContain(
      "migrations/0006_approval_dedup_pending_only.sql",
    );
    // ⚠ 顶层文档这一类的三层自检，与迁移那三层【各管同一种退化】（0062 加进来时补）：
    //   ① key 在场 —— 防「repoDocs 里根本没加这一类」；
    //   ② 内容非空 —— 防 readFileSync 恒返回 ""（那会让"这一类没有违规"永远成立）；
    //   ③ 空允许集下【真的从这一类抽出编号】—— 防"加了 key 而取材是空的"。
    //      下限写 ≥1 就够：这一类今天实测 16 个引用，而这条防的是【通路坏掉】，
    //      不充当账本 —— 写一个贴着当前读数的下限，将来正常的删改会假红。
    for (const k of [
      "OPC-OS-功能优化设计.md",
      "OPC-OS-设计文档.md",
      "附录A-对话溯源.md",
    ]) {
      expect(docs.has(k), "顶层文档没进扫描集：" + k).toBe(true);
      expect((docs.get(k) as string).length).toBeGreaterThan(0);
    }
    const landingDoc: string = "OPC-OS-功能优化设计.md";
    const topExtracted = findMissing(
      new Map([[landingDoc, docs.get(landingDoc) as string]]),
      new Set<string>(),
      new Set<string>(),
    );
    expect(topExtracted.length).toBeGreaterThanOrEqual(1);
    const existing: Set<string> = new Set(existingIds(DECISIONS));
    const reserved: Set<string> = new Set(
      reservedIds(readFileSync(INDEX_FILE, "utf8")),
    );
    // 正对照：豁免通路必须是活的。它坏了读不到 0002，下面会红 —— 不许静默放行。
    expect(reserved.has("0002")).toBe(true);
    expect(existing.has("0007")).toBe(true);
    expect(joined(docs, existing, reserved)).toEqual("");
  });
});
