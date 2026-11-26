/**
 * 紧凑化刻度守卫 —— round379 把全站留白收了一档，这份文件钉的是【收完之后的相对关系】。
 *
 * ── 为什么值得单独一份 ──────────────────────────────────────────
 * 那一轮改完，e2e 56 发全绿、原样不变 —— 这恰好说明【没有任何一发测试承重这些关系】：
 * 改动没撞上判据，因为判据里根本没有这几维。而紧凑化最容易复发的不是「改坏了」，
 * 是【下一轮把它悄悄改回去】：某处嫌挤就把 860 档 padding 调回 18px、给 .card 加回 16、
 * 或者把 --topbar-height 重新写成字面值。这些动作全都不会让任何现有测试变红。
 *
 * ── 尺子取的是【关系】，再加一道【单向】刻度闸 ───────────────────
 * 断言 `.page { padding: 16px 20px 32px }` 等于把本轮的取值钉死，下一轮换档必红，
 * 于是又得回来改判据（round377 那条教训：判据里写死的字面几何值，在「值本身可改」的
 * 轮次里必红）。所以 ①~⑥ 一条都不钉具体像素，钉的是本轮注释里真正立起来的六条不变式：
 *   ① 顶栏高度只有一个来源：:root 的 --topbar-height 被 .topbar 与 .workspace 两处消费，
 *      任何一处退回字面 px 就红（抄常数时代谢掉的病：两边各抄一个数，半改看不见）。
 *   ② 断点只能越窄越紧：base ≥ 860 ≥ 640 逐位单调，且至少一处严格变小。
 *      「越小越松」不是笔误就是漏改，而它只在窄屏上出现，没人会专门去量。
 *   ③ 卡片内部 ≥ 卡片之间：内距小于外距时圆角块读起来是散点而不是一张卡。
 *   ④ 页边距 > 卡片之间：整页留白必须比块与块之间的缝更松，否则页面贴边。
 *   ⑤ 「块 ↔ 下一块」是同一个语义，只许一个值：页头/英雄区/页签/横幅的 margin-bottom 全等；
 *      相邻卡的 margin-top 则必须【严格小于】它 —— 前者分段、后者分组，两层缝合成一个数
 *      就没有层次。谁单独挪一档，层次立刻变成噪声。
 *   ⑥ 选中条跟着条目内距走：.selected::before 的 top/bottom 相对纵向内距【对称且内缩
 *      0~4px】—— 它是按内距定位的标记，内距改了它不跟着改就会探出条目或塌成 0 高。
 *      真值是「内距 − 1」，所以这里刻意不钉「等于内距」（那会把当前正确的取值判红）。
 * 另加一条只读守卫：⑦ 空态地板不许往下挪。用户 2026-11-26 明确「保留空态卡，只收外围」，
 * 所以 .state / .board-column 的 min-height 只许变大、不许变小 —— 单向着色，正是地板该有的判据形状。
 *
 * ── 为什么关系判据之外还要 ⑧⑨ 两道绝对闸 ────────────────────────
 * ①~⑥ 对【整体等比放松】天然失明：把每一格一起放大，单调仍成立、内距仍≥外距、块缝仍全等。
 *  ⑧ 钉顶部那一条合计 ≤ 28px（每一路由都占的公共成本）；⑨ 是一张【单向】刻度上限表 ——
 *  只许往回收、往回放才红，动表的唯一正当写法是在那一行写下理由。两者都不与 round377 那条
 *  教训冲突：钉死【取值】会让下一轮正常换档必红，钉死【上限】只挡住倒退。
 *
 * ── 每条都配合成反对照 ─────────────────────────────────────────
 * 提取器（洗注释 → 花括号定深度 → 解析 media 语境 → 解析多值 padding → 解 var()）
 * 坏得太彻底时守卫会常绿。所以每条判据都是 src => string[] 的纯函数：先在【故意做坏】的
 * 合成 CSS 上证明它能报出问题，再信它对真文件报 0。同 space-scale / color-scale 的路子。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const GROUP_CSS = join(REPO, "packages/web/public", "group.css");

/** 一条叶子规则：选择器、它所处的 @media 条件、声明体、起始行号。 */
type Rule = {
  selector: string;
  scope: string;
  body: string;
  line: number;
};

/** 四值盒（padding / margin 的简写展开）。 */
type Box = { top: number; right: number; bottom: number; left: number };

/** 简写的四个边名 —— 键类型保住，别拿裸 string 去索引 Box。 */
const SIDES: (keyof Box)[] = ["top", "right", "bottom", "left"];

/**
 * 注释洗成等长空格。为什么不等长就不行：守卫报的是行号，洗一次注释把后面全体上移，
 * 行号就对不上现场，而判据照样「绿」。
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (const ch of text.slice(i, stop)) out += ch === "\n" ? "\n" : " ";
      i = stop;
    } else {
      out += text[i] ?? "";
      i += 1;
    }
  }
  return out;
}

/**
 * 扫出所有叶子规则并带上 @media 语境。只取叶子（选择器与声明体里都不含花括号），
 * 所以 @media 块里的真规则会带条件、@keyframes 的百分号步会被选择器过滤掉。
 */
