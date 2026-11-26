// round370 变异机：逐根剪线 → 跑对应测试 → 立刻按 SHA 还原（自回滚）。
//
// 规矩（沿用 round360/367 的形状）：
//  · 每根线用 replace 真抹掉源码里的字节，不许只改注释；
//  · 剪线后跑【该线对应的测试】，红 = KILLED，绿 = SURVIVED（说明测试不承重）；
//  · 无论红绿都先还原，再核对 SHA 与剪线前一致；不一致就停下人来。
//  · 本脚本一次只动一个文件，且一次一根线。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const MUTATIONS = [
  {
    id: "M1-hashchange-unmounted-gate",
    file: "packages/web/public/app.js",
    from: '  if (!mounted && !standalone.nav) return;\n  void syncAdminFromHash(location.hash);',
    to: "  void syncAdminFromHash(location.hash);",
    // 剪掉「未挂载且不在独立页就闭嘴」这道门。第一轮用 e2e 当尺子 ⇒ SURVIVED，
    // 复算后确认这不是测试不承重，是行为本来就不可达：宿主六个 data-nav 没有一个
    // 撞得上 ROUTES 七页，syncAdminFromHash 自己的 ROUTES.some 是第一道门。
    // 它是一道【够不着症状】的防御层 ⇒ 尺子换成 renderer-criteria 里的源码钉。
    cmd: "npx",
    args: ["vitest", "run", "test/web/renderer-criteria.test.ts"],
  },
  {
    id: "M2-chip-query-branch",
    file: "packages/web/public/group.js",
    from: '    (id ?? "").includes("?")\n  ) {',
    to: "    false\n  ) {",
    // 摘掉窗口 chip 那条 ? 分支：chip 写的 #/admin/today?window=7d 会被 setRoute
    // 再编码成 today%3Fwindow%3D7d。承重测试：本轮新写的那条 chip e2e（URL 无 %3F
    // + 选中态仍是今日页 + chip active 跟着窗口读数）。
    cmd: "npx",
    args: [
      "playwright",
      "test",
      "test/e2e/group-workbench.spec.ts",
      "-g",
      "窗口 chip 过一遍宿主",
      "--reporter=list",
    ],
  },
  {
    id: "M3-setRoute-page-name-carry",
    file: "packages/web/public/group.js",
    from: '  const hashId = route === "admin" ? adminPage : id;',
    to: "  const hashId = id;",
    // 页名不再进 hash：点侧栏入口得到 #/admin，点进看板再点侧栏会掉页名。
    cmd: "npx",
    args: [
      "playwright",
      "test",
      "test/e2e/group-workbench.spec.ts",
      "-g",
      "直达保住页名",
      "--reporter=list",
    ],
  },
  {
    id: "M4-getToday-cache-unwrap",
    file: "packages/web/public/app.js",
    from: "    return windowMs === undefined ? c : c.data;",
    to: "    return c.data;",
    // 本轮 e2e 真抓到的那个 bug 的形状：两份缓存都按 {windowMs,data} 解包。
    // 承重测试：新钉的那条源码守卫（含正向对照 —— toContain 那半保证剪线不会
    // 因为「两边都不在」而双向通过）。
    cmd: "npx",
    args: ["vitest", "run", "test/web/renderer-criteria.test.ts"],
  },
  {
    id: "M5-mount-export-currentPage",
    file: "packages/web/public/app.js",
    from: "currentPage,",
    to: "",
    // 函数在、忘 export —— 装载器拿到的 exportedNames 少一枚。
    cmd: "npx",
    args: ["vitest", "run", "test/web/app-pure.test.ts"],
  },
  {
    id: "M6-admin-mount-nav-hidden-attr",
    file: "packages/web/public/group.js",
    from: '        class: "admin-mount-nav",\n        "aria-label": "主导航",\n        hidden: true,',
    to: '        class: "admin-mount-nav",\n        "aria-label": "主导航",',
    // 摘掉挂载态页眉导航的 hidden 属性。原 M6 剪的是 .admin-mount .admin-mount-nav
    // {display:none} 那条规则 —— 第一轮 SURVIVED 复算后确认：那条规则排在 hidden
    // 属性之后、永远量不到失败，是假守卫，已整条拆除。真承重的这对线（属性 +
    // group.css:46 的 !important）各剪一发：属性没了，admin.css 的
    // .admin-root nav{display:flex} 稳压 UA 的 [hidden] ⇒ 顶栏下多一份可点菜单，
    // e2e 的 toHaveJSProperty/toBeHidden 当场红。
    cmd: "npx",
    args: [
      "playwright",
      "test",
      "test/e2e/group-workbench.spec.ts",
      "-g",
      "侧栏入口把控制室挂在右侧内容区",
      "--reporter=list",
    ],
  },
  {
    id: "M7-hidden-important-drop",
    file: "packages/web/public/group.css",
    from: "[hidden] { display: none !important; }",
    to: "[hidden] { display: none; }",
    // 另一枚线：去掉 !important。[hidden]{display:none} 特异度只有 0,1,0，压不住
    // admin.css 的 .admin-root nav{display:flex}(0,1,1) ⇒ hidden 属性形同虚设，
    // 同一发 e2e 当场红（这条同时也是全工作台其它 hidden 节点的线，红面只会更大）。
    cmd: "npx",
    args: [
      "playwright",
      "test",
      "test/e2e/group-workbench.spec.ts",
      "-g",
      "侧栏入口把控制室挂在右侧内容区",
      "--reporter=list",
    ],
  },
];

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const OPTS = { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 };
const run = (m) => spawnSync(m.cmd, m.args, OPTS);
// -g 的标题里有中文，而中文过 argv 会变 U+FFFD（本轮已犯过两次）。playwright
// 对「一条没匹配到」退非零 —— 不预热的话 0 测试也会被记成 KILLED，假绿。
// 所以每把 -g 尺子在【剪线之前】先空跑一次：必须恰好匹配到测试才准开工。
for (const m of MUTATIONS) {
  if (!m.args.includes("-g")) continue;
  const r = run(m);
  if ((r.status ?? -1) !== 0 || /No tests found/iu.test(`${r.stdout}${r.stderr}`)) {
    console.log(`⛔ 预热失败：${m.id} 的 -g 一条测试都没匹配到（多半是中文过 argv 被烤坏），未动任何源码。`);
    process.exit(3);
  }
}
const results = [];
for (const m of MUTATIONS) {
  const orig = readFileSync(m.file, "utf8");
  const before = sha(orig);
  if (!orig.includes(m.from)) {
    results.push(`${m.id}: SKIP（锚点不在场 —— 坐标已漂，先重钉再跑）`);
    continue;
  }
  if (orig.split(m.from).length !== 2) {
    results.push(`${m.id}: SKIP（锚点不唯一，替换会误伤）`);
    continue;
  }
  writeFileSync(m.file, orig.replace(m.from, m.to), "utf8");
  const r = run(m);
  const exit = r.status ?? -1;
  writeFileSync(m.file, orig, "utf8");
  const after = sha(readFileSync(m.file, "utf8"));
  const restored = after === before;
  results.push(
    `${m.id}: ${exit === 0 ? "SURVIVED（exit 0）" : "KILLED（exit " + exit + "）"} / 还原 ${restored ? "SHA 一致" : "SHA 不一致！"}`,
  );
  if (!restored) {
    console.log(results.join("\n"));
    console.log("⛔ 还原失败，停在这里人工核对：" + m.file);
    process.exit(2);
  }
}
console.log(results.join("\n"));
const killed = results.filter((r) => r.includes("KILLED")).length;
console.log(`合计：killed ${killed}/${MUTATIONS.length}，还原一致 ${MUTATIONS.length}/${MUTATIONS.length}`);
