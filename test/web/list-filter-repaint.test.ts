/**
 * 中栏筛选器：控件建一次，敲字符只重画行区（0079）。
 *
 * 为什么要有这个文件：renderDocumentList / renderBacklogList 过去把筛选栏挂在自己身上，
 * oninput/onchange 又回调自己，而【清空】只在调用方 renderList 里做 —— 自递归那一层
 * 什么都不清，于是每敲一个字符多一套控件、多挂一份列表，正被敲的那枚 input 当场被换掉
 * （中文输入法更糟：拼音没上屏，承载它的节点已经不存在）。三件事都不报错，所以【静默】。
 *
 * 分工（与另两份别混）：
 *   本文件 —— 钉【拆法本身】：清空只有一处、handler 只叫 paint、行区不碰控件；
 *     并把这两对函数切出来在 node:vm 里真按键，数控件与行区的份数。
 *   test/e2e/group-workbench.spec.ts 的「中栏筛选器」—— 真浏览器几何：焦点/输入法/
 *     滚动留在原处，控件与叶子一份不多。
 *
 * ⚠ 形状沿用同目录的源扫描守卫（group.js 顶层就 boot()、零 export，vitest 导不进来）。
 * 扫描只能证明「字在」，证明不了「拆了之后真的只画一份」，所以除了扫源码还把函数体
 * 切出来在 vm 里真敲两下 —— 树与空态的内部形状在这里是替身（各自的层级/文案由 e2e 与
 * 文档树守卫管），本文件只数它们被挂了几份。判别力自证放在最后一发。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const groupSrc = readFileSync(
  join(REPO, "packages/web/public/group.js"),
  "utf8",
);

/** 跳过单/双引号串，返回收尾引号的下标。 */
function skipQuoted(src: string, start: number, quote: string): number {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === "\\") i += 1;
    else if (src[i] === quote) return i;
  }
  throw new Error("引号串没闭合，取材失败");
}

/** 跳过模板串（含 `${}` 里嵌的串），返回收尾反引号的下标。 */
function skipTemplate(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") i += 1;
    else if (ch === "`") return i;
    else if (ch === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2; // 跳过 `${`，从插值内容起算
      while (i < src.length && depth > 0) {
        const inner = src[i];
        if (inner === "\\") i += 1;
        else if (inner === '"' || inner === "'") i = skipQuoted(src, i, inner);
        else if (inner === "`") i = skipTemplate(src, i);
        else if (inner === "{") depth += 1;
        else if (inner === "}") depth -= 1;
        i += 1;
      }
      i -= 1;
    }
  }
  throw new Error("模板串没闭合，取材失败");
}

/** 函数体收尾花括号之后的下标。 */
function bodyEnd(src: string, at: number, header: string): number {
  const open = src.indexOf("{", at + header.length);
  if (open < 0) throw new Error(`${header} 没有函数体，取材失败`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
    } else if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
    } else if (ch === '"' || ch === "'") {
      i = skipQuoted(src, i, ch);
    } else if (ch === "`") {
      i = skipTemplate(src, i);
    } else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`${header} 的函数体没闭合，取材失败`);
}

/**
 * 整条声明：签名 + 函数体。
 *
 * 与同族守卫同口径：认字符串、模板串、行/块注释 —— 不认注释里的花括号是这一族最容易
 * 踩的坑。取不到闭合时抛，不悄悄返回半截（半截的判据是恒绿装饰）。判据建在函数体上而不是
 * 「整个文件里搜到过这个名字」：散文里提一次、以及另一个函数里恰好出现同样的话，都会让
 * 点名点错人（renderDocumentList 上面那段说明就提了三次这个名字）。
 */
function functionDecl(src: string, header: string): string {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`找不到 ${header}，取材失败`);
  return src.slice(at, bodyEnd(src, at, header));
}

