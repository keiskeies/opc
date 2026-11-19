// round332 登记的盲区① 的真实人群：现在时 + 汉字行号，但【没有】位置性措辞。
// 上一轮 0063 第 5 行「第 208 行插 im_tokens」是手工才发现的。这里把这一形全量
// 枚举出来，看清敞着的到底是多大一格 —— 判据没覆盖≠不存在，别拿判据当人群。
import { CN_LINE_RE, decisionRows, markdownRows } from "../test/arch/doc-coords.js";
const NOW: RegExp = /(今天|如今|此刻|目前|现在)/;
const THEN: RegExp = /(当时|当年|那时|此前|曾|原本|原写|原是|原来|后来|漂|挪|顶|改成|改为|旧|那一版|写作|一度|修之前|改之前)/;
const POS: RegExp = /(在|落在|位于|处在)\s*$|^\s*(就是|才是|即|写的是|住的是|装的是)/;
let n = 0;
for (const rows of [decisionRows(), markdownRows()])
	for (const r of rows)
		r.lines.forEach((l, i) => {
			if (!NOW.test(l) || THEN.test(l)) return;
			const bare = l.replace(/`|\*/gu, "");
			CN_LINE_RE.lastIndex = 0;
			let m = CN_LINE_RE.exec(bare);
			while (m !== null) {
				if (!POS.test(bare.slice(0, m.index)) && !POS.test(bare.slice(m.index + m[0].length))) {
					n++;
					console.log(r.doc.slice(0, 4) + " l." + (i + 1) + "  " + bare.slice(Math.max(0, m.index - 45), m.index + m[0].length + 30).trim());
				}
				m = CN_LINE_RE.exec(bare);
			}
		});
console.log("\n非位置性现在时汉字行号 = " + n);
