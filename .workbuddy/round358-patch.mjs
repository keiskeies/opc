// round358: exact-text patcher that never routes CJK through the Edit tool.
// Both the search text and the replacement live in separate files written by a quoted
// heredoc (verified: heredoc preserves CJK; the Edit tool has been corrupting random CJK
// into U+FFFD this session).
//
// usage: node round358-patch.mjs <target-file> <old-file> <new-file> [--count N]
//   Asserts the old text occurs exactly N (default 1) times, replaces, then prints the
//   remaining U+FFFD count of the target.
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const [f, oldF, newF] = argv;
let want = 1;
const ci = argv.indexOf("--count");
if (ci !== -1) want = Number(argv[ci + 1]);
// A trailing newline from the heredoc is formatting, not content.
const slim = (s) => (s.endsWith("\n") ? s.slice(0, -1) : s);
const old = slim(readFileSync(oldF, "utf8"));
const next = slim(readFileSync(newF, "utf8"));
const s = readFileSync(f, "utf8");
const hits = s.split(old).length - 1;
if (hits !== want) {
  console.log("ABORT hits=" + String(hits) + " want=" + String(want));
  process.exitCode = 1;
} else {
  writeFileSync(f, s.split(old).join(next), "utf8");
  const after = readFileSync(f, "utf8");
  console.log(
    "PATCHED hits=" + String(hits),
    "ffd=" + String((after.match(new RegExp(String.fromCharCode(0xfffd), "g")) ?? []).length),
  );
}
