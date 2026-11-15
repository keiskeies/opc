# 0054 一个复现不出来的竞态，以及我那条「确定性复现」其实没复现它

> 0053 §7 登记了一格没修的东西：`test/arch/no-native-deps.test.ts` 的 `walk()` 那层
> `readdirSync` 裸奔，全套跑的时候被撞出过一次 `ENOENT ... scandir`。
> 本篇就是做那一格。做完之后本篇最该记的一条**不是修法**（修法三行，与同文件
> `readFileSync` 已有的那层 try 同形），而是：**我写的第一条「确定性复现」对老代码也是绿的**
> —— 它测不到那个缺陷，而发现这件事的唯一办法是把修好的代码改坏回去看会不会红。

---

## 1. 一句话

`walk()` 递归时对自己决定进入的目录调 `readdirSync(dir, { withFileTypes: true })`，没有任何保护；
同文件 60 行之外的 `readFileSync` 早就有 `try { … } catch { continue }`。
被撞的路径是清楚的：`fixtureTmp()` 在 `packages/<pkg>/.tmp/` 下建目录、`afterAll` 与
`pruneStaleFixtureDirs()` 删别人的，而 `walk` 的跳过名单只有 `{node_modules, dist, out}` ⇒ 它会下到这层。
修法是照抄本仓已有的形状（`test-inventory.ts` 的 `survivesStat`：只宽容 ENOENT/ENOTDIR，权限类照抛），
外加把 `readdir` 抽成可注入参数。

数字：`test/arch` 18 文件 / 138 → **141 例全绿**（+3）；全套 **2348 例 / 2342 pass / 6 skip**（+3）；
`tsc -b` exit 0；对该测试文件的一次性 `tsc --noEmit --strict` exit 0；biome 全仓 294 error
与 HEAD **逐条同**（§6）；gate exit 0；**变异 8 发全被抓住**（§4）。

---

## 2. 复现不出来，所以先把「复现」定义出来

【实测】开工前的复现率（0053 记的是同一批数字，这里重量一遍确认没记错）：
定向连跑 8 次 0 复现、HEAD 全套 3 次 0 复现、工作树全套 2 次 0 复现。
只有 0053 那次改动前的跑撞见过 1 次。⇒ **这是负载下的竞态，不是回归**，
也就没有「跑一下就红了」这种验收方式可用。

那么怎么证明修好了？只有两条路：
① 等它再撞一次（不可依赖，且撞不响的一次通过不算通过）；
② **把竞态发生后的那个状态静态摆出来**，再用变异证明这条静态场景真的抓得到原始失效模式。
本篇走的是 ②，而 ② 的坑正在于「静态摆出来的状态」很容易**不是**那个状态。

---

## 3. 我那条确定性复现测了个空（本篇的核心）

第一版写的场景很自然，看着无懈可击：真磁盘上建 `parent/child/nested.ts` 与 `parent/sibling.ts`，
`rmSync(child)`，然后断言 `walk(parent)` 不抛且只剩 `sibling.ts`。它绿了。
**问题在它是【测不到东西】才绿的**：把 `walk` 退回裸 `readdirSync`，它**照样绿**（探针变异当场暴露）。

机理是 `readdir` 的语义，这一条是我这轮真正学到的东西：

* `readdirSync(parent)` 交出的是**那一刻的快照**。快照之后 `child` 才被删，快照里它仍报 `isDirectory()`。
* 但如果我是**先删再列**（我的测试做的就是这件事），`child` 压根不出现在快照里 ⇒ `walk` 根本不会去 `readdir(child)`
  ⇒ 老代码走不到那句会抛的调用，**测试与缺陷完全错开**。
* 真正的失效点必须是：**快照里有它，递归下去时它没了**。
  也就是「删除正好落在 `walk` 内部两次 `readdir` 之间」—— 那是**时序**，从测试外部安排不了。

所以把 `readdir` 抽成参数（`Readdir`），用假清单把那一毫秒直接摆成静态状态：
假清单在 `parent` 上报 `gone-mid-scan` 是个目录，在 `gone-mid-scan` 上抛 ENOENT。
这才是实测那次 `scandir '…\.tmp\tx-scope-probe-51388'` 的形状 —— **报的是那个目录自己，不是它的父**。

