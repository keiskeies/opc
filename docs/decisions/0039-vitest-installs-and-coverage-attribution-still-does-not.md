# 0039　「覆盖率阈值没填」那句前提被证实了一半：能装 vitest、像素级覆盖归因不行

- **状态**：已定案。接 **0037 §8** 登记的那个「下一步」：`vitest.config.ts` 里那句
  「因为无从测量所以填 0」的覆盖率阈值前提，**被证实了一半**。
- **产出**：`vitest.config.ts` 的注释改写成当前真实状态（4.1.5 能装能跑 + pin 那几套
  tarball 缺失 ⇒ 覆盖归因 offline 不可达）+ 一条 0039 文档（本篇）。
- **一句话结论**：⭐ **「装不上」在本仓指的不是同一个东西。** 0037 §7 已经点破 45 处
  「装不上」里只有 8 处是 vitest。本篇把「覆盖率没填」的前提再拆成两层：
  **vitest 本身能装（4.1.5）**，而**拿到覆盖率数字需要第二套（vite/esbuild pin）装不上**
  —— 旧注释把两层压成一句「本机没有 vitest」，那半句是假的。

---

## 0. 做了什么，以及为什么敢说「能装」

0037 §7 记过：离线 store 里能装出 **vitest 4.1.5**（落在 `package.json` 的声明的
`^4.0.12` 区间内），pin 的 **4.1.12** tarball 不在 store。本篇把它再往前推一步，**真装真跑**：

- 在 `/tmp` 沙盒（`pnpm add --offline vitest@4.1.5`，依赖纯 store，45 个包，秒装）里，
  `node_modules/.bin/vitest run` 真跑一个 `.ts` 测试 → **1/1 绿**。
- 把 gate 套件（`packages/hub/test/gates/author-reviewer.test.ts` + `determinism.test.ts`）
  连同它 import 的两个 gate 源码文件拷进沙盒（`author-reviewer.ts` / `evaluate.ts`，
  二者只依赖 `@opc/contracts`—— 本仓自己的包，无 `@langchain/*` 阻塞依赖） →
  **59/59 全绿**（`author-reviewer` 27 发 + `determinism` 32 发，vitest 实测，非 harness）。

这一发独立验证了 harness 对 gate 那半的结论 —— 同一份代码、同一个测试文件，产品自己的
runner（vitest 4.1.5）与自制 harness 给出相同绿。之所以能只跑这一小片，正因它 import 链干净。

**已确认**：装 vitest 4.1.5 不再需要联网。0037 §7 那句「vitest 在离线可得」的**前半**（能装）
现在是**已复现的结论**而不是登在文档里的传闻。

## 1. 卡住的另一半：覆盖率（coverage）归因，offline 真不可达

覆盖率不是「能跑 vitest」就有。它要把**已执行的行归因回 `.ts` 源码**，这一步依赖
vite/esbuild 的 transform 管线。沙盒实测两种 provider 都归因不了：

- **v8 provider**：vitest 在这台机器直接走 Node 的 strip-types 直跑 `.ts`
  （没有 esbuild transform），v8 报 **0/130** —— 文件列全了（`author-reviewer.ts`、
  `evaluate.ts`），但每行都标 0，因为它拿不到「第 N 行被执行过」的 sourcemap。
  （0 不是「一行没测到」，是「一行的归因都没发生」。）
- **istanbul provider**：需要额外的 `@vitest/coverage-istanbul`，其 metadata 不在 store，
  离线解析直接 `ERR_PNPM_NO_OFFLINE_META`。

再往根上查：归因要的 **vite@8.3.6 / esbuild@0.28.2**（以及 pin 的 vitest 4.1.12）
在 store 里**只有空壳** —— `.pnpm/` 目录在，`find -type f` 数出来 **0 个物理文件**。
而 4.1.5 之所以能装，是因为它的 tarball **真的在**。这份 store 是「少数版本有实体、
pin 的版本全是壳」的混杂态（0037 §7 只查了 vitest 4.1.12 一个，本篇把 vite/esbuild
也坐实了）。

**断言（可复算）**：`find node_modules/.pnpm -path '*vite*/node_modules/vite' -type f | wc -l`
= 0；同法 esbuild@0.28.2 也是 0。而 `node_modules/.pnpm/vitest@4.1.5*` 有实体
（4.1.5 装得出来）。

【round320 复核：本节结论与那条断言都要修正。实测（2026-11-19，当前 node_modules 状态）：
① **断言模式本身坏了** —— `-path '*vite*/node_modules/vite'` 匹配到的是一条**目录**，
   而 `-type f` 对目录恒不命中，所以这条命令**在任何状态下一律输出 0，从来不能证明「空壳」**。
   修正为末尾补 `/*`（`find node_modules/.pnpm -path '*vite*/node_modules/vite/*' -type f`）
   后数出来：vite@8.3.6 = 49 个物理文件、esbuild@0.28.2 = 10 个（平台包 @esbuild+win32-x64 = 3）。
   即「pin 的版本全是壳」不成立。
② **pin 的 vitest 4.1.12 与 coverage-v8 也不是壳**：`.pnpm/vitest@4.1.12*` 各 120 个物理文件、
   `.pnpm/@vitest+coverage-v8@4.1.12_vitest@4.1.12` = 14 个。§0 里「4.1.5 装得出来、4.1.12 是壳」
   的混杂态描述已被自愈（vitest.config.ts round189/193/194 注释链已记 store 补齐过程）。