/** 顶层函数名下标：把一处源码位置归到「它写在哪个函数里」。 */
function ownerOf(src: string, at: number): string {
  let owner = "<顶层>";
  for (const m of src.matchAll(/^(?:async )?function ([\w$]+)\(/gmu)) {
    if ((m.index as number) > at) break;
    owner = m[1] as string;
  }
  return owner;
}

/** 全文件里每一处「清空中栏工具条」的归属函数名（按出现顺序）。 */
function toolbarClearOwners(src: string): string[] {
  return [...src.matchAll(/^\s*toolbar\.replaceChildren\(\)\s*;/gmu)].map((m) =>
    ownerOf(src, m.index as number),
  );
}

/** 全文件里每一处「清空中栏行区」的归属函数名（按出现顺序）。 */
function contentClearOwners(src: string): string[] {
  return [...src.matchAll(/^\s*content\.replaceChildren\(\)\s*;/gmu)].map((m) =>
    ownerOf(src, m.index as number),
  );
}

/** 某个控件构建器里叫了几次「只重画行区」（含构建末尾那一发）。 */
function paintCalls(decl: string, name: string): number {
  return [...decl.matchAll(new RegExp(`\\b${name}\\(content\\);`, "gmu"))]
    .length;
}

/**
 * 构建器的 handler 里有没有「把自己或把整栏重画一遍」。
 *
 * 从签名左括号之后开始找，否则函数名自己会被认成第一次自调用。
 * renderList() 也算：它把控件全拆了重建，控件份数是对的，但焦点、输入法组字、滚动
 * 全丢 —— 那是被否决的那个修法，不许以后又「统一」回去。
 */
function rebuildCalls(decl: string, selfName: string): string[] {
  const body = decl.slice(decl.indexOf("("));
  const found: string[] = [];
  if (new RegExp(`\\b${selfName}\\(`, "u").test(body)) found.push(selfName);
  if (/\brenderList\(\)/u.test(body)) found.push("renderList");
  return found;
}

/**
 * renderDocumentList 之外每一处 state.docFilter.kind 的写入。
 *
 * 下拉的 selected 只在【构建控件】时写一次，所以别的入口（人才卡按形态跳进文档列表）
 * 必须走会重建控件的 renderList()；只重画行区的话筛选当场生效、下拉却还指着旧值。
 */
function externalKindWrites(src: string): { at: number; rebuilds: boolean }[] {
  const decl = functionDecl(src, "function renderDocumentList(");
  const start = src.indexOf(decl);
  const out: { at: number; rebuilds: boolean }[] = [];
  for (const m of src.matchAll(/state\.docFilter\.kind\s*=[^=;\n]+;/gmu)) {
    const at = m.index as number;
    if (at >= start && at < start + decl.length) continue;
    out.push({
      at,
      rebuilds: /renderList\(\)/u.test(src.slice(at, at + 200)),
    });
  }
  return out;
}

/** 极简 DOM 替身：只带这两对函数真读的那几格（append / replaceChildren / 事件）。 */
type VNode = {
  tag: string;
  attrs: Record<string, unknown>;
  children: VNode[];
  listeners: Record<string, (event: unknown) => void>;
  append: (...kids: VNode[]) => void;
  replaceChildren: (...kids: VNode[]) => void;
  addEventListener: (type: string, fn: (event: unknown) => void) => void;
};

/** 替身版的 h：与真货同口径（on* 注册事件、null/false 子节点跳过、children 摊平）。 */
function h(
  tag: string,
  attrs: Record<string, unknown> = {},
  ...children: unknown[]
): VNode {
  const node: VNode = {
    tag,
    attrs: {},
    children: [],
    listeners: {},
    append: (...kids) => {
      node.children.push(...kids);
    },
    replaceChildren: (...kids) => {
      node.children = [...kids];
    },
    addEventListener: (type, fn) => {
      node.listeners[type] = fn;
    },
  };
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(
        key.slice(2).toLowerCase(),
        value as (event: unknown) => void,
      );
    } else {
      node.attrs[key] = value;
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    // 与真货同口径：非节点变文本节点。不包的话子树里混着字符串，遍历子树的
    // find/countClass 会在字符串上读 children —— 报的是「取材崩」而不是「份数不对」。
    node.append(
      typeof child === "object" && Array.isArray((child as VNode).children)
        ? (child as VNode)
        : textNode(String(child)),
    );
  }
  return node;
}

/** 替身版的文本节点：只为了让子树里不混裸字符串，判据从不读它。 */
function textNode(text: string): VNode {
  const node = h("#text");
  node.attrs.text = text;
  return node;
}

function input(
  name: string,
  value = "",
  type = "text",
  attrs: Record<string, unknown> = {},
): VNode {
  return h("input", { name, type, value, ...attrs });
}

/** 真敲一发：触发节点上注册的 handler，输入值走 event.target.value。 */
function fire(node: VNode, type: string, value: string): void {
  node.listeners[type]?.({ target: { value } });
}

