// Inserts the three new required DispatchDeps cells (gateCriteria / gateRoundNo /
// evidenceRoot) into every literal makeDispatch() in the two engine tests, plus the
// import. Anchors and replacements are pure ASCII on purpose: CJK going through a
// heredoc has been corrupted into U+FFFD this session, and here no CJK is needed.
import { readFileSync, writeFileSync } from "node:fs";

const ED = "packages/hub/test/engine/";
const DISP = ED + "dispatch.test.ts";
const SEAT = ED + "seat-card.test.ts";
const IMP_OLD = 'import { fixtureTmp } from "../fixtures/fixture-dir.js";\n';
const IMP_NEW =
  IMP_OLD + 'import { gateDepsFrom } from "../fixtures/gate-deps.js";\n';

const calls = [
  { f: DISP, old: IMP_OLD, neu: IMP_NEW },
  { f: SEAT, old: IMP_OLD, neu: IMP_NEW },
  {
    f: DISP,
    old: '  const dispatch = makeDispatch({\n    writer: q,\n',
    neu:
      '  const dispatch = makeDispatch({\n    writer: q,\n' +
      '    ...gateDepsFrom(db, TMP + "/artifacts"),\n',
  },
  {
    f: DISP,
    old:
      '    const dispatch = makeDispatch({\n      writer: q,\n' +
      '      loadTask: () => ({ id: "t1", title: "x", status: "IN_PROGRESS"',
    neu:
      '    const dispatch = makeDispatch({\n      writer: q,\n' +
      '      ...gateDepsFrom(db, TMP + "/artifacts"),\n' +
      '      loadTask: () => ({ id: "t1", title: "x", status: "IN_PROGRESS"',
  },
  {
    f: DISP,
    old:
      '    const dispatch = makeDispatch({\n      writer: q,\n' +
      '      loadTask: () => null,',
    neu:
      '    const dispatch = makeDispatch({\n      writer: q,\n' +
      '      ...gateDepsFrom(db, TMP + "/artifacts"),\n' +
      '      loadTask: () => null,',
  },
  {
    f: SEAT,
    old: '  const dispatch = makeDispatch({\n    writer: w.q,\n',
    neu:
      '  const dispatch = makeDispatch({\n    writer: w.q,\n' +
      '    ...gateDepsFrom(w.db, TMP + "/artifacts"),\n',
  },
  {
    f: SEAT,
    old:
      '    const dispatch = makeDispatch({\n      writer: w.q,\n' +
      '      loadTask: (id) => {',
    neu:
      '    const dispatch = makeDispatch({\n      writer: w.q,\n' +
      '      ...gateDepsFrom(w.db, TMP + "/artifacts"),\n' +
      '      loadTask: (id) => {',
  },
  {
    f: SEAT,
    old:
      '    const dispatch = makeDispatch({\n      writer: w.q,\n' +
      '      // loadTask',
    neu:
      '    const dispatch = makeDispatch({\n      writer: w.q,\n' +
      '      ...gateDepsFrom(w.db, TMP + "/artifacts"),\n' +
      '      // loadTask',
  },
  {
    f: SEAT,
    old: '    const again = makeDispatch({\n      writer: w.q,\n',
    neu:
      '    const again = makeDispatch({\n      writer: w.q,\n' +
      '      ...gateDepsFrom(w.db, TMP + "/artifacts"),\n',
  },
];

let failed = 0;
const byFile = new Map();
for (const c of calls) {
  const list = byFile.get(c.f) ?? [];
  list.push(c);
  byFile.set(c.f, list);
}
const ff = String.fromCharCode(0xfffd);
for (const [f, list] of byFile) {
  let s = readFileSync(f, "utf8");
  for (const c of list) {
    const hits = s.split(c.old).length - 1;
    if (hits !== 1) {
      console.log("ABORT " + f + " hits=" + String(hits) + " anchor=" + JSON.stringify(c.old.slice(0, 46)));
      failed++;
      continue;
    }
    s = s.split(c.old).join(c.neu);
  }
  if (failed > 0) continue;
  writeFileSync(f, s, "utf8");
  console.log("PATCHED " + f + " n=" + String(list.length) + " ffd=" + String((s.match(new RegExp(ff, "g")) ?? []).length));
}
if (failed > 0) process.exitCode = 1;