顺带把那条测不到的删了。留着的理由我一开始想找（「它至少钉住了 `readFileSync` 那条既有通道」），
但那句话用不上它：`readFileSync` 的容错本来就在那儿，而一条**对本轮修复不敏感**的测试
混在「遍历容错」这一族里，只会让下一个读数的人以为这一族有覆盖。

与 0051 §5 / 0053 §6 同一族的第四支：**「测试绿了」与「测试测到了」是两件事**，
区分它们唯一的手段是改坏被测代码；改坏后仍绿的测试不是保护，是安慰剂。

---

## 4. 变异 8 发

脚本入库：`.workbuddy/round258-racefix-mutate.mjs`（照 round188/round257 的先例，能独立复算的证据比 prose 值钱）。
每发：改坏 → 断言红 → 写回原始字节 + 逐字节比对 → 断言绿。基线取**探针启动那一刻的字节**而不是 HEAD
（被改的就是本轮未提交的两个文件，照 HEAD 比会一进场就 ABORT —— 第一版就是这么自杀给我的）。

| # | 变异 | 抓它的是哪发 | 结果 |
| --- | --- | --- | --- |
| M1 | 判据恒返回 true（吞掉一切） | 三种态那条 | 红 → 还原绿 |
| M2 | 判据恒返回 false（什么都不扫） | 所有正对照 | 红 → 还原绿 |
| M3 | 连权限错误一起吞 | 三种态那条的 EACCES/EPERM/EBUSY | 红 → 还原绿 |
| M4 | `walk` 的 `null` 判断写反 | 合成 + 真磁盘两条 | 红 → 还原绿 |
| M5 | `readdirOrNull` 不调注入的 `readdir`，直接给空 | 真磁盘那条 | 红 → 还原绿 |
| M6 | **`readdirOrNull` 退回无保护（原缺陷复现）** | 合成那条 | 红 → 还原绿 |
| M7 | `walk` 忽略注入、硬用真 `readdirSync` | 合成那条 | 红 → 还原绿 |
| M8 | 递归处丢掉注入的 `readdir` | 合成那条 | 红 → 还原绿 |

【实测】8 / 8。**M6 是这一族里唯一一发复现原始失效模式的**，它才是「修好了」的证据；
M7/M8 钉的是「可注入」不是装饰 —— 传进去的 `readdir` 真被用了、且递归那一层也用得到。

M1/M2 成对出现是故意的（恒真与恒假各测一次），单写 M1 的话 `readdirSurvives` 被写成恒返回
false 也能让「ENOENT 被宽容」那条照绿。

**这一发不是没付代价的**：把 `readdir` 抽成参数是为了可测性，代价是 `walk` 的签名多一个默认参数。
我认为值（同文件已经为同一个理由把 `isExemptPosix` 抽出去过），但它是我改的**生产测试基建的接口**，
不是纯内部实现 —— 记在这儿。

---

## 5. 「顺手把另外两个 walker 也修一下」是错的：三个 walker 各因不同原因没坏

我先假设的是「三处都有同一颗雷」，量完才发现不是，而且**每一处的理由都不一样**：

| 遍历 | 有没有下到 `.tmp` | stat 保护 | 结论 |
| --- | --- | --- | --- |
| `no-native-deps.walk` | **下**（跳过名单只有 `{node_modules,dist,out}`） | `readdirSync` 裸奔 | **就是它**，本轮修 |
| `harness-invariants.walkFiles` | 不下（`SKIP_DIRS` 含 `.tmp`） | 不用 stat（用 `withFileTypes`） | 不修 |
| `test-inventory.enumerate` | 不下（`IGNORED_DIRS` 含 `.tmp`） | `statSync` 已被 `survivesStat` 包着 | 不修（模式就是从它抄的） |
| `production-deps.tsFiles` | 只走 `packages/*/src`，夹具在 `packages/<pkg>/.tmp` ⇒ 到不了 | `statSync` 裸奔 | **本轮不修，登记**（见下） |

