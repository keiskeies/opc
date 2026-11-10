// 门禁脚本 docs/review/check-gate.mjs 只检查别人，此前没有任何测试检查它。
// 见 0006 §7 第 68 条【谁检查它？】。

// 钉的【不是】门禁此刻是绿的 —— 那是随仓库内容翻转的实时状态，写死它等于往
// 测试里埋一个【现在恰好为真】的断言：哪天门禁真被标记通过，它就以一个不相干
// 的理由变红。永远吵闹的门禁比不装门禁更糟，这条取舍见 0007 §4.1。
//
// ⚠ 但这条取舍【不等于】「结论也不必有人看」。本文件此前只守记账，于是门禁的
// 红没人看见（实测红过五次提交，见 0017 §2）。下面 KNOWN_RED 那一条是这条取舍
// 【不让它管什么】与【必须有人管什么】的分界：不钉「恒绿」，钉「不得有意外的红」。

// 钉的是【退出码 ⇔ 有没有不符项】这个双向契约，两个探针各验一次：
//   探针甲：在仓库里跑。现在是绿的，但断言写成双向蕴含，翻绿也不假通过。
//   探针乙：在仓库外跑。文件全读不到、git 全失败 → 必须记账且非零退出。
// 探针乙不依赖仓库此刻的内容，是确定性的，所以这条守卫永不因仓库内容误报。

// 另钉一条结构不变量：每一条打印出来的 ★FAIL 都必须在失败清单里出现。
// 它杀的是【只打印不记账】的 ok()：那种退化会打印 ★FAIL 却不计入退出码依据，
// 于是【看见红仍然 exit 0】，正是门禁脚本第一行声明要防的事。

// 刻意没钉的一条：汇总里那个数字 == 明细行数。量过，两者同源于一个数组的长度，
// 断言恒等式只会多一个【改一处必改两处】的钉。冗余的分法见 0006 §7 第 68 条。

// 也刻意没做的一件事：剥 ANSI 颜色码。门禁全文不含任何上色代码（实测：颜色码、
// chalk、isTTY 各 0 处），剥色是死代码。担心【颜色码插进 ★ 与 FAIL 之间让我解析
// 不到、断言静默退化成空对空】，靠的是每条断言自带的哨兵：解析不出来就直接抛错
// 或红，绝不放绿过去。见下面 sampledFails 那条 it 里的前提哨兵。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = join(ROOT, "docs", "review", "check-gate.mjs");

// 门禁的两类失败词汇，语义就是本文件守的两件事：读不到东西、外部命令失败。
// 用码位拼再拿字面量互证，防止我把词抄错却【正好抄成一个永远匹配不上的串】，
// 那种错会让下面的断言静默恒假。同法见门禁脚本自己的中文臂阳性对照。
const WORD_UNREADABLE = String.fromCharCode(0x8bfb, 0x4e0d, 0x5230);
const WORD_GIT_EXIT = String.fromCharCode(0x9000, 0x51fa, 0x7801);

type Run = {
  code: number;
  printedFails: string[];
  listedFails: string[];
  claimed: number;
  out: string;
};

const SUMMARY_MARK = String.fromCharCode(
  0x5224,
  0x4e0d,
  0x4e86,
  0x6216,
  0x4e0d,
  0x7b26,
  0x7684,
  0x9879,
);

