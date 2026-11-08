/**
 * 「等待 CEO 决策」的登记表与决策文档之间的双向一致性判据。
 *
 * 为什么需要它（0006 §7 第 43 条）：决策文档里写着【待 CEO 决策】的小节，
 * 靠人记得去 docs/INDEX.md 登记是防不住的 —— 实测有 4 处等待 CEO 的小节，
 * 入口文件里却一条都没有，只读入口的人无法发现有任何决策在等他。
 *
 * 本模块【不碰文件系统】，所以它能被同名单测喂合成输入（见 0006 §7-41 的分工）。
 */

export interface PendingProblem {
  readonly why: string;
}

/** 一条待决小节：出自哪篇、第几节、标题原文。 */
export interface PendingSection {
  readonly docId: string;
  readonly section: string;
  readonly heading: string;
}

/** 登记表里的一行：指向哪篇的哪一节。 */
export interface RegistryEntry {
  readonly docId: string;
  readonly section: string;
}

/**
 * 判据本体。
 *
 * 前向：登记表里每一条，必须能在对应文档里找到那一节的标题 —— 防【登记了但
 * 文档里已被改写或删掉】（腐烂）。
 * 后向：文档里每一条【标题级待决小节】，必须出现在登记表里 —— 防【新增了待决
 * 小节却没人登记】（漏报，也就是本轮实际发生的那一种）。
 */
export function checkPending(
  found: readonly PendingSection[],
  listed: readonly RegistryEntry[],
): PendingProblem[] {
  if (found.length === 0 && listed.length === 0) {
    return [
      {
        why:
          "待决小节与登记表同时为空 —— 这两个集合一起空通常意味着扫描通路坏了，" +
          "而不是真的没有任何东西在等",
      },
    ];
  }
  const problems: PendingProblem[] = [];
  const keyOf = (docId: string, section: string): string =>
    docId + " > " + section;
  const foundKeys = new Set(found.map((s) => keyOf(s.docId, s.section)));
  const listedKeys = new Set(listed.map((e) => keyOf(e.docId, e.section)));
  for (const e of listed) {
    if (!foundKeys.has(keyOf(e.docId, e.section))) {
      problems.push({
        why:
          keyOf(e.docId, e.section) +
          " 登记在入口处，但对应文档里没有这一节的标题 —— 要么那一节被改写或" +
          "删掉了，要么登记表写错了节号",
      });
    }
  }
  for (const s of found) {
    if (!listedKeys.has(keyOf(s.docId, s.section))) {
      problems.push({
        why:
          keyOf(s.docId, s.section) +
          " 的标题声明在等决策，却没登记在入口处 —— 只读入口的人发现不了它（" +
          "标题原文：" +
          s.heading.slice(0, 40) +
          "）",
      });
    }
  }
  return problems;
}

/** 决策文档里的【标题级待决小节】：标题行里出现 CEO 才算，判据必须可用一个词精确匹配。 */
export const PENDING_HEADING = /^(#{2,4})\s+(\d+(?:\.\d+)?)\.?\s+.*CEO/;

/*
 * 判据【只认 CEO 这个词】，不认【决策】。这不是随手选的：实测把【决策】也收进来，命中从 4 条
 * 涨到 9 条 —— 多出来的 5 条是【## 1. 决策】【## 5. 决策方式说明】【## 6. 本决策遗留的待办】这类
 * 【本篇自己的决策正文】，它们没有任何东西在等人。上一版我为了让一条标题不含 CEO 的小节被
 * 扫到而放宽过判据，方向是反的：判据的宽严不能由【我想让谁通过】决定。正解是改那条标题，让它
 * 点名等谁 —— 见下面那条【含决策但不含 CEO 不算】的 canary，它专门防这次放宽被重新引入。
 */

/*
 * 节号后的尾点【可有可无】：实测各篇写法不一致 —— 【## 5. 留给 CEO 的一项决定】带尾点，
 * 【### 11.4 待 CEO 决策】不带。上一版我写成必须有空格，于是带尾点那种整条漏扫，
 * 而漏扫在这里不是【少报一条】而是【入口永远等不到它】—— 所以两种形状都收，并用
 * 下面那条 canary 同时喂两种形状钉住。
 */

/** 登记表条目行：以 - **0006 §8** 这样的形状书写。 */
export const REGISTRY_LINE = /^-\s+\*\*(\d{4})\s+§(\d+(?:\.\d+)?)\*\*/;

/** 从一篇决策文档的文本里收集待决小节。 */
export function findPendingSections(
  docId: string,
  text: string,
): PendingSection[] {
  const out: PendingSection[] = [];
  for (const line of text.split("\n")) {
    const m = PENDING_HEADING.exec(line);
    if (m === null) continue;
    out.push({
      docId,
      section: m[2] as string,
      heading: line.replace(/^#+\s*/, "").trim(),
    });
  }
  return out;
}

/** 从 INDEX.md 的文本里收集登记表条目；找不到登记表标题时返回空数组。 */
export function parseRegistry(
  text: string,
  sectionTitle: string,
): RegistryEntry[] {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith("## ") && l.includes(sectionTitle),
  );
  if (start < 0) return [];
  const out: RegistryEntry[] = [];
  for (let n = start + 1; n < lines.length; n++) {
    const l = lines[n] as string;
    if (l.startsWith("## ")) break;
    const m = REGISTRY_LINE.exec(l);
    if (m === null) continue;
    out.push({ docId: m[1] as string, section: m[2] as string });
  }
  return out;
}

/** 登记表在入口文件里必须使用的小节标题（子串匹配）。 */
export const REGISTRY_SECTION = "等待 CEO 决策";

/**
 * 数量下限。实测磁盘上有 4 条，故意取 3 这个保守值：只防【扫描通路整个坏掉】
 * 与【把标题里的 CEO 字样批量删光来消音】，不充当账本（理由见 0006 §7-41）。
 */
export const MIN_PENDING_SECTIONS = 3;
