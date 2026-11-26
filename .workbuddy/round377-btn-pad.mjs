// 窄档按钮横向内距穷举：同一排里 ≥2 枚 .btn 时，它们的 padding-inline 必须同档。
// 起因：round377 的同列表穷举在 390 档报出 div.actions 里 padX=13px|9px ——
// group.css 的 @media(max-width:640px) 只压了 .btn.primary 的 padding，同排普通 .btn 没压。
// 同一次运行里量【现状】与【把 .btn 一起压到 9px 之后】，避免分两次跑把差异归错。
import { chromium } from "playwright";

const PROBE = () => {
  const rows = [];
  for (const parent of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(parent);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const kids = [...parent.children].filter((k) => {
      const s = getComputedStyle(k);
      const r = k.getBoundingClientRect();
      return k.classList.contains("btn") && s.display !== "none" && s.visibility !== "hidden" && r.width > 1 && r.height > 1;
    });
    if (kids.length < 2) continue;
    const vals = [...new Set(kids.map((k) => getComputedStyle(k).paddingLeft))].sort();
    rows.push({
      parent: `${parent.tagName.toLowerCase()}.${[...parent.classList].join(".")}`,
      pad: vals,
      items: kids.map((k) => `${[...k.classList].join(".")}=${getComputedStyle(k).paddingLeft}:${getComputedStyle(k).paddingRight}|${(k.textContent || "").trim().slice(0, 6)}`),
    });
  }
  return rows;
};

const b = await chromium.launch();
for (const w of [1440, 640, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const pg = await ctx.newPage();
  console.log(`\n== viewport ${w} ==`);
  for (const hash of ["#/backlog", "#/messages", "#/documents", "#/settings"]) {
    await pg.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(1100);
    const before = await pg.evaluate(PROBE);
    const mixed = before.filter((r) => r.pad.length > 1);
    console.log(`  ${hash} 现状：一排内 ≥2 枚 .btn 的排 ${before.length} 组 · 内距不同档 ${mixed.length} 组`);
    for (const r of mixed) console.log(`    · ${r.parent} ⇒ ${r.items.join("  ")}`);
    if (mixed.length === 0) continue;
    // 正向对照：把「.btn 全部压到 9px」这条候选修法临时注进去，混数组必须归零。
    // 报不出变化 = 候选修法压根没生效（级联压不住），不能拿它去改 CSS。
    await pg.addStyleTag({ content: ".btn { padding: 6px 9px; }" });
    await pg.waitForTimeout(300);
    const after = (await pg.evaluate(PROBE)).filter((r) => r.pad.length > 1);
    console.log(`    注入「.btn 一并压到 9px」后混档：${after.length} 组${after.length > 0 ? ` ⇒ ${after.map((r) => `${r.parent}:${r.pad.join("/")}`).join("  ")}` : ""}`);
  }
  await ctx.close();
}
await b.close();
