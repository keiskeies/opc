#!/usr/bin/env node

/**
 * 这台机器上【哪些依赖真的能用】—— 一条当场可复算的读数，不是一个清单。
 *
 * 为什么要有这个脚本（0031）：本仓有十几个任务挂着「缺依赖所以做不了」。
 * 那句话我此前一直是**抄来的**，抄的时候还顺手把「`.pnpm` 里有那个目录名」
 * 读成「装上了」—— 而那个读法在**两个相反的方向上都会错**：
 *
 *   · 空壳：`node_modules/.pnpm/tsx@4.23.15/` 这个目录**在**，里面 0 KB。
 *     按目录名判 ⇒ 判成「装了」⇒ 我会去写一个跑不起来的适配器，
 *     并在「为什么测试全绿」上再花半天。
 *   · hoist：`node_modules/zod` 是一个 8 MB 的**真目录**（pnpm 提到顶层了），
 *     而 `.pnpm/zod@4.6.7/` 是 0 KB 空壳。按 `.pnpm` 判 ⇒ 判成「没装」
 *     ⇒ 我会说「zod 不可用」，而它此刻正被 `packages/contracts` 用着。
 *
 * 所以唯一的口径是【从消费方那个位置解析得到】（createRequire + 真实 specifier）。
 * 这也正是运行时真正会问的那个问题：Node 不在乎 store 长什么样，
 * 它只在乎 `import("tsx/cli")` 从 `packages/hub/src/` 出发找不找得到。
 *
 * ⚠ 作用域不是只有一个（round319-9 修正）：pnpm 的解析**按包**分作用域，
 * 而本仓的依赖消费者不止 hub 一个 —— zod 的消费者是 packages/contracts，
 * @biomejs/biome 是 root 的 dev 工具链（pnpm lint 在 root 跑）。探测点一律钉在
 * hub 会得出「zod/ biome 装不上」的错读数，而那两包分别在 contracts 与
 * root CLI 上下文里真能用。⇒ 每条探测自带 scope，各从自己的消费方解析。
 *
 * ⚠ CLI 型包不提供 require 主入口（@biomejs/biome 是纯二进制 CLI）：
 * createRequire 对它恒 MISS ≠ 不可用。⇒ kind: "cli" 的探测走 spawnSync
 * `<bin> --version`，能跑出非空输出才算可用（round319-7 实测 2.6.5 真执行）。
 *
 * ⚠⚠ 【MISS ≠ 做不了】—— round331 加这一条，因为本脚本原先把两个问题答成了一个。
 * 本脚本只测【此刻从消费方位置 resolve 得到吗】。而它的输出表头原先写的是
 * 「这些任务今天在这台机器上做不了，也不是没试」—— 那是从「没装」直接跳到
 * 「做不了」，中间那一步【装得上吗】它一行都没测。「没装」与「装不上」是两个
 * 问题，而本仓已经被这个合并咬过三次：round319 复跑装上了 @langchain/*、
 * round278 复跑装上了 playwright，优化设计文档 §6 因此明写着「要先复跑安装再判」。
 * round331 复跑了这里全部 7 条 MISS（配方见下面 --install-probe）：
 * 【七条全部装得上、且全部能 import】。⇒ 「做不了」这句在这一天对这七条全假。
 * 真实原因写在 0009 §2 那张表里：2026-11-10 实测两个 registry 的 TCP 443 都超时，
 * 那时「装不上」是真的；网络条件变了，而没有任何一条守卫回头改这句话。
 * 所以今天的口径分成两层，各由一条命令答：
 *   · 没装（本脚本，只读）           ⇒ 判据 = createRequire.resolve
 *   · 装得上（--install-probe，联网） ⇒ 判据 = 真 npm i 到一次性目录 + 真 import
 * 一句话不能替另一句话：**「没装」是排期事实，「装不上」才是能力边界**，
 * 把前者写成后者，就会让五个计划任务长期挂在一个已经不成立的前提上。
 *
 * 默认模式只读，不装，不联网，不改任何东西。跑法：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH node packages/hub/scripts/deps-resolvable.mjs
 * 复跑安装（联网，往 .workbuddy/ 写一次性目录，绝不碰仓库自己的 node_modules）：
 *   node packages/hub/scripts/deps-resolvable.mjs --install-probe
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(HERE, "..", "..");

/** 解析作用的包作用域：hub = packages/hub/src，contracts = packages/contracts/src，root = 仓库根。 */
const SCOPE_FILE = {
  hub: join(HERE, "src", "__probe__.ts"),
  contracts: join(HERE, "..", "contracts", "src", "index.ts"),
  root: join(ROOT, "package.json"),
};

/**
 * specifier（或 CLI 命令）→ 它挡着哪个任务 + 从哪个作用域探测 + 探测方式。
 * specifier 用**真实 import 形状**（`tsx/cli` 而不是 `tsx`）：
 * 一个包可能主入口能解析而子路径不行（exports 字段挡掉），
 * 而那正是「装了但用不了」那一类的形状。
 * kind: "module" 用 createRequire.resolve 探；kind: "cli" 用 <bin> --version 探。
 */