function leafRules(text: string): Rule[] {
  const src = stripComments(text);
  const out: Rule[] = [];
  const stack: { cond: string; depth: number }[] = [];
  let depth = 0;
  let header = "";
  let firstCharLine = 1;
  let sawChar = false;
  let inRule = false;
  let ruleDepth = 0;
  let ruleSel = "";
  let ruleLine = 1;
  let scope = "";
  let body = "";
  let line = 1;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] ?? "";
    if (ch === "\n") {
      line += 1;
      if (inRule) body += "\n";
      else header += " ";
      continue;
    }
    if (ch === "{") {
      const h = header.replace(/\s+/gu, " ").trim();
      depth += 1;
      if (/^@media\b/u.test(h)) {
        stack.push({ cond: h.replace(/^@media\s*/u, ""), depth });
      } else if (h.startsWith("@")) {
        // 其它 at-rule：进栈但不当成 media 语境（否则 @supports 里的规则会被打上假标签）
        stack.push({ cond: "", depth });
      } else {
        inRule = true;
        ruleDepth = depth;
        ruleSel = h;
        ruleLine = firstCharLine;
        scope =
          stack
            .map((s) => s.cond)
            .filter((c) => c !== "")
            .join(" && ") || "(base)";
        body = "";
      }
      header = "";
      sawChar = false;
      continue;
    }
    if (ch === "}") {
      if (inRule && ruleDepth === depth) {
        out.push({ selector: ruleSel, scope, body, line: ruleLine });
        inRule = false;
      }
      while (stack.length > 0 && stack[stack.length - 1]?.depth === depth)
        stack.pop();
      depth -= 1;
      header = "";
      sawChar = false;
      continue;
    }
    if (inRule) body += ch;
    else {
      if (!sawChar && !/\s/u.test(ch)) {
        firstCharLine = line;
        sawChar = true;
      }
      header += ch;
    }
  }
  return out;
}

/** :root（以及任何规则里）的自定义属性 → 值。后出现的覆盖先出现的。 */
function tokensOf(rules: Rule[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const rule of rules) {
    for (const m of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/gu)) {
      const name = m[1];
      const value = m[2];
      if (name !== undefined && value !== undefined)
        map.set(name, value.trim());
    }
  }
  return map;
}

/** 把 var(--x) 换成值，最多解 6 层；解不动就返回 null（宁红不猜）。 */
function resolveValue(
  value: string,
  tokens: Map<string, string>,
): string | null {
  let cur = value.trim();
  for (let round = 0; round < 6; round += 1) {
    if (!cur.includes("var(")) return cur;
    const next = cur.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/gu,
      (_all, name: string, fallback?: string) => {
        const hit = tokens.get(name);
        if (hit !== undefined) return hit;
        return fallback ?? "";
      },
    );
    if (next === cur) return null;
    cur = next.trim();
  }
  return null;
}

/** 单个 px 字面值；不是纯 px 就返回 null。 */
function pxOf(value: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)px\s*$/u.exec(value);
  const head = m?.[1];
  return head === undefined ? null : Number(head);
}

/** 展开 1~4 值的简写。空串与超 4 值返回 null —— 让它返回全 0 会把「读不到」伪装成「读到 0」。 */
function boxOf(value: string): Box | null {
  const parts = value
    .trim()
    .split(/\s+/u)
    .filter((p) => p !== "");
  if (parts.length === 0 || parts.length > 4) return null;
  const nums = parts.map((p) => pxOf(p));
  if (nums.some((n) => n === null)) return null;
  const top = nums[0] ?? 0;
  if (parts.length === 1) return { top, right: top, bottom: top, left: top };
  const right = nums[1] ?? top;
  if (parts.length === 2) return { top, right, bottom: top, left: right };
  const bottom = nums[2] ?? top;
  if (parts.length === 3) return { top, right, bottom, left: right };
  const left = nums[3] ?? right;
  return { top, right, bottom, left };
}

/** 取某选择器在某语境下的声明体；不唯一或不存在就把问题写进 problems（不静默跳过）。 */
function declarations(
  rules: Rule[],
  selector: string,
  scope: string,
  problems: string[],
): Map<string, string> {
  const hits = rules.filter(
    (r) => r.selector === selector && r.scope === scope,
  );
  if (hits.length !== 1) {
    problems.push(
      `规则「${selector}」在语境 ${scope} 命中 ${hits.length} 条（需要恰好 1 条）`,
    );
    return new Map();
  }
  const body = hits[0]?.body ?? "";
  const map = new Map<string, string>();
  for (const m of body.matchAll(/([-\w]+)\s*:\s*([^;]+)/gu)) {
    const k = m[1];
    const v = m[2];
    if (k !== undefined && v !== undefined) map.set(k.trim(), v.trim());
  }
  return map;
}

/** 解析并读一个属性；缺失或解不出 px 都记问题。 */
function readPx(
  rules: Rule[],
  tokens: Map<string, string>,
  selector: string,
  scope: string,
  prop: string,
  problems: string[],
): number | null {
  const decl = declarations(rules, selector, scope, problems).get(prop);
  if (decl === undefined) {
    problems.push(`规则「${selector}」（${scope}）没有 ${prop}`);
    return null;
  }
  const resolved = resolveValue(decl, tokens);
  if (resolved === null) {
    problems.push(`「${selector}」的 ${prop} 解不开 var()：${decl}`);
    return null;
  }
  const n = pxOf(resolved);
  if (n === null) {
    problems.push(`「${selector}」的 ${prop} 不是 px 字面量：${resolved}`);
    return null;
  }
  return n;
}

