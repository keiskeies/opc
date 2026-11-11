# 0038　「检查没跑成」不能跟「查出损坏」共用一个词：它让人去恢复一份健康的库

- **状态**：已定案。修的是 **0037 §1.2** 点名的第二个缺陷：`page_integrity` 那一格
  原本写 `page.ok ? "ok" : "violated"`，把两件事压成一个词。
- **产出**：`src/db/integrity.ts` 的 `pageCheckCell`（映射收进一个函数）+ 0 个车祸侧
  新测试 5 发 + 两处「响一声」接线 + 一条被我当场证伪的旧注释。
- **一句话结论**：⭐ **一个术语把两种相反的动作绑在一起，替人做了一次不该做的选择。**
  `violated` 的修法是恢复数据；`could_not_run` 的修法是修这台机器上的检查通路。
  前者会说「照 restore.md 覆盖现网库」，后者一旦被当成前者，一台健康的库就被覆盖了。

---

## 0. 缺陷长什么样：一台健康的库，被引导去覆盖自己

0037 §1.2 量的三种**仪器故障**（`INTEGRITY_FAILURES`，`integrity.ts`）：
`worker_unavailable` / `worker_timeout`（默认 **120 秒**）/ `worker_error`。
修之前，它们在报告里长这样：

```
修之前：page_integrity = violated   unavailable = worker_timeout   broken = true
修之后：page_integrity = could_not_run  unavailable = worker_timeout  broken = false
```

- `pnpm hub:serve` 的启动闸门 `pageIntegrityBroken` 只看
  `report.checks.find((c) => c.name === "page_integrity").verdict === "violated"`。
  修之前 timeout ⇒ `violated` ⇒ **拒绝启动**，并把消息指到 `scripts/restore.md`。
- 那份文档第 3 步是**把现网库改名、再从备份覆盖过去**。

⚠ 复算轨迹要留着（0037 §1.2 的两处更正这次是**起点**而不是终点）：
- 「库路径打错会撞上这个闸门」是假的（`assemble.ts` / `maintenance.ts` 里
  `existsSync(dbPath)` 那一支先退 `EXIT_USAGE`，走不到这个闸门）⇒ 三条全删。
- 真实启动路径上能撞上闸门的仪器故障**只有那三种**。
- `pageIntegrityBroken` 自己的注释写着「`not_observable` / `could_not_run` 都不算损坏，
  据此拒绝启动等于让一次 worker 起不来变成整台机器不可用；**而它该做的（响一声、指路）
  由调用方在别处做**」—— ⭐ 分工写对了，而「响一声」这一半**全仓没有任何地方做**
  （复算：src 下读 `report.unavailable` 的非注释代码 0 处）。于是那一格的实际行为是
  「一声不吭地照常启动」—— 它刚从「拒绝启动 + 指路恢复」改过来，两个方向都错在同一处：
  **读的人不知道这次启动没有经过完整性保护**。

## 1. 修法：映射收进一个函数，词汇用本模块【既有】的那个

`pageCheckCell(page)`（`integrity.ts`）现在三个字段一起算：

```ts
function pageCheckCell(page: PageOutcome): CheckResult {
  const instrumentBroke = page.unavailable !== undefined;
  return {
    name: "page_integrity",
    verdict: page.ok ? "ok" : instrumentBroke ? "could_not_run" : "violated",
    detail: page.pageReport.slice(0, 2000),
    checked: instrumentBroke ? 0 : 1,
  };
}
```

- `could_not_run` 是**本模块既有**的第四种结论（`CHECK_VERDICTS`），为它写过一整段的
  「为什么不能并进 not_observable / violated」—— 那个词当初就是照「尺子放不下去」
  这格造的，只是 `page_integrity` 这一格没接上。
- ⚠ 留在 `violated` 的那一种（**别当成误报**）：worker 起来了、是它**开不了这份库**。
  `integrity.worker.ts` 自带 try/catch，开库抛错会变成一条 `ok:false` 的【消息】回主线程，
  于是 `unavailable` 是 `undefined`。判据【跑成了】、它的结论是「这份库我读不动」——
  那是被检查对象的结论，不是尺子坏了。实测两种形状读数不同：
  `TIMEOUT verdict=could_not_run unavailable=worker_timeout` /
  `NOPATH verdict=violated unavailable=undefined`。

### 1.1 ⚠ 顺手补的一格，跟主线同一边

`checked` 原本**恒为 1**，包括「一次都没查」的那两种。而 `CheckResult` 自己的注释只写了
「checked = 0 且 verdict = ok 是矛盾的」—— 反方向那种（verdict 不是 ok 而 checked 是 1）
从没被检查过。于是「没跑成」的报告长得像「查过一条并报出问题」。
现在 `instrumentBroke ⇒ checked = 0`：那才是实际看了多少行。
附一条用例，别把三格当独立机制 —— atomic：只造得出 timeout，worker_unavailable /
worker_error 两支【今天造不出】（入口恒存在），共用的是 `pageCheckCell` 里那一个判断。

## 2. 「响一声、指路」这半，接在它该在的两处

两条都先说**为什么照常走**，再用【响】把它照亮。

