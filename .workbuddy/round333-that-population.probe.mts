// If I add 那个/这/里的 to the POS_AFTER wording set, how many corpus lines newly
// fire? Measure before widening the rule — a wording set widened on one example
// is the same mistake as a named exemption list (isRetracted 那条家规).
import { CN_LINE_RE, decisionRows, markdownRows } from "../test/arch/doc-coords.js";
const NOW: RegExp = /(今天|如今|此刻|目前|现在)/;
const THEN: RegExp = /(当时|当年|那时|此前|曾|原本|原写|原是|原来|后来|漂|挪|顶|改成|改为|旧|那一版|写作|一度|修之前|改之前)/;
const CUR: RegExp = /^\s*(就是|才是|即|写的是|住的是|装的是)/;
const WIDE: RegExp = /^\s*(那个|这个|那行|这行|那格|那句|，那个|那个)/;
let cur = 0, wide = 0;
const extra: string[] = [];
for (const rows of [decisionRows(), markdownRows()])
  for (const r of rows) r.lines.forEach((l, i) => {
    if (!NOW.test(l) || THEN.test(l)) return;
    const bare = l.replace(/`|\*/gu, "");
    CN_LINE_RE.lastIndex = 0;
    let m = CN_LINE_RE.exec(bare);
    while (m !== null) {
      const tail = bare.slice(m.index + m[0].length);
      const before = /(在|落在|位于|处在)\s*$/.test(bare.slice(0, m.index));
      if (before || CUR.test(tail)) cur++;
      else if (WIDE.test(tail)) { wide++; extra.push(r.doc.slice(0,4) + " l." + (i+1) + "  " + bare.slice(Math.max(0,m.index-40), m.index + m[0].length + 25).trim()); }
      m = CN_LINE_RE.exec(bare);
    }
  });
console.log("现状命中=" + cur + "   加「那个」族新增=" + wide);
for (const e of extra) console.log("  NEW " + e);
