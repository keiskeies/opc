/**
 * 「哪几条已实现的端点没有渲染侧调用方」这张名单的守卫（0068 那把尺子的第一次承重使用）。
 *
 * ── 守的是什么主张 ────────────────────────────────────────────────
 * 0068 把「有没有人调这条端点」从一句 grep 变成一把量得出东西的尺子，但它当时只判
 * 【尺子能不能响】，没有把读数钉下来。本篇把读数钉成名单：IMPLEMENTED_ENDPOINTS 的
 * 95 条端点条目里，今天有 12 条（10 条路径）在渲染侧零调用方，每一条【为什么不是缺口】
 * 逐个登记在下面那份名单里。
 *
 * ── 为什么必须双向判 ──────────────────────────────────────────────
 * 单向判（只要求「名单内仍然零调用方」）会在两个方向上骗人：
 * · 有人把某条端点接进界面 ⇒ 名单还在、主张已过期，而判据不会红（这一族在
 *   claims-registry 文件头记的是老账：过期主张比缺口更贵）。
 * · 有人新写了一条没有调用方的端点 ⇒ 名单外，判据也不红，缺口静默入库。
 * 所以两条都判：名单外出现零调用方 ⇒ 红；名单内出现调用方 ⇒ 红（并要你去更新主张）。
 *
 * ── 匹配形状为什么不能是子串（两版钝尺子都实测过，各自错一个方向）────────
 * · 拿完整路径直扫：渲染侧写的是 `"/approvals/" + encodeURIComponent(id)`，字面量里没有
 *   完整路径 ⇒ 把【有调用方】的端点报成缺口（虚报缺口）。
 * · 再退一步用「参数位之前的静态前缀」：`/approvals/` 同时命中 decide 与 mint-token 两条，
 *   于是把【真的没人调】的 `POST /approvals/:interruptId/token` 报成有调用方
 *   （实测 app.js 里 `/token` 出现 0 次 ⇒ 那一格是假绿）。
 * 所以判据先把渲染侧的【路径表达式提取出来】再归一化（插值段与拼接段一律换成 `{}`、
 * 剥 query），于是 `/approvals/{}` 与 `/approvals/{}/token` 是两个不同模式，判据重新有
 * 分辨力。归一化还必须先证【无碰撞】：两条不同路径若归一成同一个模式，名单里一条就
 * 盖住两条 —— 那是把尺子自己磨钝，check ① 专门挡它。
 *
 * ── 口径边界 ──────────────────────────────────────────────────────
 * 「渲染侧零调用方」≠「没有生产调用方」，更≠「该做一个界面」。名单里那 12 条的处置
 * 分三类（判断 / 已被别的形状覆盖 / 待排期），逐条写在名单的 reason 里；本守卫
 * 【不判】该不该给它们做界面 —— 那属 CEO 排期那一格（0067 §9 同一条口径）。
 */

/** 渲染侧取材根：真控制室与七页管理视图都在这份目录下（0068 §3①）。 */
export const UI_ROOT = "packages/web/public";

/** 名单里一条「这条端点今天没有渲染侧调用方，且这不是缺口/已按某条口径处置」。 */
export interface NoUiCallerEntry {
  /** 契约里的端点条目，逐字形如 `GET /bindings`。 */
  readonly endpoint: string;
  /** 为什么它零调用方而不算缺口。空串 = 一格没有理由的豁免，判据直接红。 */
  readonly reason: string;
}

export interface RosterFacts {
  /** IMPLEMENTED_ENDPOINTS 里的端点条目（`METHOD /path`）。 */
  readonly implemented: readonly string[];
  /** 渲染侧提取并归一化后的路径模式集合（`/approvals/{}` 这种形状）。 */
  readonly uiPatterns: ReadonlySet<string>;
  /** 登记名单。 */
  readonly roster: readonly NoUiCallerEntry[];
}