/** 按 class 片段数份数（root 自己不算，只数子树）。 */
function countClass(root: VNode, fragment: string): number {
  let n = 0;
  for (const child of root.children) {
    if ((child.attrs.class as string | undefined)?.includes(fragment)) n += 1;
    n += countClass(child, fragment);
  }
  return n;
}

/** 找出子树里所有满足条件的节点（与 e2e 探针同口径：按 tag/class 数，不认引用）。 */
function find(node: VNode, pred: (n: VNode) => boolean): VNode[] {
  const out = node.children.filter(pred);
  for (const child of node.children) out.push(...find(child, pred));
  return out;
}

type Doc = {
  doc_id: string;
  title: string;
  kind: string;
  group_id: string;
  owner: string;
};
type Todo = {
  id: string;
  title: string;
  priority: number;
  state: string;
  group_id: string;
  due_at: string | null;
};

/** 把 group.js 里这两对函数切出来，交回可执行的替身 + 它们真读的那份 state。 */
function loadFilterFns(src: string): {
  renderDocumentList: (content: VNode, toolbar: VNode) => void;
  renderBacklogList: (content: VNode, toolbar: VNode) => void;
  state: {
    documents: Doc[];
    groups: { group_id: string; title: string }[];
    docFilter: { q: string; kind: string; group: string };
    backlog: Todo[];
    backlogFilter: string;
    selectedBacklog: string;
    selectedDocument: string;
  };
} {
  const docKindsLine = /^const docKinds = \[[^\]]*\];$/mu.exec(src);
  if (!docKindsLine) throw new Error("找不到 docKinds，取材失败");
  const code = [
    "(function () {",
    docKindsLine[0],
    functionDecl(src, "function renderDocumentList("),
    functionDecl(src, "function paintDocumentRows("),
    functionDecl(src, "function renderBacklogList("),
    functionDecl(src, "function paintBacklogRows("),
    "return { renderDocumentList, renderBacklogList };",
    "})()",
  ].join("\n");
  const state = {
    documents: [] as Doc[],
    groups: [] as { group_id: string; title: string }[],
    docFilter: { q: "", kind: "", group: "" },
    backlog: [] as Todo[],
    backlogFilter: "",
    selectedBacklog: "",
    selectedDocument: "",
  };
  const ctx = vm.createContext({
    state,
    labels: new Proxy({}, { get: (_t, key) => String(key) }),
    // 树与空态在这里是替身：层级与文案各归 e2e、文档树守卫管，本文件只数份数，
    // 所以 class 与真的那份保持一致（判定读的就是 class）。
    docTree: (docs: Doc[]) =>
      h(
        "div",
        { class: "doc-tree" },
        ...docs.map((doc) => h("div", { class: "doc-list-item" }, doc.title)),
      ),
    emptyState: () => h("div", { class: "state" }),
    groupName: () => "替身群",
    pill: () => h("span", { class: "pill" }),
    fmtDate: () => "—",
    selectBacklog: () => {},
    h,
    input,
  });
  const got = vm.runInContext(code, ctx, {
    filename: "group.js#list-filter",
  }) as {
    renderDocumentList: (content: VNode, toolbar: VNode) => void;
    renderBacklogList: (content: VNode, toolbar: VNode) => void;
  };
  return {
    renderDocumentList: got.renderDocumentList,
    renderBacklogList: got.renderBacklogList,
    state,
  };
}

