/**
 * round346：EXEMPT 穿透变异探针（0056 §8 明记的「没修」项）。
 *
 * 背景：docs/review/verify-open-invariants.mjs 的 EXEMPT 表每一条「豁免」都必须
 * 真实在 ④ 桶承重。旧断言只数「这条 key 在语料里出现过几次」（exemptSeen），
 * be07d9+b 那条注入值在旧断言下完全合格（它确实在语料里出现）却把 M1 弄瞎。
 * round346 在脚本里把「每条豁免必须被④用掉」（exemptHit）从提示升成断言（静态）。
 * 本文件是【动态穿透】那一半：逐条把某 key 从 EXEMPT 换成一个非 hex 无效值
 * （zzzzzzz，不会被 /\b[0-9a-fA-F]{7,}\b/ 采到，所以不污染语料），spawn 原脚本，
 * 断言【红且点名该 key】⇒ 证明这一条豁免今天真的在放行什么；然后逐字节回滚。
 *
 * ⚠ 为什么放 test/arch 而不是 .workbuddy：verify 脚本扫 .workbuddy/ 与 docs/，
 *   把 key 原文（真 hex）留在被扫目录 = 探针自己污染语料（round346 实测踩过：
 *   探针注释里的 7 位 hex 把脚本扫红）。test/ 不在扫描面，干净。
 * ⚠ 变异是真字节：readFile → replace → writeFile → spawn → 断言 → 逐字节还原。
 *
 * ⚠ round353f（脏基准盲区加固）：探针的 ORIGINAL 取自【工作树】——若 verify
 *   脚本在探针启动【之前】已被污染（round353c 那场 zzzzzzz 事件的未复原时序），
 *   ORIGINAL 就是脏的，16 条穿透会拿脏基准自证、回滚回脏版，boxed 是干净的
 *   假象。⇒ 本文件在【第一发】加「启动基线自鉴」：git show HEAD 的该文件字节
 *   与工作树逐字节比对，不一致当场红并点名"脏基准"——不跑一条穿透才允许
 *   proceed。且有一条【故意污染】的反向 canary：把文件弄脏后跑探针 ⇒ 自鉴
 *   必须红且点名，还原后恢复绿 ⇒ 自鉴这条自己不是装饰。
 *
 * 跑法：npx vitest run test/arch/exempt-pierce.test.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const TARGET = join(ROOT, "docs", "review", "verify-open-invariants.mjs");

const ORIGINAL = readFileSync(TARGET, "utf8");

/** round353f→round353h：启动基线自鉴（模块级 gate，不是某一条 it）。
 *  若 verify 脚本【内部】有污染信号，ORIGINAL 本身就是脏的，16 条穿透
 *  会拿脏基准自证、回滚回脏版。⇒ 在模块加载期直接 throw，任何 it 不跑。
 *
 *  ⚠ round353g 实测发现第一版（工作树==HEAD 才放行）误伤合法开发改动：
 *  有人合法加一条 EXEMPT（key 仍 hex 且自洽），探针整套红、21 发全灭，
 *  且没有逃生门 —— 那不是「设计权衡」，是可用性缺陷。
 *  ⇒ round353h 收窄门到【真正的污染信号】：EXEMPT 表里出现【非 hex key】
 *  （zzzzzzz 那族，round353c 实测的形状）。合法改动 key 全 hex ⇒ 放行；
 *  工作树≠HEAD 只发提示不阻断（探针按工作树自洽运行，穿透与回滚都有效）。
 *  反向 canary 两条：污染 ⇒ 红且点名；合法改动 ⇒ 放行（不误伤）。 */