function runGate(cwd: string): Run {
  const r = spawnSync(process.execPath, [GATE], {
    cwd,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (r.error) throw new Error("门禁调用失败：" + r.error.message);
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  // 空输出＝调用根本没发生，绝不能当成【没查出问题】。
  if (out.trim() === "") {
    throw new Error("门禁无任何输出，调用失败不能当作通过。退出码 " + r.status);
  }
  const lines = out.split(String.fromCharCode(10)).map((l) => l.trim());
  const printedFails: string[] = [];
  const listedFails: string[] = [];
  let claimed = -1;
  for (const l of lines) {
    if (l.startsWith("★FAIL")) {
      printedFails.push(l.slice(5).split("→")[0].trim());
    }
    if (l.startsWith("★ ")) {
      listedFails.push(l.slice(2).trim());
    }
    // 数字必须紧跟标记后的冒号：零不符时门禁打的是「项：0 无」，
    // 拿行尾锚定去匹配会在那种写法上恒解析失败，于是【绿】这一侧被永久跳过。
    if (l.includes(SUMMARY_MARK)) {
      const after = l.slice(l.indexOf(SUMMARY_MARK) + SUMMARY_MARK.length);
      const m = after.match(/^\D{0,2}(\d+)/);
      claimed = m === null ? -1 : Number(m[1]);
    }
  }
  return { code: r.status ?? -1, printedFails, listedFails, claimed, out };
}

// 探针乙的落点：从仓库根向上逐级问 git，取第一个「它不在任何
// 仓库里」的现存目录。
//
// 不写死 ROOT 的上一级：那等于假定克隆的父目录恰好不在任何仓库内。
// 把仓库克隆进家目录、而家目录本身是 dotfiles 仓库的开发者，会
// 得到一条永远呵哚的守卫（0007 §4.1）。逐级问 git 而不猜深度。
//
// 候选必须经 git 亲口认账才能用：「仓库外」这个态是验证出来的，
// 不是靠目录长得像。选择逻辑抽成纯函数（probe 泥入），是为了
// 「父目录是仓库、祖目录不是」这种态能用普通单测钉住，
// 不必真去造一个仓库来测这条守卫自己。
function pickOutsideRepo(
  candidates: string[],
  probe: (dir: string) => boolean,
): string | null {
  for (const dir of candidates) {
    if (probe(dir)) {
      return dir;
    }
  }
  return null;
}

function isNoRepo(dir: string): boolean {
  const p = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60000,
    shell: false,
  });
  return p.status !== 0;
}

let outsideCache: string | null = null;

function outsideRepoDir(): string {
  if (outsideCache !== null) {
    return outsideCache;
  }
  const candidates: string[] = [];
  let dir = join(ROOT, "..");
  for (let i = 0; i < 12; i++) {
    if (existsSync(dir)) {
      candidates.push(dir);
    }
    const up = dirname(dir);
    if (up === dir) {
      break;
    }
    dir = up;
  }
  const found = pickOutsideRepo(candidates, isNoRepo);
  if (found === null) {
    const tried = candidates.join(" ; ");
    throw new Error("探针乙无处可去：找不到仓库外的目录，试过：" + tried);
  }
  outsideCache = found;
  return found;
}
it("门禁脚本存在，否则下面全是空对空", () => {
  expect(existsSync(GATE), "找不到门禁脚本：" + GATE).toBe(true);
});

it("阳性对照：失败词汇的码位与字面量互证", () => {
  expect(WORD_UNREADABLE).toBe("读不到");
  expect(WORD_GIT_EXIT).toBe("退出码");
});

it("探针甲：退出码与不符项数同为零（双向蕴含，不预设现在是零）", () => {
  const r = runGate(ROOT);
  expect(
    r.claimed,
    "汇总行没解析出数字，契约无从成立：" + r.out.slice(0, 400),
  ).toBeGreaterThanOrEqual(0);
  expect(r.code === 0).toBe(r.claimed === 0);
});

it("探针乙：仓库外必须把读不到与外部命令失败都记上账并非零退出", () => {
  const r = runGate(outsideRepoDir());
  expect(r.code, "仓库外还能 exit 0 = 门禁对【读不到】视而不见").not.toBe(0);
  expect(
    r.listedFails.filter((x) => x.includes(WORD_UNREADABLE)).length,
    "失败清单里一条【读不到】都没有，读文件失败被咽下了：" +
      r.listedFails.join(" | ").slice(0, 300),
  ).toBeGreaterThan(0);
  expect(
    r.listedFails.filter((x) => x.includes("git ") && x.includes(WORD_GIT_EXIT))
      .length,
    "失败清单里一条【外部命令失败】都没有，git 报错被咽下了：" +
      r.listedFails.join(" | ").slice(0, 300),
  ).toBeGreaterThan(0);
});

it("打印出来的每条 ★FAIL 都得在失败清单里，不许只打印不记账", () => {
  const r = runGate(outsideRepoDir());
  if (r.printedFails.length === 0) {
    throw new Error("探针乙没产生 ★FAIL 样本，断言无从发生，检查解析或前提。");
  }
  const missing = r.printedFails.filter((x) => !r.listedFails.includes(x));
  expect(
    missing.join(" | "),
    "这些不符项只打印未记账，退出码因此可能仍为 0",
  ).toBe("");
});

