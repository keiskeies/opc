"""round357 坐标同步：把 15 处随 dispatch.ts / cards.ts / dev-seed.ts 行数漂移的
「文件:行号」引用与 SNAP 键一起挪到复算后的行号。快照【值】一字不改 ——
这一批改的只是行号，引用指向的那一行内容没变（逐条按 trim 后逐字比对过）。
"""

import io

# (文件, 旧串, 新串)  —— 旧串在目标文件里必须【恰好命中 1 次】
EDITS = [
    # cards.ts 的 INSERT 那一行（cards.ts 在 172 行处插入 21 行 ⇒ 252 → 273）
    ("docs/INDEX.md",
     "`approvals/cards.ts:252` 就是那句 INSERT，round288 现数：237 → 252，237 今天是个空行",
     "`approvals/cards.ts:273` 就是那句 INSERT，round288 现数：237 → 252，round357 复算：252 → 273"),
    ("docs/decisions/0063-zero-producer-claims-that-measure-the-past.md",
     "`approvals/cards.ts:252` 就是那句 INSERT，经 `insertCard` 被三个生产调用方用着（本行原写「第 237 行」，见下方 ⚠⚡）",
     "`approvals/cards.ts:273` 就是那句 INSERT，经 `insertCard` 被三个生产调用方用着（本行原写「第 237 行」，round357 复算 252 → 273，见下方 ⚠⚡）"),
    ("docs/decisions/0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md",
     "`cards.ts:252` 就是那句 INSERT，被 `insertCard` 用着",
     "`cards.ts:273` 就是那句 INSERT，被 `insertCard` 用着"),
    # OPC-OS 设计文档引的 topmost 判据那一【段】（区间内容逐行未变）
    ("docs/OPC-OS-功能优化设计.md",
     "（`dispatch.ts:382-387`）",
     "（`dispatch.ts:437-442`，round357 复算：382 → 437，六行一字未变）"),
    # dev-seed 的 commitOrgGraph 调用点（seed 入口那一处：add_node 循环）
    ("docs/decisions/0011-org-validation-spec-snippet-defects.md",
     "`serve/dev-seed.ts:351`（seed 入口）调用",
     "`serve/dev-seed.ts:391`（seed 入口）调用（round357 复算：351 → 391）"),
    ("docs/guides/delegation-rules.md",
     "与 `dev-seed.ts:351`；",
     "与 `dev-seed.ts:391`；"),
    # dev-seed 的 createCard 调用点（432 → 501）
    ("docs/decisions/0026-approval-card-creation-and-three-illusions-of-done.md",
     "已过期。`serve/dev-seed.ts:432`",
     "已过期。`serve/dev-seed.ts:501`"),
    ("docs/decisions/0026-approval-card-creation-and-three-illusions-of-done.md",
     "已过期——`serve/dev-seed.ts:432`",
     "已过期——`serve/dev-seed.ts:501`"),
    ("docs/decisions/0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md",
     "`serve/dev-seed.ts:432` 是 `createCard` 的调用点",
     "`serve/dev-seed.ts:501` 是 `createCard` 的调用点"),
    ("docs/decisions/0053-eight-designed-reds-that-were-never-firing-and-a-separator-nobody-normalized.md",
     "`createCard` 由 `serve/dev-seed.ts:432`（`pnpm dev:seed`",
     "`createCard` 由 `serve/dev-seed.ts:501`（`pnpm dev:seed`"),
    # dispatch.ts 里那六处
    ("docs/decisions/0041-engine-entry-work-and-decide.md",
     "与 `HUMAN_EDGES` 都有生产读者：`dispatch.ts:257` 定义且被 approve 的人席推进读、",
     "与 `HUMAN_EDGES` 都有生产读者：`dispatch.ts:281` 定义且被 approve 的人席推进读、"),
    ("docs/decisions/0043-default-value-should-be-the-one-that-runs-and-a-500-that-lied-about-replaying.md",
     "（`HUMAN_EDGES`，`dispatch.ts:238`：出边那个维度的类型是",
     "（`HUMAN_EDGES`，`dispatch.ts:262`：出边那个维度的类型是"),
    ("docs/decisions/0048-driver-pump-who-presses-enter-after-the-ceo-approves.md",
     "（`dispatch.ts:1638`，round312 复算坐标）",
     "（`dispatch.ts:1799`，round357 复算：1638 → 1799）"),
    ("docs/decisions/0048-driver-pump-who-presses-enter-after-the-ceo-approves.md",
     "**当前**在 `dispatch.ts:1638`（round312 复算）",
     "**当前**在 `dispatch.ts:1799`（round357 复算：1638 → 1799）"),
    ("docs/decisions/0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md",
     "`engine/charter.ts:448`、`dispatch.ts:1527`（round312 复算坐标，两行一字未变））。",
     "`engine/charter.ts:448`、`dispatch.ts:1688`（round357 复算：1527 → 1688，两行一字未变））。"),
    ("docs/decisions/0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md",
     "回去照 `dispatch.ts:1393`（round312 复算坐标）那个真实写入点抄了形状",
     "回去照 `dispatch.ts:1554`（round357 复算：1393 → 1554）那个真实写入点抄了形状"),
    ("docs/decisions/0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md",
     "（`DECOMPOSING → IN_PROGRESS`，`dispatch.ts:102`）",
     "（`DECOMPOSING → IN_PROGRESS`，`dispatch.ts:126`，round357 复算：102 → 126）"),
    # SNAP 键（值不动，只改键里的行号）
    ("test/arch/doc-refs.test.ts",
     '"0043-default-value-should-be-the-one-that-runs-and-a-500-that-lied-about-replaying.md>dispatch.ts:238":',
     '"0043-default-value-should-be-the-one-that-runs-and-a-500-that-lied-about-replaying.md>dispatch.ts:262":'),
    ("test/arch/doc-refs.test.ts",
     '"0048-driver-pump-who-presses-enter-after-the-ceo-approves.md>dispatch.ts:1638":',
     '"0048-driver-pump-who-presses-enter-after-the-ceo-approves.md>dispatch.ts:1799":'),
    ("test/arch/doc-refs.test.ts",
     '"0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>dispatch.ts:1527":',
     '"0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>dispatch.ts:1688":'),
    ("test/arch/doc-refs.test.ts",
     '"0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>cards.ts:252":',
     '"0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>cards.ts:273":'),
    ("test/arch/doc-refs.test.ts",
     '"0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>dispatch.ts:102":',
     '"0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>dispatch.ts:126":'),
    ("test/arch/doc-refs.test.ts",
     '"0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>dispatch.ts:1393":',
     '"0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>dispatch.ts:1554":'),
    ("test/arch/doc-refs.test.ts",
     '"0063-zero-producer-claims-that-measure-the-past.md>approvals/cards.ts:252":',
     '"0063-zero-producer-claims-that-measure-the-past.md>approvals/cards.ts:273":'),
    ("test/arch/doc-refs.test.ts",
     '"OPC-OS-功能优化设计.md>dispatch.ts:382":',
     '"OPC-OS-功能优化设计.md>dispatch.ts:437":'),
    ("test/arch/doc-refs.test.ts",
     '"INDEX.md>approvals/cards.ts:252":',
     '"INDEX.md>approvals/cards.ts:273":'),
    ("test/arch/doc-refs.test.ts",
     '"delegation-rules.md>dev-seed.ts:351":',
     '"delegation-rules.md>dev-seed.ts:391":'),
    ("test/arch/doc-refs.test.ts",
     '"0041-engine-entry-work-and-decide.md>dispatch.ts:257":',
     '"0041-engine-entry-work-and-decide.md>dispatch.ts:281":'),
    ("test/arch/doc-refs.test.ts",
     '"0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>serve/dev-seed.ts:432":',
     '"0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>serve/dev-seed.ts:501":'),
    ("test/arch/doc-refs.test.ts",
     '"0053-eight-designed-reds-that-were-never-firing-and-a-separator-nobody-normalized.md>serve/dev-seed.ts:432":',
     '"0053-eight-designed-reds-that-were-never-firing-and-a-separator-nobody-normalized.md>serve/dev-seed.ts:501":'),
    ("test/arch/doc-refs.test.ts",
     '"0011-org-validation-spec-snippet-defects.md>serve/dev-seed.ts:351":',
     '"0011-org-validation-spec-snippet-defects.md>serve/dev-seed.ts:391":'),
    ("test/arch/doc-refs.test.ts",
     '"0026-approval-card-creation-and-three-illusions-of-done.md>serve/dev-seed.ts:432":',
     '"0026-approval-card-creation-and-three-illusions-of-done.md>serve/dev-seed.ts:501":'),
    # 那条解释区间取舍的注释也要跟着改口（否则注释自���指着旧坐标）
    ("test/arch/doc-refs.test.ts",
     "// ⚠ 文档里写的是区间 `dispatch.ts:382-387`，而提取器只认【区间起点】（既有取舍），",
     "// ⚠ 文档里写的是区间 `dispatch.ts:437-442`（round357 复算：382-387 → 437-442），\n  //    而提取器只认【区间起点】（既有取舍），"),
    # src 内注释里那条生产者坐标（same-family 键的拼装点）
    ("packages/hub/src/approvals/cards.ts",
     "`dispatch.ts:1160` 用它拼键（生产者）",
     "`dispatch.ts:1263` 用它拼键（生产者）"),
]

for path, old, new in EDITS:
    s = io.open(path, encoding="utf-8").read()
    n = s.count(old)
    if n != 1:
        raise SystemExit("HIT %d in %s for %r" % (n, path, old[:60]))
    s = s.replace(old, new)
    if s.count(chr(0xFFFD)) != 0:
        raise SystemExit("FFFD in %s" % path)
    io.open(path, "w", encoding="utf-8", newline="").write(s)
    print("ok  %s  <-  %s" % (path, old[:52]))
print("done")