function assertCleanBaseline() {
  // ① 真正的污染信号：EXEMPT 表内出现【非 hex key】。
  //    注意不能对整个文件做宽匹配——verify 里还有 git 命令参数数组
  //    （["cat-file","rev-parse",...]），会误报。只切 EXEMPT 段
  //    （const EXEMPT = new Map([ ... ]);），段内字符串必须全 hex。
  const segment = ORIGINAL.match(
    /const EXEMPT\s*=\s*new Map\(\[([\s\S]*?)\]\s*\);/u,
  )?.[1];
  if (segment === undefined) {
    throw new Error("解析失败：找不到 EXEMPT 表段，无法自鉴污染");
  }
  const segKeys = [...segment.matchAll(/\[\s*"([^"]+)",/gmu)].map(
    (m) => m[1] as string,
  );
  const nonHex = segKeys.filter((k) => !/^[0-9a-fA-F]{7,40}$/u.test(k));
  if (nonHex.length > 0) {
    throw new Error(
      "脏基准拒绝：EXEMPT 表含非 hex key [" +
        nonHex.join(", ") +
        "]（探针启动前已被污染，round353c 那族的中断残留）。" +
        "拒绝拿脏 ORIGINAL 跑任何穿透。",
    );
  }
  // ② 合法未提交改动：≠HEAD 不阻断，只提示（探针按工作树自洽运行）。
  const head = (() => {
    const r = spawnSync(
      "git",
      ["show", "HEAD:docs/review/verify-open-invariants.mjs"],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
    );
    if (r.status !== 0) {
      throw new Error("git show HEAD 失败: " + String(r.stderr));
    }
    return String(r.stdout);
  })();
  if (ORIGINAL !== head) {
    console.warn(
      "⚠ exempt-pierce：工作树 verify-open-invariants.mjs ≠ HEAD（合法改动？）。" +
        "探针按工作树自洽运行；若这是无意污染（EXEMPT 内非 hex key），上方 gate 会红。",
    );
  }
  return head;
}

void assertCleanBaseline(); // throws if 污染 ⇒ 模块级全红
// ⚠ 角色边界（round353m）：不再持有 HEAD 字节。所有变异（穿透、canary
//   形状 A/B）从 ORIGINAL（工作树启动态）变异、还原到 ORIGINAL —— HEAD
//   字节可能缺合法的未提交改动（如 round353m 摘 absent），写回它会抹掉那些改动。
//   assertCleanBaseline() 内部仍用 HEAD 做「≠HEAD 提示」比对，但返回值
//   只作副作用（throw 或 warn），不再需要存下来。

function runScript(): { green: boolean; out: string } {
  const r = spawnSync(process.execPath, [TARGET], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout) + String(r.stderr);
  return { green: r.status === 0, out };
}

/** 从 EXEMPT 表里抓 key。两种写法都要认：
 *   单行 `["83697c4", "reason…"],` 与多行 `[\n  "7109a8c",\n  "reason…"]`。
 *   ⇒ 匹配 `[` 后跟 `"key",`，不看行尾（单行行尾是 `]`）。 */
