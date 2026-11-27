/**
 * 消息流滚动锚点的守卫（0078）。
 *
 * 为什么要有这个文件：背景重读（点「刷新消息」、别人插话后补拉、切回这一会话）
 * 之前每次都 `stream.scrollTop = stream.scrollHeight` —— 用户往上翻着读旧史时，
 * 一刷新就被拽回最新消息。三件事都不报错，所以【静默】。修法是重画前读一枚锚点、
 * 只有贴在底部才跳底；而「什么时候读锚点」本身是可错的（在骨架帧上读会得到
 * 「没有溢出 = 贴底」这种恒真读数，见 chatScrollAnchor 的函数头），所以时机也要钉。
 *
 * 分工（与另两份文件别混）：
 *   本文件 —— 扫源码钉【每一处跳底是谁的】+ 把那两个纯函数真的跑起来。
 *   test/e2e/group-workbench.spec.ts 的「会话滚动位置」—— 真浏览器几何：翻上去→
 *     重读→位置不动；在底部→重读→跟随；发送→跳底。
 *   test/web/history-cursor-producer.test.ts —— 0077 的游标生产者，同一族但另一头。
 *
 * ⚠ 形状沿用同目录的源扫描守卫（group.js 顶层就 boot()、零 export，vitest 导不进来）。
 * 与 0077 那份的区别：这一族的两个函数是【纯的】（吃一个长得像滚动容器的对象），
 * 所以除了扫源码还把函数体切出来在 node:vm 里真跑 —— 扫描只能证明「字在」，
 * 证明不了「阈值 80 真的在承重、上界真的夹住」。判别力自证放在最后一发。
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

/**
 * 无条件「跳到最底」那一发的形状：`x.scrollTop = y.scrollHeight;`。
 *
 * 收尾必须是分号，所以 `= scrollHeight - anchorOffset`（loadOlderMessages 的距底
 * 锚点）与 `= anchor.pinned ? … : …`（applyChatScrollAnchor 的分支）都不落进来 ——
 * 那两处各有自己的守卫，混进这份清单只会让「点名」变成一锅粥。
 */
const UNCONDITIONAL_JUMP =
  /[A-Za-z_$][\w$]*\.scrollTop\s*=\s*[A-Za-z_$][\w$]*\.scrollHeight\s*;/gmu;

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

/**
 * 取一个顶层函数声明的函数体（含首尾花括号）。
 *
 * 与 0077 那份同族：认字符串、模板串、行/块注释 —— 不认注释里的花括号是这一族
 * 最容易踩的坑。取不到闭合时抛，不悄悄返回半截（半截的判据是恒绿装饰）。
 * 装载执行请改用 functionDecl：判据读的是「花括号里那段」，执行还需要签名里的参数名。
 */
function functionBody(src: string, header: string): string {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`找不到 ${header}，取材失败`);
  const end = bodyEnd(src, at, header);
  return src.slice(src.indexOf("{", at + header.length), end);
}

/** 整条声明：签名 + 函数体 —— 装载执行必须用它（只取花括号内会丢掉参数名）。 */
function functionDecl(src: string, header: string): string {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`找不到 ${header}，取材失败`);
  return src.slice(at, bodyEnd(src, at, header));
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
 * 顶层函数名下标：把一处源码位置归到「它写在哪个函数里」。
 *
 * 归因必须靠下标而不是「函数体里搜到了这个字符串」—— 散文、以及另一个函数里
 * 恰好出现同样的话，都会让「点名」变成点错人。
 */