/**
 * `/api/v1` 前缀剥掉 + 参数段换成 `{}` + 空段丢掉。
 * ⚠ 前缀两种写法都要认（渲染侧有两条绕过 api()/request() 的直连：group.js 的
 * `/api/v1/assets/…` 与 app.js:3351 的 SSE `fetch("/api/events" + q)`），
 * 认前缀这件事放在调用方（uiPatternKeys），归一化本身只管形状。
 */
export function normalizePath(path: string): string {
  const segs = path
    .replace(/^\/api\/v1/, "")
    .split("/")
    .filter((s) => s !== "")
    .map((s) => (s.startsWith(":") ? "{}" : s));
  return "/" + segs.join("/");
}

/** 端点条目拆成方法；拆不出 ⇒ 返回 ""（取材形状变了，判据会据此报警）。 */
export function endpointPath(endpoint: string): string {
  const parts = endpoint.trim().split(/\s+/u);
  const path = parts.length === 2 ? parts[1] : undefined;
  return path === undefined ? "" : path;
}

/**
 * 一条归一模式是否【没有字面段】：`/`、`/{}`、`/{}/{}` 这类。
 * 名单里出现这种键 = 一条登记盖住任意路径 = 把尺子自己磨钝（0068 §4 那条「恒真串
 * 不许替零命中作证」在这里的形状）。
 */
export function isDegeneratePattern(pattern: string): boolean {
  return !/^\/[\w.-]+/u.test(pattern);
}

/**
 * 返回 "" = 名单与今天的读数自洽；非空 = 人话报警。判据纯化（不碰盘），口径同
 * desktop-honest-label.ts / claims-registry.ts。
 *
 * 检查顺序是有意的：先证尺子（① 归一无碰撞、② 端点条目形状解析得动），再读工件。
 * 尺子坏了的时候，读出来的「有没有缺口」没有意义 —— 0068 §5 那条「引用一个读数之前
 * 先证明它是被测对象产生的」在这里的形状。
 */
