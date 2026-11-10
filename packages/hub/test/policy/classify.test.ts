/**
 * Task 1.5 验收：三级分类 + 未知即不可逆（规格 §9.1，计划 Test 项最后一条）。
 *
 * 这个文件的核心不是「表查得对」，而是【默认方向】：
 * 一条我们从未见过的动作，必须落到 irreversible。
 * 因为两种错判的代价不对称 ——
 *   把不可逆判成可逆 ⇒ 付了款、发了版、删了数据，没有回滚；
 *   把可逆判成不可逆 ⇒ CEO 多点一次按钮。
 * 差几个数量级，所以模糊时必须往贵的那一侧偏。任何「看起来更聪明」的默认放行
 * 写法都要在这里被拦住。
 */
import { describe, expect, it } from "vitest";
import {
  type ActionDraft,
  classifyAction,
  IRREVERSIBLE_PATTERNS,
  matchForbidden,
  policyDecide,
} from "../../src/policy/engine.js";

const act = (over: Partial<ActionDraft> = {}): ActionDraft => ({
  kind: "unknown",
  detail: "",
  ...over,
});

describe("计划点名的四类样例", () => {
  it("rm -rf / 推送主干 / 对外发布 / 付款 → irreversible", () => {
    for (const detail of [
      "rm -rf /tmp/build",
      "git push origin main",
      "发布 v1.2 到生产",
      "给供应商付款 3000 美元",
      "deploy to prod",
      "send email to customer",
    ]) {
      expect(classifyAction(act({ detail })), detail).toBe("irreversible");
    }
  });

  it("改工作区文件 → reversible", () => {
    for (const detail of [
      "编辑 src/a.ts",
      "write file notes.md",
      "创建分支 feat/x",
    ]) {
      expect(classifyAction(act({ detail })), detail).toBe("reversible");
    }
  });

  it("读仓库 / 跑测试 → read_only", () => {
    for (const detail of [
      "read src/a.ts",
      "grep TODO",
      "pnpm test",
      "typecheck",
    ]) {
      expect(classifyAction(act({ detail })), detail).toBe("read_only");
    }
  });

  it("未知动作 → irreversible（fail-closed，不得默认放行）", () => {
    for (const a of [
      act({ kind: "quantum_flip", detail: "对熵增池做一次逆操作" }),
      act({ kind: "", detail: "" }),
      act({ kind: "   ", detail: "随手做点什么" }),
    ]) {
      expect(classifyAction(a), JSON.stringify(a)).toBe("irreversible");
    }
  });
});

describe("判定的取舍细节", () => {
  it("一句话里有多个动词时，按【最危险】的那个判", () => {
    // 「读取后要删除这个目录」若先命中只读表就被放行 —— 那正是危险的方向。
    expect(
      classifyAction(act({ detail: "读取配置然后 rm -rf /tmp/cache" })),
    ).toBe("irreversible");
    expect(classifyAction(act({ detail: "编辑文件前先 read 一遍" }))).toBe(
      "reversible",
    );
  });

  it("external: true 直接判不可逆（本机之外的东西收不回来）", () => {
    expect(classifyAction(act({ detail: "run tests", external: true }))).toBe(
      "irreversible",
    );
  });

  it("自报的 kind 盖不住危险描述（取两边更危险的那个）", () => {
    // kind 是调用方【自报】的，而 §8.2 的立场是门控不依赖 agent 的自觉。
    expect(
      classifyAction(act({ kind: "write_repo", detail: "改完直接发布上线" })),
    ).toBe("irreversible");
  });

  it("kind 映射表在 detail 无命中时生效", () => {
    expect(classifyAction(act({ kind: "run_tests", detail: "执行用例集 B" }))).toBe(
      "read_only",
    );
    expect(
      classifyAction(act({ kind: "production_deploy", detail: "按计划执行" })),
    ).toBe("irreversible");
  });

  it("大小写不影响命中（描述可能是英文大写命令）", () => {
    expect(classifyAction(act({ detail: "RM -RF /tmp/x" }))).toBe("irreversible");
    expect(classifyAction(act({ detail: "GIT PUSH ORIGIN MAIN" }))).toBe(
      "irreversible",
    );
  });

  it("detail 缺省（调用方传了 undefined）不崩，且落 irreversible", () => {
    const a = { kind: "x" } as unknown as ActionDraft;
    expect(classifyAction(a)).toBe("irreversible");
  });

  it("模式表只加不减：删一条等于放开一类不可逆动作", () => {
    // 这一条不是凑数。表的维护规则写在 engine.ts 里：删除的动机往往来自
    // 「这个老被拦，烦」—— 那是该由 CEO 决定的收紧/放宽（§4.4.3），
    // 不该在一次顺手重构里发生。这里把【关键几类】钉住，删了就红。
    for (const must of ["rm -rf", "git push", "发布", "付款", "deploy"]) {
      expect(IRREVERSIBLE_PATTERNS, "缺模式 " + must).toContain(must);
    }
  });
});