describe("中栏筛选器：控件建一次、handler 只重画行区", () => {
  it("清空只有一处主人，且写在调用方 renderList 里", () => {
    // 拆法的另一半：builder 只 append，那谁清？只有 renderList。工具条上出现第二处
    // 清空 = 有人把清空搬回 builder 自己里，那自递归又能悄悄累积了。
    expect(toolbarClearOwners(groupSrc)).toEqual(["renderList"]);
    // 行区清空三处：renderList 是切路由的兜底，两半 paint 各清一次是拆法的定义
    // （handler 只换行区，换之前当然先摘干净）。多出第四处 = 控件构建器里也清了行区。
    expect(contentClearOwners(groupSrc).sort()).toEqual([
      "paintBacklogRows",
      "paintDocumentRows",
      "renderList",
    ]);
  });

  it("两个 builder 都不许叫自己、也不许叫 renderList", () => {
    for (const name of ["renderDocumentList", "renderBacklogList"]) {
      expect(
        rebuildCalls(functionDecl(groupSrc, `function ${name}(`), name),
      ).toEqual([]);
    }
  });

  it("三个文档 handler 与一个待办 handler 各叫一发 paint，外加构建末尾各一发", () => {
    // 少一发 = 某个 handler 不重画行了（筛选按下去没反应）；多发没有意义。
    expect(
      paintCalls(
        functionDecl(groupSrc, "function renderDocumentList("),
        "paintDocumentRows",
      ),
    ).toBe(4); // 搜索 + 类型 + 群组 + 构建末尾
    expect(
      paintCalls(
        functionDecl(groupSrc, "function renderBacklogList("),
        "paintBacklogRows",
      ),
    ).toBe(2); // 搜索 + 构建末尾
  });

  it("行区重画拿不到工具条：paint 的签名里只有 content", () => {
    for (const name of ["paintDocumentRows", "paintBacklogRows"]) {
      const decl = functionDecl(groupSrc, `function ${name}(`);
      // 参数表里出现 toolbar ⇒ 它已经能改控件了，拆法名存实亡。
      expect(
        decl.slice(`function ${name}`.length, decl.indexOf("{")).trim(),
      ).toBe("(content)");
      expect(decl).not.toMatch(/toolbar/u);
    }
  });

  it("renderDocumentList 之外的 docFilter.kind 写入都重建控件", () => {
    // 人才卡那颗按钮改的是【下拉的选中值】，而下拉的 selected 只在构建时写一次
    // ⇒ 它必须走 renderList()；只重画行区的话筛选生效了、下拉却还指着旧值。
    const writes = externalKindWrites(groupSrc);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.rebuilds).toBe(true);
  });
});

describe("真按两下：控件与行区各只有一份", () => {
  it("文档列表：连敲两下不累加控件、不累加行，空态也只一份", () => {
    const { renderDocumentList, state } = loadFilterFns(groupSrc);
    state.groups = [{ group_id: "g1", title: "筛验群" }];
    state.documents = [
      {
        doc_id: "d1",
        title: "筛验甲",
        kind: "markdown",
        group_id: "g1",
        owner: "a",
      },
      {
        doc_id: "d2",
        title: "筛验乙",
        kind: "markdown",
        group_id: "g1",
        owner: "b",
      },
      {
        doc_id: "d3",
        title: "其他文档",
        kind: "doc",
        group_id: "g1",
        owner: "c",
      },
    ];
    const content = h("div");
    const toolbar = h("div");
    renderDocumentList(content, toolbar);
    const read = () => ({
      searches: find(toolbar, (n) => n.tag === "input").length,
      selects: find(toolbar, (n) => n.tag === "select").length,
      trees: countClass(content, "doc-tree"),
      leaves: countClass(content, "doc-list-item"),
      states: countClass(content, "state"),
    });
    expect(read()).toEqual({
      searches: 1,
      selects: 2,
      trees: 1,
      leaves: 3,
      states: 0,
    });

    const search = find(toolbar, (n) => n.tag === "input")[0] as VNode;
    fire(search, "input", "筛");
    expect(read()).toEqual({
      searches: 1,
      selects: 2,
      trees: 1,
      leaves: 2,
      states: 0,
    });
    fire(search, "input", "筛验");
    expect(read()).toEqual({
      searches: 1,
      selects: 2,
      trees: 1,
      leaves: 2,
      states: 0,
    });
    // 承载输入的那枚节点原地没动：焦点、输入法组字都挂在这个对象上，
    // 换掉它 = 第二个字符敲进一个已经离开文档的节点。
    expect(find(toolbar, (n) => n.tag === "input")[0]).toBe(search);

    fire(search, "input", "筛验不存在");
    expect(read()).toEqual({
      searches: 1,
      selects: 2,
      trees: 0,
      leaves: 0,
      states: 1,
    });

    const kindSelect = find(toolbar, (n) => n.tag === "select")[0] as VNode;
    fire(search, "input", "");
    expect(read()).toEqual({
      searches: 1,
      selects: 2,
      trees: 1,
      leaves: 3,
      states: 0,
    });
    fire(kindSelect, "change", "doc");
    expect(read()).toEqual({
      searches: 1,
      selects: 2,
      trees: 1,
      leaves: 1,
      states: 0,
    });
    expect(find(toolbar, (n) => n.tag === "select")[0]).toBe(kindSelect);
  });

  it("待办列表：连敲两下不累加搜索框、不累加行", () => {
    const { renderBacklogList, state } = loadFilterFns(groupSrc);
    state.backlog = [
      {
        id: "b1",
        title: "筛验待办一",
        priority: 1,
        state: "todo",
        group_id: "g1",
        due_at: null,
      },
      {
        id: "b2",
        title: "筛验待办二",
        priority: 2,
        state: "doing",
        group_id: "g1",
        due_at: null,
      },
      {
        id: "b3",
        title: "别的",
        priority: 3,
        state: "done",
        group_id: "g1",
        due_at: null,
      },
    ];
    const content = h("div");
    const toolbar = h("div");
    renderBacklogList(content, toolbar);
    const read = () => ({
      searches: find(toolbar, (n) => n.tag === "input").length,
      rows: countClass(content, "doc-list-item"),
      states: countClass(content, "state"),
    });
    expect(read()).toEqual({ searches: 1, rows: 3, states: 0 });
    const search = find(toolbar, (n) => n.tag === "input")[0] as VNode;
    fire(search, "input", "筛验");
    expect(read()).toEqual({ searches: 1, rows: 2, states: 0 });
    fire(search, "input", "筛验待办一");
    expect(read()).toEqual({ searches: 1, rows: 1, states: 0 });
    expect(find(toolbar, (n) => n.tag === "input")[0]).toBe(search);
    fire(search, "input", "没有这个");
    expect(read()).toEqual({ searches: 1, rows: 0, states: 1 });
  });
});

