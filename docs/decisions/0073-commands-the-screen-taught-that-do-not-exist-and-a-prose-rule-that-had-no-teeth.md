# 0073 · 屏幕上教的命令压根不存在 —— 一整个家族的 27 行，和一条把「散文纪律」变成守卫的判据

**日期。** 2026-11-27（round387）。
**落地。** 操作者文案 9 个文件 27 行（`packages/web/public/app.js`、`packages/hub/src/cli.ts`、
`engine/work.ts`、`engine/driver.ts`、`engine/dispatch.ts`、`serve/config.ts`、
`serve/assemble.ts`、`charter/seed.ts`、`heartbeat/maintenance.ts`）；
新守卫 `test/arch/cmd-name-runnable.ts` + `.test.ts`（18 发，以真解析器为 oracle）；
跟措辞走的断言 5 个文件 12 处（`work.test.ts`、`driver.test.ts`、`assemble.test.ts`、
`stub-write-guard.test.ts`、`doc-refs.test.ts`）；0050 §4.2 就地标注一处。

## 1. 一句话

看板那块「这台 Hub 没开驱动器」的横幅写着：

```
要自动推进请带 --driver-pump 起 Hub，或手工 hub work。
```

**`hub work` 这条命令不存在**，而「手工 hub work」是把不存在说成可执行的下一步。实测（真 CLI，逐字）：

```
① pnpm hub work        ⇒ 退出 2「未知子命令：work（可用：run / status / resume）」
② pnpm hub:engine work ⇒ 退出 2「缺参数：--db / --task / --max-budget-usd / --task-limit-cents」
⑥ 参数照抄齐 ⇒ 退出 2「数据库文件不存在 —— …（pnpm hub:engine work 不建库，先用 pnpm hub run 建任务）」
```

② 与 ⑥ 是同一条命令在**往前走**：② 说的是「你还差这几样」，⑥ 说的是「参数对了，去建库」。
① 说的是「我不认识这个子命令」。人在终端前照抄屏幕上那一句，拿到的是①。

而且不是那一条孤例。把屏幕上会被照抄的行全量过一遍，**同一族有 27 行**：
`hub work` / `hub decide` / `hub run` / `hub status` / `hub resume` / `hub charter seed` /
`hub charter save` / `hub-maintenance`。全部缺 `pnpm ` 前缀，因为：

**`hub` 不是可执行名。** `packages/hub/package.json` 是 `private: true` 且**没有 `bin` 字段**
⇒ 系统里不存在 `hub` 这个命令，它只作为**根 `package.json` 里的 pnpm 脚本名**存在
（`hub` / `hub:serve` / `hub:engine` / `hub:charter` / `hub:maintenance`，五个）。
所以 `hub resume` 要写成 `pnpm hub resume`，`hub work` 要写成 `pnpm hub:engine work`。

其中 `hub charter save` 是**双重的假**：不光缺前缀，`save` 这个子命令也不存在 ——
`runCharterCli` 只分发 `seed`，改已有岗位书走的是「岗位书」那页的编辑器。卡片上那句
「写岗位书并保存（hub charter save）」把两条不存在叠在一起。

## 2. 这一族的特殊之处：它**早就被写成纪律**了，只是没有牙

`packages/hub/src/serve/config.ts` 文件头（改之前就在）写着：

> 用法文本的读者是人照着敲的，一条不存在的命令比少写一行更糟。

同一批文件里 `hub work` 那一条链**至今 0 个调用方**（0069 已经量过）。也就是说这不是
「没人想到」，是**想到了、写在文件头、然后同一个文件里漏了 10 行**。散文纪律的失效方式
就是这样：它约束写它的那一次，不约束后来的每一次。所以这一发的主体不是那 27 行字，
是把那句话落成机械判据（§4）。

## 3. ⭐ 判据为什么必须拿真解析器当 oracle，以及我自己先抄错的那份名单