/** ① 顶栏高度的唯一来源。 */
function topbarSingleSource(src: string): string[] {
  const problems: string[] = [];
  const rules = leafRules(src);
  const tokens = tokensOf(rules);
  const tokenValue = tokens.get("--topbar-height");
  if (tokenValue === undefined) {
    problems.push(":root 里没有 --topbar-height");
    return problems;
  }
  const declared = pxOf(tokenValue);
  if (declared === null)
    problems.push(`--topbar-height 不是 px：${tokenValue}`);
  const topbar = declarations(rules, ".topbar", "(base)", problems).get(
    "height",
  );
  if (topbar !== undefined) {
    if (pxOf(topbar) !== null)
      problems.push(`.topbar 的 height 又写成字面 px：${topbar}`);
    if (resolveValue(topbar, tokens) !== tokenValue)
      problems.push(`.topbar 的 height 不等于 --topbar-height：${topbar}`);
  } else problems.push(".topbar 没有 height");
  const ws = declarations(rules, ".workspace", "(base)", problems).get(
    "height",
  );
  if (ws === undefined) problems.push(".workspace 没有 height");
  else {
    if (pxOf(ws) !== null)
      problems.push(`.workspace 的 height 写成字面 px：${ws}`);
    if (!ws.includes("var(--topbar-height)"))
      problems.push(`.workspace 的 height 没消费 --topbar-height：${ws}`);
    if (/\d+(?:\.\d+)?px/u.test(ws))
      problems.push(`.workspace 的 calc 里还留着 px 字面量：${ws}`);
  }
  return problems;
}

/** ② 断点越窄越紧。 */
function breakpointMonotonic(src: string): string[] {
  const problems: string[] = [];
  const rules = leafRules(src);
  const tokens = tokensOf(rules);
  const bands: { label: string; scope: string }[] = [
    { label: "base", scope: "(base)" },
    { label: "860", scope: "(max-width: 860px)" },
    { label: "640", scope: "(max-width: 640px)" },
  ];
  const boxes: { label: string; box: Box }[] = [];
  for (const band of bands) {
    const decl = declarations(rules, ".page", band.scope, problems).get(
      "padding",
    );
    if (decl === undefined) continue;
    const resolved = resolveValue(decl, tokens);
    const box = resolved === null ? null : boxOf(resolved);
    if (box === null) {
      problems.push(`.page 在 ${band.scope} 的 padding 解析失败：${decl}`);
      continue;
    }
    boxes.push({ label: band.label, box });
  }
  if (boxes.length !== bands.length) {
    problems.push(
      `.page 的三档 padding 只解析出 ${boxes.length} 档（需要 base/860/640 三档）`,
    );
    return problems;
  }
  let anyStrict = false;
  for (let i = 1; i < boxes.length; i += 1) {
    const prev = boxes[i - 1];
    const cur = boxes[i];
    if (prev === undefined || cur === undefined) continue;
    for (const side of SIDES) {
      if (cur.box[side] > prev.box[side])
        problems.push(
          `越窄反而越松：${cur.label} 的 padding-${side} = ${cur.box[side]}px > ${prev.label} 的 ${prev.box[side]}px`,
        );
      if (cur.box[side] < prev.box[side]) anyStrict = true;
    }
  }
  if (!anyStrict)
    problems.push("三档 padding 完全相等 ⇒ 断点根本没在收紧凑，档位是摆设");
  return problems;
}

/** ③④ 内距 / 块间距 / 页边距的松紧次序。 */
function tightnessOrder(src: string): string[] {
  const problems: string[] = [];
  const rules = leafRules(src);
  const tokens = tokensOf(rules);
  const inner = readPx(rules, tokens, ".card", "(base)", "padding", problems);
  const gapDecl = declarations(rules, ".card + .card", "(base)", problems).get(
    "margin-top",
  );
  const gap = gapDecl === undefined ? null : pxOf(gapDecl);
  if (gapDecl !== undefined && gap === null)
    problems.push(`.card + .card 的 margin-top 不是 px：${gapDecl}`);
  const pageDecl = declarations(rules, ".page", "(base)", problems).get(
    "padding",
  );
  const pageBox =
    pageDecl === undefined ? null : boxOf(resolveValue(pageDecl, tokens) ?? "");
  if (inner !== null && gap !== null && inner < gap)
    problems.push(
      `卡片内距 ${inner}px 小于卡片之间 ${gap}px ⇒ 圆角块读起来是散点，不是卡`,
    );
  if (pageBox !== null && gap !== null && pageBox.left <= gap)
    problems.push(
      `页边距 ${pageBox.left}px 不大于卡片之间 ${gap}px ⇒ 内容贴到视口边，页面没有留白层`,
    );
  return problems;
}

/** ⑤「块 ↔ 下一块」只许一个值。 */
function blockGapUniform(src: string): string[] {
  const problems: string[] = [];
  const rules = leafRules(src);
  const tokens = tokensOf(rules);
  const readers: { selector: string; prop: string }[] = [
    { selector: ".page-header", prop: "margin-bottom" },
    { selector: ".detail-hero", prop: "margin-bottom" },
    { selector: ".tabs", prop: "margin-bottom" },
    { selector: ".banner", prop: "margin-bottom" },
    { selector: ".group-workspace-heading", prop: "margin-bottom" },
  ];
  const seen = new Map<number, string>();
  for (const reader of readers) {
    const value = readPx(
      rules,
      tokens,
      reader.selector,
      "(base)",
      reader.prop,
      problems,
    );
    if (value === null) continue;
    const owner = seen.get(value);
    if (owner === undefined) seen.set(value, reader.selector);
  }
  if (seen.size > 1)
    problems.push(
      `「块 ↔ 下一块」有 ${seen.size} 种取值：${[...seen.entries()].map(([v, s]) => `${v}px←${s}`).join(" ")} ⇒ 同一语义两种缝，层次读成噪声`,
    );
  // 相邻卡是【同组内】的缝，必须【严格小于】块与块的缝 —— 这正是 round379 把它单独定在
  // 8 而块缝留 12 的理由：读图时「贴在一起的两张卡」与「分成两段」是两件事。
  const cardGapDecl = declarations(
    rules,
    ".card + .card",
    "(base)",
    problems,
  ).get("margin-top");
  const cardGap = cardGapDecl === undefined ? null : pxOf(cardGapDecl);
  if (cardGap !== null && seen.size === 1) {
    const blockGap = [...seen.keys()][0] ?? 0;
    if (cardGap >= blockGap)
      problems.push(
        `相邻卡 ${cardGap}px 不小于块缝 ${blockGap}px ⇒ 卡组与分块读起来是同一层，分组信息消失`,
      );
  }
  return problems;
}

