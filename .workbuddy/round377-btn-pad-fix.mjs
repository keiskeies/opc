// 窄档按钮内距：两种修法的对照量法。
// 现状：@media(max-width:640px) 只压 .btn.primary ⇒ 同排 .btn 仍 13px（内距不同档）。
// 修法 A：整排压到 9px（跟 primary 走）；修法 B：撤掉这条覆盖，primary 退回 13px。
// 选哪个不看美观，看两件事：① 内距是否同档；② 会不会把 .actions 撑出横向溢出
// （390 档 e2e 里钉着 scrollWidth <= innerWidth，撑了就红）。
import { chromium } from "playwright";

const MEASURE = () => {
  const rows = [];
  for (const parent of document.querySelectorAll(".actions")) {
    const kids = [...parent.children].filter((k) => k.classList.contains("btn") && k.getBoundingClientRect().width > 1);
    if (kids.length < 2) continue;
    rows.push({
      pad: [...new Set(kids.map((k) => getComputedStyle(k).paddingLeft))].sort().join("|"),
      // 这一排自己有没有被挤到溢出（内容宽 > 可视宽）
      rowOverflow: parent.scrollWidth > parent.clientWidth,
      rowW: Math.round(parent.getBoundingClientRect().width),
      contentW: parent.scrollWidth,
      labels: kids.map((k) => (k.textContent || "").trim().slice(0, 4)).join(","),
    });
  }
  return {
    rows,
    docOverflow: document.documentElement.scrollWidth > window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
  };
};

const b = await chromium.launch();
const CASES = [
  ["现状（只压 primary）", ""],
  ["修法A（整排 9px）", ".actions > .btn { padding: 6px 9px; }"],
  ["修法B（primary 退回 13px）", ".actions > .btn.primary { padding: 6px 13px; }"],
];
for (const w of [640, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const pg = await ctx.newPage();
  for (const [name, css] of CASES) {
    console.log(`\n== viewport ${w} · ${name} ==`);
    for (const hash of ["#/backlog", "#/messages", "#/documents"]) {
      await pg.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
      await pg.waitForTimeout(1100);
      if (css !== "") await pg.addStyleTag({ content: css });
      await pg.waitForTimeout(250);
      const m = await pg.evaluate(MEASURE);
      const mixed = m.rows.filter((r) => r.pad.includes("|")).length;
      console.log(
        `  ${hash} 内距档 ${m.rows.map((r) => r.pad).join(" / ")} · 不同档 ${mixed} · ` +
          `排内溢出 ${m.rows.filter((r) => r.rowOverflow).length}/${m.rows.length} · ` +
          `文档横向溢出 ${m.docOverflow ? `是(${m.scrollW}>${m.innerW})` : "否"}`,
      );
      for (const r of m.rows) console.log(`      ${r.labels} ⇒ 排宽 ${r.rowW} 内容 ${r.contentW}`);
    }
  }
  await ctx.close();
}
await b.close();
