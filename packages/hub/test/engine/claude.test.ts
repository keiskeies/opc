/**
 * 角色执行器（claude -p 适配器）的行为测试。
 *
 * 对面是一个【真的子进程】（fixtures/fake-claude.mjs），走真的 spawn + stdin +
 * stdout + 退出码，只有「模型」是查表的。为什么费这个劲：这一层最容易出的错全在
 * 进程边界上（参数没传过去、输出不是 JSON、进程挂住不退、非零退出被当成功），
 * 而这些错在「把 runRole 换成一个返回固定对象的 mock」之下**一个都测不出来**。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test packages/hub/test/engine/claude.test.ts
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { DECISION_MARK, parseDecision, runRole } from "../../src/engine/claude.ts";

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
    assert.equal(r.ok, true, "error=" + String(r.error));
    assert.equal(r.sessionId, "sess-1");
    assert.equal(r.costUsd, 0.042);
    assert.match(r.text, /员工的一轮汇报/);
    assert.equal(r.error, null);
  });

  it("prompt 走 stdin 而非 argv，且 rolePrompt 与预算【真的】出现在 argv 上", async () => {
    const r = await runRole({ ...base, bin: BIN, prompt: "只有 stdin 能看到这句话", maxBudgetUsd: 1.25 });
    assert.equal(r.ok, true);
    // 桩把收到的 argv 与 stdin 回显进 result，所以这一发验的是「真传了」而不是「以为传了」
    assert.match(r.text, /"prompt":"只有 stdin 能看到这句话"/);
    assert.match(r.text, /"budget":"1.25"/);
  });

  it("带 resumeSessionId ⇒ argv 里真的有 --resume 且值正确", async () => {
    const r = await runRole({ ...base, bin: BIN, resumeSessionId: "sess-上一轮" });
    assert.equal(r.ok, true);
    assert.match(r.text, /"resumed":"sess-上一轮"/);
  });

  it("不带 resumeSessionId ⇒ 不出现 --resume（空串也不算续）", async () => {
    const r = await runRole({ ...base, bin: BIN, resumeSessionId: "" });
    assert.match(r.text, /"resumed":""/);
  });

  it("二进制不存在 ⇒ ok:false 并报出错，而不是挂在那里等一个永远不会来的 close", async () => {
    const r = await runRole({ ...base, bin: join(HERE, "fixtures", "no-such-claude"), timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.notEqual(r.error, null);
    assert.match(r.error ?? "", /ENOENT|no-such-claude/);
  });

  it("is_error + 非零退出 ⇒ ok:false，但账单与会话 id 仍然保留（钱已经花了）", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "nonzero";
    try {
      const r = await runRole({ ...base, bin: BIN });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /budget exceeded/);
      assert.equal(r.costUsd, 0.042, "失败的执行也花了钱，账单不能报 0");
      assert.equal(r.sessionId, "sess-1", "会话 id 留着，下一轮才能接着谈");
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
    }
  });

  it("stdout 是垃圾 ⇒ 报「不是预期的 JSON」，不静默给一个空 text", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "garbage";
    try {
      const r = await runRole({ ...base, bin: BIN });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /不是预期的 JSON/);
      assert.equal(r.text, "", "解析不出来就不能编一段话当员工的回答");
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
    }
  });

  it("进程挂住 ⇒ 超时被杀死并报错（不能让一个角色把整个 hub 拖死）", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "hang";
    try {
      const r = await runRole({ ...base, bin: BIN, timeoutMs: 700 });
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /超时/);
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
    }
  });
});

describe("parseDecision —— 员工说了算的那一步", () => {
  const withMark = (o: unknown) => "干活过程……\n\n" + DECISION_MARK + "\n" + JSON.stringify(o);

  it("认三种决策", () => {
    assert.equal(parseDecision(withMark({ action: "handoff", to_role: "tech", summary: "好了" }))?.action, "handoff");
    assert.equal(parseDecision(withMark({ action: "blocked", summary: "要 CEO 定" }))?.action, "blocked");
    assert.equal(parseDecision(withMark({ action: "wait", summary: "还差点东西" }))?.action, "wait");
  });

  it("没有决策段 ⇒ null（调用方留在原状态，不默认往下走）", () => {
    assert.equal(parseDecision("我这边还在看代码，感觉差不多了吧"), null);
  });

  it("handoff 缺 to_role ⇒ to_role 为空串，由调度层拒绝这一手（不能凭空猜下游）", () => {
    const d = parseDecision(withMark({ action: "handoff", summary: "交出去" }));
    assert.equal(d?.to_role, "");
  });

  it("未知 action / 缺 summary ⇒ null", () => {
    assert.equal(parseDecision(withMark({ action: "approve_myself", summary: "我批我自己" })), null);
    assert.equal(parseDecision(withMark({ action: "handoff", to_role: "tech" })), null);
  });

  it("取【最后一个】决策段：员工中途举了个例子不该被当成结论", () => {
    const text =
      "格式形如 " + DECISION_MARK + " {\"action\":\"wait\",\"summary\":\"这是示例\"}\n\n" +
      "实际结论：\n" + DECISION_MARK + "\n" + JSON.stringify({ action: "handoff", to_role: "test", summary: "真的交测试" });
    const d = parseDecision(text);
    assert.equal(d?.action, "handoff");
    assert.equal(d?.to_role, "test");
  });
});
