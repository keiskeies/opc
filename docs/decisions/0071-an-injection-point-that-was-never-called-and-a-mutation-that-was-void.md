# 0071 · 一个【从来没被调用过】的注入点 —— 以及一发字节没变的「变异」

**日期。** 2026-11-27（round385）。
**落地。** `packages/hub/src/serve/dev-entry.ts`（`defaultEnsureDir` + 那一次真调用）；
`packages/hub/test/serve/dev-entry.test.ts`（+3 发，14 → 17）。

## 1. 一句话

`runDev` 的 `ensureDir` 注入点**一次都没有被调用过**。那一句写成了 `??` 当语句用：

```ts
deps.ensureDir ??
  ((dir) => mkdirSync(dir, { recursive: true }))(p.orgBackupDir);
```

`??` 的右边带括号，所以**默认那一支调的是它自己的 IIFE**，而左边那个被注入的函数
只是被求值成一个函数引用、然后丢掉。运行时实测（`node -e` 一发最小复现）：

| 场景 | 注入的 `ensureDir` 被调用次数 | 默认那一支 |
| --- | --- | --- |
| 注入（每个测试都这样） | **0** | 不跑（`??` 短路） |
| 不注入 | —— | 跑（IIFE 自己调自己） |

改成同文件里 `defaultStopSignals` 已经用的那个形状：

```ts
(deps.ensureDir ?? defaultEnsureDir)(p.orgBackupDir);
```

## 2. 为什么全量测试照绿：唯一那些调用点注入的是空函数

`dev-entry.test.ts` 的 `harness()` 与三支手写的 `runDev` 用例**全部**传
`ensureDir: () => {}`。于是没有任何一发能区分「正确委托给了注入实现」与
「压根没调用任何东西」—— 一根线唯一的见证是一个不承重任何东西的注入，
就是「每根线要有自己的那次动作」那条纪律的反面实例。

顺带把那条**注释**也量了一遍。它原本写着「注入它是因为 runDev 在测试里不落盘」。
这句今天成立，但**在我改之前它不成立为真**：旧写法下注入与不注入的差别是
「什么都不做」对「做一件事」，而那件事在测试里从没发生（每个用例都注入）；
而 `harness()` 的 `ROOT` 是 `D:/repo` —— 实测**那个目录不存在**，所以就算旧默认支
真跑到，也是往一个不存在的盘路径上 `mkdirSync`。⇒ 那句注释描述的是一道
**从没被行使过的保护**。修完之后它第一次变成真的：注入确实压住了一次真 `mkdirSync`
（新第三发判的就是「不注入 ⇒ 真建目录」，落点在 `mkdtemp` 临时根下）。

## 3. 老实说：这一格【没有】用户身上的症状，别读成「拖拽改组织一直是坏的」

备那一支自己会建目录 —— `createBackup` 在 `packages/hub/src/db/backup.ts:272` 有
`mkdirSync(o.backupDir, { recursive: true })`，而 `createBackupOffLoop` 走 worker、
worker 里跑的仍是同一个 `createBackup`（`packages/hub/src/db/backup.worker.ts:135`）。所以 `POST /org`
在真 dev 里一直是通的：挡门的是「装配有没有拿到 orgBackupDir」
（`packages/hub/src/http/real-deps.ts:936` 那三元的 `=== undefined` 分支），而不是目录在不在。

真正的缺陷在**注入点本身是死的**：谁按 `DevDeps` 的声明注入一个 `ensureDir`
（比如想把目录建到别处，或想判「这次有没有建」），会得到「你的函数一次都没被调，
而仓库里凭空多出一个真目录」。这正是本仓那一族「静默失效」的形状 —— 不崩、不报错、
接口签名一切正常，只是注入的东西不承重。⇒ 这是一格**死注入点**修复，不是产品故障修复。

## 4. 三发新判据，每根线各拿自己的那次动作

`harness()` 加了两个采集口：`dirs`（`ensureDir` 收到的目录）与 `order`
（migrate / dir / boot / web 四个注入点各在自己的位置记一格）。

| 发 | 判的是 | 落在哪根线上 |
| --- | --- | --- |
| ① 注入的 `ensureDir` 真被调用、收到的正是 `orgBackupDir` | 委托发生 | `??` 左边那一格 |
| ② 装配序 `["migrate","dir","boot","web"]` | 目录必须排在 boot 之前（那条注释的主张） | 调用**在哪一行** |
| ③ 不注入 ⇒ 默认那一支真建目录（`mkdtemp` 根下 `a/b/backups` 存在） | 默认实现不是恒等 | `??` 右边那一格 |

② 是这一族里唯一能抓「有人把它挪到 boot 之后」的 —— 那条挪动的后果（装配期已读过
`orgBackupDir`，事后补目录等于没补，501 照旧）是注释里写着的主张，今天有了判据。

