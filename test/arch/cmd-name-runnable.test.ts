/**
 * cmd-name-runnable 守卫的测试（判据在 cmd-name-runnable.ts，理由写在那儿）。
 *
 * 四段，各挡各的：
 *  ① 真仓库今天干净 —— 操作者文案里没有一条裸的 `hub <verb>` / `hub-maintenance`。
 *  ② 判据自己承重 —— 把每形态各造一条合成违规喂进去，必须报（不报的判据是装饰）。
 *  ③ verb 层拿【真解析器】当 oracle —— 不再手抄「哪条命令存在」：
 *     runEngineCli 是唯一权威，它认 work/decide，那么文案里 work/decide 合法；
 *     cli.ts 的 VERBS 是 run/status/resume，那么 `hub work` 在 cli.ts 那一头必红。
 *     跑的是【进程内】调用：不建库、不起子进程、不花钱（0073 §3）。
 *  ④ VERBS 与用法文本不许各说各话（round387 病形：文案说 work，解析器只认三条）。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEngineCli } from "../../packages/hub/src/engine/hub-work.js";
import {
  findBareHubCommands,
  findVerbUsageDrift,
  isCommentLine,
  type SourceFile,
} from "./cmd-name-runnable.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** 会被操作者照抄的那批源文件（看板 + Hub 的用法/报错文案所在地）。 */
const OPERATOR_FILES: readonly string[] = [
  "packages/web/public/app.js",
  "packages/hub/src/cli.ts",
  "packages/hub/src/serve/config.ts",
  "packages/hub/src/serve/assemble.ts",
  "packages/hub/src/serve/driver-pump.ts",
  "packages/hub/src/serve/charter-pump.ts",
  "packages/hub/src/engine/work.ts",
  "packages/hub/src/engine/driver.ts",
  "packages/hub/src/engine/dispatch.ts",
  "packages/hub/src/charter/seed.ts",
  "packages/hub/src/heartbeat/maintenance.ts",
];

const scriptKeys = (): ReadonlySet<string> => {
  const pkg = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  return new Set(Object.keys(pkg.scripts));
};

const scanAll = (): SourceFile[] =>
  OPERATOR_FILES.map((p) => ({ path: p, text: read(p) }));

describe("① 操作者文案：今天一条不存在的命令都不教", () => {
  it("扫描面非空（取材没坏：漏扫会让 ① 恒绿）", () => {
    const files = scanAll();
    expect(files.length).toBe(OPERATOR_FILES.length);
    for (const f of files) {
      expect(f.text.length).toBeGreaterThan(500);
    }
    // 锚点：app.js 的横幅确实在扫描面里（round387 的案发地）
    expect(read("packages/web/public/app.js")).toContain(
      "要自动推进请带 --driver-pump 起 Hub",
    );
  });

  it("⭐ 非注释行里没有裸 `hub <verb>`，也没有 hub-maintenance", () => {
    const hits = scanAll().flatMap((f) => findBareHubCommands(f, scriptKeys()));
    expect(
      hits.map((h) => `${h.file}:${h.line} ⇒ ${h.token}`),
      "操作者会照抄的行里出现了跑不通的命令名（要么补 pnpm 前缀，要么改成真脚本名）",
    ).toEqual([]);
  });

  it("hub 只是【脚本名】而不是可执行名：private 且无 bin ⇒ 判据的前提成立", () => {
    const pkg = JSON.parse(read("packages/hub/package.json")) as {
      private?: boolean;
      bin?: unknown;
    };
    expect(pkg.private).toBe(true);
    expect(pkg.bin).toBeUndefined();
  });

  it("根 scripts 里有 hub / hub:engine / hub:serve / hub:charter / hub:maintenance", () => {
    const keys = scriptKeys();
    for (const k of [
      "hub",
      "hub:engine",
      "hub:serve",
      "hub:charter",
      "hub:maintenance",
    ]) {
      expect(keys.has(k), `缺脚本 ${k}`).toBe(true);
    }
    // 反向：hub:work / hub:decide 这种【看着像入口】的键不存在 ⇒ 文案只能写
    // `pnpm hub:engine work`，不能写成 `pnpm hub:work`（后者跑不通）。
    expect(keys.has("hub:work")).toBe(false);
    expect(keys.has("hub:decide")).toBe(false);
  });

  it("⭐ 反向自证：把 app.js 横幅改回案发那天的写法 ⇒ 判据抓到那一行", () => {
    // 这一发是本守卫的存在理由：它必须能抓到【真发生过的那次】，而不是只挡住
    // 合成字符串。只在内存里改串，不碰盘（碰盘的变异归变异机管）。
    const app = read("packages/web/public/app.js");
    const rolled = app.replace(
      "或手工跑 pnpm hub:engine work。",
      "或手工跑 hub work。",
    );
    expect(rolled).not.toBe(app); // 替换没落空：说明当前文案确实是修好的那一版
    const hits = findBareHubCommands(
      { path: "packages/web/public/app.js", text: rolled },
      scriptKeys(),
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.token).toBe("hub work");
    // 行号必须指回今天那一行附近（同文件同行改串，行号不变）
    const today = findBareHubCommands(
      { path: "packages/web/public/app.js", text: app },
      scriptKeys(),
    );
    expect(today).toEqual([]);
  });

  it("扫描面里确实有注释行的 hub work（② 那条豁免判据不是空转）", () => {
    // 反向确认扫描面【确实】有注释行 —— 没有注释的话这条判据是空转。
    const withComments = scanAll().filter((f) =>
      f.text
        .split(/\r?\n/u)
        .some((l) => isCommentLine(l) && /\bhub (work|run|resume)\b/u.test(l)),
    );
    expect(withComments.length).toBeGreaterThan(0);
  });
});