// ── 【结论】也要有人看，而不只是【记账对不对】────────────────────────────
//
// 上面那五条 it 全部只验【记账】：退出码 ⇔ 数字、★FAIL ⇔ 清单、仓库外必须非零。
// 它们在门禁【红着】的时候同样成立 —— 这不是推测，是实测（0017 §2b）：
// 往 docs/INDEX.md 注入一行含「本轮」，脚本打 ★FAIL 且 exit 1，
// 而本文件六例【全绿】。也就是说门禁的【结论】此前没有任何人看。
//
// 后果量出来了：C7（入口里不许有轮次相对指称）从 Task 3.1 那次提交起就在报 FAIL，
// 连续五次提交各新增一处，一路到 6 处，测试套件一次没红过，也没人手工跑它。
// 每一环都合规：脚本正确报红 ⇒ 守卫正确验证「红被正确记账」⇒ 全绿 ⇒ 那行红没人看见。
//
// 本文件头第 4-6 行那条取舍（不写死「此刻为绿」，理由见 0007 §4.1）我仍然认，
// 所以这里【不】写成 expect(r.listedFails).toEqual([])。改成：结论必须落在一份
// 【点名的已知红名单】里。它与 toEqual([]) 在今晚的结果相同（名单是空的），
// 多出来的是**红的时候怎么说**：「不在已知红名单里 ⇒ 要么修掉，要么带理由登记」。
// 于是「让门禁永久红着」从一次沉默变成一次签字 —— 与本仓红名单基线、
// test-inventory 的跳过名单、doc-refs 的快照是同一个惯例，不是新造的口径。
const KNOWN_RED: readonly string[] = [];

it("门禁的【结论】必须在已知红名单里（记账对 ≠ 有人看结论，见 0017 §2）", () => {
  const r = runGate(ROOT);
  // 前提哨兵：解析必须真发生。零项时 r.claimed === 0 且清单为空，
  // 那是【通过】；但解析坏掉也会给出空清单，所以先看数字解出来了没有。
  expect(
    r.claimed,
    "汇总行没解析出数字，本条断言会退化成空对空：" + r.out.slice(0, 400),
  ).toBeGreaterThanOrEqual(0);
  if (r.claimed > 0) {
    expect(
      r.listedFails.length,
      "汇总说有不符项，清单却是空的 ⇒ 解析或门禁输出格式变了，本条判不了",
    ).toBeGreaterThan(0);
  }
  const unexpected = r.listedFails.filter((x) => !KNOWN_RED.includes(x));
  expect(
    unexpected.join(" | "),
    "门禁报了不在已知红名单里的不符项。两条路：① 修掉它；" +
      "② 若这一项本就只能报数（例如它判的是【存量】而非【违规】），" +
      "把它**带理由**加进 KNOWN_RED 并在决策文档里说明为什么不算违规。" +
      "不要让它红着没人管 —— 那正是它红过五次提交而无人发现的形状（0017 §2）。",
  ).toBe("");
  // 反向对照：名单判据本身必须有分辨力。少了这一发，
  // 「KNOWN_RED 被写成恒真判断」「filter 写反」都会让上面那条恒绿。
  expect(["某项本只该报数的检查"].filter((x) => !KNOWN_RED.includes(x))).toHaveLength(1);
  expect(KNOWN_RED).toEqual([]);
});

it(
  "探针落点的选择逻辑：父目录是仓库时必须继续向上" +
    "（写死上一级的写法在 dotfiles 仓库场景下会永呵哚）",
  () => {
    // 父目录是仓库、祖目录不是：必须选祖目录，不能取第一个候选。
    const seen: string[] = [];
    const pick = pickOutsideRepo(["a", "b", "c"], (d) => {
      seen.push(d);
      return d !== "a";
    });
    expect(pick).toBe("b");
    expect(seen).toEqual(["a", "b"]);
    // 全是仓库：返回 null，由调用方抛错，绝不静默拿一个仓库内目录交差。
    expect(pickOutsideRepo(["a", "b"], () => false)).toBeNull();
    // 空候选：同样不得编造落点。
    expect(pickOutsideRepo([], () => true)).toBeNull();
  },
);
