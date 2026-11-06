// web 包的最小入口占位。
// 真实实现从计划 Task 2.2（desktop）/ Task 2.3（web）起落地。
// 此文件的存在还有一层作用：git 不跟踪空目录，而 test/arch/dependency-boundary.test.ts
// 要往 src/ 写探针 —— 没有它，别人 clone 下来测试会 ENOENT 而非报边界违规。
export const webEntryPending = true;
