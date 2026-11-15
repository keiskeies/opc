/**
 * 角色执行器（claude -p 适配器）的行为测试。
 *
 * 对面是一个【真的子进程】（fixtures/fake-claude.mjs），走真的 spawn + stdin +
 * stdout + 退出码，只有「模型」是查表的。为什么费这个劲：这一层最容易出的错全在
 * 进程边界上（参数没传过去、输出不是 JSON、进程挂住不退、非零退出被当成功），
 * 而这些错在「把 runRole 换成一个返回固定对象的 mock」之下**一个都测不出来**。
 *
 * 跑法就是门禁的跑法：`npx vitest run packages/hub/test/engine/claude.test.ts`。
 * ⚠ 这一发今天【从 node:test 搬进 vitest】，因为搬之前它是门禁里的一发假绿，三条都实测过：
 *   ① `vitest run` 对它报 "No test suite found" ⇒ 整套 `pnpm test` 恒 exit 1
 *     ⇒ `pnpm verify`（lint && typecheck && test）恒不可能通过；
 *   ② 那 13 发在门禁下【一发都没跑】：把 `parseDecision` 的 `lastIndexOf` 改成 `indexOf`
 *     （正是「取最后一个决策段」那发明令禁止的改法）门禁输出与基线【逐字节同】；
 *   ③ 文件头原先写的兜底跑法依赖 `/tmp/opc-harness/register.mjs`，那个文件在本机【不存在】
 *     ⇒ 「node --test 下 13/13 绿」这句话我当时是照抄 round187 的，没有自己复算过。
 * 搬过来之后 ② 那条变异必须红，这是本次改动唯一的验收（0054 §4 同一口径）。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DECISION_MARK,
  parseDecision,
  runRole,
} from "../../src/engine/claude.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-claude.mjs");

const base = {
  prompt: "把登录模块做完",
  rolePrompt: "你是测试工程师。",
  cwd: HERE,
  maxBudgetUsd: 0.5,
};

/**
 * 桩是一个【带 shebang 的可执行文件】，直接当 bin 传给 spawn。
 * 不在测试里写 `node <脚本>` 那种一串：runRole 用的是 spawn(bin, args) 不经 shell，
 * 整串会被当成一个可执行文件名。也不为了迁就测试给 runRole 加 shell:true ——
 * 那会把 prompt（CEO 输入的原文）经 shell 解析的风险面打开。
 */
const BIN = FAKE;

