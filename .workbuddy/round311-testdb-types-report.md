# round311 — packages/hub/test/db 类型债 31 → 0 + 撤配额格

日期：2026-11-19。范围：只改 `packages/hub/test/db/` 六个测试文件 +
`test/arch/test-type-baseline.ts` 删一格。未动 src / contracts / 其他测试。
未 git add/commit。未跑全量 vitest。

## 交活读数（①②）

```
$ npx tsc -p .workbuddy/tsconfig.tests.json --noEmit   # 修完后终跑
TOTAL=$(grep -c 'error TS' .workbuddy/round311-tsc-db-final.txt)  # => 260
DB=$(grep -c 'packages/hub/test/db' ...)                          # => 0
```

- 本轮起点实测：**291 总 / 31 在 test/db**（`.workbuddy/round311-tsc-start-mine.txt`，与任务给的基线逐字相符）。
- 终读：**260 总 / 0 在 test/db**，恰等于 291−31，无「别的 agent 语法错掐停 tsc」迹象
  （掐停的形状是总数掉到个位数；这里没有任何时刻出现过）。
  并发对照：修的中途一次读数是 261/1（还差 schema-0001 一处 TS18048，是修 shim 后
  新暴露的 `.get()` undefined），修掉后到 260/0 —— 每一步总数都 ≥ 260，方向干净。

```
$ node node_modules/vitest/vitest.mjs run packages/hub/test/db test/arch/test-type-baseline.test.ts
Test Files  9 passed (9)
Tests  182 passed (182)     # test/db 8 文件 156 发 + test-type-baseline 26 发
```

（末跑 182/182 是 biome --write 之后复跑的数。）

## ③ 配额表

`test/arch/test-type-baseline.ts` 的 TYPE_BASELINE 里
`{ dir: "packages/hub/test/db", atMost: 31 }` 一格已删。
守卫 26 发全绿：真跑那一发的 `diffTypeBaseline` 对 260 条在表内；
`staleTypeEntries` 的反向判据（合成夹具那发点名的是 engine/test/org，不点名 db）
与真仓库半都不再报 test/db —— 格删了，豁免不再比现实活得久。
（守卫自带的「基线表自证」只查表内目录存在，删格不影响。）

## 逐文件修法

### migrate.test.ts — 11× TS2345（Db 不能赋给 DatabaseSync）

`type Db = {...prepare/exec/close}` 手写面子类型换真类型：
`import type { DatabaseSync } from "node:sqlite"` + `type Db = DatabaseSync;`
（保留别名，改动面最小），`openDb(path) as unknown as Db` 的 cast 随之删掉
（openDb 声明返回就是 DatabaseSync）。两处 `migrate(db.db as never, …)` 的
`as never` 是当年替身类型塞不进去才加的，真类型下多余，一并摘掉。
`.all()` 后已有的 `as {…}[]` 行形状标注在真类型下仍是合法窄化，未动。
先例：round310 的 shim→真类型（`packages/hub/test/acceptance/rejected-waiver-still-asks.test.ts:27,86`
直接用 `DatabaseSync` 作字段类型）；cast 位保留的同类先例
`packages/hub/test/approvals/cards.test.ts:76`。

### schema-0001.test.ts — 9× TS2322 + 1× TS2345

1. Db 同上一条换 `DatabaseSync`（同因同修，先例同上）。换真类型后
   `StatementSync.get()` 显出真语义 `Record | undefined`，`.get()` 后直接 `.c` /
   `.payload` 的行读取共 7 处补上同目录已有的行形状标注
   `.get() as { c: number | bigint }`（先例：同文件目录内
   `integrity.test.ts:114`、`backup.test.ts:113`、`write-queue.test.ts` 内多处）。
   `run(payload) as { lastInsertRowid }` 换回真返回类型 `StatementResultingChanges` 的
   `.lastInsertRowid`，cast 删掉。
2. 9× TS2322 的病灶：`cases: Array<[label, sql]>` 的二元组标注 vs 数据里的
   `[label, sql, []]` 三元组。**修标注不修数据**（删那 9 个 `[]` 是动运行时数据）：
   标注补成 `[label: string, sql: string, params: readonly unknown[]]`。
   `for (const [label, sql] of cases)` 解构第三格自动忽略，行为不变。

