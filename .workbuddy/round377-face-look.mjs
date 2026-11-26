// 两处以「底色与所在面几乎同值」被报出来的形状，各截一张局部放大：
//  ① admin 浅色 replay：.admin-pill/.admin-tag 坐在 --bg 上，chip 与 bg 逐字节同值（比 1.000）；
//  ② 左导航选中项 .nav-item.active：底走 --surface，与 --rail-bg 比 1.023，形状只靠
//     --shadow-card（5%/7% alpha 的浅投影）撑着 —— 投影到不到得了「读出这一格」这件事。
// 截图不用于自我安慰：判的是「抹���唯一那层读数之后，屏幕上还剩不剩形状」。
import { chromium } from "playwright";

const b = await chromium.launch();

// ① admin 浅色 chip
{
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await pg.goto("http://127.0.0.1:9797/group.html#/admin/replay", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(2000);
  const el = pg.locator(".admin-pill").first();
  const box = await el.boundingBox();
  if (box) {
    await pg.screenshot({
      path: ".workbuddy/round377-chip-on-bg.png",
      clip: { x: Math.max(0, box.x - 60), y: Math.max(0, box.y - 40), width: 420, height: 110 },
    });
  }
  const chain = await el.evaluate((e) => {
    const out = [];
    for (let n = e; n; n = n.parentElement) {
      out.push(`${[...n.classList].join(".") || n.tagName.toLowerCase()}=${getComputedStyle(n).backgroundColor}`);
      if (out.length > 4) break;
    }
    return out.join(" ← ");
  });
  console.log(`① .admin-pill 祖先链：${chain}`);
  await pg.close();
}

// ② 左导航选中项：分别截「原样」与「抹掉 box-shadow」两张，同一位置
{
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await pg.goto("http://127.0.0.1:9797/group.html#/backlog", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1800);
  const rail = await pg.locator(".nav-rail").boundingBox();
  const info = await pg.evaluate(() => {
    const el = document.querySelector(".nav-item.active");
    const cs = getComputedStyle(el);
    return {
      bg: cs.backgroundColor,
      color: cs.color,
      shadow: cs.boxShadow,
      railBg: getComputedStyle(document.querySelector(".nav-rail")).backgroundColor,
      fw: cs.fontWeight,
    };
  });
  console.log(`② .nav-item.active：bg=${info.bg} rail-bg=${info.railBg} fw=${info.fw} shadow=${info.shadow}`);
  if (rail) {
    await pg.screenshot({ path: ".workbuddy/round377-nav-active-shadow.png", clip: { x: rail.x, y: rail.y, width: rail.width + 20, height: 340 } });
    await pg.addStyleTag({ content: ".nav-item.active { box-shadow: none !important; }" });
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: ".workbuddy/round377-nav-active-noshadow.png", clip: { x: rail.x, y: rail.y, width: rail.width + 20, height: 340 } });
    console.log("  已截：有投影 / 抹掉投影 两张同位置对照");
  }
  await pg.close();
}
await b.close();
console.log("截图：round377-chip-on-bg.png / round377-nav-active-shadow.png / round377-nav-active-noshadow.png");
