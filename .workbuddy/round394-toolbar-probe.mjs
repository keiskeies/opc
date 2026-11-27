import { chromium } from "playwright";

const origin = "http://127.0.0.1:9797";
const browser = await chromium.launch();
const page = await browser.newPage();

async function counts() {
  return page.evaluate(
    `() => {
      const tb = document.querySelector("#listToolbar");
      const content = document.querySelector("#listContent");
      return {
        toolbarChildren: tb ? tb.children.length : -1,
        inputs: tb ? tb.querySelectorAll("input").length : -1,
        selects: tb ? tb.querySelectorAll("select").length : -1,
        tabs: tb ? tb.querySelectorAll(".tabs").length : -1,
        contentChildren: content ? content.children.length : -1,
        docItems: content ? content.querySelectorAll(".doc-list-item").length : -1,
        docTree: content ? content.querySelectorAll(".doc-tree").length : -1,
      };
    }`,
  );
}

async function probe(route, selector, typing) {
  await page.goto(`${origin}/#${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(selector, { timeout: 15000 });
  const before = await counts();
  if (typing) {
    await page.locator(selector).first().pressSequentially("abc", {
      delay: 30,
    });
  }
  const after = await counts();
  return { before, after };
}

const out = {};
out.documents = await probe("/documents", "#docSearch", true);
out.backlog = await probe("/backlog", "#backlogSearch", true);
out.contacts = await probe("/contacts", "#groupSearch", true);
out.talent = await probe("/talent", "#listToolbar .tabs button", false);
out.settings = await probe("/settings", "#listToolbar .tabs", false);
console.log(JSON.stringify(out, null, 2));
await browser.close();