### write-queue.test.ts — 7× TS2532（noUncheckedIndexedAccess 下的索引）

5 处 `rows[0].x` → `rows[0]?.x`（`q.read` 返回数组，`count(*)` 恒出一行；上一发
`toHaveLength(1)` 钉着行数的两处只加 `?.`）；1 处 `Array.from(rows[0]?.b ?? [])`
（`?.` 进不了 `Array.from` 的参数位，`?? []` 只在真取不到时兜底，而那种情况
`expect(…).toHaveLength(1)` 已先红）；1 处 `.get().c` → `.get() as { c }` 行标注
（同 schema-0001 的先例）。先例：`packages/hub/test/acceptance/phase3.test.ts:544`
的 `rows[0]?.["actor_type"]` 一族。取值语义逐条等价，未动任何期望值。

### worker-entry.test.ts — 1× TS2379（exactOptionalPropertyTypes）

本地 `type Hook` 的 `context: { parentURL?: string }` 在 EOPT 下不收 callHook
递进来的 `string | undefined`。修法按仓内既有写法把标注补全形状：
`context: { parentURL?: string | undefined }`（先例：`packages/hub/src/cli.ts:85`
的 `db?: string | undefined`、`approvals/query.ts:93`）。
没选条件展开 `{...(p!==undefined && {parentURL:p})}`：那会把「入口那一跳没有
parentURL」和「parentURL=undefined 的显式键」两种输入并成一种，恰好糊掉 ③
那一节要测的边界。

### integrity.test.ts — 1× TS2551（actorId vs actor_id）

`audit?.actorId ?? audit?.actor_id` 里左半边在这条行上不存在（TS2551）。
sqlite 回来的行只有列名 `actor_id` 键，运行时 `audit?.actorId` 恒 undefined、
`??` 恒走右半边 ⇒ 删掉死左半边与原判据逐字等价（audit 为 undefined 时两边同样
给 undefined，那一发同样先被 `toBeDefined()` 拦）。只改测试侧用法。

### backup.test.ts — 1× TS2698（spread 非对象类型）

`{ dbPath, backupDir, ...(extra as never) }`：spread 不接受 never。修法把 cast 从
spread 括号挪到整对象：`{ dbPath, backupDir, ...extra } as never`。
先例就在**同文件同一条 it 的下方两行**——「两个都传」那一发本来就是整对象
`as never`。运行时逐字节等价（extra 照常展开，`rejectsFunctionFields` 照常点名）。
`as never` 在这里不是堵嘴：这两个字段被 `Omit` 掉了，测试测的正是「JS 侧硬塞函数
字段必须当场抛」，类型上无路可走；文件注释本来就写着这一点。

## 规矩遵守

- 零新增 `as any` / `@ts-ignore` / `@ts-expect-error`（grep 过，唯一命中是
  backup.test.ts 注释里的散文）。
- 未动 `packages/hub/src`、未动 contracts。没有一条错的根因需要动 src 才能修
  （schema-0001 的 `get()` 真语义变化按同目录 `.get() as {…}` 先例在测试侧吸收）。
- 定向 vitest，未跑全量。未 git add/commit。
- biome：只对本次改过的 7 个文件跑了 `npx biome check --write`（规则允许的落点内），
  应用的是 organizeImports/format 两类自动修；三处 `noUnusedVariables` 是
  **改前就有的存量**（integrity.test.ts 两处、worker-entry.test.ts 一处，均为
  warning 位、不进 lint 棘轮的 error 计数），按「不弱化任何现存内容」原则未动。
  全仓 biome 未跑。
- 未碰 src/harness 与 `.workbuddy/round311-gate-criteria-survey.md`。

## 留档

- 起点读数 `.workbuddy/round311-tsc-start-mine.txt`（291/31）；
  终读 `.workbuddy/round311-tsc-db-final.txt`（260/0）；
  中途 `.workbuddy/round311-tsc-db-after1.txt`（261/1）。
