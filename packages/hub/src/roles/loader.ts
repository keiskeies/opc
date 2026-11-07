import { readFileSync } from "node:fs";
import { type Charter, charterSchema } from "@opc/contracts";
import { parse as parseYaml } from "yaml";

/**
 * 岗位书加载器（计划 Task 0.7）。
 *
 * 职责边界：这里只做【读 + 解析 + 校验】，不修数据。校验规则的唯一定义在
 * @opc/contracts 的 charterSchema —— loader 里再写一遍规则就是两个真相。
 */

/** 把 zod 的 issue 路径（PropertyKey[]）格式化成可定位的字段路径。 */
export function joinCharterPath(segments: readonly PropertyKey[]): string {
  let out = "";
  for (const s of segments) {
    if (typeof s === "number") out += "[" + s + "]";
    else out += out === "" ? String(s) : "." + String(s);
  }
  return out;
}

/**
 * 校验失败。fieldPaths 是【给人看的字段路径】，不是原始报错转储：
 * 计划要求「拒绝加载并给出字段路径」，因为岗位书由 CEO 手改，CEO 不需要读 zod 的
 * 内部结构就能改对。原文只留一条摘要，避免几十行 issue 把关键字段淹没。
 */
export class CharterValidationError extends Error {
  readonly fieldPaths: readonly string[];
  readonly source: string;

  constructor(
    source: string,
    fieldPaths: readonly string[],
    issueCount: number,
    firstMessage: string,
  ) {
    super(
      "岗位书校验失败（" +
        source +
        "）：" +
        issueCount +
        " 处问题；首个原因：" +
        firstMessage +
        "；字段：" +
        fieldPaths.join(", "),
    );
    this.name = "CharterValidationError";
    this.source = source;
    this.fieldPaths = fieldPaths;
  }
}

/** YAML 语法错误单独一类：它没有「字段路径」可言，别和校验失败混成一个类型。 */
export class CharterSyntaxError extends Error {
  readonly source: string;
  constructor(source: string, message: string) {
    super("岗位书 YAML 解析失败（" + source + "）：" + message);
    this.name = "CharterSyntaxError";
    this.source = source;
  }
}

/**
 * 取字段路径。非 CharterValidationError 返回【空数组】而不是抛错 —— 调用方拿到 []
 * 就说明「不是校验类错误」，测试会因此在断言路径时失败，而不是被一个空洞的 try/catch 放过。
 */
export function charterFieldPaths(e: unknown): readonly string[] {
  return e instanceof CharterValidationError ? e.fieldPaths : [];
}

interface CharterIssueLite {
  readonly code?: string;
  readonly path?: readonly PropertyKey[];
  readonly message?: string;
  readonly keys?: readonly string[];
}

/** 从 zod error.issues 提取字段路径；unrecognized_keys 的 path 是 []，真正要报的是键名本身。 */
function pathsOf(issues: readonly CharterIssueLite[]): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys)) {
      for (const k of issue.keys) {
        const base = joinCharterPath(issue.path ?? []);
        out.push(base === "" ? k : base + "." + k);
      }
      continue;
    }
    out.push(joinCharterPath(issue.path ?? []));
  }
  return out;
}

/** 校验文本。source 只用于报错定位（文件路径或 "<inline>"），绝不进审计载荷。 */
export function loadCharterText(text: string, source: string): Charter {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new CharterSyntaxError(
      source,
      e instanceof Error ? e.message : String(e),
    );
  }
  const result = charterSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues as readonly CharterIssueLite[];
    const paths = pathsOf(issues);
    const first =
      issues.find((i) => typeof i.message === "string")?.message ?? "未知原因";
    throw new CharterValidationError(source, paths, issues.length, first);
  }
  return result.data;
}

/** 从文件加载。encoding 固定 utf8：岗位书含中文，漏了 utf8 会在 Windows 上按 GBK 读出乱码。 */
export function loadCharterFile(path: string): Charter {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      "读不到岗位书文件 " +
        path +
        "：" +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  return loadCharterText(text, path);
}

export interface CharterRunOverrides {
  /** 本次运行【追加】的禁止项（收紧）。只能追加，不能删。 */
  readonly forbidden?: readonly string[];
  /**
   * 故意【不支持】删除禁止项：出现即抛错。
   * 规格 §20.2「Agent 间通信不能绕过门控」+ §4「Agent 不能给自己加工具权限」：
   * forbidden 是黑名单，黑名单只能变长。给它一个删除口子，就等于把岗位书
   * 的保护交给一次运行时参数 —— 那正是 §4 要防的事。
   */
  readonly removeForbidden?: readonly string[];
}

/**
 * 计算一次运行的有效禁止项。单调性（只增不减）是【强制】的，不是文档约定。
 *
 * 为什么 forbidden: [] 也抛错：空数组在语义上歧义 —— 「不加任何新条目」还是「清空」？
 * 歧义输入必须拒绝，不能猜。要表示「不加」就【不要传】forbidden。
 */
export function mergeForbiddenForRun(
  charter: Charter,
  overrides: CharterRunOverrides,
): readonly string[] {
  if (
    overrides.removeForbidden !== undefined &&
    overrides.removeForbidden.length > 0
  ) {
    throw new Error(
      "运行时不得删除岗位书的禁止项（规格 §20.2 / §4）。被要求移除的条目：" +
        overrides.removeForbidden.join(", ") +
        "。要调整禁止项请改岗位书并升 version，走审计。",
    );
  }
  const base = charter.decisionScope.forbidden;
  if (overrides.forbidden === undefined) return base;
  if (overrides.forbidden.length === 0) {
    throw new Error(
      "运行时 forbidden: [] 语义歧义（清空 还是 不追加？），拒绝执行。不追加就别传这个字段。",
    );
  }
  const merged = [...base];
  for (const f of overrides.forbidden) {
    if (f.trim() === "") {
      throw new Error(
        "运行时禁止项不能是空白字符串：它既拦不住任何行为，又会在审计里显示成一条空条目。",
      );
    }
    if (!merged.includes(f)) merged.push(f);
  }
  if (merged.length <= base.length) {
    throw new Error(
      "运行时只允许【新增】禁止项，不允许减少或替换原有禁止项（规格 §20.2 权限单调性）。",
    );
  }
  return merged;
}
