/// <reference types="node" />

// Hub 包入口占位。src/main.ts 与 src/cli.ts 已经落地（Task 0.10），但入口不从这里走：
// main.ts 是将来 Electron 主进程的挂载点，cli.ts 是 CLI 的可测试内核。此文件仍然留着，
// 因为两件事都还成立：
//   1. 让 tsc -b 对 hub 有合法输入（否则 TS18003 无输入报错）；
//   2. 让 src/ 这个目录能进 git（git 不跟踪空目录），架构探针才有地方落脚。
// 它【不是】对外 API  barrel：Phase 0 没有外部消费者，提前 re-export 只会多出一层
// 需要同步维护的假接口。真有消费者时再补，补的时候要有测试钉住导出面。
export const HUB_ENTRY_PENDING = true;