function ownerOf(src: string, at: number): string {
  let owner = "<顶层>";
  for (const m of src.matchAll(/^(?:async )?function ([\w$]+)\(/gmu)) {
    if ((m.index as number) > at) break;
    owner = m[1] as string;
  }
  return owner;
}

/** 渲染侧每一处「无条件跳到最底」的归属函数名（按出现顺序）。 */
function jumpOwners(src: string): string[] {
  return [...src.matchAll(UNCONDITIONAL_JUMP)].map((m) =>
    ownerOf(src, m.index as number),
  );
}

/** 把 group.js 里那一族纯函数切出来，交回可执行的替身。 */
function loadAnchorFns(src: string): {
  chatScrollAnchor: (stream: unknown) => Anchor | null;
  applyChatScrollAnchor: (
    stream: FakeStream | null,
    a: Anchor | null,
  ) => boolean;
  stickPx: number;
} {
  const constLine = /^const CHAT_BOTTOM_STICK_PX = \d+;/mu.exec(src);
  if (!constLine) throw new Error("找不到 CHAT_BOTTOM_STICK_PX，取材失败");
  const code = [
    "(function () {",
    constLine[0],
    functionDecl(src, "function chatScrollAnchor("),
    functionDecl(src, "function applyChatScrollAnchor("),
    "return { chatScrollAnchor, applyChatScrollAnchor, CHAT_BOTTOM_STICK_PX };",
    "})()",
  ].join("\n");
  const ctx = vm.createContext({});
  const got = vm.runInContext(code, ctx, { filename: "group.js#anchor" }) as {
    chatScrollAnchor: (stream: unknown) => Anchor | null;
    applyChatScrollAnchor: (
      stream: FakeStream | null,
      a: Anchor | null,
    ) => boolean;
    CHAT_BOTTOM_STICK_PX: number;
  };
  return {
    chatScrollAnchor: got.chatScrollAnchor,
    applyChatScrollAnchor: got.applyChatScrollAnchor,
    stickPx: got.CHAT_BOTTOM_STICK_PX,
  };
}

type Anchor = { pinned: boolean; top: number };

/** 长得像滚动容器的替身：只带这两个函数真读的那几格。 */
type FakeStream = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  querySelectorAll: () => unknown[];
};

function fakeStream(
  over: Partial<FakeStream> & { rows?: number } = {},
): FakeStream {
  const rows = over.rows ?? 5;
  return {
    scrollTop: over.scrollTop ?? 0,
    scrollHeight: over.scrollHeight ?? 2000,
    clientHeight: over.clientHeight ?? 600,
    querySelectorAll: () => new Array(rows).fill(null),
  };
}

