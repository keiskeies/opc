/**
 * 「屏幕上教的命令必须真跑得通」守卫（round387，0073）。
 *
 * ── 守的是什么 ────────────────────────────────────────────────────
 * 操作者文案（看板横幅、--help、报错里的下一步）里出现的命令名。
 * round386 修的是「句子说错了事实」；这一族修的是「句子教了一条压根不存在的命令」：
 * app.js 的驱动器横幅教「手工 hub work」，实测 `pnpm hub work` 拿到的是
 * 「未知子命令：work（可用：run / status / resume）」退出 2 —— 人在终端前照抄，
 * 挫败被记在「这系统不行」头上。serve/config.ts 文件头早已写明这条纪律
 * （「用法文本的读者是人照着敲的，一条不存在的命令比少写一行更糟」），
 * 但它一直是散文纪律：同一批文件里 hub work / hub charter / hub-maintenance
 * 各还有一串，没有任何机械判据挡着。这一发把它落成守卫。
 *
 * ── 判据为什么是机械的，不是名单 ──────────────────────────────────
 * 「hub 是不是可执行名」不靠口味：packages/hub 是 private 且【没有 bin 字段】，
 * 系统里不存在 hub 这个命令 —— hub 只作为【pnpm 脚本名】存在（根 scripts 的
 * hub / hub:engine / hub:serve / hub:charter / hub:maintenance）。所以：
 *  · 空格形态 `hub <verb>` 前面必须跟着 `pnpm `，否则教的是不存在的可执行名；
 *  · `hub-maintenance` 这种连字符形态对照【真 scripts 键名】判 ——
 *    将来真注册了这个脚本，守卫自动放行，判据不依赖任何手抄名单。
 * verb 层（pnpm hub 后面那个词存不存在）不归静态扫描管：那要跑真解析器，
 * 放在测试里用 runEngineCli 当 oracle（work.test.ts 同款 import，已实测可导入）。
 *
 * ── 扫描面为什么只有字符串行 ──────────────────────────────────────
 * 注释里的 `hub work` 是给开发者讲历史（0041/0043 的论证本体），不是给人照抄的；
 * 把人会照抄的行（含引号的代码行）与开发者散文分开，判据才不需要一串豁免。
 */

/** 一个被扫描的源文件：路径用仓库相对形式，违规报告才指得回源码。 */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** 一条违规：文件、行号（1 起）、命中的命令形态。 */
export interface CmdViolation {
  readonly file: string;
  readonly line: number;
  readonly token: string;
}

/**
 * 空格形态：`hub <verb>`。verb 名单是【已知的坑】而不是封闭集 ——
 * 判定不靠名单兜底（名单外的 `hub 新verb` 同样先命中 `\bhub ` 前缀形态再被
 * 下方正则放行？不放行：这里刻意保留名单，因为裸形态里真正要挡的是
 * 「脚本名 + 子命令」这串形状；将来新增子命令文案时名单漏项的代价是
 * 守卫测试的变异段先红，比静默漏过便宜）。
 */
const SPACED =
  /\bhub (run|status|resume|work|decide|serve|charter|maintenance)\b/gu;

/** 连字符形态：历史上 maintenance 的用法文本自称 `hub-maintenance`（真脚本是 hub:maintenance）。 */
const HYPHENED = /\bhub-maintenance\b/gu;

/**
 * 脚本名形态：`hub:engine` / `hub:serve` / `hub:charter` / `hub:maintenance`，
 * 以及【看着像入口而其实没有的】`hub:work`。判据两条都要成立：前面是 `pnpm `，
 * 且【根 scripts 真有那个键】—— 只查前缀会放行 `pnpm hub:work`（没有这个脚本），
 * 只查键名会放行不带 pnpm 的 `hub:engine work`。两条各挡一半，合起来才是「跑得通」。
 */
const SCRIPTED = /\bhub:[a-z][a-z0-9-]*/gu;

/** 注释行（JSDoc 的 `*`、行首 `//`、块起 `/*`）不计 —— 见文件头第三条。 */
export function isCommentLine(line: string): boolean {
  return /^\s*(\*|\/\/|\/\*)/u.test(line);
}

/** 命中位置前面是否正好跟着 `pnpm `。 */
function precededByPnpm(line: string, idx: number): boolean {
  return line.slice(Math.max(0, idx - 5), idx) === "pnpm ";
}

/**
 * 扫一个文件里的【非注释行】。`pnpm ` 紧跟其后的空格形态合法（hub 是脚本名）；
 * hub-maintenance 只有在【根 scripts 真有同名键】时才合法。
 */
export function findBareHubCommands(
  src: SourceFile,
  scriptKeys: ReadonlySet<string>,
): CmdViolation[] {
  const out: CmdViolation[] = [];
  const lines = src.text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (isCommentLine(line)) continue;
    for (const re of [SPACED, HYPHENED, SCRIPTED]) {
      re.lastIndex = 0;
      let m = re.exec(line);
      while (m !== null) {
        const idx = m.index;
        const token = m[0];
        const ok =
          token === "hub-maintenance"
            ? scriptKeys.has("hub-maintenance")
            : token.startsWith("hub:")
              ? precededByPnpm(line, idx) && scriptKeys.has(token)
              : precededByPnpm(line, idx);
        if (!ok) out.push({ file: src.path, line: i + 1, token });
        m = re.exec(line);
      }
    }
  }
  return out;
}

/**
 * cli.ts 的 VERBS 与它的用法文本是【同一件事的两个源】—— 改一边忘另一边
 * 正是 round387 抓到的病形（文案说 work，解析器只认 run/status/resume）。
 * 判据：VERBS 里每个 verb，cli.ts 的源码文本里必须有对应的 `pnpm hub <verb>`。
 */
export function findVerbUsageDrift(cliText: string): string[] {
  const decl = /const VERBS: readonly Verb\[\] = \[([^\]]*)\]/u.exec(cliText);
  if (decl === null) return ["VERBS 声明找不到了（改形状请连本守卫一起改）"];
  const verbs = [...(decl[1] as string).matchAll(/"([a-z]+)"/gu)].map(
    (m) => m[1] as string,
  );
  return verbs.filter((v) => !cliText.includes("pnpm hub " + v));
}
