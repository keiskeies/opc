// 台账追加 round378 / round379 两条（四件套之③）。
// 为什么走 .mjs 而不是 shell heredoc：本仓被 shell 咬中文咬过三次（BOM/码点截断），
// 台账是 UTF-8 主证据，一个字都不能错。写完必查 U+FFFD=0。
// 用法（等 round378-pane-mutations-r3.log 出「合计」后填好 r3 计数再跑）：
//   node .workbuddy/round379-ledger-append.mjs
import { readFileSync, appendFileSync } from "node:fs";

const LEDGER = "D:/item/opc/.workbuddy/AUDIT-LEDGER.txt";
const src = readFileSync(LEDGER, "utf8");

const ENTRY_378 = `
round378（2026-11-26）— 文档编辑器分栏预览落地；一支探针的【变异自己不是那件坏事】被抓两次
--------------------------------------------------------------------------------

【需求与落地】用户：「文档的编辑页面, 文档区域太小了…markdown需要有 预览 以及分两栏的
  左边编辑右边预览」。落地形状（全部零构建、离线 vendored）：
  · packages/web/public/markdown.js —— 新渲染器：标题/列表/代码块/引用/链接白名单。
    :26 的 [\\u0000-\\u0020\\u007f] 剥控制符是 safeHref 的【防线】（javascript: 协议拆分绕过），
    :38/:66 的 \\u0000(\\d+)\\u0000 是行内码占位哨兵的写读两端成对。
  · group.css .editor-panes[data-mode] —— 源码面/预览面同挂一层弹性容器，谁显示由 CSS 分派；
    栏基准写 50% 而不是 1 1 50%（内距差会从另一栏借，:1073 注释有实测 487.5/496.5 的账）。
  · group.js mountPanes 把分栏容器【装进】水位面：.editor-surface 同时是 queueDraft 读
    data-draftBody（:4783）与 restoreDraft 找 textarea（:5861）的锚点，顶替它=草稿整条静默失效。
  · 页签条/草稿条各是一条 flex:0 0 auto 的带，正文吃剩下的分（.editor-panes flex:1 1 auto）。
  · 新测试 test/e2e/doc-preview.spec.ts（形态记忆/aria-pressed/草稿链）+ test/web/markdown.test.ts
    （23 发，含 javascript: 协议落回 # 的反面断言）。

【⭐ 最贵的一条：P9 存活 ⇒ 顺着「先怀疑判据」查到第三步，发现问题在【变异】不在判据】
  P9-mount-replaces-surface 的线是「分栏装进水位面而不是顶替它」。三刀：
    第一刀 append→replaceChildren：【存活】。查 group.js 才看清：watermark 在 :4693 现造，
      markdown/mindmap 两支走到 mountPanes 时一子未挂（挂 toolbar 的是互斥的 doc 支、挂
      sheetHost 的是 sheet 支）⇒ paneHost 是当时唯一子节点，两种写法产出同一棵树。
      等价变异 —— 判据再准也量不到不存在的差别。这不是「声明不承重」（round376 margin-top
      那种），是【变异不承重】：变异自己不是那件坏事。
    第二刀 append→replaceWith：会把编辑面整个弄没（此刻 watermark 还没挂进 editor-card，
      装配在 :5249；无父节点的 replaceWith 按规范直接 return）⇒ 判据会以「页面没了」这种
      【不相干的理由】变红。这种红比存活更糟：它让你以为防线接住了。
    第三刀 append→watermark.after(paneHost)：分栏照旧渲染、照旧能打字，但 input 冒泡不到
      水位面 ⇒ captureDraft 从不触发 ⇒ data-draftBody 停在初始正文 —— 正是注释里那件坏事，
      判据按【它自己的那条消息】变红。
  教训一句话：剪线变异要过的标准不是「删了字节」，是【产出真·那件坏事的状态】；
  等价变异（两写法同树）与湮灭变异（页面塌了红得理直气壮）都算不合格刀具。
  证据：.workbuddy/round378-pane-mutations-r3.log（17 发全 KILLED，SHA 还原一致 17/17；
  r2 里 P8 填全锚点后 KILLED、P9 存活触发本节）。

【探针退役：P5-min-width-zero】剪的是 .editor-panes>* 的 min-width:0 —— 那条声明本身在
  round379 被实测判成重言（同规则 overflow:auto 已让它成为滚动容器，滚动容器的自动最小尺寸
  按规范就是 0；1440/1000/700 三档 × 长代码 × 宽表实测 0 与 auto 逐像素相同，
  round379-minwidth-narrow.mjs + group.css:1075 注释）。剪线存活 ⇒ 先怀疑声明：声明已抹，
  探针随行删除、「豁免不许比现实活得久」。锚点预检器（round378-check-pane-anchors.mjs）
  从此对 17 发报「全部锚点可用」。

【lint 基线登记一条】lint-baseline.ts 加 noControlCharactersInRegex atMost:3 ——
  全部在 markdown.js（见上），三条都是【刻意】。处置选登记不选就地 biome-ignore：
  markdown.js 正是 P15/P16/P17 的锚点文件，往里面插注释会让已落的证据 log 与坐标失效。

【状态】全部未 commit（用户未要求提交，HEAD 仍是 e7b56fb）。
  回归读数：vitest 2 failed | 4111 passed | 6 skipped（4119，round379-vitest-full.log 同态）；
  e2e 全量 55 passed（round378-e2e-full.log）；markdown.test.ts 23 发单跑全绿。
`;