第一版的守卫有一行**手抄的动词表**（「已知存在的 verb」）。手抄名单 = 第二个真相源，
它会在下一次加子命令时安静地变成错的 —— 这正是被守的那个病。改成两条都不靠记忆：

- **verb 层用 `runEngineCli` 自己当 oracle**（`engine/hub-work.ts` 的导出，进程内调用）。
  它的报错把「认得」与「不认得」分得很干净：不认得 ⇒「没有 [x] 这个子命令」，
  认得但缺必填 ⇒「缺参数」。于是**存在性是它当场说的**，不是我抄的。
  跑的是进程内调用：给一个不存在的库路径就停在参数与文件检查那一层，
  **不建库、不起子进程、不花钱**（全量里每轮 4 发，这一格必须是零成本）。
  实测：`work` / `decide` ⇒ 认得；`run` / `status` / `resume` ⇒ 不认得、退出 2。
  后三条正是 `cli.ts` 的 `VERBS`，两边不重合是**设计**（引擎路线与 CLI 是两个入口），
  所以守卫同时钉「`cli.ts` 的 `VERBS` 每条都得在自己的用法文本里带 `pnpm hub <verb>` 出现」
  —— round387 的病形恰恰是**用法文本说 work，而 `VERBS` 只有三条**。
- **脚本名层对照真 `package.json` 的 scripts 键名**。将来真注册 `hub-maintenance`，
  守卫自动放行，不需要谁来改名单。

`hub charter seed` 走的是 CLI 的 `charter` 位置参数，不是 `VERBS` 那一项 —— 所以它落在
**脚本名层**判，不在 verb 层。两层的权威源不同，别并成一条。

## 4. 判据三条形态各挡各的（缺一半就有真实漏法）

`findBareHubCommands` 只扫**非注释行**（注释里的 `hub work` 是 0041/0043 的论证本体，
不是给人照抄的）。三种形态：

| 形态 | 合法条件 | 只查一半会漏什么 |
| --- | --- | --- |
| `hub <verb>` | 前面正好是 `pnpm ` | 只查 verb ⇒ 放行裸可执行名 `hub` |
| `hub:<name>` | 前面是 `pnpm ` **且** scripts 真有那个键 | 只查前缀 ⇒ 放行 `pnpm hub:work`（没这脚本）；只查键名 ⇒ 放行不带 pnpm 的 `hub:engine work` |
| `hub-maintenance` | scripts 真有同名键 | 写死「它是错的」⇒ 真注册之后守卫恒红，会被整条关掉 |

第二行那两条半边是**变异机逼出来的**，不是我一开始想到的：第一版只查前缀，
`pnpm hub:work` 这种「看着像入口而其实没有」的写法直接放行（M7 那发），
反方向「裸 `hub:engine`」同样放行（M8 那发）。

## 5. ⭐ 变异机第一版有两处毛病，都是机器自己的

**预检 3/3 绿 · 变异 8/8（M1–M8 该红全红，控制组 C1 该绿）**，每发跑完**立刻**逐字节还原并核对 sha256。

1. **C1 控制组第一版报红，而红的是上一发的残留。** 我原先把所有还原放在 `finally`
   里统一做，于是 M5（把判据的前缀核对改成恒真）跑完之后判据还是坏的，才跑控制组 ⇒
   控制组那 3 发红的是 **M5 的行为**，不是它自己的。一次归因错比少跑一发贵得多：
   它会把「判据坏了」记成「控制组不稳」，而控制组唯一的用处就是证明判据没坏。
   改成每发 `finally` 各自还原 + 单发 sha256 核对。
2. **M2 第一版存活。** 抹掉 `WORK_USAGE` 首行的 `pnpm` 之后 `work.test.ts` 33 发**全绿**：
   全文另有一句「不是再敲一次 pnpm hub:engine work」，`toContain` 从它身上拿到绿。
   按家法先怀疑判据 —— 人打错命令时读的是**第一行**，所以补一发钉行首
   （`split("\n")[0]` 匹配 `^用法：pnpm hub:engine work `）而不是放宽阈值；M2 即红。
   同族那条全文判据（`not.toMatch(/(?<!pnpm )hub (work|decide)\b/)`）**保留**，
   两发各挡各的：一条防「别处混进裸形态」，一条防「首行不是能照抄的那句」。