describe("runRole —— 真的起一个 agent 进程", () => {
  it("成功路径：文本、会话 id、账单三样都拿回来", async () => {
    const r = await runRole({ ...base, bin: BIN });
    expect(r.ok, "error=" + String(r.error)).toBe(true);
    expect(r.sessionId).toBe("sess-1");
    expect(r.costUsd).toBe(0.042);
    expect(r.text).toMatch(/员工的一轮汇报/);
    expect(r.error).toBe(null);
  });

  it("prompt 走 stdin 而非 argv，且 rolePrompt 与预算【真的】出现在 argv 上", async () => {
    const r = await runRole({
      ...base,
      bin: BIN,
      prompt: "只有 stdin 能看到这句话",
      maxBudgetUsd: 1.25,
    });
    expect(r.ok).toBe(true);
    // 桩把收到的 argv 与 stdin 回显进 result，所以这一发验的是「真传了」而不是「以为传了」
    expect(r.text).toMatch(/"prompt":"只有 stdin 能看到这句话"/);
    expect(r.text).toMatch(/"budget":"1.25"/);
    // ⚠ 这一条是 round259 补的：上面那句标题一直写着「rolePrompt 真的出现在 argv 上」，
    //   而【体内从来没有断过它】—— 于是把 --append-system-prompt 的值换成空串，
    //   13 发全绿（变异 P3 就是这么存活过一次）。标题写着而断言没写 = 这一格没人守。
    expect(r.text).toMatch(/"systemPrompt":"你是测试工程师。"/);
  });

  it("带 resumeSessionId ⇒ argv 里真的有 --resume 且值正确", async () => {
    const r = await runRole({
      ...base,
      bin: BIN,
      resumeSessionId: "sess-上一轮",
    });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/"resumed":"sess-上一轮"/);
    expect(r.text).toMatch(/"resumeFlag":true/);
  });

  it("不带 resumeSessionId ⇒ 不出现 --resume（空串也不算续）", async () => {
    const r = await runRole({ ...base, bin: BIN, resumeSessionId: "" });
    expect(r.text).toMatch(/"resumed":""/);
    // resumeFlag 才是这一发的判据。只看 resumed 的话，「不推 --resume」与
    // 「推一个空串的 --resume」两种实现回显一模一样 ⇒ 变异 P4 曾因此存活。
    expect(r.text).toMatch(/"resumeFlag":false/);
  });

  it("二进制不存在 ⇒ ok:false 并报出错，而不是挂在那里等一个永远不会来的 close", async () => {
    const r = await runRole({
      ...base,
      bin: join(HERE, "fixtures", "no-such-claude"),
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).not.toBe(null);
    expect(r.error ?? "").toMatch(/ENOENT|no-such-claude/);
  });

  it("is_error + 非零退出 ⇒ ok:false，但账单与会话 id 仍然保留（钱已经花了）", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "nonzero";
    try {
      const r = await runRole({ ...base, bin: BIN });
      expect(r.ok).toBe(false);
      expect(r.error ?? "").toMatch(/budget exceeded/);
      expect(r.costUsd, "失败的执行也花了钱，账单不能报 0").toBe(0.042);
      expect(r.sessionId, "会话 id 留着，下一轮才能接着谈").toBe("sess-1");
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
    }
  });

  /**
   * ⚠ 这一发是 round259 补的，起因是变异 N1 存活：原来的 nonzero 档【同时】给
   * is_error:true 与 exit(1)，两个失败信号绑死在一起 ⇒ 「适配器只信 is_error、
   * 把非零退出当成功」这个改法改完全绿。两个信号必须各测一次才算「两个都信」。
   * 真的 CLI 会不会给出 is_error:false 却非零退出，本机离线装不上 CLI、没实测过
   * ⇒ 这一发钉的是【适配器不许只信一个信号】，不是【真 CLI 长这样】。
   */
  it("is_error 是 false 但退出码非零 ⇒ 仍判失败（不能只信一个信号）", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "silentfail";
    try {
      const r = await runRole({ ...base, bin: BIN });
      expect(
        r.ok,
        "退出码非零而 is_error 说没事：只信 is_error 的实现会在这里判成功",
      ).toBe(false);
      expect(r.costUsd).toBe(0.042);
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
    }
  });

  it("stdout 是垃圾 ⇒ 报「不是预期的 JSON」，不静默给一个空 text", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "garbage";
    try {
      const r = await runRole({ ...base, bin: BIN });
      expect(r.ok).toBe(false);
      expect(r.error ?? "").toMatch(/不是预期的 JSON/);
      expect(r.text, "解析不出来就不能编一段话当员工的回答").toBe("");
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
    }
  });

  it("进程挂住 ⇒ 超时被杀死并报错（不能让一个角色把整个 hub 拖死）", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "hang";
    try {
      const r = await runRole({ ...base, bin: BIN, timeoutMs: 700 });
      expect(r.ok).toBe(false);
      expect(r.error ?? "").toMatch(/超时/);
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
    }
  });
});

describe("parseDecision —— 员工说了算的那一步", () => {
  const withMark = (o: unknown) =>
    "干活过程……\n\n" + DECISION_MARK + "\n" + JSON.stringify(o);

  it("认三种决策", () => {
    expect(
      parseDecision(
        withMark({ action: "handoff", to_role: "tech", summary: "好了" }),
      )?.action,
    ).toBe("handoff");
    expect(
      parseDecision(withMark({ action: "blocked", summary: "要 CEO 定" }))
        ?.action,
    ).toBe("blocked");
    expect(
      parseDecision(withMark({ action: "wait", summary: "还差点东西" }))
        ?.action,
    ).toBe("wait");
  });

  it("没有决策段 ⇒ null（调用方留在原状态，不默认往下走）", () => {
    expect(parseDecision("我这边还在看代码，感觉差不多了吧")).toBe(null);
  });

  it("handoff 缺 to_role ⇒ to_role 为空串，由调度层拒绝这一手（不能凭空猜下游）", () => {
    const d = parseDecision(withMark({ action: "handoff", summary: "交出去" }));
    expect(d?.to_role).toBe("");
  });

  it("未知 action / 缺 summary ⇒ null", () => {
    expect(
      parseDecision(
        withMark({ action: "approve_myself", summary: "我批我自己" }),
      ),
    ).toBe(null);
    expect(
      parseDecision(withMark({ action: "handoff", to_role: "tech" })),
    ).toBe(null);
  });

  it("取【最后一个】决策段：员工中途举了个例子不该被当成结论", () => {
    const text =
      "格式形如 " +
      DECISION_MARK +
      ' {"action":"wait","summary":"这是示例"}\n\n' +
      "实际结论：\n" +
      DECISION_MARK +
      "\n" +
      JSON.stringify({
        action: "handoff",
        to_role: "test",
        summary: "真的交测试",
      });
    const d = parseDecision(text);
    expect(d?.action).toBe("handoff");
    expect(d?.to_role).toBe("test");
  });
});
