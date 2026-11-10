/**
 * 提交消息里的决策文档编号核查：只有纯函数与常量，故单独成模块。
 *
 * 为什么不写在测试文件里：biome 的 noExportsInTest 禁止从 *.test.ts 导出（同一个理由见
 * 本目录 index-diff.ts 的开头）。判据逻辑必须能被 canary 直接调用，所以它得是可导入的。
 *
 * 两条判据，各管一种撒谎方式：
 *   A. 标题含 docs(NNNN) 而本次改动没碰那篇文档 → scope 在撒谎。
 *   B. 消息里出现 docs/decisions/ 下不存在的编号 → 死引用或号写错。
 *
 * B 必须能豁免，而豁免必须是可数的（0006 §7 第 28 条：不可数的豁免等于没有判据）。
 * 名单按 提交短号>编号 成对登记，不按编号登记：同一个号在别的提交里出现照样会被抓。
 *
 * git 一律 argv 数组调用，绝不拼 shell 字符串：cmd 会把 ^ 当转义符吃掉，实测
 * git rev-parse X^ 退化成 rev-parse X，比较的是提交自身，任何「parent 相同」的判断都
 * 恒真 —— 0006 §7 第 32 条那一族，这轮差点让我把一次 amend 误判成改掉了历史。
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const NL: string = String.fromCharCode(10);

/* 独立出现的四位 0 开头编号。前后用字符类划界，所以版本号 10001、task-0123、
   docs/decisions/0002-x.md 都不算一次引用 —— 路径形态交给 decision-index 那节管。 */
const DOC_ID: RegExp = /(?<![A-Za-z0-9_/.-])(0[0-9]{3})(?![A-Za-z0-9_-])/g;
/* 标题里的 scope：只认 docs(NNNN)，不认任意括号数字。 */
const SCOPE: RegExp = /\bdocs\((0[0-9]{3})\)/;

export type Entry = {
  hash: string;
  subject: string;
  body: string;
  files: string[];
};
export type Problem = { hash: string; why: string };

function git(rootDir: string, args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      "git 失败: " +
        args.join(" ") +
        " | " +
        String(r.stderr ?? " ").slice(0, 200),
    );
  }
  return String(r.stdout ?? "");
}

/** 一次调用取回所有提交。分隔符用控制字符，免被正文里的竖线或中文打断。 */
export function loadEntries(rootDir: string): Entry[] {
  const raw = git(rootDir, [
    "log",
    "--all",
    "--name-only",
    "--format=%x01%H%x02%s%x02%b%x03",
  ]);
  return raw
    .split(String.fromCharCode(1))
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const at = chunk.indexOf(String.fromCharCode(3));
      const head = at < 0 ? chunk : chunk.slice(0, at);
      const tail = at < 0 ? "" : chunk.slice(at + 1);
      const parts = head.split(String.fromCharCode(2));
      return {
        hash: (parts[0] ?? "").trim(),
        subject: (parts[1] ?? "").trim(),
        body: (parts[2] ?? "").trim(),
        files: tail
          .split(NL)
          .map((l) => l.trim())
          // 非空那一半推得出：下游只做 startsWith，空串本来就不匹配（0006 §7 第 65 条）。
          .filter((l) => l.length > 0 && !l.includes(String.fromCharCode(1))),
      };
    });
}

export function docIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(DOC_ID)) out.add(String(m[1]));
  return [...out].sort();
}

export function existingIds(decisionsDir: string): string[] {
  const out = new Set<string>();
  for (const f of readdirSync(decisionsDir)) {
    const m = /(0[0-9]{3})/.exec(f);
    if (m?.[1] !== undefined) out.add(m[1]);
  }
  return [...out].sort();
}

export const RESERVE_WORD: string = "预约";

/** 从 INDEX 文本里取【被预约】的编号：只看引用块行，且同一行必须含关键词。 */
export function reservedIds(indexText: string): string[] {
  const out = new Set<string>();
  for (const raw of indexText.split(NL)) {
    const line = String(raw);
    if (!line.startsWith(">")) continue;
    if (!line.includes(RESERVE_WORD)) continue;
    for (const m of line.matchAll(/(0[0-9]{3})/g)) out.add(String(m[1]));
  }
  return [...out].sort();
}

export function check(
  entries: Entry[],
  existing: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
  exempt: ReadonlySet<string>,
): Problem[] {
  const problems: Problem[] = [];
  for (const e of entries) {
    const short = e.hash.slice(0, 7);
    const id = SCOPE.exec(e.subject)?.[1];
    if (id !== undefined) {
      const touched = e.files.some((f) => f.startsWith("docs/decisions/" + id));
      if (!touched) {
        problems.push({
          hash: short,
          why: "scope 撒谎: 标题写了 docs(" + id + ") 却没碰那篇文档",
        });
      }
    }
    for (const d of docIds(e.subject + " " + e.body)) {
      if (existing.has(d) || reserved.has(d)) continue;
      if (exempt.has(short + ">" + d)) continue;
      problems.push({ hash: short, why: "死引用: 提到不存在的 " + d });
    }
  }
  return problems;
}

/* 逐提交豁免名单。当前为空 —— 对 0002 的合法陈述由上面的预约号机制覆盖，不需要登记。
   留着这个参数是因为总有一类引用只能逐条认定；一旦启用，每条都必须写清理由，且必须可数
   （0006 §7 第 28 条：不可数的豁免等于没有判据）。 */
export const EXEMPT: ReadonlySet<string> = new Set<string>([]);
