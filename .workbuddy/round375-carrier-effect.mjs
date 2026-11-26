// round375 载体效果实测（第 2 版，尺子换对）：挂上 tw:text-balance 后【每行墨迹宽度】变没变。
//
// 第 1 版拿元素【高度】当尺子，读出「31 枚载体，0 枚高度变化」。这个数当时被我读成
// 「utility 接上了但没有视觉收益」—— 错。text-wrap:balance 的定义性效果是【把各行拉齐】，
// 它通常会保持行数不变、只挪断词点，所以高度本来就不该动。用高度量它，等于拿米尺量温度：
// 「0 变化」是量错时刻/量错属性得来的，正属本仓踩过的那一族「绿了不等于成立」。
// 判据的尺子必须与被测性质有因果 —— 这里换成 Range.getClientRects() 逐行取宽度，
// 比较「最长行 − 最短行」这个参差量。
//
// 同元素开关（挂 → 量 → 摘 → 量 → 装回）比「两份指纹文件对比」干净：
// 指纹的键里带类名，加类本身就把键改了，差异里混着在场性变化，分不清是几何动了还是键动了。
import { chromium } from "playwright";

const BS = String.fromCharCode(92);
const ORIGIN = process.env.ORIGIN ?? "http://127.0.0.1:9797";
const ROUTES = ["messages", "contacts", "documents", "backlog", "talent", "settings", "admin/today"];

const browser = await chromium.launch();
let total = 0;
let improved = 0;
let flat = 0;
let worse = 0;
const rows = [];
for (const width of [390, 768, 1440]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  for (const route of ROUTES) {
    await page.goto(`${ORIGIN}/#/${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    const out = await page.evaluate(
      ([sel]) => {
        const res = [];
        for (const e of document.querySelectorAll(sel)) {
          const cs = getComputedStyle(e);
          const lh = Number.parseFloat(cs.lineHeight) || 20;
          const read = () => {
            const rg = document.createRange();
            rg.selectNodeContents(e);
            const ws = rg.getClientRects().length ? [...rg.getClientRects()].map((x) => Math.round(x.width)) : [];
            const lines = Math.max(1, Math.round(e.getBoundingClientRect().height / lh));
            return { lines, ws, ragged: ws.length ? Math.max(...ws) - Math.min(...ws) : -1 };
          };
          const on = read();
          const hOn = e.getBoundingClientRect().height;
          e.classList.remove("tw:text-balance");
          const off = read();
          const hOff = e.getBoundingClientRect().height;
          e.classList.add("tw:text-balance");
          res.push({
            cls: [...e.classList].join(".").slice(0, 46),
            txt: (e.textContent || "").slice(0, 22),
            onLines: on.lines,
            offLines: off.lines,
            onRagged: on.ragged,
            offRagged: off.ragged,
            onWs: on.ws,
            offWs: off.ws,
            heightMoved: Math.abs(hOn - hOff) > 0.5,
          });
        }
        return res;
      },
      [`.tw${BS}:text-balance`],
    );
    for (const c of out) {
      total += 1;
      const verdict =
        c.onRagged < c.offRagged ? "变齐" : c.onRagged > c.offRagged ? "更参差" : "相同";
      if (verdict === "变齐") improved += 1;
      else if (verdict === "相同") flat += 1;
      else worse += 1;
      rows.push(
        `${String(width).padEnd(5)} ${route.padEnd(12)} ${c.cls.padEnd(46)} ` +
          `行 ${c.offLines}→${c.onLines} 参差 ${c.offRagged}→${c.onRagged}px ${verdict} ` +
          `高度动=${c.heightMoved} | ${c.txt}`,
      );
    }
    if (errs.length) console.log(`!! ${width}/${route} pageerror:`, errs.join(" | "));
  }
  await ctx.close();
}
await browser.close();
console.log(rows.join("\n"));
console.log(
  `\n合计载体 ${total}：参差变小 ${improved}｜不变 ${flat}｜更参差 ${worse}` +
    `\n说明：单行载体参差恒为 0px，落在「不变」里 —— 那是数据的性质（标题够短），不是改动的性质。`,
);