const KEY_ANCHOR = /\[\s*"([0-9a-fA-F]{7,40})",/gmu;
const keys = [
  ...new Set(
    [...ORIGINAL.matchAll(KEY_ANCHOR)].map((m) =>
      (m[1] as string).toLowerCase(),
    ),
  ),
].filter((k) => k !== "1877e8e"); // HASHLIST 钉住的检查器哈希，不是 EXEMPT

const INVALID = "zzzzzzz"; // 非 hex，采不到 ⇒ 换了=把豁免拿掉，但不污染语料

function rollback() {
  writeFileSync(TARGET, ORIGINAL, "utf8");
  expect(readFileSync(TARGET, "utf8"), "回滚后字节必须与原文一致").toBe(
    ORIGINAL,
  );
}

describe("verify-open-invariants EXEMPT 穿透（round346）", () => {
  it("启动基线自鉴：EXEMPT 无污染信号才允许跑穿透", () => {
    // 模块加载期的 assertCleanBaseline() 已经从根上保证——这里重读一次
    // 工作树再比，专防"模块加载后、本 it 运行前"被外部写脏的窗口。
    // gate 语义（round353h）：EXEMPT 段内非 hex key = 污染 ⇒ 红；合法改动放行。
    const seg = readFileSync(TARGET, "utf8").match(
      /const EXEMPT\s*=\s*new Map\(\[([\s\S]*?)\]\s*\);/u,
    )?.[1];
    expect(seg, "EXEMPT 表段必须存在").toBeDefined();
    const segKeys = [...(seg ?? "").matchAll(/\[\s*"([^"]+)",/gmu)].map(
      (m) => m[1] as string,
    );
    expect(
      segKeys.filter((k) => !/^[0-9a-fA-F]{7,40}$/u.test(k)),
      "EXEMPT 段的 key 必须全 hex（无污染信号）",
    ).toEqual([]);
  });

  // ⚠ 反向 canary 会 spawn 子 vitest 进程（切断 env）来验证"污染 ⇒ gate 红"。
  //   子进程里必须跳过本条，否则它又 spawn 孙进程 ⇒ 无限递归。
  //   父进程（无 env）跑全量；子进程（OPC_EXEMPT_SKIP_CANARY=1）跳过本条。
  const skipCanary = process.env.OPC_EXEMPT_SKIP_CANARY === "1";
  // ⚠ 不用 it.skipIf：skipIf 会落入 pending-inventory 的 SKIP_PROPS（skip 一族），
  //   而在本仓这个形态是【env 条件跳过】不是【列表计数跳过】，又把 canary 放进
  //   ALLOW_SKIP_FILES 会稀释名单「必须自带活着的运行计数」语义。
  //   ⇒ 改用运行时早返：it() 永远收集这条（tests 数不变、不算 pending）、
  //     子进程里函数体第一行就验 env 并 return；
  //     requireAssertions 要求每条用例至少一发断言 ⇒ 早返分支也要真断言
  //     （验证"子进程态"这个事实本身就是断言，不是装饰）。
  it("反向 canary：污染 ⇒ gate 红且点名；合法改动 ⇒ 放行；还原后绿", () => {
    if (skipCanary) {
      // 子进程防递归。早返分支也发断言：证明我们确实处于"子进程"态
      // （env 被正确传入），且满足 requireAssertions。
      expect(
        process.env.OPC_EXEMPT_SKIP_CANARY,
        "早返分支必须确实处在子进程态",
      ).toBe("1");
      return;
    }
    // ── 形状 A：zzzzzzz 污染 ⇒ 子进程红且点名「脏基准拒绝」 ──
    // round353m（并发竞态修）：变异基与还原目标都取 ORIGINAL（工作树启动态）
    //   而非 HEAD —— HEAD 可能缺合法的未提交改动（如本仓现状 round353m 摘
    //   absent），还原到 HEAD 会把那些改动抹掉，且让并行读 verify 的守卫
    //   （verify-lexicon-guard）在「absent 回③」的瞬时窗口看到被污染的形态
    //   而误红（全量实测一次）。
    const next = ORIGINAL.replace(`"521daf21"`, `"zzzzzzz"`);
    expect(next, "变异必须真的改变字节").not.toBe(ORIGINAL);
    writeFileSync(TARGET, next, "utf8");
    try {
      // 模拟"一个新探针进程在污染后的工作树上启动"：spawn vitest 单独跑本文件，
      // 模块加载期的 assertCleanBaseline() 会 throw ⇒ 整文件红且点名"脏基准"。
      // env 切断子进程的 canary：否则子进程又会 spawn 孙进程 ⇒ 无限递归。
      const r = spawnSync(
        process.execPath,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "test/arch/exempt-pierce.test.ts",
          "--reporter=dot",
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 180_000,
          env: { ...process.env, OPC_EXEMPT_SKIP_CANARY: "1" },
        },
      );
      const out = String(r.stdout) + String(r.stderr);
      expect(r.status !== 0, "污染基线下探针必须以非零退出").toBe(true);
      expect(out, "红话必须点名『脏基准拒绝』").toContain("脏基准拒绝");
    } finally {
      writeFileSync(TARGET, ORIGINAL, "utf8");
      expect(
        readFileSync(TARGET, "utf8"),
        "还原后工作树必须恢复启动态（ORIGINAL）",
      ).toBe(ORIGINAL);
    }

    // ── 形状 B：合法改动（加一条 hex 豁免）⇒ 不阻断（round353h 修的误伤） ──
    // 521daf21 在 verify 里是多行格式（`    "521daf21",`），锚点不含 `[`。
    // round353m：变异基改用 ORIGINAL（同形状 A，理由见上）。
    const legit = ORIGINAL.replace(
      `"521daf21",`,
      `"521daf21",\n    "1234abcd",`,
    );
    expect(legit, "合法改动必须真的改变字节").not.toBe(ORIGINAL);
    writeFileSync(TARGET, legit, "utf8");
    try {
      // 合法改动 ⇒ gate 放行（key 全 hex）⇒ 探针正常跑到测试阶段。
      // 断言一：输出绝不能含"脏基准拒绝"（round353h 修的就是这个误伤）。
      // 断言二：必须真的【跑到了测试】—— gate 拦截是 0 tests（模块级 throw 在
      //   describe 外，vitest 报 no tests）；走到了描述阶段才有测试数。
      //   （多出的 1234abcd 会让「EXEMPT 表 N 条 key」那条计数断言红，那是穿透的正常语义，
      //   但测试数非 0 证明 gate 没有把整个文件拦在门外。）
      const r = spawnSync(
        process.execPath,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "test/arch/exempt-pierce.test.ts",
          "--reporter=dot",
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 180_000,
          env: { ...process.env, OPC_EXEMPT_SKIP_CANARY: "1" },
        },
      );
      const out = String(r.stdout) + String(r.stderr);
      expect(
        out,
        "合法改动绝不能触发『脏基准拒绝』（round353h 修的就是这个误伤）",
      ).not.toContain("脏基准拒绝");
      expect(
        out,
        "合法改动下探针必须真的跑到测试阶段（gate 拦截 = 0 tests 才看不见测试数）",
      ).not.toContain("no tests");
    } finally {
      writeFileSync(TARGET, ORIGINAL, "utf8");
      expect(
        readFileSync(TARGET, "utf8"),
        "还原后工作树必须恢复启动态（ORIGINAL）",
      ).toBe(ORIGINAL);
    }

    // ── 还原后再起一个进程 ⇒ 恢复绿（gate 能区分干净与脏，不是恒红） ──
    const r2 = spawnSync(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "test/arch/exempt-pierce.test.ts",
        "--reporter=dot",
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 180_000,
        env: { ...process.env, OPC_EXEMPT_SKIP_CANARY: "1" },
      },
    );
    expect(
      r2.status === 0,
      "还原后探针必须恢复绿，gate 不是恒红: " +
        (String(r2.stdout) + String(r2.stderr)).slice(-800),
    ).toBe(true);
  });

  it("基线：脚本未变异时可复算绿", () => {
    const r = runScript();
    expect(r.green, r.out.slice(-1400)).toBe(true);
  });

  it("EXEMPT 表 17 条 key 全部提取到且锚点唯一", () => {
    expect(keys.length).toBe(17);
    for (const k of keys) {
      const n = ORIGINAL.split(`"${k}"`).length - 1;
      expect(n, `${k} 的引号锚点应唯一命中`).toBe(1);
    }
  });

  for (const key of keys) {
    it(`穿透 ${key}：从 EXEMPT 拿掉 ⇒ 脚本红且点名该 key（然后逐字节还原）`, () => {
      const before = readFileSync(TARGET, "utf8");
      const next = before.replace(`"${key}"`, `"${INVALID}"`);
      expect(next, "变异必须真的改变字节").not.toBe(before);
      writeFileSync(TARGET, next, "utf8");
      let got: { green: boolean; out: string };
      try {
        got = runScript();
      } finally {
        rollback(); // 任何情况都还原；若断言失败仍保证文件干净
      }
      expect(
        got.green,
        "删掉一条真·承重豁免后脚本必须红（证明确实在放行）",
      ).toBe(false);
      expect(got.out).toContain(key); // 点名 = 不是别的桶在红
      // 且失败因确实是这条豁免：豁免桶或 "腐烂" 出现在输出
      expect(got.out).toMatch(/(豁免|腐烂|⑤)/u);
    });
  }

  it("全还原后复跑 ⇒ 脚本恢复绿", () => {
    expect(
      readFileSync(TARGET, "utf8"),
      `${keys.length} 条逐字节还原后应干净`,
    ).toBe(ORIGINAL);
    const r = runScript();
    expect(r.green, r.out.slice(-1400)).toBe(true);
  });
});
