# 0053 那 8 发「故意红」在 Windows 上从来没生效过，以及一次没人做过的分隔符归一

> 起因还是 CEO 那一句「看看 docs 下还有多少没做完的，继续往下做」。
> 我按 `docs/INDEX.md` 与 `.workbuddy/AUDIT-LEDGER.txt` 的口径去找「没做完」，
> 找到的第一件东西却是**台账自己**：F.3 与 round187 那份矩阵把 8 发断言记成
> 「诚实的设计红，等外部 owner 接线」，跑了 ~70 轮、每一轮都复述一遍。
> 本轮的实测结论是：**那 8 发红的原因不是它们声称的那个原因**，
> 因此它们既不是「设计红」，也不是「缺口证据」—— 它们是**恒红**，
> 而恒红的断言在它声称要盯的那件事上**分辨能力是零**（0013 §8 用的正是这七个字）。

---

## 1. 一句话

四份测试文件里的 8 发断言，判据用**正斜杠字面量**比路径（`endsWith("charter/store.ts")`、
`includes("/charter/")`、`f.replace(SRC + "/", "")`、期望值写成 `SRC + "/harness/verifier.ts"` 那种拼接），
而取材侧是 `join()` —— Windows 给反斜杠。两侧不同形的后果不是「少匹配一点」，
而是**判据整体反过来**：「排除定义处」那个 filter 永不生效 ⇒ 模块自己把自己数成调用方 ⇒
「零调用方」恒不成立 ⇒ 断言恒红，**红因与它声称的「零调用方」完全无关**。

我按台账记下期望值把它们全部复算了一遍（分隔符归一后），
**11 个判据全部交出它们文档里写着的那个值** ⇒ 这 8 发**今天本该是绿的**，
而缺口是**另一件仍然开着的事**（§8）。修完：那 4 个文件 8 failed / 87 passed → **95 passed**
（【实测】分母同为 95，所以是同一批断言换了结果，不是我换掉了断言）。

---

## 2. 红因是分隔符，不是接线：逐条实测

【实测】HEAD `462c2e8`，全套 2334 / 2320 pass / 8 fail / 6 skip，8 发正是矩阵记的 8 发。
决定性的证据在**失败输出本身**——两侧内容相同、只有分隔符不同：

```
- Expected:  []
+ Received:  ["D:\\item\\opc\\packages\\hub\\src\\charter\\store.ts"]

- Expected:  "D:\\item\\opc\\packages\\hub\\src/harness/verifier.ts"
+ Received:  "D:\\item\\opc\\packages\\hub\\src\\harness\\verifier.ts"
```

第二发尤其直白：期望值那一串里 `src/harness/verifier.ts` 是**手写**的，
`D:\item\opc\packages\hub\src` 那一段才是 `join()` 给的 —— 同一条路径混着两种分隔符，
这本身就是「两侧不同形」的物证，不需要我推断。

判据是零分辨力，**只能靠注入真缺陷来证**（0013 §8 的规矩：改完变绿不是证据，
从恒红变恒绿最坏的解释是我把判据改瞎了）。复算脚本
`.workbuddy/round257-sepfix-mutate.mjs`（**入库**，照 round188 那份 `verify-open-invariants.mjs`
的先例：能独立复算的证据比一段 prose 值钱），逐发记录见
`.workbuddy/round257-sepfix-mutation-evidence.txt`，形状照 0051 §5
（锚点命中次数当场断言、每发**逐字节**还原比对）：

| # | 注入的真缺陷 | 目标断言 | 注入后 | 还原后 |
| --- | --- | --- | --- | --- |
| M1 | `saveCharterVersion` 出现 `charter/` 外调用方 | store ④ 第一条 | 红 1 | 绿 |
| M2 | 同上（写通道那条：`INSERT` 不过 HTTP/组织图） | store ④ 第二条 | 红 1 | 绿 |
| M3 | `syncCharterBudgets` 出现调用方 | budget-sync ⑦ | 红 1 | 绿 |
| M4 | `autoApprove` 出现调用方 | auto-approve ⑧ 第二条 | 红 1 | 绿 |
| M5 | `createCard` 出现调用方 | auto-approve ⑧ 第一条 | 红 1 | 绿 |
| M6 | `verifyFix` 出现调用方 | phase3 ④ | 红 2 | 绿 |
| M7 | `readAutoApprovalReport` 出现调用方 | phase3 ④ | 红 2 | 绿 |

