/**
 * 门禁住址对账：计划文档每一条验收行点名的文件路径，必须逐字存在。
 *
 * ── 为什么是这一格 ─────────────────────────────────────────────
 * 计划有 6 道 Phase 出口门禁，其中 3 条写着 `**Run**`。本轮把它们的**每一条**
 * 现数了一遍（`.workbuddy/round276-run-lines.ts`），结果是：验收行一共点名 6 条
 * 文件路径，其中 **5 条逐字不存在** —— 而这三条 Run 今天【跑起来是绿的】。
 *
 * 绿的原因是工具给的，不是住址对：`vitest run <路径>` 把参数当**子串过滤器**，
 * 不是当路径。实测（本轮）：
 *   · `test/acceptance/phase1-gates.test.ts` 这条路径 `ls` 都说不存在，
 *     `npx vitest run` 它却报 1 文件 / 13 发通过 —— 因为 `packages/hub/` 下有个同名文件。
 *   · 完全不存在的名字（`test/definitely/not/here.test.ts`）才 exit 1。
 * ⇒ **一条指向不存在文件的验收命令，可以长期绿**，而它绿的那一格是「碰巧有个同名文件」。
 *    仓库将来再多一个同名测试，这条命令就会静默地跑到别的文件上去。
 *
 * ── 为什么不把范围放成「计划里所有反引号路径」 ─────────────────
 * 现数：计划全文点名 116 条带扩展名的路径，逐字命中只有 27 条，另有 65 条
 * 「文件在，但住址从 `src/...` 搬到了 `packages/hub/src/...`」，24 条全仓查无此物。
 * ⇒ 拿这个口径做守卫 = 一条**恒红**的守卫，而本仓对这件事有明文结论：
 * 恒不可能通过的验收命令 = 恒红断言，恒红的东西会被当环境噪音关掉，比不写更坏
 * （0055 / 0056 / 0057 三连治的就是这个）。**计划是施工前的文档**，它的正文本来就该
 * 保留当时的布局；要钉的是【还要拿来当验收用】的那几行，不是历史叙述。
 *
 * ── 豁免怎么给 ────────────────────────────────────────────────
 * 计划里两道 Playwright 门（`test/e2e/ceo-loop.spec.ts` / `mobile-approval.spec.ts`）
 * 曾经【东西压根没建】—— 当时那两条既不能让它红（它一红就没人再看），
 * 也不能悄悄放过：豁免是一行显式的 `<!-- gate-path-not-built -->` 标记，
 * 写在同一块验收行里，且**条数只许减不许增**（上限在 .test.ts 里，同 lint 基线那张表）。
 * ⇒ 豁免是一个可数的账，不是一句散文。
 *
 * ⚠ 上面那句「当时没建」的**理由已经过期**，留在这儿而不是删掉，理由见下：
 * round291 建了 `test/e2e/ceo-loop.spec.ts` 与根 `playwright.config.ts`，
 * playwright/@playwright/test@1.65.1 进了根 devDependencies，`test/e2e/` 目录存在，
 * 全仓 `*.spec.ts` 从 0 变 1 ⇒ 「playwright 不在任何 package.json 里、目录不存在」
 * 这三句今天全是假的。这一段在本文件里躺了十几轮，没有任何一道门禁看见它过期 ——
 * 因为**判据读的是计划正文，不读自己的文件头**（round290 那条「为不存在的守卫作证」
 * 同形：证人写在注释里，注释没有读者）。
 * 今天真正还活着的豁免只有 **1 条**（`mobile-approval.spec.ts`，它要真飞书沙箱 + 真凭据）。
 * 那一条的成立条件消失时（有人真建了它），`.test.ts` 里那两条精确相等的断言会红，
 * 逼着人来摘标记 —— 与 round291 摘 ceo-loop 那一格同一剧本。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PLAN_PATH =
  "docs/superpowers/plans/2026-11-06-opc-os-development-plan.md";

/** 显式豁免标记：写在验收行同一块里，表示「这个路径对应的东西还没建」。 */
export const NOT_BUILT_TAG = "<!-- gate-path-not-built -->";

