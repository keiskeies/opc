/**
 * 决策文档坐标的【纯判据】：形状识别、节号/条目号存在性、撤回豁免、短哈希核对。
 *
 * 为什么单独成模块：这些判据原本内联在 doc-coords.test.ts 里。要把同一套判据用于
 * 【源码注释里的引用】时，只有两种做法 —— 复制一遍，或者共用一份。复制的那份会漂移：
 * 本仓已经栽过【两处同名判据各改各的】，0006 §7 第 55、56 条记的就是这个形状。
 * 所以判据与取材各留一份在下面；取材（哪些文件、读哪些字节）也导出，供第二个调用方复用。
 *
 * 判据语义的取舍理由写在 doc-coords.test.ts 的文件头注释里，此处不重复，避免两处说明分家。
 */

const SEC: string = String.fromCharCode(167);

export type HeadingSets = { top: Set<number>; sub: Set<string> };

/**
 * 从标题行取节号。带点号的行【先】处理，绝不能再折进整数集 —— 上一版的判据把 ## 23.1 读成
 * 一级 §23，于是【一级共 23 节】这个数其实是 118 个二级的整数部分折叠出来的巧合。
 */
export function headingSets(lines: string[]): HeadingSets {
  const top: Set<number> = new Set<number>();
  const sub: Set<string> = new Set<string>();
  for (const raw of lines) {
    const l: string = raw.trimEnd();
    const mSub: RegExpExecArray | null =
      /^#{1,4}[ \t]+([0-9]+[.][0-9]+(?:[.][0-9]+)*)[ \t]/.exec(l);
    if (mSub) {
      const num: string | undefined = mSub[1];
      if (num !== undefined) sub.add(num);
      continue;
    }
    const mTop: RegExpExecArray | null =
      /^#{1,4}[ \t]+([0-9]+)[.](?![0-9])/.exec(l);
    if (mTop) top.add(Number(mTop[1]));
  }
  return { top, sub };
}

export function secExists(sets: HeadingSets, num: string): boolean {
  return num.includes(".") ? sets.sub.has(num) : sets.top.has(Number(num));
}

