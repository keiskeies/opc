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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { RoleRunResult } from "../../src/engine/claude.js";
import {
  DECISION_MARK,
  parseDecision,
  retryableWithoutCost,
  runRole,
} from "../../src/engine/claude.js";

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

  /**
   * ⚠ 后三格（started / spawnErrno / retryableWithoutCost）是 round305 补的，
   * 它们是 Task 6.1 那条判据在【真跨进程】这一侧唯一的凭据。
   *
   * turn-retry.test.ts 那一族用的是注入的假 runRole —— 它判的是「给定
   * started:false + errno=X，放不放行」，而【真 spawn 到底给出哪个 errno】它一次都没判。
   * 于是这条链断在中间：判据绿 + 装配绿，而「真机上 started 真的是 false 吗」
   * 这件事只有这一发知道答案。少了它，哪天 node 改了行为（比如把 ENOENT 挪到
   * close 之后发），`started` 恒真 ⇒ 重试层【静默】退化成不重试，而全仓不红。
   */
  it("二进制不存在 ⇒ ok:false 并报出错，而不是挂在那里等一个永远不会来的 close", async () => {
    const r = await runRole({
      ...base,
      bin: join(HERE, "fixtures", "no-such-claude"),
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).not.toBe(null);
    expect(r.error ?? "").toMatch(/ENOENT|no-such-claude/);
    expect(
      r.started,
      "进程从未存在 ⇒ started 必须是 false，否则重试层永不介入",
    ).toBe(false);
    expect(r.spawnErrno).toBe("ENOENT");
    // 这一句是本文件与 round305 那句「今天真机上一条重试都不放行」的接点：
    // 本机【唯一造得出来】的 started:false 形状，判据必须把它挡在门外。
    expect(retryableWithoutCost(r)).toBe(false);
  });

  /**
   * bin 指着一个【目录】：实测（node v24 / win32）走的也是异步 ENOENT，不是 EISDIR。
   *
   * 断言里【不钉 errno 名】而钉「非空 + 不放行」：目录的 errno 是平台给的
   * （Linux 上常见 EACCES），钉 ENOENT 会把一条本机实测抄成跨平台事实。
   * 真正要守的是判据的结论，而它对这三型的答案都是「不重试」。
   */
  it("bin 指着一个目录 ⇒ started:false 且 retryableWithoutCost 为 false", async () => {
    const r = await runRole({ ...base, bin: HERE, timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(r.started).toBe(false);
    // 非空这一格是判据的输入本身：空串在瞬时表上取不到任何名字 ⇒ 恒不重试，
    // 而「errno 没带出来」与「errno 是空」在假账里会长得一模一样。
    expect(r.spawnErrno).not.toBe("");
    expect(retryableWithoutCost(r)).toBe(false);
  });

  /**
   * bin 指着一个【普通文件】：本机实测 node 从 spawn() 【同步】抛 EFTYPE，
   * 被 Promise 构造器吞成 rejection ⇒ runRole 自己 reject，而不是返回 ok:false。
   *
   * 这一发钉的是台账 round305 §④ 登记的那个【残留】，方向是「别把它抹平」：
   * turn-retry.test.ts 里那发 reject 用的是手搓的 Error，证明的是外壳原样抛回，
   * 不是「真机器上真有这样的形状」。这里补上那半格。
   *
   * ⚠ 平台分支是【读数不同、结论相同】而不是「非 win32 就跳过」：
   *   win32  ⇒ reject（同步抛 EFTYPE）
   *   其他   ⇒ 大概率返回 started:false + EACCES/ENOEXEC 一类（都【不在】瞬时表上）
   * 两支都必须走到「不放行重试」，所以这一发在任何平台上都判了东西；
   * 哪天平台改了行为而走进第三支，它红在【两个都不成立】那一格，不会静默。
   */
  it("bin 指着一个普通文件 ⇒ 响亮的崩溃，或被记录的失败轮；两种读数都不放行重试", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opc-notexec-"));
    const file = join(dir, "not-an-executable.txt");
    writeFileSync(file, "not an executable\n");
    /** 两种可能的读数，各带自己要判的那一格（不用 `| null` + cast：那要写两处断言非空）。 */
    type Outcome =
      | { readonly via: "rejected"; readonly code: string }
      | { readonly via: "returned"; readonly r: RoleRunResult };
    try {
      const outcome: Outcome = await runRole({
        ...base,
        bin: file,
        timeoutMs: 5000,
      })
        .then((r): Outcome => ({ via: "returned", r }))
        .catch(
          (e: unknown): Outcome => ({
            via: "rejected",
            code: String((e as { code?: unknown })["code"]),
          }),
        );
      if (outcome.via === "rejected") {
        // 这一支【连 started 都拿不到】，所以判据结构上无法介入 ——
        // 这正是「装配错 bin」今天仍然响亮崩溃的原因。
        if (process.platform === "win32") {
          expect(
            outcome.code,
            "本机实测是 EFTYPE；换了名字说明 node 的形状变了，要重读 round305 §④",
          ).toBe("EFTYPE");
        } else {
          // 非 win32 没有实测过 ⇒ 只钉「带得出 errno 名」，不把本机读数抄成跨平台事实。
          expect(outcome.code).not.toBe("undefined");
        }
        return;
      }
      expect(outcome.r.ok).toBe(false);
      expect(outcome.r.started).toBe(false);
      expect(outcome.r.spawnErrno).not.toBe("");
      expect(retryableWithoutCost(outcome.r)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  /**
   * ── 下面两发是【今天唯一那条安全边界】的行为探针 ──────────────────────
   *
   * `--permission-mode plan` 是生产路线上今天【唯一】生效的安全边界
   * （本文件头与 engine/claude.ts 文件头都这么写）。round277 之前，守着这句话的
   * 只有「argv 里有这两个 token」那类回显断言 —— 而**回显证明的是参数传到了，
   * 不是边界挡住了什么**。这一格补的是那另一半：让桩在拿不到 plan 时【真的写盘】，
   * 于是「没写」这个读数第一次有了内容。
   *
   * ⚠ 边界本身仍然不可测：本机装不上真的 CLI（复算：
   * `require("@anthropic-ai/claude-agent-sdk/package.json")` 在根与 packages/hub 两处都取不到），
   * 离线拿不到「真 CLI 的 plan 模式到底会不会挡住写」。桩这里模拟的是【CLI 的语义】，
   * 所以这两发的标题写的是「适配器有没有把 plan 交出去」，不是「plan 挡住了写文件」。
   * 把这句话写在测试里而不是省掉，是因为下一读到这里的人会以为它验的是后者。
   */
  it("把 plan 交出去 ⇒ 对面那一个进程一次都没有写工作区", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opc-plan-probe-"));
    const target = join(dir, "wrote.txt");
    process.env["FAKE_CLAUDE_MODE"] = "write";
    process.env["FAKE_CLAUDE_WRITE_TO"] = target;
    try {
      const r = await runRole({ ...base, bin: BIN, cwd: dir });
      expect(r.ok, "error=" + String(r.error)).toBe(true);
      // 先钉「plan 真的到了 argv」，再钉「因此没写」。只钉后者的话，
      // 桩那侧任何一处坏掉（路径写错、权限不够、mode 没生效）都会让它【绿得毫无意义】。
      expect(r.text).toMatch(/"permissionMode":"plan"/);
      expect(r.text).toMatch(/"wrote":"no"/);
      expect(
        existsSync(target),
        "员工的一轮真的写出了文件 —— 那条被叫做安全边界的参数没起作用",
      ).toBe(false);
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
      delete process.env["FAKE_CLAUDE_WRITE_TO"];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 正向对照，也是这一组里【唯一证明写探针会写】的一发。
   *
   * 上面那发「文件不在」有五种成因：边界起作用 / 路径写错 / 权限不够 / 桩没实现 /
   * 写到了别处。前四种里只有第一种是我想验的，而**不配对照就分不出这五种**。
   * 所以这一发让桩【无视 argv 里那个 plan】、当作没给 ⇒ 必须真的写出文件。
   * 它红了不是生产路线坏了，是探针坏了 —— 那也是一种必须当场知道的事。
   */
  it("正向对照：桩拿不到 plan ⇒ 同一条路径真的写出了文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opc-plan-probe-"));
    const target = join(dir, "wrote.txt");
    process.env["FAKE_CLAUDE_MODE"] = "write";
    process.env["FAKE_CLAUDE_WRITE_TO"] = target;
    process.env["FAKE_CLAUDE_NO_PLAN"] = "1";
    try {
      const r = await runRole({ ...base, bin: BIN, cwd: dir });
      expect(r.ok).toBe(true);
      // 这一发的 argv 上【照样有】plan —— 被绕过的是桩，不是适配器。
      // 所以「文件写出了」的原因只能是没有 plan 模式挡着，而不是「没传参数」。
      expect(r.text).toMatch(/"permissionMode":"plan"/);
      expect(r.text).toMatch(/"wrote":"yes"/);
      expect(existsSync(target), "写探针不写了 ⇒ 上一发变成一句空话").toBe(
        true,
      );
    } finally {
      delete process.env["FAKE_CLAUDE_MODE"];
      delete process.env["FAKE_CLAUDE_WRITE_TO"];
      delete process.env["FAKE_CLAUDE_NO_PLAN"];
      rmSync(dir, { recursive: true, force: true });
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