const ENTRY_379 = `
round379（2026-11-26）— 全站紧凑化（重档）：一把【量关系不量取值】的新尺子，与地板吸收第二次复发
--------------------------------------------------------------------------------

【需求与定盘】用户：「其他页面呢? 我希望稍微再紧凑一点, 当前所有页面的空白地方太多了」。
  AskUserQuestion 两问答复：力度=【重档：再加密度刻度 + 动 topbar】；空态=【保留空态卡，
  只收外围】⇒ .state{min-height:210px} / .board-column{min-height:220px} 一律不动。

【落地】group.css 一张改动 + 一份新守卫：
  · --topbar-height 64→52（640 窄档另有一条刻意 57px：.topbar:1528 sticky 与 .workspace:1543
    同档配对，:233 注释在案）；.topbar/.workspace 两处全部只吃 var，字面值清零。
  · .page padding 24/28/50 → 16/20/32；.card 内距、块缝刻度（页头/英雄区/页签/横幅的
    margin-bottom 全等一个「分段缝」，相邻卡 margin-top 严格小于它 = 「分组缝」）；
    --fs-* 密度刻度收一档；.conversation-item padding 收到 8px 9px。
  · 穷举在案：round379-scope-map.mjs / round379-detail.mjs（逐页量改前留白，
    round379-whitespace-audit-before.out / -after.out 前后对账 —— 收的是顶栏/页边距/缝，
    空态尾部死区按用户答复【不动】，所以「尾部」读数不因本轮变小，别把它误读成漏改）。

【⭐ 新守卫 test/web/compact-scale.test.ts（31 发）：为什么长这样】
  改完 e2e 56 发全绿且【一条没动过】—— 这恰好证明没有任何既有判据承重这些关系。
  紧凑化最容易复发的不是改坏，是下一轮被悄悄改回去，而那种改法全都不会让现有测试红。
  尺子取【关系】不取取值（①~⑥）：顶栏单一来源 / 断点越窄越紧单调 / 卡片内距≥外距 /
  页边距>块缝 / 分段缝全等且分组缝严格小于 / 选中条随内距内缩 0~4px —— 一条都不钉字面像素，
  否则就犯 round377 那条（判据写死的值在「值本身可改」的轮次必红）。
  关系判据对【整体等比放松】天然失明 ⇒ 再加两道【单向】绝对闸：⑧ 顶部合计 ≤28px、
  ⑨ 刻度上限表只许收不许放（往回放才红；动表唯一正当写法=在那行写理由）。
  ⑦ 空态地板单向着色（只许变大）—— 用户「保留空态卡」那条答复的机器可读形式。
  每条 src=>string[] 纯函数都先在故意做坏的合成 CSS 上自证能报问题（提取器坏了守卫会常绿）。
  变异机 round379-compact-mutations.mjs 22/22 KILLED、SHA 还原 22/22
  （注释改后在新基线 sha256 ceb32a94c97b 重跑：round379-compact-mutations-after-comments.log）。

【地板吸收第二次复发：T4 拆成 T4a/T4b】round376 立的「整行行盒 <60」在这轮 padding
  20→16 之后被【悄悄解除武装】：当年照它标定的变异（摘 line-height）现在整行只走 54.14
  （round379-rowbox-after.log inheritBody 也才 56.73，全在 60 之下）。阈值是【别的输入的旧函数】
  —— 与 round376「绿了几轮从没成立过」同族。处置不是把 60 改成 55（那是把尺子重新钉在
  本轮取值上，重蹈覆辙），是换尺子形状：
    T4a 量那根线【直接吹胀的那一格】：prevH ≤ fontSize×1.45（绿 16.19 / 摘声明 18.59 红），
      对 padding 怎么动都免疫；
    T4b 整行 <60 保留、只兜地板总量，注释里【明写】它已抓不到 padding 回退与 line-height 回退。
  变异机 round379-t4-mutations.mjs 4/4 符合期望：Q1 摘声明/Q2 放宽 1.5/Q3 窄档摘声明 全 KILLED；
  Q4（padding 8→10 期望【存活】）是【反向探针】——它 falsify-or-confirm 的正是我上面那句
  「T4b 管不到 padding」的职责边界声明。反向探针的用处：文档里的免责条款从此有了判据。

【坐标重钉四条（四件套之④，原地加批注不改旧文）】round379-ledger-repin.mjs 在四处旧主张
  紧随块插「坐标重钉 · round379」：上文 round368 的 calc(100vh - 64px)（现 var(--topbar-height)
  在 group.css:581）、round369 W4 的「正文宿主 ≤1484」（该断言已随 round370 翻向不存在，
  1540 只剩反向那发在 doc-layout.spec.ts:714-716 守其余路由）、round376 的 .kind-icon:560
  （现 :718）与「padding 20 + 地板 38 = 58」（现 16+38=54，地板 38 未动）、
  T4 阈值账 58.33（现 54.33，阈值 60 原样）。

【状态】全部未 commit（用户未要求提交，HEAD 仍是 e7b56fb）。
  回归读数（2026-11-27 凌晨全量）：vitest 2 failed | 4111 passed | 6 skipped（4119，
  round379-vitest-full.log）—— 两发红都是 sheet-editor 那一摊：.workbuddy/scratch/probe-sheet.spec.ts
  不被任何 runner 收（test-inventory 报）+ test/e2e 的 29 个类型错在 TYPE_BASELINE 之外
  （test-type-baseline 报，棘轮按设计工作，【不许】为让它绿把 test/e2e 登进表 —— 要先跟用户对齐）；
  全量 Playwright 56 passed（round379-e2e-full-2.log，含 doc-preview 14 发）；
  biome 净新增 0（新类目 3 条已登记，见 round378 条）；compact-scale 单跑 31/31。
`;

const TEXT = ENTRY_378 + ENTRY_379;
if (src.includes("round379（2026-11-26）— 全站紧凑化")) {
  console.log("round379 条目已在位 ⇒ 跳过（幂等）");
  process.exit(0);
}
const fffd = TEXT.split("\uFFFD").length - 1;
console.log(`待写 FFFD ${fffd}，字符数 ${TEXT.length}`);
if (fffd !== 0) process.exit(1);
if (!src.endsWith("\n")) appendFileSync(LEDGER, "\n", "utf8");
appendFileSync(LEDGER, TEXT, "utf8");
const after = readFileSync(LEDGER, "utf8");
console.log(
  `写入完成 行数 ${after.split("\n").length} 全文件 FFFD ${after.split("\uFFFD").length - 1}`,
);
