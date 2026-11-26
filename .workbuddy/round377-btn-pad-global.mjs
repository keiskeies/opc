// 窄档「整排 .btn 压到 9px」这条修法的全页面体检：
// 不能只在 .actions 那一排证明它没副作用 —— 媒体查询里的 .btn 覆盖会影响窄屏上【所有】按钮。
// 所以每屏量三件事：① 是否还有同一排内距不同档；② 文档是否横向溢出；
// ③ 按下按钮后文字有没有被内距挤掉（scrollWidth > clientWidth 的那一类截断）。
import { chromium } from "playwright";

const PROBE = () => {
  const rows = [];
  for (const parent of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(parent);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const kids = [...parent.children].filter(
      (k) => k.classList.contains("btn") && k.getBoundingClientRect().width > 1,
    );
    if (kids.length < 2) continue;
    rows.push([...new Set(kids.map((k) => getComputedStyle(k).paddingLeft))].sort().join("|"));
  }
  const clipped = [...document.querySelectorAll(".btn")]
    .filter((b) => b.getBoundingClientRect().width > 1 && b.scrollWidth > b.clientWidth + 1)
    .map((b) => `${[...b.classList].join(".")}:${(b.textContent || "").trim().slice(0, 8)}`);
  return {
    mixed: rows.filter((r) => r.includes("|")),
    allPads: [...new Set(rows)],
    clipped,
    docOverflow: document.documentElement.scrollWidth > window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
  };
};

const b = await chromium.launch();
for (const mode of ["现状", "修法A"]) {
  for (const w of [640, 390]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
    const pg = await ctx.newPage();
    console.log(`\n== ${mode} · viewport ${w} ==`);
    for (const hash of ["#/backlog", "#/messages", "#/documents", "#/settings", "#/talent", "#/contacts", "#/admin/today"]) {
      await pg.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
      await pg.waitForTimeout(1200);
      if (mode === "修法A") await pg.addStyleTag({ content: ".btn { padding: 6px 9px; }" });
      await pg.waitForTimeout(250);
      const m = await pg.evaluate(PROBE);
      console.log(
        `  ${hash} 内距档 ${m.allPads.join(" / ") || "(无 ≥2 枚的排)"} · 混档 ${m.mixed.length} · ` +
          `截断 ${m.clipped.length}${m.clipped.length > 0 ? ` [${m.clipped.join(", ")}]` : ""} · 横向溢出 ${m.docOverflow ? `是(${m.scrollW})` : "否"}`,
      );
    }
    await ctx.close();
  }
}
await b.close();