describe("② 判据承重：每形态各有一发自己的动作", () => {
  const keyset = (): ReadonlySet<string> => scriptKeys();

  it("裸 `hub work` ⇒ 报", () => {
    const hits = findBareHubCommands(
      { path: "x.ts", text: '  io.error("或手工 hub work。");' },
      keyset(),
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.token).toBe("hub work");
    expect(hits[0]?.line).toBe(1);
  });

  it("`pnpm hub work` ⇒ 不报（合法形态真能放行，判据不是恒红装饰）", () => {
    expect(
      findBareHubCommands(
        { path: "x.ts", text: '  io.error("或手工 pnpm hub:engine work。");' },
        keyset(),
      ),
    ).toEqual([]);
  });

  it("注释行不计：开发者散文里的 hub work 不是给人照抄的", () => {
    const src = {
      path: "x.ts",
      text: ["// 旧文案教 hub work，那是假的", "* hub decide 的参数。"].join(
        "\n",
      ),
    };
    expect(isCommentLine("// a")).toBe(true);
    expect(isCommentLine(" * b")).toBe(true);
    expect(isCommentLine('  io.error("hub work");')).toBe(false);
    expect(findBareHubCommands(src, keyset())).toEqual([]);
  });

  it("hub-maintenance ⇒ 报；真注册同名脚本后自动放行（判据不靠手抄名单）", () => {
    const src = { path: "m.ts", text: '"用法：hub-maintenance --db <path>",' };
    expect(findBareHubCommands(src, new Set(["hub:maintenance"])).length).toBe(
      1,
    );
    expect(
      findBareHubCommands(src, new Set(["hub:maintenance", "hub-maintenance"])),
    ).toEqual([]);
  });

  it("同一行两条 ⇒ 两条都报（漏一条就是静默失效）", () => {
    expect(
      findBareHubCommands(
        { path: "x.ts", text: '  s = "hub work 或 hub decide 都行";' },
        keyset(),
      ).length,
    ).toBe(2);
  });

  it("脚本名形态的两半各有一发：缺 pnpm ⇒ 报；pnpm 但键名不存在 ⇒ 报", () => {
    // 这两发各挡判据的一半边，缺任一半都有真实漏法：
    //  · 只查键名 ⇒ 放行 `hub:engine work`（系统里没这个可执行名，照抄必挂）；
    //  · 只查 pnpm ⇒ 放行 `pnpm hub:work`（看着像入口而根 scripts 里没这个键）。
    const keys = keyset();
    const bare = findBareHubCommands(
      { path: "x.ts", text: '  u("再推一次 hub:engine work 即可");' },
      keys,
    );
    expect(bare.length).toBe(1);
    expect(bare[0]?.token).toBe("hub:engine");
    const ghost = findBareHubCommands(
      { path: "x.ts", text: '  u("用法：pnpm hub:work --db <path>");' },
      keys,
    );
    expect(ghost.length).toBe(1);
    expect(ghost[0]?.token).toBe("hub:work");
    // 反向对照：真键 + pnpm ⇒ 放行（判据不是见到 hub: 就红）
    expect(
      findBareHubCommands(
        {
          path: "x.ts",
          text: '  u("用法：pnpm hub:engine work --db <path>");',
        },
        keys,
      ),
    ).toEqual([]);
  });
});