export function checkRoster(f: RosterFacts): string {
  // ① 归一化必须无碰撞。⚠ 比对的是【不同的路径字符串】压成同一模式，不是端点条目：
  // 同一条路径挂多个方法（实测 67 条路径里有 26 条如此）是契约的常态，拿条目数判
  // 会把「GET 与 POST 同在 /tasks」报成碰撞 —— 那是把判据立成恒红，等于没有判据。
  const byPattern = new Map<string, string[]>();
  for (const ep of f.implemented) {
    const path = endpointPath(ep);
    if (path === "") continue;
    const key = normalizePath(path);
    const prev = byPattern.get(key);
    if (prev === undefined) byPattern.set(key, [path]);
    else if (!prev.includes(path)) prev.push(path);
  }
  const collided = [...byPattern].filter(([, v]) => v.length > 1);
  if (collided.length > 0) {
    const first = collided[0] as [string, string[]];
    return (
      "归一化把 " +
      collided.length +
      " 组不同路径压成同一个模式（例如 " +
      first[0] +
      " ← " +
      first[1].join(" | ") +
      "）⇒ 名单里一条登记会盖住两条，这张名单失去分辨力。先改形状再谈读数"
    );
  }

  // ② 取材形状解析得动：解析不出路径的条目数超过一半 ⇒ 是契约表变了形状，不是端点没了。
  const unparsed = f.implemented.filter((ep) => endpointPath(ep) === "");
  if (f.implemented.length > 0 && unparsed.length * 2 > f.implemented.length) {
    return (
      "IMPLEMENTED_ENDPOINTS 里有 " +
      unparsed.length +
      "/" +
      f.implemented.length +
      " 条形如 `METHOD /path` 的条目解析不出路径（取到的是 " +
      JSON.stringify(unparsed[0]) +
      "）⇒ 契约表换了写法，判据的取材断了，别把「名单全对」当成结论"
    );
  }

  const rosterByEndpoint = new Map<string, NoUiCallerEntry>();
  for (const e of f.roster) {
    if (e.reason.trim() === "") {
      return (
        "名单里 " +
        e.endpoint +
        " 那一格没有理由 —— 没有理由的登记等于把缺口登记成豁免"
      );
    }
    if (rosterByEndpoint.has(e.endpoint)) {
      return "名单里 " + e.endpoint + " 登记了两次";
    }
    const path = endpointPath(e.endpoint);
    if (path === "") {
      return "名单里有一条端点条目解析不出路径：" + e.endpoint;
    }
    const key = normalizePath(path);
    if (isDegeneratePattern(key)) {
      return (
        "名单里 " +
        e.endpoint +
        " 归一后是 " +
        key +
        "（没有字面段）⇒ 这一格会盖住任意路径，恒真登记不能替「零调用方」作证"
      );
    }
    rosterByEndpoint.set(e.endpoint, e);
  }

  // ③ 名单外的端点必须被渲染侧命中。
  const unlisted: string[] = [];
  for (const ep of f.implemented) {
    const path = endpointPath(ep);
    if (path === "") continue;
    if (rosterByEndpoint.has(ep)) continue;
    if (!hitsUi(normalizePath(path), f.uiPatterns)) unlisted.push(ep);
  }
  if (unlisted.length > 0) {
    const shown = unlisted.slice(0, 6).join(" , ");
    return (
      "名单外出现了渲染侧零调用方的端点 " +
      unlisted.length +
      " 条（" +
      shown +
      (unlisted.length > 6 ? " …" : "") +
      "）⇒ 要么接线，要么按下面这份名单的口径登记「为什么不是缺口」；" +
      "第三种选项是让它继续没人调而不说理由，那正是本守卫要挡的"
    );
  }

  // ④ 名单内的端点必须仍然零命中（接了线就要回来改主张）。
  const nowWired = [...rosterByEndpoint.keys()].filter((ep) =>
    hitsUi(normalizePath(endpointPath(ep)), f.uiPatterns),
  );
  if (nowWired.length > 0) {
    return (
      "名单里的 " +
      nowWired.length +
      " 条端点现在【有】渲染侧调用方了（" +
      nowWired.slice(0, 6).join(" , ") +
      "）⇒ 接线落地了，请把这一格从名单里摘掉并同步 docs 里那条主张（双向判的另一半）"
    );
  }

  // ⑤ 名单里不许留已经不存在的端点（契约收缩后的死格）。
  const implementedSet = new Set(f.implemented);
  const stale = [...rosterByEndpoint.keys()].filter(
    (ep) => !implementedSet.has(ep),
  );
  if (stale.length > 0) {
    return (
      "名单里有 " +
      stale.length +
      " 条端点已不在 IMPLEMENTED_ENDPOINTS（" +
      stale.slice(0, 6).join(" , ") +
      "）⇒ 契约收缩了而名单没跟着改，这一格现在守的是一个不存在的东西"
    );
  }

  return "";
}

/**
 * 命中口径：归一模式【整体等于】某条提取到的模式，或它带着 `/api`、`/api/v1` 前缀
 * （含一段拼接尾巴 `{}`）等于 —— 后者认的是渲染侧那两条绕过传输层的直连写法。
 * ⚠ 刻意不用 startsWith / includes / 任意 endsWith：那正是上面两版钝尺子的形状，
 *   会把 `/approvals/{}` 当成 `/approvals/{}/token` 的命中。
 */
export function hitsUi(
  pattern: string,
  uiPatterns: ReadonlySet<string>,
): boolean {
  if (uiPatterns.has(pattern)) return true;
  // 只认「整条前缀 + 这一条路径」这一种越写法的等价形式（含拼接尾巴 `{}`）：
  // 任意 endsWith 会让 `/api/v1/dispatch/rules` 冒充 `/rules` 的命中 —— 那正是本篇
  // 文件头批过的钝尺子形状，不能一边批一边用。
  for (const prefix of ["/api/v1", "/api"]) {
    if (uiPatterns.has(prefix + pattern)) return true;
    if (uiPatterns.has(prefix + pattern + "{}")) return true;
  }
  return false;
}

/**
 * 名单本体。三类处置写在 reason 里：
 * 【判断】= 刻意不给界面（引用它的代码位置）；【覆盖】= 渲染侧用另一种形状已经做到了
 * 这件事；【排期】= 真缺口，等人拍板。
 */