/**
 * 验收行 = 门禁「拿什么复核」的那几行。
 * 只认这三类前缀，是因为本轮实测只有这三类里会出现可执行的工件路径；
 * `**Commit**` / `**Gate**` 那些行点的是提交说明与流转，不指向文件。
 */
export const ACCEPTANCE_RE = /^\s*-+\s*\*\*(Run|Playwright E2E|E2E)\*\*/;

/** 一个反引号片段里的路径 token：含 `/`、以已知扩展名结尾、整段就是一个路径。 */
export const PATH_TOKEN_RE =
  /^(?:[\w.@-]+\/)+[\w.@-]+\.(?:ts|tsx|mjs|json|sql)$/;

/**
 * 从计划正文里取出验收行，连带它下面属于同一条目的续行。
 *
 * ⚠ 为什么要带续行：豁免标记和「这个文件不存在」那句说明，写在 Run 行的下一行
 * （markdown 的缩进续行）。只扫 Run 行本身，标记就看不见 ⇒ 那两条会红。
 * 这是【把豁免做成机器可读】时必须处理的一格，否则豁免形同虚设。
 */
export function acceptanceBlocks(
  planMarkdown: string,
): Array<{ lineNo: number; text: string }> {
  const lines = planMarkdown.split("\n");
  const out: Array<{ lineNo: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!ACCEPTANCE_RE.test(line)) continue;
    const block = [line];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      // 遇到下一个条目 / 标题 / 空行以外的块，就出了本条目。
      if (next.trim() === "") break;
      if (/^\s*-\s*\*\*/.test(next)) break;
      if (/^#{1,4}\s/.test(next)) break;
      block.push(next);
    }
    out.push({ lineNo: i + 1, text: block.join("\n") });
  }
  return out;
}

/** 一段文本里点名的路径 token（先去反引号外噪声，再按空白切）。 */
export function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const span of text.matchAll(/`([^`]+)`/g)) {
    for (const tok of (span[1] ?? "").split(/\s+/)) {
      if (PATH_TOKEN_RE.test(tok)) out.push(tok);
    }
  }
  return out;
}

export interface MissingGatePath {
  readonly lineNo: number;
  readonly path: string;
}

/**
 * 判据（纯函数）：验收行点名、但在语料里逐字不存在、且【没有】豁免标记的那些。
 *
 * ⚠ 反假绿：blocks 为空 ⇒ 一律红。计划改名 / 验收行前缀换了 ⇒ 什么都取不到，
 * 那时「0 条住址坏掉」是【什么都没读到】换来的。同族见 plan-refs.ts 那句哨兵。
 */
export function missingGatePaths(
  blocks: ReadonlyArray<{ lineNo: number; text: string }>,
  exists: (p: string) => boolean,
): MissingGatePath[] {
  if (blocks.length === 0) {
    return [{ lineNo: 0, path: "<计划里一条验收行都没解析到>" }];
  }
  const out: MissingGatePath[] = [];
  for (const b of blocks) {
    if (b.text.includes(NOT_BUILT_TAG)) continue;
    for (const p of pathTokens(b.text)) {
      if (!exists(p)) out.push({ lineNo: b.lineNo, path: p });
    }
  }
  return out;
}

/** 被豁免标掉的验收行（用来让豁免保持【可数】，而不是隐形）。 */
export function exemptedBlocks(
  blocks: ReadonlyArray<{ lineNo: number; text: string }>,
): Array<{ lineNo: number; paths: string[] }> {
  return blocks
    .filter((b) => b.text.includes(NOT_BUILT_TAG))
    .map((b) => ({ lineNo: b.lineNo, paths: pathTokens(b.text) }));
}

export function readPlan(root: string): string {
  const p = join(root, PLAN_PATH);
  if (!existsSync(p)) {
    throw new Error(
      "计划文档不在了：" +
        PLAN_PATH +
        " —— 本守卫宁可直接抛，也不拿『0 条住址坏掉』冒充通过。",
    );
  }
  return readFileSync(p, "utf8");
}