`production-deps` 那一处为什么不顺手修：【实测】`grep mkdirSync|mkdtempSync` 在全部测试里
**没有任何一处在 `packages/**/src` 下建目录**；而它排除的 `BOUNDARY_PROBE` 是**一个文件**
（`__boundary_probe.ts`，`run-fixtures.ts` 第 16 行），且 `isRuntimeFixture(name)` 在 `statSync` **之前**
按名字拦掉。所以那颗雷今天没有并发引爆者。**它不是没有雷** —— 谁哪天往 `src/` 里建个目录夹具，
它就是第二个 `no-native-deps`。修法与本轮同形，写在这儿让下一个人不必重新定位。

### 为什么不「顺手把 `.tmp` 加进跳过名单」

这是最省事的修法，我量完**否掉了**：【实测】`packages/**` 下可扫的源码文件 197 个，
把 `.tmp` / `coverage` / `.next` 全跳过会少扫 **0** 个 —— 看起来白捡。
但本守卫是**零容忍扫描器**：多跳一个目录 = 多看不见一片源码。此刻是 0，
等 `coverage/` 里落进一份带 `better-sqlite3` 的产物就**永远看不见**它，而它正是 D6-a 要抓的东西。
跳过是**少算**（静默假绿），撞不上是**多报**（红，有人会去看）——
这与 0053 §3「归一化放取材侧而不是期望侧」是**同一个不对称**在这一族的第二次应用。
所以修的是「消失了就跳过这一层」，扫描范围一分不减。

---

## 6. 我自己的测量差点是假的：biome 的三个坑

本轮要交付的结论之一是「biome 与 HEAD 逐条同」。这句话我**三次差点写错**，每一坑都记下来：

1. **默认只打 20 条诊断**（`--max-diagnostics` 默认 20），而汇总行 `Found 294 errors` **不受这个上限影响**。
   ⇒ 任何拿默认输出算「规则构成」的做法都是在 20 条样本上说 294 条的话。我第一次抽出 10 条标签、
   123 字节，**看着就像能下结论**；拦住我的是「123 字节不可能装下 294 条」这个数量级直觉。
2. **输出顺序每次不同**。同一份工作树连跑两次，整份输出差 **158179 字节**；`sort` 之后差 112 字节
   （那 112 是耗时行）。⇒ 直接 `diff` 两份 biome 输出测的是**排序**，不是差异。
3. 我第一版提取式只覆盖 **241 / 294** 条（正则没吃下所有行形），比出来的「IDENTICAL」只覆盖 82%。

最终口径：`--max-diagnostics=none` + 剥掉耗时行 + `sort` + 整份 diff ⇒
**26322 行逐条同**，294 error / 109 warning / 2 info 与 HEAD 一致，本轮**零新增零修掉**。
（这条与 0051 §5「脚本把自己统计空了」同族，但成因是外部工具的分页与乱序，不是我的代码；
可迁移的部分是：**先问这个测量能覆盖几个，再读它的结论**。）

---

## 7. 本轮我犯的错（每条都是「改完看着对」的形状）

1. **`continue` 写在循环外**。第一版把保护塞在 `walk` 的函数顶部（`for` 之前），照着循环体的写法
   用了 `continue` —— 语法错。它**只可能被 vitest 抓到**：`tsc -b` 不覆盖 `test/**`（0007 §5），
   `test/**` 的语法/类型全靠跑。这一发是 §8 那条「一次性 tsc 不是闸门」的现场教材。
2. **第一条确定性复现测了个空**（§3，代价最大的一条，靠变异抓到）。
3. **`as Dirent` 造假目录项**：`Dirent` 还有别的成员，部分字面量强转是 **TS2352**，
   而 `test/**` 不在 tsc 射程里 ⇒ 这种错会**静默留在树上**。改成 `Pick<Dirent, "name" | "isDirectory">`，
   假条目不再需要断言。
4. **块注释里写了 hub 源码树那串通配**，`*/` 把注释提前闭合。**这个坑我读过两遍**：
   `test-inventory.test.ts` 文件头写着它，0053 §6 第 4 条 是我上一轮刚写的「读了、写进了注释、又犯一遍」。
   第三次还是犯了。⇒ 光把坑写进文档**不阻止我再踩**；真正拦住它的是「改完就 `vitest run` 一次」这个动作。
5. **探针第一版带着 round257 的前置条件**进场（要求被改文件相对 HEAD 干净），而本轮被改的
   **就是**未提交的本轮工作 ⇒ 它一进场就 ABORT。抄脚本时**抄来了上一轮的情境假设**。