describe("policyDecide：三档决定", () => {
  it("只读 → auto_allow（CEO 的注意力是稀缺资源，读文件不该找他）", () => {
    const d = policyDecide(act({ detail: "read src/a.ts" }), {});
    expect(d.action).toBe("auto_allow");
  });

  it("可逆与不可逆本期一律 require_approval（模式自动批准在 Task 3.5）", () => {
    expect(policyDecide(act({ detail: "编辑 src/a.ts" }), {}).action).toBe(
      "require_approval",
    );
    expect(policyDecide(act({ detail: "git push origin main" }), {}).action).toBe(
      "require_approval",
    );
    // reason 必须说清【为什么】，否则审批界面上是一句废话
    const d = policyDecide(act({ detail: "git push origin main" }), {});
    if (d.action === "require_approval") {
      expect(d.reason.length).toBeGreaterThan(10);
    }
  });

  it("命中黑名单 → forbidden，且优先级高于「只读 ⇒ 自动放行」", () => {
    // 这条是本轮真正抓出来的语义要点：§4 的黑名单若无条件优先，
    // 一个被禁的只读动作会被 auto_allow —— 黑名单退化成建议。
    const draft = act({ kind: "read_file", detail: "读取生产库全部用户数据" });
    expect(classifyAction(draft)).toBe("read_only");
    const d = policyDecide(draft, { forbidden: ["读取生产库全部用户数据"] });
    expect(d.action).toBe("forbidden");
    if (d.action === "forbidden") {
      expect(d.reason).toContain("黑名单");
    }
  });

  it("历史批准次数【本期】不能换来自动放行（防止没有规则时的伪自动批准）", () => {
    const d = policyDecide(act({ detail: "编辑 src/a.ts" }), {
      recentSimilarApprovals: 99,
    });
    expect(d.action).toBe("require_approval");
  });
});

describe("黑名单匹配（双向包含，全等永远匹配不上中文条目）", () => {
  it("条目含于描述 → 命中", () => {
    expect(
      matchForbidden(act({ detail: "git push origin main" }), [
        "git push 到主干",
        "git push",
      ]),
    ).toBe("git push");
  });

  it("描述含于条目 → 也命中（宽的一侧是人多拦一次）", () => {
    expect(
      matchForbidden(act({ detail: "发布" }), ["对外发布新版本需 CEO 批准"]),
    ).toBe("对外发布新版本需 CEO 批准");
  });

  it("大小写不敏感", () => {
    expect(matchForbidden(act({ detail: "GIT PUSH" }), ["git push"])).toBe(
      "git push",
    );
  });

  it("空条目被跳过（否则 needle.includes(low) 会命中一切，拦光所有动作）", () => {
    expect(matchForbidden(act({ detail: "read a" }), ["", "   "])).toBeUndefined();
  });

  it("一切皆空 → 不命中（无信息时不做肯定判断）", () => {
    expect(matchForbidden(act({ kind: "", detail: "" }), ["禁止 anything"])).toBeUndefined();
  });
});