/** 决策文档自己的 §7 清单：只数【## 7.】到下一个一级标题之间的 N. **粗体** 行。 */
export function itemNumbers(lines: string[]): Set<number> {
  const got: Set<number> = new Set<number>();
  let in7: boolean = false;
  for (const raw of lines) {
    const l: string = raw.trimEnd();
    const mTop: RegExpExecArray | null =
      /^#{1,4}[ \t]+([0-9]+)[.](?![0-9])/.exec(l);
    if (mTop) {
      in7 = Number(mTop[1]) === 7;
      continue;
    }
    if (/^#{1,4}[ \t]/.test(l)) continue;
    if (!in7) continue;
    const mi: RegExpExecArray | null = /^([0-9]+)[.][ \t][*][*]/.exec(l);
    if (mi) got.add(Number(mi[1]));
  }
  return got;
}

export type Ref = {
  doc: string;
  line: number;
  targetDoc: string;
  num: string;
  kind: "sec" | "item";
};
export type Problem = { ref: string; why: string };

/*
 * 篇号前缀的宽度：`000[1-9]` 只认 0001–0009，**0010 往后一律不认**。
 * 这个宽度在 0009 之前是对的，之后就成了一个**假绿**的成因，而且形状很坏：
 * 0013 正文里写 `0012 §7`，旧正则那组不匹配 ⇒ 整条被当成【本篇的裸形 §7】，
 * 而本篇恰好也有 §7 ⇒ 于是它【被自己的编号洗白】一路放行，跨篇引用从未被校验过。
 * 实测 widened 之后新识别出的跨篇前缀有 0010 / 0011 / 0012 / 0013 四个、共 20 处，
 * 全部此前处于「看着有守卫、其实没查」的状态。
 * 改成 `0\d{3}`（四位数、0 开头）：与 0006 §7 那条「文档正文里凡是独立出现的
 * 四位、0 开头的数字都会被当成编号引用」的既有口径同一个形状，不是新发明。
 * 代价如实记在这里：将来若正文写出【四位数 0 开头的篇号 + 一个节号】这种东西，
 * 它会被当真引用要求那一节存在。这条代价**当场就付了一次**：我在这段注释里
 * 举那个例子时写出了那个形状，comment-citations 立刻报「目标决策文档不存在」。
 * 守卫是对的，被要求改的是我的例子而不是守卫的判据 —— 所以这里不再写样例形状。
 * 探针脚本与逐篇命中数记在 0014。
 */
export const SEC_RE = new RegExp(
  "(?:(0\\d{3})\\s*)?" + SEC + "\\s*(\\d+(?:\\.\\d+)*)(?![\\s]*第)",
  "g",
);
export const ITEM_RE = new RegExp(
  "(0\\d{3})\\s*" + SEC + "\\s*7\\s*第\\s*([\\d、,，\\s]+)条",
  "g",
);

export function extractRefs(doc: string, lines: string[]): Ref[] {
  const out: Ref[] = [];
  lines.forEach((l: string, i: number) => {
    for (const m of l.matchAll(SEC_RE)) {
      // 捕获组在类型上是 string | undefined（noUncheckedIndexedAccess）：这里的组都是必需组，
      // 运行时不可能缺失；显式收窄是为了让【判据输入】处在类型保护之下，而不是靠类型谎言。
      const num: string | undefined = m[2];
      if (num === undefined) continue;
      out.push({
        doc,
        line: i + 1,
        targetDoc: m[1] ?? doc,
        num,
        kind: "sec",
      });
    }
    for (const m of l.matchAll(ITEM_RE)) {
      // targetDoc 在这里【不能】兜底成本篇：ITEM_RE 的篇号组是必需组，裸形条目引用根本不匹配。
      const targetDoc: string | undefined = m[1];
      const nums: string | undefined = m[2];
      if (targetDoc === undefined || nums === undefined) continue;
      for (const tok of nums.split(/[、,， \t]+/).filter(Boolean)) {
        out.push({ doc, line: i + 1, targetDoc, num: tok, kind: "item" });
      }
    }
  });
  return out;
}

export type World = {
  byDoc: Map<string, { sets: HeadingSets; items: Set<number> }>;
  spec: HeadingSets;
  plan: HeadingSets;
  hashes: Set<string>;
  lines: Map<string, string[]>;
};

/**
 * 这个 § 引用是否已被【外部限定词】锚定：同一子句内（到最近一个子句终止符为止）出现过
 * 规格 / 设计文档 / 计划 / spec，就认为它指的是设计文档而不是本篇。中文技术写作里枚举是
 * 【规格 §5.8、§6.3、§22.1】这样共享前缀的，所以限定词向后可传递到子句结束 —— 要求每处都
 * 重复【规格】既不现实也没人会写；代价是同子句内后面那个引用不再受本篇校验，如实记在这里。
 */
export function qualifiedAsExternal(pre: string): boolean {
  const cut: number = Math.max(
    ...["。", "；", ";", "！", "？", String.fromCharCode(10)].map((t: string) =>
      pre.lastIndexOf(t),
    ),
  );
  const clause: string = pre.slice(cut + 1);
  return /(规格|设计文档|计划|spec)/.test(clause);
}
/**
 * 【撤回】行的判据：整行以该标记开头，不是【这一行含该标记】。实测四行同时含该标记与坐标，
 * 只有 1 行真是撤回记录，另 3 行只是提到那个词 —— 按【含】判会让【写一段解释豁免的文字】
 * 就悄悄扩大豁免范围，不需要任何人主动滥用。决策文档与非决策 markdown 共用这一份：
 * 两处各写一遍迟早漂移（0006 §7 第 55、56 条同族）。
 */
export function isRetracted(line: string | undefined): boolean {
  return line?.trimStart().startsWith("【撤回】") === true;
}

export function verify(refs: Ref[], w: World, retracted: string[]): Problem[] {
  const problems: Problem[] = [];
  for (const r of refs) {
    const shown: string =
      r.doc +
      " l." +
      r.line +
      " → " +
      (r.kind === "sec"
        ? r.targetDoc + " " + SEC + r.num
        : r.targetDoc + " §7 第 " + r.num + " 条");
    // 【撤回】行里的引用不报：0007 §4.1 要求已提交进决策文档的错误事实标【撤回】保留原文，
    // 不能静默删。守卫若把被撤回的引用当缺陷报，就会逼人手删撤回记录 —— 而【静默删掉错误事实】
    // 正是本守卫要防止的事。这条豁免可以被滥用，所以它必须【可数】：真数据 it 断言它的条数，
    // 数字一变就得重新去读那些撤回段，不许默默放过新增。
    const srcLine: string | undefined = (w.lines.get(r.doc) ?? [])[r.line - 1];
    // 判据是【整行以该标记开头】，不是【这一行含该标记】：实测四行含该标记又含坐标，只有 1 行真是撤回记录，
    // 另外 3 行只是【提到了这个词】（其中一行就是本守卫的说明文字本身）。按【含】判会把讨论豁免的那行
    // 也变成豁免区 —— 不需要任何人主动滥用，写一段解释豁免的文字就会悄悄扩大豁免范围。
    if (isRetracted(srcLine)) {
      retracted.push(shown);
      continue;
    }
    if (r.kind === "item") {
      const t = w.byDoc.get(r.targetDoc);
      if (!t) {
        problems.push({ ref: shown, why: "目标决策文档不存在（写错篇号？）" });
        continue;
      }
      if (!t.items.has(Number(r.num)))
        problems.push({
          ref: shown,
          why: "那一篇的 §7 没有第 " + r.num + " 条",
        });
      continue;
    }
    // 形状歧义（本轮抓出的假绿）：裸形 §N.M，本篇有父节 §N 却没有 §N.M，而设计文档/计划有 §N.M。
    // 这种写法既可能是【本篇 §N 下的一个不存在的子节号】（真错号），也可能是【指设计文档但漏了
    // 限定词】。旧版按【设计文档有就算对】放行，于是【本篇内的错号】会被设计文档的同名节洗白：
    // 0003 写 §6.2 / §6.5 指自己 §6 下的有序列表项，被设计文档 §6.2 兜住，错号一路绿灯。
    // 判据不确定时不要猜，报出来让人写成不会歧义的形状。
    if (r.kind === "sec" && r.targetDoc === r.doc && r.num.includes(".")) {
      const own: { sets: HeadingSets; items: Set<number> } | undefined =
        w.byDoc.get(r.doc);
      const parent: string = r.num.slice(0, r.num.lastIndexOf("."));
      const parentHere: boolean =
        own !== undefined &&
        (own.sets.sub.has(parent) || own.sets.top.has(Number(parent)));
      const notHere: boolean = own === undefined || !secExists(own.sets, r.num);
      const elsewhere: boolean =
        secExists(w.spec, r.num) || secExists(w.plan, r.num);
      if (parentHere && notHere && elsewhere) {
        const src: string = (w.lines.get(r.doc) ?? [])[r.line - 1] ?? "";
        const pre: string = src.slice(0, Math.max(0, src.indexOf(SEC + r.num)));
        if (!qualifiedAsExternal(pre)) {
          problems.push({
            ref: shown,
            why:
              "形状歧义：本篇有 §" +
              parent +
              " 但没有 §" +
              r.num +
              "，而设计文档或计划有 §" +
              r.num +
              "；要指本篇就写成本篇 §" +
              parent +
              " 第 N 项，要指外部就加【规格】这类限定词",
          });
          continue;
        }
      }
    }
    if (r.targetDoc === r.doc) {
      const own = w.byDoc.get(r.doc);
      if (own && secExists(own.sets, r.num)) continue;
      if (secExists(w.spec, r.num) || secExists(w.plan, r.num)) continue;
      problems.push({
        ref: shown,
        why: "本篇没有这一节，设计文档与计划里也没有",
      });
      continue;
    }
    const t = w.byDoc.get(r.targetDoc);
    if (!t) {
      problems.push({ ref: shown, why: "目标决策文档不存在（写错篇号？）" });
      continue;
    }
    if (!secExists(t.sets, r.num))
      problems.push({ ref: shown, why: "那一节在目标篇里不存在" });
  }
  return problems;
}

/**
 * ⚠ 【恰好 7 位】的那个正则只有这一份（`HASH_TOKEN`）。
 *
 * 原来计数与判错两处各写了一份字面量，于是「改一处忘另一处」是可达的：判据放宽而
 * 计数不放宽，覆盖自检（tokens >= 15）与真实扫描范围就脱钩，那时【没数到东西】又能
 * 伪装成【全对】—— 正是本文件反复要消灭的那个形状。所以正则只留一份，两个函数共用。
 */
const HASH_TOKEN = /(?<![0-9A-Za-z])[0-9a-f]{7}(?![0-9A-Za-z])/g;

/**
 * 边界为什么是【字母数字】而不是【十六进制字符】（这一发改过一次，理由是实测的）：
 * 旧写法 `(?<![0-9a-f]…(?![0-9a-f])` 只看两侧是不是 hex 字符，于是英文单词会被切成
 * 一个「短哈希」。当场量到的三个受害者：`succeeded` → `cceeded`、`feedback` →
 * `feedbac`、`deadbeat` → `deadbea` —— 全都是**含字母**的，连下面那条「纯数字放过」
 * 的豁免也挡不住。第一个就真的红过一次（INDEX 里写 `succeeded` flag）。
 * 收紧成两侧非字母数字之后：本仓文档少扫到的条目恰好只有那一条假阳，74 条真引用
 * 一条没丢。反向的漏报也要看清楚 —— 真哈希写在 `(abc1234)` / `` `deadbee` `` /
 * 句末 `abc1234.` 里都仍在边界外，照样扫得到；唯一扫不到的是 `abc1234def` 这种
 * 本来就【不是恰好 7 位】的东西，而那正是这条判据一开始就不打算管的东西。
 */
function hashTokens(l: string): RegExpMatchArray[] {
  HASH_TOKEN.lastIndex = 0;
  return [...l.matchAll(HASH_TOKEN)];
}

/** 只数【恰好 7 位】的坐标 token，不管好坏：把【扫到了多少】与【其中多少坏】分开计数。 */
export function hashTokenCount(lines: string[]): number {
  let n: number = 0;
  for (const l of lines) n += hashTokens(l).length;
  return n;
}

export function hashProblems(
  doc: string,
  lines: string[],
  hashes: Set<string>,
): Problem[] {
  const problems: Problem[] = [];
  lines.forEach((l: string, i: number) => {
    for (const m of hashTokens(l)) {
      // 不含 a-f 的七位纯数字按【普通数字】放过：实测本仓 55 个提交的 7 位短哈希里没有一个是全数字，
      // 决策文档里现存的 22 处引用也全是含字母的 ⇒ 这条过滤不漏真引用，却能挡住【共 1234567 行】这种假阳。
      if (!/[a-f]/.test(m[0])) continue;
      if (!hashes.has(m[0]))
        problems.push({
          ref: doc + " l." + (i + 1) + " → " + m[0],
          why: "仓库里没有这个提交（短哈希写错或已被改写）",
        });
    }
  });
  return problems;
}

/**
 * 装配 World：只吃已经读好的行，不碰文件系统。
 *
 * 为什么要单独导出：World 的组装本身有坑，而且坑不在判据里 —— 上一轮我把同一个 doc
 * 写进 rows 两行，Map 后一行【静默覆盖】前一行，新增的节就这样没了，规则永远不触发，
 * canary 红在计数上而不是红在规则上（doc-coords.test.ts 里那段注释记的就是这件事）。
 * 两个调用方各自手写这段组装，等于把这个坑复制两遍，所以组装也只留一份。
 */
export function makeWorld(
  rows: readonly { doc: string; lines: string[] }[],
  spec: HeadingSets,
  plan: HeadingSets,
  hashes: Set<string>,
): World {
  const byDoc: Map<string, { sets: HeadingSets; items: Set<number> }> =
    new Map();
  const lines: Map<string, string[]> = new Map<string, string[]>();
  for (const r of rows) {
    if (byDoc.has(r.doc)) {
      throw new Error(
        "判据失效：rows 里 " + r.doc + " 出现两行，Map 会静默覆盖前一行",
      );
    }
    byDoc.set(r.doc, {
      sets: headingSets(r.lines),
      items: itemNumbers(r.lines),
    });
    lines.set(r.doc, r.lines);
  }
  return { byDoc, spec, plan, hashes, lines };
}

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NL: string = String.fromCharCode(10);
const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DECISIONS: string = join(ROOT, "docs", "decisions");
const SPEC: string = join(ROOT, "docs", "OPC-OS-设计文档.md");
const PLAN: string = join(
  ROOT,
  "docs",
  "superpowers",
  "plans",
  "2026-11-06-opc-os-development-plan.md",
);

/* ========================= 取材（IO）=========================

 * IO 也放进来是因为它和判据一样有坑，两个调用方各写一遍迟早漏：短哈希在 git 不可用时必须抛
 * 【判据失效】而不是返回空集合（0006 §7 第 22 条），rows 里同一个 doc 出现两行会被 Map 静默
 * 覆盖、规则从此永不触发。取材口径也只留一份：哪些文件、读哪些字节。
 */

export type Row = { doc: string; lines: string[] };

export function decisionRows(): Row[] {
  return readdirSync(DECISIONS)
    .filter((f: string) => f.endsWith(".md"))
    .sort()
    .map((f: string) => ({
      doc: f.slice(0, 4),
      lines: readFileSync(join(DECISIONS, f), "utf8").split(NL),
    }));
}

export function readSets(path: string): HeadingSets {
  return headingSets(readFileSync(path, "utf8").split(NL));
}

export function repoShortHashes(): Set<string> {
  const out: string = execFileSync("git", ["rev-list", "--all"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const full: string[] = out
    .split(NL)
    .filter((l: string) => /^[0-9a-f]{40}$/.test(l.trim()))
    .map((l: string) => l.trim());
  if (full.length < 5)
    throw new Error(
      "判据失效：git rev-list 只拿到 " +
        full.length +
        " 个提交，不是【没有坏引用】",
    );
  return new Set<string>(full.map((h: string) => h.slice(0, 7)));
}

/**
 * 决策目录之外、git 跟踪的每一个 markdown：入口 README、索引、评审说明、溯源、规格、计划。
 * 取材走 git 而不是维护名单 —— 名单会漏新文件（0006 §7 第 57 条同族）。docs/decisions 整篇排除，
 * 因为那批由 doc-coords.test.ts 用更强口径核对（连裸形引用一起判），重复扫会让两份判据抢话。
 * 比较基准必须是仓库相对路径：git ls-files 输出的就是相对路径，拿绝对 DECISIONS 去比【前缀对不上】，
 * 决策文档会全数混进来 —— 本轮实测过一次，12 行而不是 6 行，靠行数对不上才发现。
 * git 失败或结果为空都抛【判据失效】而不是返回空数组：第 22 条，没扫到不等于没问题。
 */
const DECISIONS_REL: string = "docs/decisions/";

export function markdownRows(rootDir: string = ROOT): Row[] {
  let raw: Uint8Array;
  try {
    raw = execFileSync(
      "git",
      ["-c", "core.quotepath=off", "ls-files", "-z", "--", "*.md"],
      { cwd: rootDir, maxBuffer: 100000000 },
    ) as unknown as Uint8Array;
  } catch {
    throw new Error("判据失效：git ls-files 跑不起来，不是【没有坏引用】");
  }
  const paths: string[] = Buffer.from(raw)
    .toString("utf8")
    .split(String.fromCharCode(0))
    .filter(Boolean)
    .filter((p: string) => p.slice(0, DECISIONS_REL.length) !== DECISIONS_REL)
    .sort();
  if (paths.length === 0) {
    throw new Error(
      "判据失效：跟踪的 *.md 里一个非决策文档都没有（跟踪口径变了？）",
    );
  }
  return paths.map(
    (p: string): Row => ({
      doc: p,
      lines: readFileSync(join(rootDir, p), "utf8").split(NL),
    }),
  );
}

export function world(rows: Row[], hashes: Set<string>): World {
  return makeWorld(rows, readSets(SPEC), readSets(PLAN), hashes);
}
