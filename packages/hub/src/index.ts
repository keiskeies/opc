/// <reference types="node" />

// Hub 包入口占位（计划 Task 0.2 的目录骨架产物）。
// 真正的 main / CLI 在 Task 0.10 落地；在此之前此文件的存在只为两件事：
//   1. 让 tsc -b 对 hub 有合法输入（否则 TS18003 无输入报错）；
//   2. 让 test/arch 的越界探针有 src/ 可写，且该目录能进 git（git 不跟踪空目录）。
export const HUB_ENTRY_PENDING = true;