describe("③ verb 层：以【真解析器】为 oracle，不手抄命令名单", () => {
  /** 指向不存在的库 ⇒ 不建库、不起子进程；只看 verb 那一层认不认。 */
  const probe = async (
    verb: string,
  ): Promise<{ code: number; kind: string }> => {
    let err = "";
    let out = "";
    const r = await runEngineCli([verb, "--db", ".workbuddy/scratch/none.db"], {
      write: (t) => {
        out += t;
      },
      error: (t) => {
        err += t;
      },
    });
    const kind = err.includes("没有 [")
      ? "unknown-verb"
      : err.includes("数据库文件不存在") || err.includes("缺参数")
        ? "recognized"
        : `other:${(err || out).slice(0, 60)}`;
    return { code: r.code, kind };
  };

  it("解析器【认得】work 与 decide ⇒ 文案里那两条是对的", async () => {
    for (const v of ["work", "decide"]) {
      const p = await probe(v);
      expect(p.kind, `hub:engine ${v}`).toBe("recognized");
    }
  });

  it("⭐ 解析器【不认】run/status/resume ⇒ 那三条的家在 cli.ts，不在 hub:engine", async () => {
    for (const v of ["run", "status", "resume"]) {
      const p = await probe(v);
      expect(p.kind, `hub:engine ${v}`).toBe("unknown-verb");
      expect(p.code).toBe(2);
    }
  });

  it("app.js 横幅教的正是解析器认得的那一条", async () => {
    const line = read("packages/web/public/app.js")
      .split(/\r?\n/u)
      .find((l) => l.includes("要自动推进请带 --driver-pump 起 Hub"));
    expect(line).toBeDefined();
    expect(line).toContain("pnpm hub:engine work");
    expect(line).not.toMatch(/(?<!pnpm )hub work/u);
    // 教的这一条，verb 层由解析器当场背书
    expect((await probe("work")).kind).toBe("recognized");
  });
});

describe("④ VERBS 与用法文本同一口径", () => {
  it("⭐ cli.ts 每条 VERBS 都在自己的用法文本里（带 pnpm 前缀）", () => {
    expect(findVerbUsageDrift(read("packages/hub/src/cli.ts"))).toEqual([]);
  });

  it("承重：VERBS 加一条而用法文本不动 ⇒ 报", () => {
    const drifted = read("packages/hub/src/cli.ts").replace(
      'const VERBS: readonly Verb[] = ["run", "status", "resume"];',
      'const VERBS: readonly Verb[] = ["run", "status", "resume", "replay"];',
    );
    expect(drifted).not.toBe(read("packages/hub/src/cli.ts"));
    expect(findVerbUsageDrift(drifted)).toEqual(["replay"]);
  });

  it("承重：VERBS 声明被改名 ⇒ 报，而不是静默返回空", () => {
    expect(findVerbUsageDrift('const VERB_LIST = ["run"];')).toEqual([
      "VERBS 声明找不到了（改形状请连本守卫一起改）",
    ]);
  });
});

/* 覆盖面到此为止的说明：本守卫只判【命令名可跑】。round386 那条「POST /budget
   改不动分母」是【句子说错事实】，不是【命令名不存在】，两件事的权威源不同
   （前者是 SQL 语义，后者是解析器 + scripts 键名），硬并成一条判据会得到一个
   两头都不承重的混合体。路由面另有一族守卫（API_ENDPOINTS / IMPLEMENTED_ENDPOINTS）
   在管，别在这里重复登记一份会漂移的名单。 */