③ **「覆盖归因 offline 真不可达」已被推翻**：本机 `npx vitest run --coverage` 真跑
   `packages/hub/test/gates/{author-reviewer,determinism}.test.ts`，v8 provider 在线，
   author-reviewer.ts = 100/100/100、evaluate.ts = 96.1/94.82/100、全文件 lines 97.41%、
   54/54 测试绿，门控 per-glob 阈值（95/95/100/90）判定真实生效。
   ⇒ 0039 §2「第一条路被判掉了」不成立——第一条路（量真数字再定阈值）现在可走且已走，
   见 vitest.config.ts round193/194 的实测数字与已设阈值。本篇的历史记录保留，
   结论以 vitest.config.ts 的更新注释链为当前口径。】

## 2. 所以 0037 §8 给的两条路，本篇走哪条

0037 §8 说「要么用 4.1.5 量出真数字再决定阈值，要么把『4.1.5 量的数字不能代表 pin 的
4.1.12』写进去顶掉旧理由」。本篇的实测把**第一条路判掉了**：

- 用 4.1.5 量数字，需要 coverage 归因 → §1 证明 offline 拿不到。
- 就算量到 4.1.5 的覆盖，它也不能代表 pin 的 4.1.12（0037 §7 已说），现在连「量到 4.1.5 的
  数字」都做不到。

于是走的是第三条题 —— 比 0037 §8 给的更诚实的一档：
**不是换数字、也不是只写「版本不符」，而是把【已经发生的真实前提】写回去**。
`vitest.config.ts` 的注释现在说明：能装 4.1.5（那只是「有 vitest 可跑」）、
pin 的 4.1.12 / vite / esbuild 全是壳（覆盖归因 blocked）、两款 provider 都归因不了，
所以阈值仍是 0 是**基础设施 blocked**，不是「我没量」也不是「本机没有 vitest」。

`thresholds` 四个 0 **一字未动**。被更正的只有那句不成立的前提（旧句留着、标「旧注释」引号
—— 规则：没验过的陈述留证据，不静默删）。

## 3. 那「能装能跑」的理由，用在哪里

gate 套件在 4.1.5 下 59/59 全绿，这件事本身有一格意义：**harness 不是唯一能验证这两文件的
runner**。之前所有绿都是 `node:test` + 自制 harness 给的、`pnpm verify` 跑不起来，
于是任何绿都悬在「harness 会不会在别处替产品环境兜了什么」这句 0037 §7 的保留之下。
本篇对 gate 那一小半补了一个交叉确认：**产品自己的 runner 给出同一份绿**。
（射程只到 gate 这两文件 —— 它们 import 链干净才做得到；其余文件仍只有 harness 绿。）

## 4. 判据

- gate 套件在 vitest 4.1.5 下：**59/59**（`author-reviewer.test.ts` 27 + `determinism.test.ts`
  32；都与它们自身的 `it` 数一致，且与 harness 全量里这两文件的绿一致）。
- `requireAssertions: true` 仍 **19 行**真值（`harness-invariants.ts:157` 那条守卫要求它，
  改的是注释、没动开关，回归绿。行号从 `:156` 漂到 `:157`：round277 在它上面加了一行 import，
  让 `walkFiles` 也排除运行期夹具 —— 与 0006 那条同一个症）。
- 可复算的「空壳」断言（§1）：vite / esbuild 两套 `find ... -type f` = 0；vitest 4.1.5 有实体。
- 覆盖归因可复算失败：v8 报 0/0，istanbul `ERR_PNPM_NO_OFFLINE_META`。
- `git diff` 只动 `vitest.config.ts` 的头注释一处（`thresholds` 值、`provider`、`include`、
  `requireAssertions` 全不动）＋ 本篇 + INDEX 条目。

## 5. 与「更严」的距离

1. **没有把覆盖率数字真正量出来**（blocked，§1）。
2. **没有给「4.1.5 与 4.1.12 版本差异」补一条可执行的对照**：diff 两份产物在 offline 下
   造不出来（4.1.12 根本没实体）。
3. **只在 sandbox 里跑过 gate 两文件**，没有对全量/别文件跑 4.1.5（`@langchain/*` 缺失，
   0037 §7 说过那批「71 发失败 vs harness 37 发」不可复算—— 本篇遵守，不新建一个综合读数）。

## 6. 别当成做到了

- **阈值还是 0，覆盖率还是「无」**。本篇只是把「为什么是 0」从一句假话改成真话，没有让
  门控判定分支被覆盖这件事发生。
- **「能装 vitest」只打通了 4.1.5 这一版 + gate 两文件**；pin 的 4.1.12 与其它文件离线仍然
  是坛子（0037 §7 那 37 处「装不上」照旧真 —— 但其中 8 处 vitest 的已被本篇证伪为「4.1.5 能装」）。
- **29 处「测得 X」仍不是「门禁过的 X」**：gate 绿是 vitest 4.1.5 给的，不是 `pnpm verify` 给的。
  `pnpm verify` 仍跑不起来。

【round320 复核（末行与上面两行）】：「`pnpm verify` 仍跑不起来」已被 round319-7/3032 §7 实测推翻：
`pnpm verify` 现在**真能跑**（biome 2.6.5 / tsc / vitest 三件套都在 `.bin` 且各自真执行），
exit 1 来自 biome **存量** 276 errors / 115 warnings / 2 infos（docs/*.md 不在 biome 范围，
那是 HEAD 债不是本篇引入）。「29 处测得 X 不是门禁过的 X」中的「门禁」若指 `pnpm verify`
则已翻转为「验证三件套能跑、唯 biome 存量债不清理」；若指「覆盖率门控」则已因 round193/194
设了门控 thresholds 而不再是空转 —— 但现在有真数字与真阈值守着，语义从「空转」变「生效」。
本篇写作时的历史状态保留如上。