const PROBES = [
  {
    spec: "@langchain/core/messages",
    blocks: "Task 6.1 重试接进图节点 / 6.2、6.3 端到端那半",
    scope: "hub",
    kind: "module",
  },
  {
    spec: "@langchain/langgraph",
    blocks: "同上（StateGraph 与图执行）",
    scope: "hub",
    kind: "module",
  },
  {
    spec: "tsx/cli",
    blocks: "全量测试里那 60 条基线红（子进程跑 TS 的那几套）",
    scope: "hub",
    kind: "module",
  },
  { spec: "vitest", blocks: "pnpm verify", scope: "hub", kind: "module" },
  {
    spec: "@biomejs/biome",
    blocks: "pnpm lint ⇒ 新文件格式（2.6.5）",
    scope: "root",
    kind: "cli",
  },
  {
    spec: "react",
    blocks: "Task 4.2 / 4.3 移动端、Replay.tsx",
    scope: "root",
    kind: "module",
  },
  {
    spec: "@capacitor/core",
    blocks: "Task 4.2 移动端打包",
    scope: "root",
    kind: "module",
  },
  {
    spec: "@xyflow/react",
    blocks: "Task 3.2 组织图编辑器",
    scope: "root",
    kind: "module",
  },
  {
    spec: "@larksuiteoapi/node-sdk",
    blocks: "Task 4.4 飞书通道 ⇒ 也是 bindings/im 的生产者",
    scope: "hub",
    kind: "module",
  },
  {
    spec: "@modelcontextprotocol/sdk/client/index.js",
    blocks: "Task 5.7 三层搜索",
    scope: "hub",
    kind: "module",
  },
  {
    spec: "@openai/codex-sdk",
    blocks: "Task 5.5 Codex 适配器",
    scope: "hub",
    kind: "module",
  },
  {
    spec: "@qoder-ai/qoder-agent-sdk",
    blocks: "Task 5.6 Qoder 适配器",
    scope: "hub",
    kind: "module",
  },
  // 正对照：这两个【必须】解析得到，否则整份读数是「什么都没探到」而不是「全都缺」。
  {
    spec: "zod",
    blocks: "正对照（contracts 的 schema 全用它）",
    scope: "contracts",
    kind: "module",
  },
  {
    spec: "typescript",
    blocks: "正对照（tsc 与 test/arch 的 AST 守卫用它）",
    scope: "root",
    kind: "module",
  },
];

function probeOne({ spec, scope, kind }) {
  if (kind === "cli") {
    // CLI 型包：require.resolve 恒 MISS（无主入口），用二进制本身探。
    // bin 在仓库根的 node_modules/.bin/ 里（pnpm 把 dev 工具链 bin 放那），
    // 裸命令名未必在 PATH 上（尤其 Windows），所以先解析 .bin 再跑；解析不到
    // 再退回裸名（备选：bin 可能由全局 PATH 提供）。
    const binPath = join(ROOT, "node_modules", ".bin", spec.split("/").pop());
    const candidates = [binPath, spec];
    for (const cmd of candidates) {
      const r = spawnSync(cmd, ["--version"], {
        encoding: "utf8",
        shell: process.platform === "win32",
        timeout: 15_000,
      });
      if (r.status === 0 && (r.stdout || r.stderr).trim().length > 0) {
        return {
          ok: true,
          detail: (r.stdout || r.stderr).trim().split(/\r?\n/)[0].slice(0, 40),
        };
      }
    }
    return { ok: false, detail: "" };
  }
  const req = createRequire(SCOPE_FILE[scope]);
  try {
    req.resolve(spec);
    return { ok: true, detail: "" };
  } catch {
    return { ok: false, detail: "" };
  }
}

const usedScopes = [...new Set(PROBES.map((p) => p.scope))];
for (const s of usedScopes) {
  if (!SCOPE_FILE[s]) {
    console.error(`★ 未知探测作用域 ${s} —— 脚本自己坏了，读数不可采信。`);
    process.exitCode = 2;
  }
}

const rows = PROBES.map((p) => ({ ...p, ...probeOne(p) }));

const usable = rows.filter((r) => r.ok);
const missing = rows.filter((r) => !r.ok);

console.log("── 能解析（真能用）──");
for (const r of usable)
  console.log(
    "  " +
      r.spec.padEnd(44) +
      r.blocks +
      (r.detail ? "  [" + r.detail + "]" : ""),
  );
// ⚠ 表头原先写的是「这些任务今天在这台机器上做不了，也不是没试」—— 那是把
// 「没装」当成「装不上」（round331，见文件头 ⚠⚠ 那段）。这里只报量到的那一件。
console.log(
  "\n── 此刻没装（【不是】「装不上」；要判能不能装：--install-probe）──",
);
for (const r of missing) console.log("  " + r.spec.padEnd(44) + r.blocks);