## 6. 顺手量到的两格

- **`--help` 只在 verb 位置有效。** `work --help` ⇒ 退出 2「work 不认识参数 --help」
  （`--help` 只在 `argv[0]` 被认，见 `hub-work.ts` 的分发）。这是**已知形状**、不是本篇改的，
  但它说明「屏幕上写的命令能不能跑」要连**参数位置**一起判；本篇只把命令名与必填参数
  照抄得对，`--help` 那一格记在这里，没动。
- **反向那一发仍然对**（`assemble.test.ts` 那条 `not.toContain("hub resume")`）：
  没接图运行时的横幅**不许**教 resume（`cli.ts` 顶层 import `@langchain/langgraph`，
  本机装不上）。本篇只把**该教** resume 的那一支从 `hub resume --db` 改成
  `pnpm hub resume --db`，两支横幅各自只描述自己那条路线的结构一字未动。
  图工厂那条报错里有 `<库路径>` 占位符 —— 有库路径时印真路径，没有时印**明显要填的占位**，
  而不是印一条看着完整、实际必挂的命令（0043 那条论证原样保留）。

## 7. 别当成做到哪一格

- **文档里的 94 处没动**（`docs/` 全量，其中两份设计文档 15 处）。设计文档写的是**动作名**
  而不是可复制命令行；`docs/INDEX.md` 自己就是被 C7「入口里不许轮次相对指称」管着的入口，
  而决策记录是 CEO 已经读过的东西 —— 批量重写不是单方能做的动作。**要不要把设计文档
  也统一成 `pnpm …` 形态，等 CEO 一句话**；本篇只改**屏幕上会被照抄的那 27 行**。
- **`packages/web/public/app.js` 整文件不在守卫的注释豁免之外**：它没有注释行形态的
  `hub work` 残留，是靠 ① 那一发实测为 0，不是靠名单放行。
- **守卫只扫 11 个文件**（`OPERATOR_FILES` 名单）。新加一个会打印命令名的入口而没进名单 ⇒
  守卫不会响。名单本身有一条「取材没坏」的发（每文件长度 > 500 且 app.js 那句锚点在），
  它挡得住漏扫某个文件导致**恒绿**，挡不住「新文件根本不在名单里」。
- **`hub:engine` 后面那个 verb 的**合法性不在静态扫描面上**，在 ③ 那发的解析器 oracle 上；
  而 ③ 只测了 `work` / `decide` / `run` / `status` / `resume` 五个词，
  不是「未来任何 verb」。
- **`at_limit` 那一档的措辞与泵开关的建议一字未动**（0050 §4.2 的理由仍成立：那一档的
  下一步不是再敲一次驱动器）。0050 §4.2 里被本篇改掉的那句**命令名**，就地标注了
  「改的是命令名写法，不是这一档要不要指它的判断」，而那条引用所在文件的行数**没变**
  （本篇刻意保持每个文件的行数，见 §8）。

## 8. 实跑

- 定点：`work.test.ts` 33 · `driver.test.ts` 11 · `cmd-name-runnable.test.ts` 18 ·
  `serve` + `cli` + `heartbeat` + `charter` **546 passed**（20 文件，一次覆盖 app.js 的横幅、
  `config.ts` 用法、`maintenance.ts` 用法、seed 的 summary、cli 的 `run`/`status`/`resume` 行为）·
  `assemble.test.ts` + `stub-write-guard.test.ts` + `doc-refs.test.ts` **64 passed**。