【实测】7 / 7 PASS。**这才是「修好了」的证据**：修完的 8 发现在真的会在接线那天红。
注入点是 `packages/hub/src/overview/today.ts`（真 src，见 §7 的风险边界），
还原方式是**写回原始字节后逐字节比对**、不等即停机 —— 不是 `rmSync`（§6 第 2 条）。

**接线缺口本身一条都没被这次修复消掉**：`git diff` 里每一条 `toEqual(...)` 的
**期望值一字未动**（`toEqual([])`、`toEqual(["approvals/cards.ts"])`），
改的全是取材侧。这一点值得逐行核对，因为「修红」最容易作弊的地方就是把期望值改掉。

---

## 3. 归一化放在取材侧，不是期望侧

新文件 `packages/hub/test/fixtures/paths.ts` 三个函数：`toPosix` / `relPosix` / `posixJoin`。
放在 `test/fixtures/` 而不是各文件各写一份，理由与 0026 §0 同一族：
**同一个判据不许有两份字面拷贝**，抄的那份会各自漂移，而漂移的方向是「某个文件在 Windows 上静默失效」。

**为什么是取材侧而不是期望侧**（这是本轮唯一需要拍的取舍）：

* 期望侧写 `join()` 拼的本机分隔杠路径 ⇒ 「零调用方」这类断言在别的 OS 上可能**少算**而**照绿**；
* 期望侧写正斜杠 + 取材侧归一 ⇒ 分隔符出事时名单只会**变长** ⇒ **红** ⇒ 有人会去看。

这一族判据承受的两侧不对称：少算（把没接线的说成接了线）不可接受，误报可接受。
`phase3.test.ts` 里还有一条更隐蔽的：`out.sort()` 的**次序也是判据的一部分** ——
反斜杠 0x5C 与正斜杠 0x2F 排序位置不同，混合分隔符会让同一份源码在两台机器上
产出**两份不同的名单**，而两份都「非空」，只看 `length` 的断言照绿。

`relPosix` 的 `base` 参数**自己也做归一化**，这一条不是我设计出来的，是被我自己写的一发测试**逼出来的**（§6 第 1 条）。

---

## 4. 存量扫描：49 处命中 / 25 个文件，其中真需要修的只有这一族

`node .workbuddy/round257-sep-scan.mjs` 分类器扫全仓，形状三类：`endsWith/includes` 带斜杠字面量、
`split("/")` 切 `join()` 产物、`TMP + "/x.db"` 拼接。分堆结论：

* **本轮修的**：上面那 4 个文件里 6 处（另 `phase3.test.ts` 的 `SRC` 一处覆盖 13 处期望值拼接；
  【实测】`grep -c 'SRC + "'` 代码行 13 处，注释行另 3 处）。
* **本来就对的**：`test/arch/*` 那几份 `split("/")` 拆的是 **npm 包名**（`production-deps`、
  `no-native-deps`、`test-inventory`），不是文件路径 —— 拆包名用正斜杠是对的，改成 `split(sep)` 才是 bug。
* **良性**：`TMP + "/x.db"` 那类是**建库**用的拼接，交给 OS 解析，不参与任何字符串比对。
* `docs/review/check-gate.mjs` 两处 `includes("/")` 比的是自己拼出来的相对路径，同形。

**没有**给 `walk()` 之类加一道全局归一：判据要在哪一侧归一是**每条断言自己的事**，
加一道全局的等于把「谁归一了」变成读不出来，而下一次出事时读不出来就是又一次恒红。

---

## 5. `vitest.config.ts` 里那句前提是错的（已就地改注）

第 61 行与第 72 行写着覆盖率赤字「**恰是那 8 个设计红模块**」。数字本身仍然对
（`charter/store`、`budget-sync`、`auto-approve` 的 src 覆盖 0~17%，本轮**只动测试不动 src**，
所以覆盖率一分不变【本轮不动 src，此句是推论而**不是**新测量 —— 本轮没有跑 coverage】），
错的是**归因**：那 8 发红的成因是分隔符。改法是**改注释而不是改数值**——
阈值 0 的成立理由（全局 95 会因接线缺口恒红）不依赖那 8 发的红因是什么。

---

## 6. 本轮我自己犯的错（每条都是「改完看着对」的形状）