/** ⑥ 选中条跟着条目纵向内距走。 */
function markerTracksPadding(src: string): string[] {
  const problems: string[] = [];
  const rules = leafRules(src);
  const tokens = tokensOf(rules);
  const itemDecl = declarations(
    rules,
    ".conversation-item",
    "(base)",
    problems,
  ).get("padding");
  const item =
    itemDecl === undefined ? null : boxOf(resolveValue(itemDecl, tokens) ?? "");
  if (itemDecl !== undefined && item === null)
    problems.push(`.conversation-item 的 padding 解析失败：${itemDecl}`);
  const marker = declarations(
    rules,
    ".conversation-item.selected::before",
    "(base)",
    problems,
  );
  const top =
    marker.get("top") === undefined ? null : pxOf(marker.get("top") ?? "");
  const bottom =
    marker.get("bottom") === undefined
      ? null
      : pxOf(marker.get("bottom") ?? "");
  if (item === null || top === null || bottom === null) {
    if (item !== null)
      problems.push("选中条的 top/bottom 读不到 px，无法与内距对照");
    return problems;
  }
  // 真值是「内距 − 1」：标记比条目盒子上下各短 1px，才读得出它是【贴在文字块旁边的一道】
  // 而不是通顶通底的一条。所以判据不能钉「等于内距」—— 那会把当前正确的 7/8 判红。
  // 钉的是这条关系里真正不可破坏的两件事：① 上下【对称】（不对称就是视觉重心偏移）；
  // ② 内缩落在 0~4px 这一小带内（> 内距会塌成 0 高、为负则通顶通底）。
  if (top !== bottom)
    problems.push(`选中条 top ${top}px 与 bottom ${bottom}px 不对称`);
  const relief = item.top - top;
  if (relief < 0 || relief > 4)
    problems.push(
      `选中条内缩 ${relief}px 不在 0~4 带内（条目纵向内距 ${item.top}px）⇒ 标记探出条目或塌成 0 高`,
    );
  return problems;
}

/**
 * ⑦ 空态地板只许变大（用户 2026-11-26 拍板：保留空态卡，只收外围）。
 * required 由调用方给：真文件两枚地板都必须存在（整条 min-height 被删 = 地板消失，
 * 也是违规）；合成反对照只造它关心的那一枚。不能写成「读不到就放过」—— 那等于把
 * 「把 min-height 整条删掉」这条最省事的回退路留成常绿。
 */
function emptyStateFloorsKept(src: string, required: string[]): string[] {
  const problems: string[] = [];
  const rules = leafRules(src);
  const tokens = tokensOf(rules);
  const FLOOR = 200;
  for (const selector of required) {
    const decl = declarations(rules, selector, "(base)", problems).get(
      "min-height",
    );
    if (decl === undefined) {
      problems.push(`${selector} 没有 min-height ⇒ 空态地板整条消失`);
      continue;
    }
    const resolved = resolveValue(decl, tokens);
    const n = resolved === null ? null : pxOf(resolved);
    if (n === null) {
      problems.push(`${selector} 的 min-height 读不到 px：${decl}`);
      continue;
    }
    if (n < FLOOR)
      problems.push(
        `${selector} 的 min-height 被压到 ${n}px（< ${FLOOR}）⇒ 空态卡塌成一条，与「保留空态卡」冲突`,
      );
  }
  return problems;
}

/**
 * ⑧ 顶部留白预算：页头之上那一条（页面上内距 + 页头下缘缝）合计不得超过 BUDGET。
 *
 * 为什么关系判据之外还要这一发：①~⑦ 全是【相对】的，于是「base 与两档断点一起等比放大」
 * 能同时满足它们 —— 把 16/20/32 换回 24/28/50 依然单调、依然内距≥外距、依然页边距>卡间，
 * 紧凑化就这么悄悄退回去了。这条是唯一带绝对刻度的判据，形状照 group-workbench 的
 * T4「行盒预算 < 60」：钉的是【上限】而不是取值，下一轮想收得更紧照样过，只有变松才红。
 * 阈值取当前实测 28（16 + 12）：贴边留 0 余量是有意的 —— 这一格每一路由都要占，
 * 加 1px 就是 10 条路由各多 1px，不该有免费额度。
 */
