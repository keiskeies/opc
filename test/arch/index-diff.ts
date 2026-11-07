/**
 * 决策索引比对：只有纯函数，故单独成模块。
 *
 * 为什么不写在测试文件里：biome 的 noExportsInTest 禁止从 *.test.ts 导出 —— 导入一个
 * 测试文件会把它里面的用例再执行一遍，产生重复测试。仓库已有同样先例：run-fixtures.ts
 * 就是「纯函数 + 唯一真相」的独立模块，这里照这个模式来。
 *
 * 本模块刻意不用正则字面量，也不用换行转义：都用最直白的字符串判断，
 * 少一层转义就少一类「脚本传过去内容已经变了」的事故。
 */

import { readdirSync, readFileSync } from "node:fs";

const NL = String.fromCharCode(10);
const LIST_PREFIX = "- **";
const ID_LEN = 4;

export type IndexDiff = { missing: string[]; extra: string[] };

/** 目录里的 ADR 编号（文件名前四位）。 */
export function fileIds(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, ID_LEN))
    .sort();
}

/**
 * 索引里已列出的编号。只认行首的 - **NNNN**：正文或引文里提到的编号（例如解释 0002
 * 为何空缺的那段）不算「已列出」，否则解释性文字会把「缺条目」这件事抹平。
 */
export function listedIds(indexText: string): string[] {
  const out: string[] = [];
  for (const line of indexText.split(NL)) {
    if (!line.startsWith(LIST_PREFIX)) {
      continue;
    }
    const id = line.slice(LIST_PREFIX.length, LIST_PREFIX.length + ID_LEN);
    const digits =
      id.length === ID_LEN && [...id].every((c) => c >= "0" && c <= "9");
    const closed =
      line.slice(
        LIST_PREFIX.length + ID_LEN,
        LIST_PREFIX.length + ID_LEN + 2,
      ) === "**";
    if (digits && closed) {
      out.push(id);
    }
  }
  return out;
}

export function diffIds(
  actual: readonly string[],
  listed: readonly string[],
): IndexDiff {
  const a = new Set(actual);
  const l = new Set(listed);
  return {
    missing: [...a].filter((x) => !l.has(x)).sort(),
    extra: [...l].filter((x) => !a.has(x)).sort(),
  };
}

/** 读索引原文（守卫与测试共用同一条路径，避免两处各拼一遍）。 */
export function readIndex(rootDir: string): string {
  return readFileSync(rootDir + "/docs/INDEX.md", "utf8");
}
