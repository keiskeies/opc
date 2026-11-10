// 门禁脚本 docs/review/check-gate.mjs 只检查别人，此前没有任何测试检查它。
// 见 0006 §7 第 68 条【谁检查它？】。

// 钉的【不是】门禁此刻是绿的 —— 那是随仓库内容翻转的实时状态，写死它等于往
// 测试里埋一个【现在恰好为真】的断言：哪天门禁真被标记通过，它就以一个不相干
// 的理由变红。永远吵闹的门禁比不装门禁更糟，这条取舍见 0007 §4.1。

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