function topBandBudget(src: string): string[] {
  const problems: string[] = [];
  const rules = leafRules(src);
  const tokens = tokensOf(rules);
  const BUDGET = 28;
  const padDecl = declarations(rules, ".page", "(base)", problems).get(
    "padding",
  );
  const pad =
    padDecl === undefined ? null : boxOf(resolveValue(padDecl, tokens) ?? "");
  if (padDecl !== undefined && pad === null)
    problems.push(`.page 的 padding 解析失败：${padDecl}`);
  const mb = readPx(
    rules,
    tokens,
    ".page-header",
    "(base)",
    "margin-bottom",
    problems,
  );
  if (pad === null || mb === null) return problems;
  const band = pad.top + mb;
  if (band > BUDGET)
    problems.push(
      `页头之上留白 ${band}px（内距 ${pad.top} + 页头缝 ${mb}）超预算 ${BUDGET}px ⇒ 每一路由都多占这一条`,
    );
  return problems;
}

/**
 * ⑨ 单向刻度上限（CEILINGS）：本轮收完的取值即上限，只许继续收、不许往回放。
 *
 * 为什么关系判据不够：①~⑧ 里只有 ⑦⑧ 带绝对刻度，而它们各只管一格（空态地板、页头之上那条）。
 * 拿 round379 之前的真实 CSS 演一遍就知道漏得多宽 —— 那一份 .topbar 64、.card 17、块缝 18/18/15、
 * 条目 11，如果【全体一起】退回原位：① 仍是一处令牌（令牌值写 64 而已）、② 仍单调（24/18/16 逐档变小）、
 * ③ 仍内距≥外距、⑤ 仍可做到五档全等、⑥ relief = 11 − 9 = 2 仍在 0~4 带内。八条全绿，
 * 紧凑化整轮蒸发。这就是「判据只写关系」在【回退方向】上的天然失明：等比放松不是违规，是合规。
 *
 * 所以这里补一张表，与 round377 那条教训（判据写死字面值 → 下一轮必红 → 回来改判据）并不冲突，
 * 因为形状是【单向】的：往回收永远绿，只有往回放才需要动表，而动表的唯一正当写法是
 * 在同一行写下「为什么这一格要多给」。别把上限改成当前取值的「大约」—— 那三格 6 的余量
 * 就是十路由此起之争的地方。
 */
type Ceiling = {
  selector: string;
  scope: string;
  prop: string;
  /** 允许的最大 px；当前实测值即上限。 */
  max: number;
  /** 为什么这一格只能这么多（回退时会被逐字打进失败信息）。 */
  why: string;
};

const CEILINGS: Ceiling[] = [
  {
    selector: ".topbar",
    scope: "(base)",
    prop: "height",
    max: 52,
    why: "顶栏每一屏都占，64 → 52 是本轮实测的让渡额",
  },
  {
    selector: ".page-header h2",
    scope: "(base)",
    prop: "font-size",
    max: 18,
    why: "页标题降到 --fs-xl(18)：层级靠字重与位置，不靠字号",
  },
  {
    selector: ".page",
    scope: "(base)",
    prop: "padding",
    max: 16,
    why: "页面上内距 24 → 16：整条顶带由 ⑧ 管合计、这里管单格",
  },
  {
    selector: ".page",
    scope: "(base)",
    prop: "padding-bottom",
    max: 32,
    why: "页底收 50 → 32：尾部留白不是呼吸感，是滚不到底的错觉",
  },
  {
    selector: ".page",
    scope: "(max-width: 860px)",
    prop: "padding",
    max: 14,
    why: "窄屏只会更挤，档位必须比 base 更紧",
  },
  {
    selector: ".page",
    scope: "(max-width: 640px)",
    prop: "padding",
    max: 12,
    why: "最窄一档",
  },
  {
    selector: ".card",
    scope: "(base)",
    prop: "padding",
    max: 12,
    why: "卡内 17 → 12：内距一旦大于卡间缝就撑破分组层次（③ 只管方向）",
  },
  {
    selector: ".conversation-item",
    scope: "(base)",
    prop: "padding",
    max: 8,
    why: "条目行盒 58.3 → 54.3 全靠这一格；列表密度是唯一的空白杠杆",
  },
  {
    selector: ".list-heading",
    scope: "(base)",
    prop: "padding",
    max: 12,
    why: "栏头 18 → 12：test/ 里没有任何判据读它，没有这行它就只是【现状】",
  },
  {
    selector: ".page-header",
    scope: "(base)",
    prop: "margin-bottom",
    max: 12,
    why: "⑧ 管的是「页面上内距 + 页头缝」的【合计】，所以把内距收紧就能给页头缝腾出额度；这一格得自己有一道闸",
  },
  // 块缝另外四格（英雄区/页签/横幅/工作台标题）【故意不入表】：⑤ 已钉它们与页头缝全等，
  // 一行上限 + 一条全等 = 五格同时被钉住。立五行读不到的上限 = 假覆盖。
];

/** 读一条声明并解成 px；padding 简写取「上」那一位，padding-<边> 先读自己的声明、没有再回落到简写。 */
function ceilingValue(
  rules: Rule[],
  tokens: Map<string, string>,
  c: Ceiling,
  problems: string[],
): number | null {
  const decls = declarations(rules, c.selector, c.scope, problems);
  const side = SIDES.find((s) => c.prop === `padding-${s}`);
  const key = decls.has(c.prop)
    ? c.prop
    : side !== undefined && decls.has("padding")
      ? "padding"
      : c.prop;
  const decl = decls.get(key);
  if (decl === undefined) {
    problems.push(`${c.selector}（${c.scope}）没有 ${c.prop} ⇒ 上限无人看守`);
    return null;
  }
  const resolved = resolveValue(decl, tokens);
  if (resolved === null) {
    problems.push(`${c.selector} 的 ${key} 解不开 var()：${decl}`);
    return null;
  }
  if (key === "padding") {
    const box = boxOf(resolved);
    if (box === null) {
      problems.push(`${c.selector} 的 padding 解析失败：${decl}`);
      return null;
    }
    return box[side ?? "top"];
  }
  const n = pxOf(resolved);
  if (n === null) {
    problems.push(`${c.selector} 的 ${c.prop} 不是 px 字面量：${resolved}`);
    return null;
  }
  return n;
}

