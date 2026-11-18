// ── 诚实标注（O13 动作 3）：本包是【IPC 契约层，非可运行 App】──────────
// 1557 行里有真东西：ipc-surface（通道白名单 + 契约校验）、main/{channels,
// event-stream,signed-fetch,wire}（参数注入的主进程三块 + 接线）、preload/api。
// 每一块都有分母（test/desktop/）。但它【跑不起来】，缺的不是代码而是依赖：
// package.json 没有 electron，根 scripts 没有指向本包的入口 ——
// wire.ts 文件头记着这条决策（离线装不上 electron，故三样 electron 东西全做参数注入）。
// 所以「桌面端」这个说法今天对本包不成立：它是给未来那个壳的契约与零件，
// 不是壳。双向守卫见 test/arch/desktop-honest-label.ts ——
// 补上 electron 依赖或加本包入口脚本的那天，这条标注必须摘掉，守卫会红着提醒。
//
// 此文件的存在还有一层作用：git 不跟踪空目录，而 test/arch/dependency-boundary.test.ts
// 要往 src/ 写探针 —— 没有它，别人 clone 下来测试会 ENOENT 而非报边界违规。
export const desktopEntryPending = true;