6. **拿 `node -e` 做字符串手术去改探针锚点**，改到第三处 ANCHOR-MISS。放弃手术、照新的代码形状**重写**了探针。
   （0053 §9 与 memory 里那条「修坏字符要用 node 替换而不是重打」是**另一件事**：那里重打是触发器，
   这里重打是正确做法 —— 区别在于我改的是**自己刚写的、形状已知**的脚本，还是**一份我要保留原文**的证据。）

---

## 8. 别当成做到了

* **修的是「崩」，不是「竞态本身」**。目录在扫描途中消失，现在的行为是**静默跳过这一层**。
  理论上这会跳过一个「扫描期间存在过、随后被删」的真实越界文件。这是本文件对 `readFileSync`
  **早就做过的同一个取舍**，我只是把缺失的那一层补上，没有新引入它，也没有消除它。
* **没有新增守卫**去防「以后有人再写第四个裸遍历」。§5 那张表里三处「没坏」的理由**各不相同**
  （跳过名单 / `survivesStat` / 没有并发删除者），而**没有一个是被机械强制的**。
  做成守卫要先能区分「遍历来比对内容」与「遍历来数东西」，本轮没做（与 0053 §8 那条同一族）。
* **`production-deps` 的裸 `statSync` 本轮没修**，理由见 §5 —— 是「今天没有并发引爆者」，
  不是「没有雷」。
* **M6 证明的是「退回无保护会红」**，不是「修完之后那次真竞态不会再撞」。
  原始 ENOENT 在修复前后**都一次没复现过**（§2），我对它覆盖到的信心来自**形状比对**
  （scandir 报的是那个目录自己）+ M6，不来自一次「修完后干净地跑过真竞态」。
* **变异探针是手工脚本，不进 CI**（与 0053 §8 同一条）。`paths.ts` 那三个函数、`readdirSurvives`
  的判据，CI 里都只有它们**自己的单测**在跑，判别力证据在 `.workbuddy/` 里等人跑。
* `test/arch` 从 138 → 141 例，**新增 3 发全在这一族**；`vitest.config.ts` 的覆盖率阈值一分未动，
  本轮**不动 `src`**（只动 `test/arch`），覆盖率不可能变 —— 这句是**推论，本轮没跑 coverage**。
* `tsc -b` 不覆盖 `test/**` 这条既有缺口**本轮没有修**；我为这两个文件跑的一次性 `tsc --noEmit --strict`
  是**手工动作**，不是闸门。
* 0053 §7 与台账 M 段那条登记**没有回头改写**（历史条目按本仓规矩留着），本篇只做它。

---

## 9. 复算方式（本机 node v24.14.0，离线）

```bash
npx vitest run test/arch/no-native-deps.test.ts        # → 5 passed（改前 2）
npx vitest run test/arch/                              # → 18 文件 / 141 例
npx vitest run                                         # → 2348 / 2342 pass / 6 skip
node .workbuddy/round258-racefix-mutate.mjs            # → PASS 8/8 + 收尾字节自检
npx tsc -b                                             # exit 0（注意：不含 test/**）
# test/** 的类型层只能自己补一发（0007 §5 那条缺口）：
npx tsc --noEmit --strict --skipLibCheck --target es2023 --module nodenext \
        --moduleResolution nodenext --types node test/arch/no-native-deps.test.ts   # exit 0
node docs/review/check-gate.mjs                        # exit 0
# biome 与 HEAD 比：必须 --max-diagnostics=none，且 sort（§6 三坑）
npx biome check . --max-diagnostics=none | grep -vE 'in [0-9.]+m?s|Checked [0-9]+ files' | sort > /tmp/w.txt
git stash push -u -m bio && npx biome check . --max-diagnostics=none \
  | grep -vE 'in [0-9.]+m?s|Checked [0-9]+ files' | sort > /tmp/h.txt && git stash pop
diff /tmp/h.txt /tmp/w.txt                             # → 空
```

台账记在 `.workbuddy/AUDIT-LEDGER.txt` 的 N 段（round258）。
`pnpm verify`（lint + typecheck + test 全链）与审计日志可读性依项目规矩**待人亲跑**。