按 M1 变异实测：红的是且只是 ①② 那两发（`2 failed | 15 passed`）——
新断言承重，不是整支文件级失败冒充被抓到。

## 5. ⭐ 变异机：第一版 M4 是【字节没变】的假变异

`.workbuddy/scratch/round385-ensure-dir-mutate.mjs`，预检（未变异必须绿且读得到 vitest
摘要，读不到 = 当场中止）+ 6 发：

| 发 | 抹的是什么 | 预期 | 结果 |
|---|---|---|---|
| M0 | 未变异 | 该绿 | 绿 |
| M1 | 退回本轮修掉的那一句 `??` 语句 | 该红 | 红（点名 ①②） |
| M2 | 删掉那一次调用 | 该红 | 红 |
| M3 | `defaultEnsureDir` 退化成空函数体 | 该红 | 红 |
| M4 | 建目录挪到 boot 之后 | 该红 | **第一版绿** → 修变异后红 |
| M5 | 控制组：只加一行无关注释 | 该绿 | 绿 |

M4 第一版活了。按 0069 §7 的次序**先怀疑变异**：它的漂法写成「从原位置删掉，插到
`const r = await deps.bootHub(` 之前」—— 而那一句**本来就紧贴在那行之前**，
所以拼出来的源码与原文的**执行序一字不差** ⇒ 这是一发**void 变异**，
判据没被测到，谈不上有没有牙。真漂法是插到 `deps.spawnWeb(` 之前（那时已经在 boot 之后）。
改完即红。

⇒ 补了一条机器门进变异机：`expectRed && mutated === original` ⇒ 直接抛
「该发的字节一个字没变，变异本身不成立」。假绿最省事的成因不是判据松，
是变异根本没发生 —— 而这一格不写死在脚本里就一定会再犯（我自己这一轮就犯了）。

`finally` 逐字节还原 + sha256 核对，每发跑完源码与跑前同一 sha；复跑全量前 `git diff`
确认工作区只剩本篇那一处 +6/−2。

## 6. 同族扫了一遍：全仓只有这一处

`??` 当语句用这一族，正则 `\?\?\s*$` 扫 `packages` `docs` `test` `scripts`
（排 `node_modules` 与 `dist`）：**25 处命中**，逐处读上下文（不是只看正则吐出来的那一行），
其余 24 处全是表达式续行 —— `??` 落在赋值/实参/返回的**中间**，右侧是默认实现或下一段
（`packages/*/src` 那 17 处里含 `assemble.ts` 的 5 个注入点、`event-stream.ts`、
`charter.ts`、`runtime.ts`、`recorder.ts`、`cli.ts`、`formats.ts`、`dispatch.ts`、
`stub-model.ts` 两处、两个 harness adapter、`meetings/service.ts`；`packages/web/public/app.js`
的 `setConn` 两处；测试侧 6 处是期望值/入参构造）；只有 `dev-entry.ts` 这一处是**裸语句**。

⇒ **没有**为这一族立守卫：一处出现的形状不构成又一座 arch 守卫的依据，
而一条只会命中历史一次的判据，它腐烂的方式与它的价值不成比例。要立的正确形态是
biome/TS 层面的 lint 规则（未验证本仓这份 biome 有没有对应规则），不是再加一座仓库守卫。

## 7. 别当成做到了

- **没有用户可见症状**（§3）：`POST /org` 一直是通的，别把本篇读成修了一个产品 bug。
- `devMain` / `isDirectRun` 那一段入口块**仍无人执行**（0070 §7 那条主张一字不动）——
  本篇让 `runDev` 的注入点诚实了，没有让入口块被覆盖。
- ③ 那一发判的是「默认实现真建了目录」，**不判**「dev 在真实仓库里把目录建对了地方」——
  后者是 `devPaths` + `repoRootOf` 的事，由 `dev-entry.test.ts` 已有的两发钉着。
- `order` 采集只在 `harness()` 里挂，三支手写用例没挂（它们判的是退出码与收尾，
  别读成全仓装配序都有序化了）。
- 变异机脚本随 `.workbuddy/scratch/` 不入库（既有纪律）。

## 8. 实跑读数

- `packages/hub/test/serve/dev-entry.test.ts`：**17 passed**（落地前 14，恰好 +3）；
- 变异机 **6/6 符合预期**（M0/M5 该绿全绿，M1/M2/M3/M4 该红全红），逐字节还原核对 sha256；
- 变异态定点复算：M1 下红的是且只是新那两发（`2 failed | 15 passed`）；
- `tsc -p tsconfig.test.json --noEmit` exit 0；`tsc -b` exit 0；
- biome 对两个改动文件：**0 诊断**（import 顺序按 `node:` 分组收敛后复验）；
- `test/arch/production-deps.test.ts` **8 passed**（未新增文件、未新增 node: 导入到
  生产面，无需登记）；
- 收尾核对：工作区无 `zzzzzzz`/变异残留，`dev-entry.ts` 的 diff 只有本篇那一处。