### 2.1 启动那一侧（`assemble.ts`）

`pageIntegrityBroken(report)` 为 false 时 Hub 照常起（`needOk`），但：

```ts
if (report.unavailable !== undefined) {
  io.warn(
    "页面完整性检查【没有跑成】（" + report.unavailable +
    "）⇒ 本次启动【没有】被页面完整性保护过一道。"
    "\n  · 原因：" + report.pageReport.slice(0, 300) +
    "\nHub 照常起来（库并没有被证明坏了），但【别把它当成「检查通过」】。" +
    "\n→ 要修的是这台机器上的检查通路（worker / 超时 / 依赖），不是库。" +
    "**不要**照 scripts/restore.md 恢复 —— 那会把一份可能完全健康的现网库覆盖掉。");
}
```

- 用 `io.warn` 而不是让 `boot` 判失败：这一格每次启动都可能命中（120 秒超时在大库上
  不是想象出来的），判失败 = 让一次慢扫描变成整机不可用，正是 `pageIntegrityBroken`
  那段注释拒绝的事。
- 造法：`BootOverrides.integrityTimeoutMs`（与 `backupTimeoutMs` 同类 —— 注入的是
  【时机】不是【结论】）。`integrityTimeoutMs: 0` ⇒ 真的起 worker、真的超时 ⇒
  真的 `unavailable` 从 `runIntegrityScan` 出来。Alternate 是塞一份假报告，但那只会测到
  「boot 读了那个字段」这一行，测不到 `pageCheckCell` 那条映射。
- 两个方向同一发：起来 + 响 + **不指路 restore.md**（措辞里出现「不要……恢复」，
  以及单独断「不能出现『按 scripts/restore.md 恢复』那个祈使句」）。

### 2.2 备份那一侧（`maintenance.ts` + `report()`）

修之前 `maintenance.ts:290` 就地内联 `page.verdict === "violated"` ——
**抄一份 ≠ 搬走了**：0038 改 verdict 语义时，只改 `integrity.ts`，这里会安静地变成
「仪器故障 ⇒ 拦备份」而 Hub 那边「仪器故障 ⇒ 照常启动」—— 两边各自自洽、各自都绿，
正是 `pageIntegrityBroken` 注释当初要防的两半没合起来。现在它调 `pageIntegrityBroken`。

`runMaintenance` 里 `integrity.unavailable !== undefined` 那一支，**照常备份 + 响一声**：

1. 少一份备份是【真损失】：保留策略只留最近 7 份，跳过一次就把可用备份往前推一天。
2. 这条路已经有另一道闸：`createBackup` 对自己产出的那份跑 `integrity_check`，不过就
   `rmSync` 并在【清理旧备份之前】早退（`backup.ts`）。实测 page 级损坏的源库连
   `VACUUM INTO` 都过不去（当场抛 "database disk image is malformed"）⇒
   「源坏了而产物全绿」这格我造不出来 —— 拦住这里的必要性比 pageBroken 低一档。
3. 「没跑成」最可能是 worker / 超时的毛病，不是库 —— 为一个仪器的毛病停一天数据保护，
   是给错的药。

`report()` 尾行也改了：修之前【对所有】`!ok` 都喊「库可能已损坏 → 照 restore.md」，
而 `!ok` 混着两种相反的东西（`unavailable` 有值 = 库可能健康）。
现在 `unavailable 有值 ⇒ 喊「没跑成」+「不要……恢复」`，否则才喊「库可能已损坏」。

⚠ `runMaintenance` 的直接调用方是 `runMaintenanceCli`，而 CLI **没有**这个超时旗
（刻意不加：那等于一个「关掉启动闸门」的命令行开关）。所以这条只能靠直接调
`runMaintenance` + 导出 `report()` 喂真结果来测。

## 3. 一条我当场证伪的旧注释（文物级别）

修的时候 `pageIntegrityBroken` 的长注释撞到我读它 —— 它写着：

> `ok` 会被 `could_not_run` 与 `not_observable` 拉下来（**实测**：一个没有任何门控
> 决定的合法新库，因为「没有 gate_decision 可核」而 ok = false）。用 ok 当启动闸会
> 【把一大半真实启动挡在门外】……

**那两句是假的，而第一句还挂着「实测」。** 复算：
`ok` 的表达式是 `page.ok && !checks.some(violated || could_not_run)` ——
`not_observable` 【根本不在里面】。真跑一份「没有任何门控决定的合法新库」：

```
合法新库 ok=true unavailable=undefined broken=false
各格：page_integrity=ok/1 append_only=not_observable/0 action_enum=not_observable/0
      state_machine=not_observable/0 gate_evidence=not_observable/0
      harness_call=not_observable/0 fts_index=not_observable/0
```

该夹具的 `ok` 是 **true**，不是注释说的 false。⇒ 那个取舍当时唯一的支撑（「挡掉一大半
真实启动」这个【后果】）没发生过。**取舍本身仍然成立**，换一个真理由：`could_not_run`
确实拉得下 ok（表达式里有它），而它是「有东西可核而尺子放不下去」—— 拿它当启动闸，
一次 instrument 故障就会变成整机不可用，并要求人去恢复一份可能健康的库。
另一条真理由在 `IntegrityReport.ok` 那段：ok 是「全部格子都没问题」的合取，通吃一个布尔
天生答不出【哪一格】出问题，而启动闸门要的正是「只有页面坏了才拦」。

