// round375 正对照（第 2 版，改判据）：证明「载体 0 变化」这个读数的含义。
//
// 第 1 版拿【行数】当尺子，9 个用例全部 false —— 但那不能算证伪，因为量错了东西：
// 中文（CJK）可在任意字后断行，自然断行本来就把每行填满，balance 想平衡也没有余量，
// 所以「行数不变」对中文是【预期内】的，它既可能来自「balance 有效但没东西可改」，
// 也可能来自「balance 根本没生效」—— 两件事在行数这个刻度上长得一样。这正是本仓
// 反复踩的那一族：判据的尺子和被测的性质没有因果，绿/红都不说明问题。
//
// balance 的定义性效果是【各行宽度趋于相等】，所以尺子换成每行的实际墨迹宽度：
// 用 Range.getClientRects() 逐行取矩形宽度，比较「最长行 - 最短行」这个参差量。
// 并配一发【拉丁文】用例：拉丁词只能整词断行，尾部孤词是 balance 的靶心形状，
// 若连它都不动，才真的说明这套环境下 balance 是空操作。
import { chromium } from "playwright";

const ORIGIN = process.env.ORIGIN ?? "http://127.0.0.1:9797";

const CASES = [
  ["latin", "Responsive layout skeleton screens and per viewport screenshot acceptance"],
  ["latin-short", "Group role upper chain end to end acceptance record"],
  ["cjk", "响应式布局与骨架屏打磨专项验收记录（含逐视口截图与四刻度尺子复测）"],
];

const browser = await chromium.launch();
console.log("Chromium:", browser.version());
for (const width of [390, 768, 1440]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/#/contacts`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  for (const [name, text] of CASES) {
    const box = Math.round(width * 0.55);
    const r = await page.evaluate(
      ([t, w, label]) => {
        const host = document.createElement("div");
        host.style.cssText =
          "position:absolute;left:0;top:0;width:" + w + "px;font-size:15px;line-height:22px";
        const h = document.createElement("h3");
        h.textContent = t;
        host.append(h);
        document.body.append(host);
        // 逐行墨迹宽度：Range 选中文本后 getClientRects() 每个矩形≈一行。
        const read = () => {
          const rg = document.createRange();
          rg.selectNodeContents(h);
          const ws = rg.getClientRects().length > 0 ? [...rg.getClientRects()].map((x) => Math.round(x.width)) : [];
          const lines = Math.round(h.getBoundingClientRect().height / 22);
          return { lines, ws, ragged: ws.length ? Math.max(...ws) - Math.min(...ws) : -1 };
        };
        h.classList.add("tw:text-balance");
        const on = read();
        h.classList.remove("tw:text-balance");
        const off = read();
        host.remove();
        return {
          label,
          onLines: on.lines,
          offLines: off.lines,
          onRagged: on.ragged,
          offRagged: off.ragged,
          onWs: on.ws,
          offWs: off.ws,
        };
      },
      [text, box, name],
    );
    const better = r.onRagged >= 0 && r.offRagged >= 0 && r.onRagged < r.offRagged;
    console.log(
      `${String(width).padEnd(5)} ${name.padEnd(11)} 盒宽${box} ` +
        `自然=${r.offLines}行 参差${r.offRagged}px [${r.offWs.join(",")}] → ` +
        `balance=${r.onLines}行 参差${r.onRagged}px [${r.onWs.join(",")}] ` +
        `⇒ ${better ? "参差变小（balance 真在干活）" : r.onLines === r.offLines && r.onRagged === r.offRagged ? "读数完全相同" : "未见变小"}`,
    );
  }
  await ctx.close();
}
await browser.close();