describe("守卫本身有判别力（否则本节是恒绿装饰）", () => {
  it("每一根线都各自被剪一次就红", () => {
    // ① 文档搜索 handler 退回「回调自己」⇒ 自递归判据报红，且 vm 里控件真的长。
    const docHandler = [
      "          state.docFilter.q = event.target.value;",
      "          paintDocumentRows(content);",
    ].join("\n");
    expect(groupSrc.split(docHandler).length - 1).toBe(1);
    const docSelf = groupSrc.replace(
      docHandler,
      "          state.docFilter.q = event.target.value;\n          renderDocumentList(content, toolbar);",
    );
    expect(docSelf).not.toBe(groupSrc);
    expect(
      rebuildCalls(
        functionDecl(docSelf, "function renderDocumentList("),
        "renderDocumentList",
      ),
    ).toEqual(["renderDocumentList"]);
    expect(
      paintCalls(
        functionDecl(docSelf, "function renderDocumentList("),
        "paintDocumentRows",
      ),
    ).toBe(3);
    const grown = loadFilterFns(docSelf);
    grown.state.groups = [{ group_id: "g1", title: "筛验群" }];
    grown.state.documents = [
      {
        doc_id: "d1",
        title: "筛验甲",
        kind: "markdown",
        group_id: "g1",
        owner: "a",
      },
    ];
    const grownContent = h("div");
    const grownToolbar = h("div");
    grown.renderDocumentList(grownContent, grownToolbar);
    // 行区不再累加（paint 自己清），但控件照样一套变两套 —— 这正是 e2e 那发红的
    // 其中一格，所以这一支的判据只盯控件，别顺手断言行也翻倍（那是清空整条没
    // 了才有的形状，见 ④）。
    fire(
      find(grownToolbar, (n) => n.tag === "input")[0] as VNode,
      "input",
      "筛",
    );
    expect(find(grownToolbar, (n) => n.tag === "input").length).toBe(2);
    expect(find(grownToolbar, (n) => n.tag === "select").length).toBe(4);
    expect(countClass(grownContent, "doc-list-item")).toBe(1);

    // ② 待办 handler 同样退回自递归 ⇒ 搜索框从 1 枚变 2 枚。
    const backlogHandler = [
      "        state.backlogFilter = event.target.value;",
      "        paintBacklogRows(content);",
    ].join("\n");
    expect(groupSrc.split(backlogHandler).length - 1).toBe(1);
    const backlogSelf = groupSrc.replace(
      backlogHandler,
      "        state.backlogFilter = event.target.value;\n        renderBacklogList(content, toolbar);",
    );
    expect(backlogSelf).not.toBe(groupSrc);
    const grownTodo = loadFilterFns(backlogSelf);
    grownTodo.state.backlog = [
      {
        id: "b1",
        title: "筛验待办",
        priority: 1,
        state: "todo",
        group_id: "g1",
        due_at: null,
      },
    ];
    const todoContent = h("div");
    const todoToolbar = h("div");
    grownTodo.renderBacklogList(todoContent, todoToolbar);
    fire(
      find(todoToolbar, (n) => n.tag === "input")[0] as VNode,
      "input",
      "筛验",
    );
    expect(find(todoToolbar, (n) => n.tag === "input").length).toBe(2);
    expect(
      rebuildCalls(
        functionDecl(backlogSelf, "function renderBacklogList("),
        "renderBacklogList",
      ),
    ).toEqual(["renderBacklogList"]);

    // ③ handler 改成「统一走 renderList」——控件份数是对的，但焦点/输入法/滚动全丢
    //    ⇒ builder 里出现 renderList() 必须报（这一支正是被否决的那个修法）。
    const viaRenderList = groupSrc.replace(
      docHandler,
      "          state.docFilter.q = event.target.value;\n          renderList();",
    );
    expect(viaRenderList).not.toBe(groupSrc);
    expect(
      rebuildCalls(
        functionDecl(viaRenderList, "function renderDocumentList("),
        "renderDocumentList",
      ),
    ).toEqual(["renderList"]);

    // ④ 把两处清空从 renderList 摘掉 ⇒ 两份归属清单同时空掉（清空没主人 = 谁都能
    //    往上堆，那正是 0079 那一发的病根）。
    expect(groupSrc.split("  toolbar.replaceChildren();\n").length - 1).toBe(1);
    expect(
      groupSrc.split(
        "  content.replaceChildren();\n  toolbar.replaceChildren();",
      ).length - 1,
    ).toBe(1);
    const noClear = groupSrc.replace(
      "  content.replaceChildren();\n  toolbar.replaceChildren();\n",
      "",
    );
    expect(noClear).not.toBe(groupSrc);
    expect(toolbarClearOwners(noClear)).toEqual([]);
    expect(contentClearOwners(noClear).sort()).toEqual([
      "paintBacklogRows",
      "paintDocumentRows",
    ]);

    // ⑤ 行区清空搬回构建器一份 ⇒ 归属重复，清空的唯一性没了。
    const clearBack = groupSrc.replace(
      "function paintDocumentRows(content) {\n  const filtered",
      "function paintDocumentRows(content) {\n  content.replaceChildren();\n  const filtered",
    );
    expect(clearBack).not.toBe(groupSrc);
    const owners = contentClearOwners(clearBack);
    expect(owners.filter((o) => o === "paintDocumentRows")).toHaveLength(2);

    // ⑥ 人才卡那一发退回「只重画行区」⇒ 下拉停在旧值，外部写入判据必须报红。
    const talentAnchor = [
      "                state.docFilter.kind = kind;",
      "                renderList();",
    ].join("\n");
    expect(groupSrc.split(talentAnchor).length - 1).toBe(1);
    const talentPaintOnly = groupSrc.replace(
      talentAnchor,
      '                state.docFilter.kind = kind;\n                paintDocumentRows($(".list-content"));',
    );
    expect(talentPaintOnly).not.toBe(groupSrc);
    expect(externalKindWrites(talentPaintOnly)).toEqual([
      { at: expect.any(Number), rebuilds: false },
    ]);

    // ⑦ 构建末尾那一发被删 ⇒ paint 计数少一发，且 vm 里首屏真的什么都不画。
    const noFirstPaint = groupSrc.replace(
      '    h("div", { class: "toolbar doc-filter-kinds" }, kinds, groups),\n  );\n  paintDocumentRows(content);',
      '    h("div", { class: "toolbar doc-filter-kinds" }, kinds, groups),\n  );',
    );
    expect(noFirstPaint).not.toBe(groupSrc);
    expect(
      paintCalls(
        functionDecl(noFirstPaint, "function renderDocumentList("),
        "paintDocumentRows",
      ),
    ).toBe(3);
    const blank = loadFilterFns(noFirstPaint);
    blank.state.documents = [
      {
        doc_id: "d1",
        title: "甲",
        kind: "markdown",
        group_id: "g1",
        owner: "a",
      },
    ];
    const blankContent = h("div");
    blank.renderDocumentList(blankContent, h("div"));
    expect(countClass(blankContent, "doc-list-item")).toBe(0);

    // 取材失败的形状也要成立：拿不到对象时是抛，不是悄悄返回半截或空集合。
    expect(() => functionDecl("const x = 1;", "function nope(")).toThrow(
      /取材失败/u,
    );
    expect(() => loadFilterFns("const x = 1;")).toThrow(/取材失败/u);
  });
});