⚠ 原文留着（标「原文」引号），**不静默删** —— 规则不让我擦掉「我写过一句没验的话」
这个证据。补的是「为什么取舍仍成立」的新理由，不是把旧的话擦掉再写新的。

## 4. 判据：五发变异，各红在它该红的用例

`integrity.test.ts` 30 发（原 28 + 新增 2）、`assemble.test.ts` 51 发（49 + 2）、
`maintenance.test.ts` 22 发（20 + 2）。反向对照（不加变异）三文件各全绿。

| 变异 | 改的东西 | 实测红的发数与位置 |
| --- | --- | --- |
| **M-A** | 把映射改回 `page.ok ? "ok" : "violated"`（= 本篇缺陷本体） | **红 2**：超时那一发（`could_not_run` 变 `violated`）+ 仪器故障那发（`pageIntegrityBroken === true`）|
| **M-B** | `checked` 恢复恒 1 | **红 1**：超时那发里 `checked === 0` 的断言 |
| **M-C** | 删掉 `assemble.ts` 那段 `report.unavailable` warn | **红 1**：启动「响一声」那发（警告没出现）|
| **M-D** | `maintenance.ts` 那支改成「跳过备份」 | **红 1**：备份那发（`backup.ok === true` 变 false）|
| **M-E** | `report()` 把 else（真损坏指路）删成空 | **红 1**：report() 那发（真损坏不再喊「库可能已损坏」）|
| **M-F** | `pageBroken = false`（真损坏也照样备份） | **红 1**：**既有** ③「页面检查不过就不备份」—— 那是个我在本篇没写的用例，它早就守住了「照备份」之所以安全的前提 |

- 每发跑完立刻 `cp /tmp/keep-*.ts` 还原 + `cmp` 逐字节核对。
- ⚠ 变异迭代慢在一个大头：`integrity.test.ts` ① 那颗 128k 行的「默认路径走 worker」
  测试（~14–19s，它建 128k 行的代价 + 扫描期间的主线程推进断言）。M-A/M-B 时它
  出现在 describe 级红里，我一度以为被变异弄红 —— 复跑确认是【干净的 aggregate】：
  它内一个测试没红，describe 红是它组内那两发(超时/仪器故障)被 M-A 弄红后聚合的结果。
  **别把 describe 级红当测试级红读**；也别为了「只测我新增那几发」跳过它 ——
  M-A 真正红的恰是那两个新发，而它们在自己的测试里。
- ⚠ **M-F 是最有价值的发现**：它证明「照备份的『安全』不是设计，是 `createBackup`
  产物自检那道既有闸在兜」。如果把 pageBroken 那支（源健康才可备份）删掉，
  `maintenance.test.ts` 里那条【我没写的】真正损坏用例当场红 —— 而它正是 0038
  §2.2 说「安全性不在对比里、在产物自检里」时依赖的那条既有判据。

## 5. 与「更严」的距离

1. **没有把 three 种仪器故障都造出来**（§1.1 说了：worker_unavailable / worker_error
   今天造不出，共用同一条映射，timeout 打中它 = 映射被覆盖过）。
2. **没有把 `page_integrity` 的 `could_not_run` 从 `report.ok` 里独立出去**。ok 仍被
   could_not_run 拉下 ⇒ 一台检查没跑成的机器，巡检/备份入口的退出码仍是 1 —— 那是
   「没跑成不算通过」那条验收，本文不改（改它才是真的放水）。
3. **没有给「为什么照备份是安全的」补一道【源损坏 ⇒ 产物必坏】的定理**：那是
   SQLite 的 VACUUM INTO 行为，我只实测过一个形状（page 级损坏 → 当场抛），
   不是证明。真正兜底的是 `createBackup` 产物自检 + 「在清理旧备份之前早退」的顺序。

## 6. 别当成做到了

- ⚠⭐ **本篇的「照备份」不是一个保险决定，而是一个搏**：它把安全托付给
  `createBackup` 对【坏产物】的拒收 + 早退顺序。这两样都已有既有用例，但「源损坏而
  产物通过自检」这一格我**没造出来、也没证明它不可能**（只实测到 VACUUM INTO 当场抛）。
  信它是信任 SQLite 的行为，不是信任一个我证过的界线。
- `worker_unavailable` / `worker_error` **仍然没有用例**（0036 §7 那条登记继续有效）。
- `integrity.test.ts` ① 那颗「默认路径走 worker」**慢**（~14–19s，建 128k 行 + 扫描期间
  主线程推进断言），每个变异迭代都付它一次；它【不是 flake】（干净代码连跑 3 次 30/30），
  只是「慢 + describe 级红聚在它身上」这两件独立的事在变异时撞在一起，容易误读。
- **`pnpm verify` 仍跑不起来**；③ 那两发在 0038 之后仍是 harness 给的绿，不是门禁绿。