1. **`relPosix` 要求调用方先归一 `base`**，而我给它的注释说它处理混排。自己写的那发
   「混排（原生 base + 手写正斜杠尾段）」**红了**——这一发红是本轮最省事的时刻：
   它抓到的是**新代码的脚枪**，而且抓的时机在我把它交给 4 个文件之前。
   修法是 `base` 也过 `toPosix`，并把「这条测试红过」写在函数注释里。
2. **变异脚本第一版用 `rmSync` 当「还原」**。`appendFileSync` 之后 `rmSync(abs)`
   删的是**被注入的那份真源码**。写的时候看着像「清理」，跑下去就是删生产文件。
   改成保存原始字节 → `writeFileSync` 写回 → 逐字节比对，不等即停机。
3. **变异脚本第二版的锚点取自定义文件，注入点却在另一个文件** ⇒ 「改动落地」这道
   前置断言恒真，等于没断。第二版还先用 `includes(name + "(")` 判落地，
   而**定义行自己**就含这个串 ⇒ 恒真。最终改成数出现次数并要求**严格增加**。
   （0051 §5 那两次「全 0 输出」讲的是脚本把自己统计空了；这里是同族的另一支：
   **脚本把自己前置条件做成了恒真**，输出照样漂亮。）
4. **我一度以为 `paths.ts` 的注释写完了**，直到它因**注释里写了 hub 源码树的通配形状**
   （`packages/hub` 下那串 `.ts` glob）而整文件语法错 —— 那串里的 `*/` 把块注释提前闭合了。这个坑在 `test-inventory.test.ts`
   文件头就写着，我读过，然后在自己的注释里犯一遍（0051 §5 那句「读了、写进了注释、又犯一遍」在这里成立）。
5. **我自己的测试有一发前提写错**：以为「前缀短一层」会把路径整条留下，
   实测是剥成 `src/x.ts`。没有改判据迁就预期，而是把那一发**改写成真正想钉的东西**并补了一发不同根目录的反例。

---

## 7. 顺带撞见的一个新洞（登记，本轮**没有**修）

跑全套时 `test/arch/no-native-deps.test.ts` 报过一次
`ENOENT: no such file or directory, scandir '…\.tmp\tx-scope-probe-51388'`。
机理清楚：`walk()` 的 `readdirSync` 裸奔，而 `packages/hub/test/checkpoint/tx-scope-probe.test.ts`
的 `afterAll` 正在 `rmSync` 自己那份夹具目录；`fixtureTmp()` 还会替别人
`pruneStaleFixtureDirs`（`test/fixtures/fixture-dir.ts`），窗口比单个测试的 teardown 更宽。
同一个文件里 `readFileSync` **已经有** try/catch，`walk` 少了对应的那一层 ——
文件头 71~77 行已经把 `BOUNDARY_PROBE` 这一族记成「跨文件并行的已知撞法」。

**为什么本轮不动它**：这是**测试基建**的竞态，与本轮的分隔符是两条独立因果链，
混在一个提交里会让「哪一发证明了哪件事」读不出来。而且它比我起初以为的罕见得多：
【实测】HEAD 连跑 3 次全套 **0 复现**，工作树连跑 2 次 **0 复现**，
只有 1 次出现在改动前那趟；`no-native-deps` + `checkpoint/` 定向连跑 6 次 **0 复现**
⇒ 只在**全套负载**下撞，是**竞态**而不是回归。我没有修，也没有假装它不存在。
修法已经想清楚（`walk` 的 `readdirSync` 包一层 try/catch 跳过消失的目录，
与 `readFileSync` 同形），下一轮做这一格的人不必重新定位。

`packages/hub/test/engine/claude.test.ts` 报 "No test suite found" 属**既有良性**：
那是 `node:test` 文件，vitest 收不到，`node --test` 下 13/13 绿（round187 已记）。

> 【撤回 0055 §4】上面那句**既有良性**是错的，原句照留。错的不是机理而是结论：
> vitest 收不到 ⇒ ① `npx vitest run` **恒 exit 1** ⇒ `pnpm verify`（`lint && typecheck && test`）
> **恒不可能通过**；② 那 13 发在门禁下**一发都没跑**（把 `parseDecision` 的 `lastIndexOf` 改成 `indexOf`，
> 门禁输出与基线逐字节同）。机理对（node:test 收不到）不等于结论无害 ——
> **给一个红灯找到正确的机理，不等于给它找到无害的结论**。而我那句「13/13 绿」是照抄 round187、
> 没有自己复算（它依赖的 `/tmp/opc-harness/register.mjs` 本机已不存在）。修的过程与三条
> 「标题写着而断言没写」见 0055。