export const NO_UI_CALLER_ROSTER: readonly NoUiCallerEntry[] = [
  {
    endpoint: "GET /bindings",
    reason:
      "【覆盖】desktop 侧有 IPC 通道 hub:listBindings（packages/desktop/src/ipc-surface.ts），" +
      "读侧的合法出口在那条通道上；web 管理页没有绑定视图是有意为之，" +
      "见同一份文件里 hub:listBindings 上面那段 ①②③。",
  },
  {
    endpoint: "POST /bindings",
    reason:
      "【判断】ipc-surface.ts 里 hub:listBindings 上面那段明写：写侧三条刻意【没有】渲染进程通道 —— " +
      "校验身份的那一次「我知道他是谁」不发生在能跑远程脚本的上下文里。合法入口是人 + CLI/curl。",
  },
  {
    endpoint: "POST /bindings/verify",
    reason:
      "【判断】同上 —— 那三条里最高的一档门，做成按钮会伪造出「点一下就行」的假象。",
  },
  {
    endpoint: "POST /bindings/rebind",
    reason:
      "【判断】同上。⚠ 这一格是判断不是未完成：真要做管理界面时得连那段 ① 一起回答。",
  },
  {
    endpoint: "POST /approvals/:interruptId/token",
    reason:
      "【排期】签票只认回环（http/app.ts 的 mintToken：501 而不是 404 那条口径）。装配确实接了 " +
      "issueApprovalToken（serve/assemble.ts 的 bindForAssembly 把它当成远程审批是否接通的判式之一），" +
      "而界面与 CLI 都没有入口 ⇒ 「远程持票人从哪拿到第一张票」这一格今天靠人手工发。" +
      "要不要给界面加一个「签一张票」按钮属排期，且它一旦落地必须仍在回环侧。",
  },
  {
    endpoint: "DELETE /api/v1/members/:id/skills/:skillId",
    reason:
      "【覆盖】people.ts 里这条 DELETE 的实现就是「filter 掉一条再 setMemberSkills」，" +
      "而成员设置面板（group.js 的 skillsEditor）走的是同一条整体替换 POST —— 摘一件技能这件事" +
      "在界面里已经能做，只是没走 DELETE 这条路。⚠ 所以这一格守的是「没人调这条路由」，" +
      "不是「界面没有这个能力」；两者不等价这件事本身就是本名单要说的话。",
  },
  {
    endpoint: "DELETE /api/v1/members/:id/executors/:seq",
    reason:
      "【覆盖】同上一条：执行器那一格也是 filter + 整体替换 POST（group.js 的 executorsEditor）。",
  },
  {
    endpoint: "GET /api/v1/members/:id/training",
    reason:
      "【覆盖】它的返回体是 { member_id, skills, executors }，而这三样设置面板已经拿得到" +
      "（列表接口就带 skills/executors）。设计文档里 training 只出现在实施计划 §3 那张端点清单，" +
      "没有任何一处描述它该显示什么 ⇒ 今天它是同一份数据的第二个出口，不是缺的界面。",
  },
  {
    endpoint: "GET /api/v1/talent/:id",
    reason:
      "【覆盖】talentItemViewSchema 里列表项已含 payload（contracts/src/talent.ts），" +
      "人才市场那一页从列表直接拿到要显示的东西，并走 /export 下载蓝图 ⇒ 详情读今天没有界面需求。",
  },
  {
    endpoint: "GET /api/v1/dispatch/rules",
    reason:
      "【排期】分发规则配置页整页未做，属 CEO 排期那一格（0067 §9：放 web 还是 desktop、" +
      "列表与表单的信息密度两条都无依据）。⚠ 本名单【不判】该不该做它 —— 那一天落地就是把这三条" +
      "从名单里摘掉，而那是排期决定，不是判据逼出来的。",
  },
  {
    endpoint: "POST /api/v1/dispatch/rules",
    reason: "【排期】同上一条（配置页那一格的三条端点之一）。",
  },
  {
    endpoint: "PATCH /api/v1/dispatch/rules/:id",
    reason:
      "【排期】同上一条。b502632 落地的是它的生产写入路径本身（enabled/priority），不是界面。",
  },
];

