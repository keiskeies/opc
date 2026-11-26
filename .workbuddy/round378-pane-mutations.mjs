// Round378 self-rollback mutation verification（markdown 三态视图：源码 / 预览 / 分栏 + 新增两条外壳带）。
// 为什么单独一个脚本：round370-fill-mutations 打的是「打开即铺满」那一批高度线，
// 这一轮在它下面新插了一层 .editor-panes（分栏容器）与一条 .doc-mode-bar（形态页签）。
// 新形状最容易出的事故不是「切不过去」，而是切完之后某条看不见的线静默断了：
//  · .editor-surface 同时是草稿读写的锚点 ⇒ 分栏容器若顶替它，草稿整条失效而界面照旧；
//  · textarea.value 赋值不触发 input ⇒ 恢复草稿后右栏还写着旧正文；
//  · 页签条/草稿条每多 1px 都是从正文里借的。
// 每发变异必须【真抹字节】（删声明、删监听、改条件），注释掉不算；每发跑完从原 Buffer 还原，
// 还原后复跑同一条控制组，SHA 必须与开局一致。
// 剪完期望【只有指向这根线的那条用例】红：SURVIVED = 判据没接上，控制组红 = 还原没还原干净。
// 变异基 = 工作树原态 ORIGINAL（round353n 的纪律），不是 git HEAD。
// Run: node .workbuddy/round378-pane-mutations.mjs [id 子串]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = "D:/item/opc";
const CSS = "packages/web/public/group.css";
const JS = "packages/web/public/group.js";
const MD = "packages/web/public/markdown.js";
const PREVIEW_SPEC = "test/e2e/doc-preview.spec.ts";
const MD_TEST = "test/web/markdown.test.ts";
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** 运行器按 spec 后缀分派：.spec.ts 走 playwright，其余走 vitest。 */
function runRunner(spec, grepTitle) {
  const argv = spec.endsWith(".spec.ts")
    ? [
        "node_modules/@playwright/test/cli.js",
        "test",
        spec,
        "-g",
        grepTitle,
        "--reporter=line",
      ]
    : [
        "node_modules/vitest/vitest.mjs",
        "run",
        spec,
        "-t",
        grepTitle,
        "--reporter=dot",
      ];
  const r = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 480_000,
    maxBuffer: 40 * 1024 * 1024,
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 自证「grep 只命中一条用例」：命中多条时红了也不知道是谁，等于没有判据。 */
function matchCount(spec, grepTitle) {
  const argv = spec.endsWith(".spec.ts")
    ? ["node_modules/@playwright/test/cli.js", "test", spec, "-g", grepTitle, "--list"]
    : ["node_modules/vitest/vitest.mjs", "list", spec, "-t", grepTitle];
  const r = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (spec.endsWith(".spec.ts"))
    return (out.match(/\.spec\.ts:\d+:\d+/gu) || []).length;
  // vitest list 每行一条「test/web/markdown.test.ts > 套件 > 用例」
  return (out.match(/\S+\.test\.ts\s+>\s+\S/gu) || []).length;
}

// expect 是被剪那根线【自己那条】用例的标题子串（每发只命中一条用例）。
const PROBES = [
  {
    // 线：隐藏那一面靠 display 分派。抹掉「源码态藏预览面」后，源码态下两栏并排，
    // 「打开即编辑 + 预览面不参与布局」当场红（预览盖掉半屏编辑区）。
    id: "P1-mode-source-hide",
    file: CSS,
    spec: PREVIEW_SPEC,
    from:
      '.editor-panes[data-mode="source"] > .markdown-preview,\n.editor-panes[data-mode="source"] > .mindmap-preview { display: none; }',
    to: "",
    expect: "打开停在源码态",
  },
  {
    // 线：反向那一半 —— 预览态藏源码面。抹掉后「预览态」仍挂着 textarea，
    // 等于同一份正文有两个输入面（这轮之前的老形状）。
    id: "P2-mode-preview-hide",
    file: CSS,
    spec: PREVIEW_SPEC,
    from:
      '.editor-panes[data-mode="preview"] > .markdown-editor,\n.editor-panes[data-mode="preview"] > .mindmap-outline { display: none; }',
    to: "",
    expect: "预览态渲染出真节点",
  },
  {
    // 线：等分的基准。50% 换回 0 —— border-box 下 Chromium 把每栏自己的横向内距当基准，
    // 只把剩余部分对半分 ⇒ 两栏差 9px（实测 487.5 / 496.5）。判据读的就是这个差。
    id: "P3-basis-50pct",
    file: CSS,
    spec: PREVIEW_SPEC,
    from: ".editor-panes > * { flex: 1 1 50%;",
    to: ".editor-panes > * { flex: 1 1 0;",
    expect: "分栏时两栏等宽",
  },
  {
    // 线：flex-basis 归 auto（= 看内容宽）。长代码那段会把源码栏撑过一半、把预览挤成一条，
    // 「两栏宽之和 = 容器宽」与等宽同时红。
    id: "P4-basis-auto",
    file: CSS,
    spec: PREVIEW_SPEC,
    from: ".editor-panes > * { flex: 1 1 50%;",
    to: ".editor-panes > * { flex: 1 1 auto;",
    expect: "分栏时两栏等宽",
  },
  // P5-min-width-zero 已【退役】（round379）：它剪的那枚 min-width:0 不在源码里了。
  // 退役理由不是「锚点写错」，是那条声明本身被实测判成重言 —— 同一条规则的 overflow:auto
  // 已让分栏成为滚动容器，滚动容器的自动最小尺寸按规范就是 0（三档视口 × 长代码 × 宽表实测
  // 0 与 auto 逐像素相同，见 group.css:1075 的注释与 round379-minwidth-narrow.mjs）。
  // 当时剪掉它 18 发用例全绿 = 剪线存活 ⇒ 按纪律先怀疑声明而不是怀疑判据，声明已抹。
  // 豁免不许比现实活得久（与 lint/type 基线「降到 0 就删条目」同一立场），所以这里删探针、
  // 把理由留在原地，而不是留一条【永远不会命中】的 from 让预检 A 天天红。
  {
    // 线：分栏容器自己要 grow。不 grow 时它退回内容高，正文底下重新压一条空白，
    // 「正文仍拿编辑卡的八成以上」红。
    id: "P6-panes-fill",
    file: CSS,
    spec: PREVIEW_SPEC,
    from: ".editor-panes { flex: 1 1 auto; min-height: 0;",
    to: ".editor-panes { min-height: 0;",
    expect: "新增的两条 chrome 只按内容高",
  },
  {
    // 线：页签条不被拉伸。grow 之后 spacer 把整行摊平、条高由正文分，
    id: "P7-mode-bar-shrink",
    file: CSS,
    spec: PREVIEW_SPEC,
    from: ".doc-mode-bar { flex: 0 0 auto; }",
    to: ".doc-mode-bar { flex: 1 1 auto; }",
    expect: "新增的两条 chrome 只按内容高",
  },
  {
    // 线：草稿条同一条账 —— 它 grow 时会把卡片剩余高分给自己，正文少一条带。
    // （第一版这条漏写了 from/to，预检 A 当场拦下：锚点命中 0 ⇒ 脚本过期。
    //  锚点选【基础规则】那条而不是媒体查询里的覆盖：.doc-draft-bar 全仓只声明一次。）
    id: "P8-draft-bar-shrink",
    file: CSS,
    spec: PREVIEW_SPEC,
    from: ".doc-draft-bar { flex: 0 0 auto;",
    to: ".doc-draft-bar { flex: 1 1 auto;",
    expect: "草稿提示是一条带",
  },
  {
    // 线：分栏容器装进【水位面里】而不是顶替它。.editor-surface 同时是 queueDraft 读
    // data-draftBody、restoreDraft 找 textarea 的那枚锚点 ⇒ 顶替 = 草稿整条静默失效。
    // 剪法换过两刀，两刀都是【变异自己的错】、不是判据不承重：
    //   第一刀 replaceChildren —— 存活。watermark 在 :4693 现造，markdown/mindmap 两支
    //     走到 mountPanes 时一子未挂（挂 toolbar 的是互斥的 doc 支、挂 sheetHost 的是 sheet 支），
    //     paneHost 是当时唯一子节点 ⇒ 两者产出同一棵树，判据再准也量不到差别。
    //   第二刀 replaceWith —— 此刻 watermark 还没挂进 editor-card（装配在 :5249），
    //     没有父节点的 replaceWith 按规范直接 return ⇒ 编辑面压根不渲染。那不叫「草稿锚点被
    //     剪断」，那叫「页面没了」，判据会以一个不相干的理由变红。
    // 现在这刀 watermark.after(paneHost)：分栏照旧渲染、照旧能打字，但 input 冒泡不到水位面
    //   ⇒ captureDraft 从不触发 ⇒ data-draftBody 停在初始正文，草稿静默失效 ——
    //   正是注释里那件坏事，判据按【它自己的那条消息】变红。
    id: "P9-mount-replaces-surface",
    file: JS,
    spec: PREVIEW_SPEC,
    from: "    watermark.append(paneHost);",
    to: "    watermark.after(paneHost);",
    expect: "草稿锚点没被分栏剪断",
  },
  {
    // 线：恢复草稿要连当前视图一起重画（textarea.value 赋值不触发 input）。
    // 抹掉回调后 textarea 是新正文、右栏还是旧正文，屏幕同时说两件矛盾的事。
    id: "P10-restore-repaint",
    file: JS,
    spec: PREVIEW_SPEC,
    from: "() => restoreDraft(doc, watermark, title, status, () => repaintPanes?.())",
    to: "() => restoreDraft(doc, watermark, title, status)",
    expect: "恢复草稿会重画当前视图",
  },
  {
    // 线：同一根回调在思维导图那一支的读者。round378 之前这里还有一条
    // dispatchEvent("input") 与它做同一件事（掩着它），现在只剩这一条 ⇒ 剪掉后那棵树不重画。
    // 单开一发而不是并入上一发：两种形态各自要为自己的那条重画付一次钱。
    id: "P10b-restore-repaint-mindmap",
    file: JS,
    spec: PREVIEW_SPEC,
    from: "() => restoreDraft(doc, watermark, title, status, () => repaintPanes?.())",
    to: "() => restoreDraft(doc, watermark, title, status)",
    expect: "思维导图恢复草稿后那棵树跟着重画",
  },
  {
    // 线：打字即重渲染。抹掉监听后预览停在首屏那份，「左改右不动」。
    id: "P11-preview-live-repaint",
    file: JS,
    spec: PREVIEW_SPEC,
    from: '    editor.addEventListener("input", paintPreview);',
    to: "",
    expect: "边打字边重渲染",
  },
  {
    // 线：首屏就把预览画好（不等用户点开预览才画）。抹掉后切到预览才渲染，
    // 源码态下那一栏是空框 ⇒ 判据读的是「隐藏态也已有节点数」。
    id: "P12-preview-first-paint",
    file: JS,
    spec: PREVIEW_SPEC,
    from: "    editor.addEventListener(\"input\", paintPreview);\n    paintPreview();",
    to: '    editor.addEventListener("input", paintPreview);',
    expect: "打开停在源码态",
  },
  {
    // 线：形态按文档各记各的。抹掉读取后每篇都从 source 起步，切回原文档丢了视图。
    id: "P13-mode-per-doc",
    file: JS,
    spec: PREVIEW_SPEC,
    from: 'const mode = docModes.get(doc.doc_id) ?? "source";',
    to: 'const mode = "source";',
    expect: "形态按文档记",
  },
  {
    // 线：选中态三样一起落（class active + aria-pressed）。只留 class 时读屏听不到当前形态，
    // 页签条的「只有一枚 pressed」判据红。
    id: "P14-aria-pressed",
    file: JS,
    spec: PREVIEW_SPEC,
    from: '        node.setAttribute("aria-pressed", String(on));',
    to: "",
    expect: "aria-pressed 跟着走",
  },
  {
    // 线：markdown 渲染器整模块的语法形状 —— 一个孤立 ] 在 u 标志下是 SyntaxError，
    // 模块解析期就抛 ⇒ group.js 整页白屏。变异只抹掉图片那条里 ] 前的转义反斜杠，
    // 复现本轮真实撞到的那一次。这条剪的判据在 test/web/markdown.test.ts：模块在解析期
    // 就抛 ⇒ 整个文件收集失败（界面形状同样是整页白，不是某一条用例红）。
    id: "P15-lone-bracket-parse",
    file: MD,
    spec: MD_TEST,
    from: String.raw`([^\]]*)\]\(`,
    to: String.raw`([^\]]*)](`,
    expect: "装载本身是一条断言",
  },
  {
    // 线：引用块要在【未转义】的那一行上认（escMd 把 > 变成 &gt;）。改回拿 raw 判 ⇒
    // 整段引用当普通段落渲染，且这条分支是死代码。
    id: "P16-blockquote-escaped",
    file: MD,
    spec: MD_TEST,
    from: "if (/^ {0,3}>/u.test(lines[i])) {",
    to: "if (/^ {0,3}>/u.test(raw)) {",
    expect: "连续引用行合成一个 blockquote",
  },
  {
    // 线：URL 协议白名单是渲染器唯一的防线。放宽成「原样透传」⇒ javascript: 变成可执行 href。
    id: "P17-safeHref-open",
    file: MD,
    spec: MD_TEST,
    from: "  if (/^(?:https?:|mailto:|#|\\/|\\.\\/|\\.\\.\\/)/iu.test(flat)) return url;",
    to: "  if (flat.length > 0) return url;",
    expect: "javascript: 协议落回 #",
  },
];

const only = process.argv[2] || "";
const SELECTED = only ? PROBES.filter((p) => p.id.includes(only)) : PROBES;
if (!SELECTED.length) {
  console.log(`没有 id 含 "${only}" 的探针`);
  process.exit(2);
}

const before = new Map(SELECTED.map((p) => [p.file, sha(p.file)]));
const weird = (p) => {
  const CH = String.fromCharCode(0xfffd);
  const text = readFileSync(p, "utf8");
  return `FFFD_COUNT ${[...text].filter((c) => c === CH).length} BS ${[...text].filter((c) => c === String.fromCharCode(8)).length}`;
};

// ── 预检 A：先把全部锚点与变异量查完，再开始跑用例 ──────────────────
// 逐发边跑边查的话，第 12 发才发现 FROM 不命中，前 11 发的时间白烧。
let bad = 0;
for (const probe of SELECTED) {
  const text = readFileSync(probe.file, "utf8");
  const hits = text.split(probe.from).length - 1;
  if (hits !== 1) {
    console.log(`${probe.id}: FROM 在 ${probe.file} 命中 ${hits} 处（要恰好 1 处）⇒ 脚本过期`);
    bad += 1;
    continue;
  }
  if (text.replace(probe.from, probe.to) === text) {
    console.log(`${probe.id}: 变异是 no-op（字节没变）`);
    bad += 1;
  }
}
if (bad > 0) {
  console.log(`预检 A 失败 ${bad} 发 ⇒ 未改动任何字节，停`);
  process.exit(2);
}

// ── 预检 B：未变异必须绿 ────────────────────────────────────────────
// 只在【还原后】跑控制组不够：开局就是红的话，变异后「红」证明不了任何事。
// 同一 (spec, expect) 只跑一次（状态相同，重跑不出新信息）。
const green = new Map();
for (const probe of SELECTED) {
  const key = `${probe.spec}|${probe.expect}`;
  if (green.has(key)) continue;
  const hits = matchCount(probe.spec, probe.expect);
  if (hits !== 1) {
    console.log(`${probe.id}: grep "${probe.expect}" 命中 ${hits} 条用例（要恰好 1 条）⇒ 停`);
    process.exit(2);
  }
  const base = runRunner(probe.spec, probe.expect);
  green.set(key, base.code === 0);
  console.log(`预检 ${probe.expect}（${probe.spec}）未变异 exit ${base.code}`);
  if (base.code !== 0) {
    console.log(`基线就是红 ⇒ 这批发下来的「红」不可信，先修基线：\n${base.out.slice(-2000)}`);
    process.exit(2);
  }
}

for (const [file, sum] of before)
  console.log(`开局 ${file} sha ${sum.slice(0, 12)} ${weird(file)}`);

let killed = 0;
let restoredOk = 0;
for (const probe of SELECTED) {
  const original = readFileSync(probe.file, "utf8");
  const mutated = original.replace(probe.from, probe.to);
  writeFileSync(probe.file, mutated, "utf8");
  const run = runRunner(probe.spec, probe.expect);
  const killedThis = run.code !== 0;
  if (killedThis) killed += 1;
  writeFileSync(probe.file, original, "utf8");
  const restored = sha(probe.file) === before.get(probe.file);
  if (restored) restoredOk += 1;
  const control = runRunner(probe.spec, probe.expect);
  console.log(
    `${probe.id}: ${killedThis ? "KILLED" : "SURVIVED"}（exit ${run.code}）` +
      ` / 还原后控制组 exit ${control.code} / SHA ${restored ? "一致" : "不一致"}`,
  );
  if (!killedThis) console.log(run.out.slice(-2500));
  if (killedThis && control.code !== 0)
    console.log(
      `!! 控制组也红（还原后仍失败），这发的绿不可信：\n${control.out.slice(-1500)}`,
    );
}
for (const [file, sum] of before)
  console.log(
    `收摊 ${file} sha ${sha(file).slice(0, 12)} ${weird(file)} 目标 ${sum.slice(0, 12)}`,
  );
console.log(
  `合计：killed ${killed}/${SELECTED.length}，SHA 还原一致 ${restoredOk}/${SELECTED.length}`,
);
process.exit(killed === SELECTED.length && restoredOk === SELECTED.length ? 0 : 1);
