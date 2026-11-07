// 见 config-match.test.ts 的文件头：为什么这段比对逻辑不能只写在测试体内。

export interface Problem {
  readonly why: string;
}

const PREMISE = "真配置的 include 一条都读不出来，比对会退化成空对空";

/**
 * 比对【真配置里的 include】与【守卫里手抄的模式常量】。
 * @param real 真配置读出的模式（顺序无关，但重复要报）
 * @param hand 守卫里手抄的模式
 * @returns 问题列表；空列表表示一致
 */
export function checkConfigMatch(
  real: readonly string[],
  hand: readonly string[],
): Problem[] {
  const problems: Problem[] = [];
  if (real.length === 0) {
    problems.push({ why: PREMISE });
  }
  for (const p of hand) {
    const n = real.filter((x) => x === p).length;
    if (n !== 1) {
      problems.push({
        why: "手抄模式 " + p + " 在真配置里出现 " + n + " 次，应为 1 次",
      });
    }
  }
  const seen = new Set<string>();
  for (const r of real) {
    if (seen.has(r)) {
      continue;
    }
    seen.add(r);
    if (!hand.includes(r)) {
      problems.push({ why: "真配置有 " + r + "，手抄常量没有" });
    }
  }
  return problems;
}
