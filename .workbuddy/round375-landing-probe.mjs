// 落点实测（round374 · tw:text-balance 的 8 处 landing）。
//
// 为什么不能只靠「类名加了 + 产物里有规则」就收工：tailwind-wiring 钉的是「源里每个
// tw:* 在产物里有规则」，tw-cascade 钉的是「整页样式在场时这枚 utility 会生效」——
// 两条都不看【具体那一个元素】。类名拼错、h() 把 class 覆盖掉、那条渲染路径根本没走到，
// 三种都会让「我改了 8 处」与「页面上 0 处生效」同时成立。
//
// 所以这份探针把每个落点分成【三档】而不是通过/失败两档 —— 这一刀是分数的关键：
//   RENDERED  元素在场且算出 balance                ⇒ 真验到了
//   GATED     该落点的渲染路径当前无数据（元素不在） ⇒ 只验 binding，明说不假装
//   BROKEN    元素在场却读不到 balance                ⇒ 真故障
// 第一版只有两档，于是 backlog/documents/talent/admin 四条「库里没数据」被报成失败，
// 而失败与「类名根本没接上」在报告里长得一模一样 —— 分不清这两者，探针就等于没测。
// GATED 那一档补一发 binding 断言：把【该站点自己的 class 串 + utility】建一个节点挂进
// 真页面再读它。这证的是「这个类名组合在这套真样式表下确实产出 balance」，
// 不证「这个站点会渲染」—— 两句话分开说，正是这份文件要守住的那条界限。
import { chromium } from "playwright";

const ORIGIN = process.env.ORIGIN ?? "http://127.0.0.1:9797";

/** [路由, 站点自身选择器（不含 utility）, 说明, 建 binding 节点时套的标签] */
const SITES = [
  ["contacts", ".state h3", "空态标题 emptyState()（一处覆盖 ~15 个空态）", "h3"],
  ["backlog", ".group-task-title", "待办卡标题", "span"],
  ["documents", ".group-document-title", "文档卡标题", "strong"],
  ["talent", ".entry-heading h3", "研究条目卡标题", "h3"],
  ["admin/today", ".admin-s", "管理视图看板任务标题", "div"],
  ["admin/today", ".admin-row h3.admin-grow", "管理抽屉标题", "h3"],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 140)));

let rendered = 0;
let gated = 0;
const broken = [];
for (const [route, base, what, tag] of SITES) {
  await page.goto(`${ORIGIN}/#/${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1900);
  const raw = await page.evaluate(
    ([b, t]) => {
      const els = [...document.querySelectorAll(b)];
      const withU = els.filter((e) => e.classList.contains("tw:text-balance"));
      const vals = [...new Set(withU.map((e) => getComputedStyle(e).getPropertyValue("text-wrap")))];
      // 对照组：同站点【没挂】utility 的兄弟元素，必须还是 initial。
      const peers = els.filter((e) => !e.classList.contains("tw:text-balance"));
      const peerVals = [...new Set(peers.map((e) => getComputedStyle(e).getPropertyValue("text-wrap")))];
      // binding：只挂【这一枚 utility】建一个节点进真页面读一次。证的是「这个类名在
      // 这套真样式表下确实产出 balance」；「站点自己的 class 会不会也写 text-wrap」由
      // 上面那个未挂对照回答，两件事不混成一个读数。
      const probe = document.createElement(t);
      probe.className = "tw:text-balance";
      document.body.append(probe);
      const binding = getComputedStyle(probe).getPropertyValue("text-wrap");
      probe.remove();
      // 整页对照：什么都不挂的同类节点必须是 initial（否则下面所有 balance 都不值钱）。
      const bare = document.createElement(t);
      document.body.append(bare);
      const initial = getComputedStyle(bare).getPropertyValue("text-wrap");
      bare.remove();
      return JSON.stringify({
        n: els.length,
        nU: withU.length,
        vals,
        peerVals,
        binding,
        initial,
      });
    },
    [base, tag],
  );
  const g = JSON.parse(raw);
  const clean = g.initial.startsWith("wrap");
  let state;
  if (!clean) {
    state = "BROKEN";
    broken.push(`${route} ${what}：窗口不干净，裸节点读到 ${g.initial}`);
  } else if (g.nU > 0 && g.vals.length === 1 && g.vals[0] === "balance") {
    state = "RENDERED";
    rendered += 1;
  } else if (g.nU === 0) {
    state = g.binding === "balance" ? "GATED" : "BROKEN";
    if (state === "GATED") gated += 1;
    else broken.push(`${route} ${what}：元素不在场且 binding 读 ${g.binding}`);
  } else {
    state = "BROKEN";
    broken.push(`${route} ${what}：在场 ${g.nU} 枚却读到 ${g.vals.join("/")}`);
  }
  console.log(
    `${state.padEnd(8)} ${route.padEnd(12)} ${what.padEnd(34)} ` +
      `在场 ${g.n}（挂 utility ${g.nU}）text-wrap=${g.vals.join("/") || "—"} ` +
      `binding=${g.binding} 裸节点=${g.initial}` +
      (g.peerVals.length ? ` 未挂对照=${g.peerVals.join("/")}` : ""),
  );
}
await browser.close();
console.log(
  `\nRENDERED ${rendered}｜GATED ${gated}｜BROKEN ${broken.length}` +
    (errs.length ? `；pageerror：${errs.join(" | ")}` : ""),
);
for (const b of broken) console.log(`  ✘ ${b}`);
console.log(
  "\nGATED = 该视图当前库里没有数据（.admin-tk / .group-task-title / .group-document-title /" +
    "\n         .entry-heading 的渲染条数为 0），只证到「这个 class 组合在这套真样式表下产出" +
    "\n         balance」，没有证到「这条渲染路径跑起来时会挂上它」。台账按这句话记账。",
);