// 恒绿的形状要当场能看出来：如果一条都没解析到，那不是「依赖很缺」，是探针坏了。
if (usable.length === 0) {
  console.log(
    "\n★ 一条都没解析到 ⇒ 这个脚本自己坏了（正对照 zod / typescript 也失败），" +
      "上面那份【解析不到】清单一律不可采信。",
  );
  process.exitCode = 2;
}

/**
 * ── --install-probe：把「没装」与「装不上」分开量 ─────────────────────
 * 只对上面 MISS 的那些跑。每条：一次性临时目录里真 `npm i --ignore-scripts`
 * → 再从这个目录【真 import 一次】那个 specifier（目录在 ≠ 能用：exports 字段
 * 挡掉子路径、纯 CLI 包无主入口，都是「装了而 import 不到」的形状）。
 *
 * 刻意不往仓库里写：临时目录走 os.tmpdir()，跑完 rmSync。仓库自己的
 * node_modules / pnpm-lock.yaml 一个字都不碰 —— 这个模式答的是「这台机器
 * 装不装得上」，不是「把依赖加进项目」（那是 CEO/开发者的排期决定，不是探针该做的）。
 *
 * ⚠ 判据是【两步都过】：INSTALL_OK 且 IMPORT_OK。只装上不 import = 仍然不可用。
 */
const INSTALL_PROBE = process.argv.includes("--install-probe");
if (!INSTALL_PROBE) {
  console.log(
    "\n（上面那份【此刻没装】不等于【装不上】。复跑安装：node 本脚本 --install-probe，" +
      "它会往临时目录真装真 import，不碰本仓。）",
  );
} else {
  console.log("\n── 装得上吗（一次性临时目录，真 npm i + 真 import）──");
  const probes = missing.filter((r) => r.kind === "module");
  if (missing.length !== probes.length) {
    console.log(
      "  ⚠ 有 " +
        (missing.length - probes.length) +
        " 条是 CLI 型探测，本模式不装它们（装得上≠能跑出该任务要的东西）。",
    );
  }
  let installOk = 0;
  let importOk = 0;
  for (const r of probes) {
    const dir = mkdtempSync(join(tmpdir(), "opc-deps-probe-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "opc-deps-probe",
          private: true,
          type: "module",
        }) + "\n",
      );
      // specifier 可能是【子路径】（@modelcontextprotocol/sdk/client/index.js —— 这是
      // 本脚本故意的：真实 import 形状才测得出 exports 字段挡不挡）。npm i 只认包名，
      // 所以这里从 specifier 取包名去装（作用域包取前两段），import 时仍用【原 specifier】。
      const segs = r.spec.split("/");
      const pkgName = r.spec.startsWith("@")
        ? segs.slice(0, 2).join("/")
        : segs[0];
      const inst = spawnSync(
        "npm",
        ["i", "--ignore-scripts", "--no-audit", "--no-fund", pkgName],
        {
          cwd: dir,
          encoding: "utf8",
          shell: process.platform === "win32",
          timeout: 420_000,
        },
      );
      const installed = inst.status === 0;
      if (installed) installOk++;

      // 真 import：从那个临时目录里起一个 .mjs，import 的就是【上面那一条 specifier】。
      writeFileSync(
        join(dir, "probe.mjs"),
        "import(" +
          JSON.stringify(r.spec) +
          ").then(()=>console.log('IMPORT_OK')).catch((e)=>{console.log('IMPORT_FAIL '+e.message);process.exitCode=3;});\n",
      );
      const imp = spawnSync(process.execPath, [join(dir, "probe.mjs")], {
        cwd: dir,
        encoding: "utf8",
        timeout: 120_000,
      });
      const imported = (imp.stdout || "").includes("IMPORT_OK");
      if (imported) importOk++;

      console.log(
        "  " +
          r.spec.padEnd(44) +
          (installed ? "INSTALL_OK   " : "INSTALL_FAIL ") +
          (imported ? "IMPORT_OK" : "IMPORT_FAIL") +
          (installed
            ? ""
            : "  " +
              (inst.stdout + inst.stderr)
                .split(/\r?\n/)
                .filter((l) => l.includes("npm error"))
                .slice(0, 1)
                .join("")),
      );
    } finally {
      // Windows 上偶尔 EBUSY（有进程还握着句柄）：报出来而不是让整轮探针红。
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch (e) {
        console.log(
          "  ⚠ 临时目录没删掉（不影响读数）：" +
            dir +
            " " +
            String(e).slice(0, 60),
        );
      }
    }
  }
  console.log(
    "\n  可装 " +
      installOk +
      "/" +
      probes.length +
      " · 可装且可 import " +
      importOk +
      "/" +
      probes.length +
      "  ⇒ 【可装且可 import】的那些，「做不了」这句不成立。",
  );
}