describe("消息流滚动锚点：谁许跳底、什么时候读锚点", () => {
  it("每一处无条件跳底都点得出主人，且只有该跳的那两处", () => {
    const owners = jumpOwners(groupSrc);
    // sendMessage：用户自己的动作 ⇒ 无条件跳底是对的（0078 §1）。
    // loadMessages：只许出现在「没有锚点」那一支 ⇒ 下一条 it 单独钉那一支的条件。
    // 多出第三处 = 有人新加了一发「无论如何都回底部」，那正是本轮修掉的病。
    expect(owners.sort()).toEqual(["loadMessages", "sendMessage"]);
  });

  it("背景重读那一跳挂在『没有锚点』上，而不是挂在 if (stream) 上", () => {
    const body = functionBody(groupSrc, "async function loadMessages(");
    // 首屏/刚切会话（锚点为 null）落到最新消息是对的；有锚点必须交回锚点。
    expect(
      /if \(scrollAnchor === null\) stream\.scrollTop = stream\.scrollHeight;/u.test(
        body,
      ),
    ).toBe(true);
    expect(
      /else applyChatScrollAnchor\(stream, scrollAnchor\);/u.test(body),
    ).toBe(true);
    // 反向：整条 if 拆成「有流就跳底」= 回到 0078 之前的形状。
    expect(body).not.toMatch(
      /if \(stream\) stream\.scrollTop = stream\.scrollHeight;/u,
    );
  });

  it("锚点读在重画之前：骨架帧与拆节点都量不到真位置", () => {
    // loadMessages：读锚点必须早于 messageLoading=true —— 那一帧画的是 chatSkeleton
    // （3 行、撑不满一屏 ⇒ 无溢出 ⇒ 恒判「贴底」）。
    const load = functionBody(groupSrc, "async function loadMessages(");
    expect(load.indexOf("chatScrollAnchor(")).toBeGreaterThan(-1);
    expect(load.indexOf("chatScrollAnchor(")).toBeLessThan(
      load.indexOf("state.messageLoading = true"),
    );
    // renderMain：读锚点必须早于 view.replaceChildren() —— 摘下来的节点量不到
    // 任何几何（scrollHeight/clientHeight 一律 0，实测见 0078 §4），进了 renderChat
    // 再读只剩 0，而 0 会被读成「没有溢出 = 贴底」。
    const main = functionBody(groupSrc, "function renderMain(");
    expect(main.indexOf("chatScrollAnchor(")).toBeGreaterThan(-1);
    expect(main.indexOf("chatScrollAnchor(")).toBeLessThan(
      main.indexOf("view.replaceChildren()"),
    );
    // renderChat 里不许有锚点：它跑起来时旧节点已经没了，那一一对是恒绿的装饰
    // （本轮第一版就写在那里，删掉它任何测试都不红 ⇒ 移走）。
    const chat = functionBody(groupSrc, "function renderChat(");
    expect(chat).not.toMatch(/chatScrollAnchor\(/u);
    expect(chat).not.toMatch(/\.scrollTop\s*=/u);
  });

  it("两处压回都过窗口归属门，别把上一个会话的位置压到新会话上", () => {
    const main = functionBody(groupSrc, "function renderMain(");
    // renderMain 的锚点是【这一屏】的，切会话时它属于上一个会话 ⇒ 整条不许动。
    expect(
      /if \(state\.messagesWindowId === state\.selectedConversation\)\s*\n?\s*applyChatScrollAnchor\(/u.test(
        main,
      ),
    ).toBe(true);
    // loadMessages 的锚点在【读】的那一侧过门（读不到就不压）：屏幕上还是别的
    // 会话时交回 null，落到最新消息。
    const load = functionBody(groupSrc, "async function loadMessages(");
    expect(
      /state\.messagesWindowId === id\s*\?[\s\S]{0,60}chatScrollAnchor\(/u.test(
        load,
      ),
    ).toBe(true);
    expect(load).not.toMatch(/const scrollAnchor = chatScrollAnchor\(/u);
  });

  it("往旧翻那一头仍用距底距离：两对锚点各管一头，不许互相「统一」", () => {
    // prepend 往【上方】加内容 ⇒ 尺子是「距底」；背景重读往【下方】加 ⇒ 尺子是
    // scrollTop 本身。把任一根换成另一根都会跳段，而且跳得静悄悄。
    const older = functionBody(groupSrc, "async function loadOlderMessages(");
    expect(older).toMatch(
      /streamBefore\.scrollHeight - streamBefore\.scrollTop/u,
    );
    expect(older).toMatch(
      /stream\.scrollTop = stream\.scrollHeight - anchorOffset;/u,
    );
    expect(older).not.toMatch(/chatScrollAnchor\(/u);
  });
});

describe("chatScrollAnchor / applyChatScrollAnchor 真的算得对", () => {
  const { chatScrollAnchor, applyChatScrollAnchor, stickPx } =
    loadAnchorFns(groupSrc);

  it("贴底判定有个非零容差，而不是一像素不差", () => {
    expect(stickPx).toBeGreaterThan(0);
    // 整页不溢出（首屏就一屏）⇒ 贴底。
    expect(
      chatScrollAnchor(fakeStream({ scrollHeight: 500, clientHeight: 600 })),
    ).toEqual({ pinned: true, top: 0 });
    // scrollTop 是浏览器向下取整的整数：滚到底「距底」读到 1 也算贴底。
    expect(
      chatScrollAnchor(
        fakeStream({ scrollTop: 1399, scrollHeight: 2000, clientHeight: 600 }),
      ),
    ).toEqual({ pinned: true, top: 1399 });
    // 明显翻上去（远超容差）⇒ 不贴底，且留住的是 scrollTop 本身。
    expect(
      chatScrollAnchor(
        fakeStream({ scrollTop: 500, scrollHeight: 2000, clientHeight: 600 }),
      ),
    ).toEqual({ pinned: false, top: 500 });
  });

  it("骨架帧交回 null：没一行正文时量出来的是假「贴底」", () => {
    // 骨架 3 行撑不满一屏 ⇒ scrollHeight<=clientHeight ⇒ 上面那条判据恒真。
    // 这一格自己认骨架，否则每次背景重读都跳底，而判据永远成立（0077 §5 同款）。
    expect(chatScrollAnchor(fakeStream({ rows: 0 }))).toBeNull();
    expect(chatScrollAnchor(null)).toBeNull();
    expect(chatScrollAnchor(undefined)).toBeNull();
  });

  it("压回：贴底跳到底，未贴底留在原地并夹住上界", () => {
    // 未贴底 —— 内容变高（重读补了几条）也留在同一屏像素上。
    const up = fakeStream({ scrollTop: 500 });
    expect(applyChatScrollAnchor(up, { pinned: false, top: 500 })).toBe(true);
    expect(up.scrollTop).toBe(500);
    // 贴底 —— 跟着新消息走。
    const down = fakeStream({ scrollTop: 1400 });
    expect(applyChatScrollAnchor(down, { pinned: true, top: 1400 })).toBe(true);
    expect(down.scrollTop).toBe(2000);
    // 上界夹住：窗口换页把尾部几条读掉了，不夹就写一个超界的 scrollTop，
    // 浏览器按它自己的口径乱夹 ⇒ 判据读不到「停在原地」。
    const shrunk = fakeStream({ scrollTop: 100, scrollHeight: 900 });
    expect(applyChatScrollAnchor(shrunk, { pinned: false, top: 800 })).toBe(
      true,
    );
    expect(shrunk.scrollTop).toBe(300);
    // 锚点为空 / 没有流 ⇒ 不动手，交回调用方决定（首屏落到最新消息）。
    expect(applyChatScrollAnchor(fakeStream(), null)).toBe(false);
    expect(applyChatScrollAnchor(null, { pinned: false, top: 10 })).toBe(false);
  });
});

describe("守卫本身有判别力（否则本节是恒绿装饰）", () => {
  it("每一根线都各自被剪一次就红", () => {
    // ① 容差归零 ⇒ 滚到底读到「距底 1」不再算贴底 ⇒ 贴底的人不再跟随。
    const noTolerance = groupSrc.replace(
      "const CHAT_BOTTOM_STICK_PX = 80;",
      "const CHAT_BOTTOM_STICK_PX = 0;",
    );
    expect(noTolerance).not.toBe(groupSrc);
    const tight = loadAnchorFns(noTolerance);
    expect(
      tight.chatScrollAnchor(
        fakeStream({ scrollTop: 1399, scrollHeight: 2000, clientHeight: 600 }),
      )?.pinned,
    ).toBe(false);
    expect(loadAnchorFns(noTolerance).stickPx).toBe(0);

    // ② 摘掉骨架帧那一格 ⇒ 骨架上量出「贴底」，背景重读必跳底。
    const blindSkeleton = groupSrc.replace(
      'if (!stream || stream.querySelectorAll(".message-row").length === 0)\n    return null;',
      "if (!stream) return null;",
    );
    expect(blindSkeleton).not.toBe(groupSrc);
    expect(
      loadAnchorFns(blindSkeleton).chatScrollAnchor(fakeStream({ rows: 0 })),
    ).not.toBeNull();

    // ③ 摘掉上界夹持 ⇒ 写一个超界读数。
    const noClamp = groupSrc.replace(
      [
        "    : Math.max(",
        "        0,",
        "        Math.min(anchor.top, stream.scrollHeight - stream.clientHeight),",
        "      );",
      ].join("\n"),
      "    : anchor.top;",
    );
    expect(noClamp).not.toBe(groupSrc);
    const unclamped = fakeStream({ scrollTop: 100, scrollHeight: 900 });
    loadAnchorFns(noClamp).applyChatScrollAnchor(unclamped, {
      pinned: false,
      top: 800,
    });
    expect(unclamped.scrollTop).toBe(800);

    // ④ renderMain 的锚点读到 replaceChildren 之后 ⇒ 时机判据必须报红。
    const lateCapture = groupSrc.replace(
      [
        '  const chatAnchor = chatScrollAnchor($(".message-stream"));',
        "  view.replaceChildren();",
      ].join("\n"),
      [
        "  view.replaceChildren();",
        '  const chatAnchor = chatScrollAnchor($(".message-stream"));',
      ].join("\n"),
    );
    expect(lateCapture).not.toBe(groupSrc);
    const lateMain = functionBody(lateCapture, "function renderMain(");
    expect(lateMain.indexOf("chatScrollAnchor(")).toBeGreaterThan(
      lateMain.indexOf("view.replaceChildren()"),
    );

    // ⑤ 背景重读退回「有流就跳底」⇒ 归属清单不变但条件判据必须报红。
    const alwaysBottom = groupSrc.replace(
      "        if (scrollAnchor === null) stream.scrollTop = stream.scrollHeight;\n        else applyChatScrollAnchor(stream, scrollAnchor);",
      "        stream.scrollTop = stream.scrollHeight;",
    );
    expect(alwaysBottom).not.toBe(groupSrc);
    const alwaysBody = functionBody(
      alwaysBottom,
      "async function loadMessages(",
    );
    expect(
      /if \(scrollAnchor === null\) stream\.scrollTop = stream\.scrollHeight;/u.test(
        alwaysBody,
      ),
    ).toBe(false);
    expect(jumpOwners(alwaysBody)).toEqual(["<顶层>"]);

    // ⑥ 把「跳到底」那一发从发送里删掉 ⇒ 清单少一个人（清单真按字节数人，
    //    不是恒等于一条写死的数组）。
    const sendJump =
      '    const stream = $(".message-stream");\n    if (stream) stream.scrollTop = stream.scrollHeight;';
    expect(groupSrc.split(sendJump).length - 1).toBe(1);
    expect(jumpOwners(groupSrc.replace(sendJump, "")).sort()).toEqual([
      "loadMessages",
    ]);

    // ⑦ 把两对锚点「统一」成同一根尺子 ⇒ 距底判据必须报缺口。
    const unified = groupSrc.replace(
      "    ? streamBefore.scrollHeight - streamBefore.scrollTop",
      "    ? streamBefore.scrollTop",
    );
    expect(unified).not.toBe(groupSrc);
    expect(
      functionBody(unified, "async function loadOlderMessages("),
    ).not.toMatch(/streamBefore\.scrollHeight - streamBefore\.scrollTop/u);

    // ⑧ 窗口归属门反过来（!==）⇒ 新会话被压到半屏。
    const wrongOwner = groupSrc.replace(
      "if (state.messagesWindowId === state.selectedConversation)\n    applyChatScrollAnchor(",
      "if (state.messagesWindowId !== state.selectedConversation)\n    applyChatScrollAnchor(",
    );
    expect(wrongOwner).not.toBe(groupSrc);
    expect(
      /if \(state\.messagesWindowId === state\.selectedConversation\)\s*\n?\s*applyChatScrollAnchor\(/u.test(
        functionBody(wrongOwner, "function renderMain("),
      ),
    ).toBe(false);

    // 取材失败的形状也要成立：拿不到对象时是抛，不是悄悄返回半截。
    expect(() => functionBody("const x = 1;", "function nope(")).toThrow(
      /取材失败/u,
    );
    expect(() => loadAnchorFns("const x = 1;")).toThrow(/取材失败/u);
  });
});