---

## 8. 别当成做到了

* **8 发断言现在绿，说的是「今天的接线状态与文档写的一致」，不是「接上了」**。
  逐条对照 round187 那份矩阵，**缺口一条没消**：`saveCharterVersion` /
  `syncCharterBudgets` / `autoApprove` / `createCard` 的生产调用方**仍是零**，
  `readAutoApprovalReport` 仍只到数据面，桌面/HTTP 仍到不了 `policy/auto-approve.ts`
  （那格在 0052 §3 的差账里，本轮没碰）。§2 那 7 发变异证明的是**断言会红**，
  不是**缺口已补**。
  【round321 复核：本句四项「仍是零」现为 3 假 1 真。真（仍零）：`syncCharterBudgets`
  在 src 仍只有定义。假（已接上）：`saveCharterVersion` 由 `charter/seed.ts` 作第一个
  生产调用方（seed.ts 文件头自有 ⚠ 标注）；`autoApprove` 由 `approvals/query.ts:274`
  影子判定（O9 阶段一）生产读取；`createCard` 由 `serve/dev-seed.ts:432`（`pnpm dev:seed`
  入口，dev 专用建卡正当路径）调用。→「缺口一条没消」改为「三项已补、一项仍零」，
  与 round316 记忆的 insertCard/cards 链现状一致。】
* **本轮没有新增守卫**去防「以后再写出一条分隔符不相称的判据」。`round257-sep-scan.mjs` 是**一次性脚本**
  而不是普查守卫：它 49 个命中里 40 多个是合法的，直接升成守卫会造出大片假阳
  （0007 §4.1 记的正是假阳逼人关掉守卫的代价）。要做成守卫，判据得先能区分
  「比对用的路径」与「建库/拆包名用的路径」——`fixture-dir.ts` 的 `createsTmpDir` 那条
  「分得开建目录与比对名字」是现成的形状参照，但本轮没做。
* **`paths.test.ts` 那 11 发只测三个函数本身**，不测那 4 个文件的判据；
  后者的分辨力证据只有 §2 那 7 发变异，而变异是**手工脚本**、**不进 CI**。
* coverage 阈值**没动**（§5）；`tsc -b` 覆盖不到 `test/**`（0007 §5 那条既有缺口），
  所以 `paths.ts` 的形状**没有类型层闸门**。
* 台账与矩阵里「8 设计红」的旧措辞，本轮只在**本轮新写的条目**里更正，
  **没有回头改写 round187 那份历史证据**（历史条目按本仓规矩留着，见 §9）。

---

## 9. 复算方式（本机 node v24.14.0，离线）

```bash
# 修前 / 修后对照（同一批 4 个文件，分母同为 95）
git stash push -u -m sep
npx vitest run packages/hub/test/charter/ packages/hub/test/policy/auto-approve.test.ts \
               packages/hub/test/acceptance/phase3.test.ts        # → 8 failed | 87 passed
git stash pop
npx vitest run packages/hub/test/charter/ packages/hub/test/policy/auto-approve.test.ts \
               packages/hub/test/acceptance/phase3.test.ts        # → 95 passed
npx vitest run packages/hub/test/fixtures/paths.test.ts           # → 11 passed

node .workbuddy/round257-sep-scan.mjs                    # 分隔符脆弱点分类：49 命中 / 25 文件
node .workbuddy/round257-sepfix-mutate.mjs      # §2 那 7 发变异（入库；自带 src 洁净终检）
npx vitest run --run                            # 全套 2345 / 2339 pass / 6 skip
npx vitest run test/arch/                       # 18 文件 / 138 例全绿
node docs/review/check-gate.mjs                 # 只读自证
```

台账记在 `.workbuddy/AUDIT-LEDGER.txt` 的 M 段（round257）。
`pnpm verify`（lint + typecheck + test 全链）依项目规矩**待人亲跑**：
本轮**实测到**的是——4 个改动文件 biome 与 HEAD **同一组 8 error + 1 warning、同一规则构成**
（【实测】`assist/source/organizeImports` ×4 + `lint/correctness/noUnusedImports` ×1，
逐条 diff 一致 ⇒ 本轮**零新增**静态检查问题，那 8 条既有问题**没被本轮修掉也没被本轮加重**）；
新建两份文件 biome **0 错**（格式化过一次）；`test/arch` 138 例绿。