function densityCeilings(src: string, table: Ceiling[] = CEILINGS): string[] {
  const problems: string[] = [];
  const rules = leafRules(src);
  const tokens = tokensOf(rules);
  for (const c of table) {
    const value = ceilingValue(rules, tokens, c, problems);
    if (value === null) continue;
    if (value > c.max)
      problems.push(
        `${c.selector}（${c.scope}）的 ${c.prop} = ${value}px 超上限 ${c.max}px ⇒ ${c.why}`,
      );
  }
  return problems;
}

/** 真文件读一次，供下面每条「0 问题」判据共用。 */
function groupCss(): string {
  return readFileSync(GROUP_CSS, "utf8");
}

describe("紧凑化刻度守卫（round379）", () => {
  it("提取器能认出 @media 语境与基础语境（否则下面全是假绿）", () => {
    const src =
      ".a { padding: 1px; }\n@media (max-width: 640px) { .a { padding: 2px; } }\n";
    const rules = leafRules(src);
    expect(rules).toHaveLength(2);
    expect(rules[0]?.scope).toBe("(base)");
    expect(rules[1]?.scope).toBe("(max-width: 640px)");
    // 行号锚点：洗注释不许把行号洗掉
    const withComment = "/* 两\n行注释 */\n.b { padding: 1px; }";
    const located = leafRules(withComment);
    expect(located[0]?.line).toBe(3);
  });

  it("反对照：提取器解不开 var() 时报问题，不静默放行", () => {
    const src = ".card { padding: var(--nope); }";
    expect(
      tightnessOrder(src).some(
        (p) => p.includes("解不开 var()") || p.includes("命中 0 条"),
      ),
    ).toBe(true);
  });

  describe("① 顶栏高度只有一个来源", () => {
    it("真文件：.topbar 与 .workspace 都消费 --topbar-height，无残留字面值", () => {
      expect(topbarSingleSource(groupCss())).toEqual([]);
    });
    it("反对照：任一处退回字面 px 就红", () => {
      const src =
        ":root { --topbar-height: 52px; }\n.topbar { height: 64px; }\n.workspace { height: calc(100vh - var(--topbar-height)); }";
      expect(topbarSingleSource(src).some((p) => p.includes("字面 px"))).toBe(
        true,
      );
      const src2 =
        ":root { --topbar-height: 52px; }\n.topbar { height: var(--topbar-height); }\n.workspace { height: calc(100vh - 64px); }";
      expect(
        topbarSingleSource(src2).some(
          (p) => p.includes("calc 里还留着 px") || p.includes("没消费"),
        ),
      ).toBe(true);
    });
    it("反对照：令牌被删就红", () => {
      expect(
        topbarSingleSource(".topbar { height: 52px; }").some((p) =>
          p.includes("--topbar-height"),
        ),
      ).toBe(true);
    });
  });

  describe("② 断点只能越窄越紧", () => {
    it("真文件：base ≥ 860 ≥ 640 逐位单调且至少一处严格", () => {
      expect(breakpointMonotonic(groupCss())).toEqual([]);
    });
    it("反对照：860 档比 base 还松 ⇒ 抓到", () => {
      const src =
        ".page { padding: 16px 20px 32px; }\n@media (max-width: 860px) { .page { padding: 18px; } }\n@media (max-width: 640px) { .page { padding: 12px 12px 20px; } }";
      expect(
        breakpointMonotonic(src).some((p) => p.includes("越窄反而越松")),
      ).toBe(true);
    });
    it("反对照：三档一模一样 ⇒ 抓到（档位是摆设）", () => {
      const src =
        ".page { padding: 16px; }\n@media (max-width: 860px) { .page { padding: 16px; } }\n@media (max-width: 640px) { .page { padding: 16px; } }";
      expect(
        breakpointMonotonic(src).some((p) => p.includes("档位是摆设")),
      ).toBe(true);
    });
    it("反对照：少一档就红，不当「没这条规则 = 没问题」放过", () => {
      const src =
        ".page { padding: 16px; }\n@media (max-width: 860px) { .page { padding: 12px; } }";
      expect(breakpointMonotonic(src).some((p) => p.includes("只解析出"))).toBe(
        true,
      );
    });
  });

  describe("③④ 松紧次序", () => {
    it("真文件：卡内 ≥ 卡间，页边距 > 卡间", () => {
      expect(tightnessOrder(groupCss())).toEqual([]);
    });
    it("反对照：内距小于外距 ⇒ 抓到", () => {
      expect(
        tightnessOrder(
          ".card { padding: 8px; }\n.card + .card { margin-top: 12px; }\n.page { padding: 20px; }",
        ).some((p) => p.includes("散点")),
      ).toBe(true);
    });
    it("反对照：页边距塌到不大于块间距 ⇒ 抓到", () => {
      expect(
        tightnessOrder(
          ".card { padding: 12px; }\n.card + .card { margin-top: 12px; }\n.page { padding: 12px; }",
        ).some((p) => p.includes("贴到视口边")),
      ).toBe(true);
    });
  });

  describe("⑤ 块间距只许一个值", () => {
    it("真文件：五个块缝读者全等，且相邻卡严格小于块缝", () => {
      expect(blockGapUniform(groupCss())).toEqual([]);
    });
    it("反对照：单独挪走其中一档 ⇒ 抓到", () => {
      const src = [
        ".page-header { margin-bottom: 12px; }",
        ".detail-hero { margin-bottom: 20px; }",
        ".tabs { margin-bottom: 12px; }",
        ".banner { margin-bottom: 12px; }",
        ".group-workspace-heading { margin-bottom: 12px; }",
        ".card + .card { margin-top: 8px; }",
      ].join("\n");
      expect(blockGapUniform(src).some((p) => p.includes("种取值"))).toBe(true);
    });
    it("反对照：相邻卡贴平块缝 ⇒ 抓到（分组信息消失）", () => {
      const src = [
        ".page-header { margin-bottom: 12px; }",
        ".detail-hero { margin-bottom: 12px; }",
        ".tabs { margin-bottom: 12px; }",
        ".banner { margin-bottom: 12px; }",
        ".group-workspace-heading { margin-bottom: 12px; }",
        ".card + .card { margin-top: 12px; }",
      ].join("\n");
      expect(blockGapUniform(src).some((p) => p.includes("分组信息消失"))).toBe(
        true,
      );
    });
  });

  describe("⑥ 选中条跟着内距走", () => {
    it("真文件：::before 上下对称，且内缩在 0~4 带内", () => {
      expect(markerTracksPadding(groupCss())).toEqual([]);
    });
    it("反对照：内距改了、标记没跟着改 ⇒ 抓到", () => {
      const src =
        ".conversation-item { padding: 14px 9px; }\n.conversation-item.selected::before { top: 4px; bottom: 4px; }";
      expect(markerTracksPadding(src).some((p) => p.includes("带内"))).toBe(
        true,
      );
    });
    it("反对照：只改 top 不改 bottom（不对称）⇒ 抓到", () => {
      const src =
        ".conversation-item { padding: 8px 9px; }\n.conversation-item.selected::before { top: 7px; bottom: 2px; }";
      expect(markerTracksPadding(src).some((p) => p.includes("不对称"))).toBe(
        true,
      );
    });
  });

  describe("⑦ 空态地板只许往上", () => {
    it("真文件：.state / .board-column 的地板仍在 200 以上", () => {
      expect(
        emptyStateFloorsKept(groupCss(), [".state", ".board-column"]),
      ).toEqual([]);
    });
    it("反对照：地板被压小 ⇒ 抓到", () => {
      expect(
        emptyStateFloorsKept(".state { min-height: 120px; }", [".state"]).some(
          (p) => p.includes("空态卡塌成一条"),
        ),
      ).toBe(true);
    });
    it("反对照：整条 min-height 被删 ⇒ 也抓到（否则「删声明」是常绿回退路）", () => {
      expect(
        emptyStateFloorsKept(".state { padding: 30px; }", [".state"]).some(
          (p) => p.includes("整条消失"),
        ),
      ).toBe(true);
    });
    it("反向自证：地板变大不红（这是单向着色，不是取值钉死）", () => {
      expect(
        emptyStateFloorsKept(".state { min-height: 260px; }", [".state"]),
      ).toEqual([]);
    });
  });

  describe("⑧ 顶部留白预算（唯一带绝对刻度的一发）", () => {
    it("真文件：页头之上留白在预算内", () => {
      expect(topBandBudget(groupCss())).toEqual([]);
    });
    it("反对照：关系全成立但整体等比放松 ⇒ 只有这一发抓得到", () => {
      // 这一串不是 round379 之前的真实 CSS（那时块缝是 20/18/18/15，本身就违反 ⑤），
      // 而是【假想的下一次放松】：断点仍单调、内距仍≥外距、块缝仍统一、相邻卡仍更小、
      // 地板与标记关系都在 —— ①~⑦ 全绿，只有顶部留白从 28 涨到 36。
      // 这正是要单独立一条绝对预算的理由：纯关系判据对「整体变松」天然失明。
      const loose = [
        ":root { --topbar-height: 52px; --space-4: 16px; }",
        ".topbar { height: var(--topbar-height); }",
        ".workspace { height: calc(100vh - var(--topbar-height)); }",
        ".page { padding: 20px 24px 40px; }",
        "@media (max-width: 860px) { .page { padding: 18px; } }",
        "@media (max-width: 640px) { .page { padding: 12px; } }",
        ".page-header { margin-bottom: 16px; }",
        ".detail-hero { margin-bottom: 16px; }",
        ".tabs { margin-bottom: 16px; }",
        ".banner { margin-bottom: 16px; }",
        ".group-workspace-heading { margin-bottom: 16px; }",
        ".card { padding: var(--space-4); }",
        ".card + .card { margin-top: 12px; }",
        ".conversation-item { padding: 10px 9px; }",
        ".conversation-item.selected::before { top: 9px; bottom: 9px; }",
        ".state { min-height: 210px; }",
        ".board-column { min-height: 220px; }",
      ].join("\n");
      expect(topBandBudget(loose).some((p) => p.includes("超预算"))).toBe(true);
      // 同一段 CSS 在七条关系判据下全绿 —— 反向坐实预算这一发确实在射程内
      expect(breakpointMonotonic(loose)).toEqual([]);
      expect(tightnessOrder(loose)).toEqual([]);
      expect(blockGapUniform(loose)).toEqual([]);
      expect(markerTracksPadding(loose)).toEqual([]);
      expect(emptyStateFloorsKept(loose, [".state", ".board-column"])).toEqual(
        [],
      );
    });
    it("反对照：只把页头缝放宽一档 ⇒ 抓到", () => {
      expect(
        topBandBudget(
          ".page { padding: 16px 20px 32px; }\n.page-header { margin-bottom: 24px; }",
        ).some((p) => p.includes("超预算")),
      ).toBe(true);
    });
    it("反向自证：收得更紧不红（预算是上限，不是取值钉死）", () => {
      expect(
        topBandBudget(
          ".page { padding: 12px 20px 32px; }\n.page-header { margin-bottom: 8px; }",
        ),
      ).toEqual([]);
    });
  });

  describe("⑨ 单向刻度上限（整轮蒸发只有这张表抓得住）", () => {
    it("真文件：十格读数全在各自上限内", () => {
      expect(densityCeilings(groupCss())).toEqual([]);
    });
    it("反对照：整体退回原位但仍在 ⑧ 的顶部预算内 ⇒ ①~⑧ 全绿，只有这张表红", () => {
      // 顶带故意压到刚好贴着 ⑧ 的上限（内距 10 + 页头缝 18 = 28），块缝五格一起退回 18 且保持全等，
      // 于是 ⑤ 与 ⑧ 都没话说 —— 卡片内距、条目内距、栏头、字号、顶栏值就这么各回各家。
      const evaporated = [
        ":root { --topbar-height: 64px; --space-4: 16px; --fs-2xl: 22px; }",
        ".topbar { height: var(--topbar-height); }",
        ".workspace { height: calc(100vh - var(--topbar-height)); }",
        ".page { padding: 10px 20px 32px; }",
        "@media (max-width: 860px) { .page { padding: 8px; } }",
        "@media (max-width: 640px) { .page { padding: 6px; } }",
        ".page-header { margin-bottom: 18px; }",
        ".page-header h2 { font-size: var(--fs-2xl); }",
        ".detail-hero { margin-bottom: 18px; }",
        ".tabs { margin-bottom: 18px; }",
        ".banner { margin-bottom: 18px; }",
        ".group-workspace-heading { margin-bottom: 18px; }",
        ".card { padding: var(--space-4); }",
        ".card + .card { margin-top: 8px; }",
        ".list-heading { padding: 18px 17px 10px; }",
        ".conversation-item { padding: 11px 9px; }",
        ".conversation-item.selected::before { top: 9px; bottom: 9px; }",
        ".state { min-height: 210px; }",
        ".board-column { min-height: 220px; }",
      ].join("\n");
      // 前八条一致绿 —— 这正是要补这张表的理由
      expect(topbarSingleSource(evaporated)).toEqual([]);
      expect(breakpointMonotonic(evaporated)).toEqual([]);
      expect(tightnessOrder(evaporated)).toEqual([]);
      expect(blockGapUniform(evaporated)).toEqual([]);
      expect(markerTracksPadding(evaporated)).toEqual([]);
      expect(
        emptyStateFloorsKept(evaporated, [".state", ".board-column"]),
      ).toEqual([]);
      expect(topBandBudget(evaporated)).toEqual([]);
      // 只有刻度表红，而且红在真正被放回去的那几格上
      const problems = densityCeilings(evaporated);
      const offenders = problems.map((p) => p.split("（")[0]).sort();
      expect(offenders).toEqual([
        ".card",
        ".conversation-item",
        ".list-heading",
        ".page-header",
        ".page-header h2",
        ".topbar",
      ]);
      expect(problems.every((p) => p.includes("超上限"))).toBe(true);
    });
    it("反对照：padding-bottom 只写在简写里也要读到，不当「没有这条声明」放过", () => {
      const table: Ceiling[] = [
        {
          selector: ".page",
          scope: "(base)",
          prop: "padding-bottom",
          max: 32,
          why: "页底",
        },
      ];
      // 简写第三值 = bottom
      expect(
        densityCeilings(".page { padding: 16px 20px 40px; }", table).some((p) =>
          p.includes("超上限"),
        ),
      ).toBe(true);
      // 显式声明优先于简写
      expect(
        densityCeilings(
          ".page { padding: 16px 20px 32px; padding-bottom: 40px; }",
          table,
        ).some((p) => p.includes("超上限")),
      ).toBe(true);
      // 两路都在上限内 ⇒ 绿（证明不是「读不到就一律红」）
      expect(
        densityCeilings(".page { padding: 16px 20px 30px; }", table),
      ).toEqual([]);
    });
    it("反向自证：往回收永远绿（表是单向闸门，不是取值钉死）", () => {
      const table: Ceiling[] = [
        {
          selector: ".card",
          scope: "(base)",
          prop: "padding",
          max: 12,
          why: "卡内",
        },
        {
          selector: ".topbar",
          scope: "(base)",
          prop: "height",
          max: 52,
          why: "顶栏",
        },
      ];
      expect(
        densityCeilings(
          ":root { --topbar-height: 44px; --space-2: 8px; }\n.topbar { height: var(--topbar-height); }\n.card { padding: var(--space-2); }",
          table,
        ),
      ).toEqual([]);
    });
    it("反对照：声明整条被删 = 上限无人看守，不放行", () => {
      const table: Ceiling[] = [
        {
          selector: ".card",
          scope: "(base)",
          prop: "padding",
          max: 12,
          why: "卡内",
        },
      ];
      expect(
        densityCeilings(".card { background: #fff; }", table).some((p) =>
          p.includes("无人看守"),
        ),
      ).toBe(true);
    });
  });
});