/**
 * ── 下面是【尺子本体】：把渲染侧源码里的路径表达式提取成归一模式 ──────────────
 * 放在判据文件而不是测试文件里，理由与 claims-registry 家法一致：变异要打在尺子上，
 * 而打在「测试自己怎么写的」那段提取器上，证的不是尺子有牙齿。
 *
 * 两步：① 剥注释（否则注释里提一句 `/bindings` 就算「有调用方」—— 本仓 r1/r25 那两格
 * 立的都是【剥掉注释之后的字节】这条口径）；② 提取字面量/模板/拼接链，插值与拼接段
 * 一律换成 `{}`、剥掉 query。
 */

/** 剥掉行注释与块注释；字符串内部的斜杠不误伤。 */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "line" | "block" | "dq" | "sq" | "tpl" = "code";
  while (i < text.length) {
    const c = text[i] as string;
    const n = i + 1 < text.length ? text[i + 1] : "";
    if (mode === "code") {
      if (c === "/" && n === "/") {
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (c === '"') mode = "dq";
      else if (c === "'") mode = "sq";
      else if (c === "`") mode = "tpl";
      out += c;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") {
        mode = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    const close = mode === "dq" ? '"' : mode === "sq" ? "'" : "`";
    if (c === "\\") {
      out += c + n;
      i += 2;
      continue;
    }
    if (c === close) mode = "code";
    out += c;
    i += 1;
  }
  return out;
}

/** 一个候选串是否像一个 API 路径；像就归一后收进集合。 */
function addPath(set: Set<string>, raw: string): void {
  if (!raw.startsWith("/")) return;
  const noQuery = raw.split("?")[0] as string;
  // 字符类要求 `/` 之后至少还有一个合法字符 ⇒ 裸 `/` 与空串天然进不来，不必再写长度门
  // （写过：它对任何输入都不可能单独起效，一根没有自己那次动作的线不如没有）。
  if (!/^\/[\w{}[\]/.:-]+$/u.test(noQuery)) return;
  set.add(noQuery);
}

/** 从一份（已剥注释的）源码里取出全部路径模式，归一成 `/a/{}/b` 形状。 */
export function extractPathPatterns(code: string): Set<string> {
  const set = new Set<string>();
  for (const m of code.matchAll(/`(?:[^`\\]|\\.)*`/gu)) {
    addPath(set, (m[0] as string).slice(1, -1).replace(/\$\{[^}]*\}/gu, "{}"));
  }
  for (const m of code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gu)) {
    addPath(set, (m[0] as string).slice(1, -1));
  }
  // 拼接链：`"a/" + x + "/b"` 与 `"a/" + x`。字面量段留着，被拼掉的那一段换成 `{}`。
  // 中间那一段限定成【标识符链 + 可选一层不带嵌套的调用】：渲染侧写的就是
  // `encodeURIComponent(id)` 这种形状，而早先那版 `[^+;,){}]` 把 `(` 排除在外 ⇒ 整条规则
  // 对真代码一次都没生效过（变异机 M5 因此活下来：规则是死的，测试却在绿）。
  for (const m of code.matchAll(
    /"[^"\n]{1,80}"\s*\+\s*[\w.$]+(?:\([^()]{0,60}\))?\s*\+\s*"[^"\n]{1,80}"/gu,
  )) {
    const parts = (m[0] as string).split(/\s*\+\s*/u);
    const head = (parts[0] as string).slice(1, -1);
    const tail = (parts[2] as string).slice(1, -1);
    addPath(set, head + "{}" + tail);
  }
  for (const m of code.matchAll(
    /"\/[^"\n]{1,80}"\s*\+\s*[\w.$]+(?:\([^()]{0,60}\))?/gu,
  )) {
    const head = ((m[0] as string).split(/\s*\+\s*/u)[0] as string).slice(
      1,
      -1,
    );
    addPath(set, head + "{}");
  }
  return set;
}