- **变异机 8/8 + 预检 3/3 + 控制组绿**，每发单发还原核对 sha256（`.workbuddy/round387-mutation.mts`）。
- `tsc -b` exit 0 · `tsc -p tsconfig.test.json --noEmit` exit 0（新守卫两文件在 0 错硬门语料内）。
- 新守卫两文件 biome **0 诊断**（第一版有 3 条：一条 `noUnusedImports` 的 `relative` 没删 + 两处
  format；`--write` 之后重跑判定与 `tsc -b` 都重绿，变异机的锚点串按格式化后的字节重核过）。
- **行数：我改的 27 行做到了一行对一行**（改的都是行内字，`work.ts` 那句「下一步」原本占两行、
  改后仍占两行），但**「每个文件行数不变」这句没成立**：biome 随后把两枚超长的字符串字面量折了行
  —— `charter/seed.ts` 的 `summaryOf` 那一句折成 5 行，`work.test.ts` 那条行首断言折成 3 行。
  两处增量分别落在 721 与 612 之后，而**被文档引用的两条坐标都在增量之前**（saveCharterVersion
  在 seed.ts 的调用点 653、`work.test.ts` 里 fake-claude 那一发的 326）⇒ 实读字节一字未变，
  SNAP 与两份文档的引用都不必重钉。**判定用实读**（直接 `sed -n` 把那两行打出来对），
  不靠「增量在它后面所以没事」这句推断。SNAP 里只有**内容**变了一格：`0050>app.js`
  那一行的快照串换成新那句（同一条键、同一行号）。
  探针⑥的读数里那句「`pnpm hub:engine work` 不建库」现在与源码逐字一致 ——
  改之前它印的是 `hub work 不建库`，而 SNAP 钉的是 app.js 那一行，两者不冲突。
- 0050 §4.2 加两行**就地标注**（正文与旧读数原样留着）；本篇引用它时**不写冒号形态**的
  旧坐标（`doc-refs` 的取材是整篇散文，复述一次就算一次活引用）。
- ⚠ **全量先红过三发，三发的病因各不相同**（定点全绿而全量红 ⇒ 这三条都不在定点面上）：
  1. `doc-coords`：本篇把「0050 §4.2」写成了**带行内代码标记的篇号 + 空格 + 节号**，
     而它的解析器要求篇号与节号符号**相邻** ⇒ 那条被读成**本篇的裸形子节号**（4 下面的 2），
     恰好本篇有 §4、
     设计文档有 §4.2 ⇒ 撞进它明文的「形状歧义」判据（**错号会被同名外部节洗白**，所以它不猜）。
     修法是写成解析器认的相邻形态，而不是给守卫加豁免。同族那一发在 §7 里本来就写着「引用别篇要加限定词」。
     ⚠ **而它第二遍红在同一格的描述句上**：我为了说明那个错形状，把「篇号漏掉、只剩子节号」
     那一串照着符号原样打了出来 —— 守卫照抓。它的取材是整篇散文，不认「我只是在描述旧写法」。
     改成不用那个符号形态的说法（这条已在 doc-refs 那一族记过，这次是它的兄弟守卫 doc-coords）。
  2. `lint-baseline`：报的是 `format=2` 这个**基线外类目** —— 正是本篇自己那两枚超长字面量。
     按规矩**修代码而不是登记基线**（登记等于把新种类的 error 放进「反正 lint 本来就红」里混过去）。
     ⚠ 我先把 `--write` 只用在两枚新守卫文件上就宣布「biome 0 诊断」，那是对的**但只覆盖两个文件**；
     基线跑的是 458 个文件。**「我改的文件干净」≠「仓库的 lint 读数没被我改坏」**。
  3. `test-inventory`：红在 `.workbuddy/probearch/p.test.ts` —— **我自己调试 `scriptKeys()`
     时留的那发临时测试**，它在 include 面里却没有进 Playwright/清单那一侧的枚举。已删；
     顺带删掉同一发派生的 `.mts` 版本。**探针写完留在磁盘上就是一颗会在下一轮炸的雷**，
     而它炸的时候读起来像「新守卫把 inventory 改坏了」。
