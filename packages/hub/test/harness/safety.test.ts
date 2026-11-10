/**
 * Task 5.2 的四层防护测试（规格 §12.7 + §4.1.3 + §20.2）。
 *
 * 计划把这一组的 Test 项写成【四条绕过尝试】而不是「正常调用能通过」，这个取向是本文件的骨架：
 *   ① `--dangerously-skip-permissions` / `--no-sandbox` / `--yolo` 被拒且留痕
 *   ② 运行时不能缩短绝对禁止项
 *   ③ 沙箱档位不能被提级
 *   ④ 高风险调用会暂停；没人可问时是拒而不是放行
 * 理由一句话：**一条防线的强度由最便宜的绕过方式决定**。
 * 所以「传 `--yolo` 会被拒」这种用例在这里只算半个，另外半个是
 * `--YOLO` / `-yolo` / `--yolo=true` / `["--yolo"].concat()` 这类**形状改写**，
 * 因为真实 agent 传参的形状不由我们决定。
 *
 * ── 这个文件里有一组用例测的是【判据本身不是空的】──────────────────
 * 见 describe("判据不是自比"）。那几条不测任何新功能，它们测的是
 * 「拒绝用的两侧来自不同来源」—— 我第一版把提级判据写成
 * `sandboxTierBlock(req.sandbox, req.sandbox)`（同一个值和它自己比，永远 ok），
 * 那种代码【没有任何用例能让它红】，所以必须专门写能让它红的用例：
 * 把「授权档位」与「请求档位」给成不同的值，然后要求它必须拒。
 */
import { classifyAction } from "../../src/policy/engine.js";
import { describe, expect, it } from "vitest";
import {
  approvalBlock,
  forbiddenFlagBlock,
  isInsideWorkspace,
  needsApproval,
  normalizeFlag,
  REDACTED,
  redact,
  redactArgs,
  sandboxTierBlock,
  sandboxTierIndex,
  toolAllowed,
  toolWhitelistBlock,
  workspaceContainmentBlock,
} from "../../src/harness/safety.js";

/** 岗位书基线禁止项（§4.1.3 那两家共同的那三条）。 */
const BASELINE = ["--dangerously-skip-permissions", "--no-sandbox", "--yolo"];

describe("第 4 层：绝对禁止项（计划点名的三条 flag）", () => {
  it("三条点名 flag 逐个被拒", () => {
    for (const flag of BASELINE) {
      const v = forbiddenFlagBlock({
        baseline: BASELINE,
        effective: BASELINE,
        args: [flag],
      });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("forbidden_flag");
    }
  });

  it("改写形状照样被拒：大小写 / 单横线 / =true / 空格包围", () => {
    const shapes = [
      "--YOLO",
      "-yolo",
      "--yolo=true",
      "  --yolo  ",
      "--No-Sandbox",
      "--DANGEROUSLY-SKIP-PERMISSIONS",
    ];
    for (const s of shapes) {
      const v = forbiddenFlagBlock({ baseline: BASELINE, effective: BASELINE, args: [s] });
      expect(v.ok, "形状 " + s + " 应该被拒").toBe(false);
    }
  });

  it("--yolo=false 也被拒（故意过度拦截，理由见 normalizeFlag 的注释）", () => {
    // 这一条断言的是【行为】不是【语义】：我们不主张 `--yolo=false` 在哪家 CLI 上是开启，
    // 我们主张的是「命中禁止项就拦」，所以这条用例不依赖任何解析器行为，
    // 也就不需要（也无法）在离线状态核验三家的 flag 解析约定。
    const v = forbiddenFlagBlock({ baseline: BASELINE, effective: BASELINE, args: ["--yolo=false"] });
    expect(v.ok).toBe(false);
  });

  it("报错里点名命中的那一条，而不是只说「不合规」", () => {
    const v = forbiddenFlagBlock({ baseline: BASELINE, effective: BASELINE, args: ["--verbose", "--yolo"] });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("--yolo");
      // 命中的那一条要【只有那一条】：把整串参数都列成命中，报错就退化成「把入参打一遍」，
      // 当事人看不出该删哪个（同 target 那一格的立场：审计要指得出具体对象）。
      expect(v.detail?.["hits"]).toEqual([{ arg: "--yolo", flag: "yolo" }]);
    }
  });

  it("没有命中的参数放行（不然第 4 层等于全拒）", () => {
    expect(
      forbiddenFlagBlock({
        baseline: BASELINE,
        effective: BASELINE,
        args: ["--sandbox", "read-only", "--model", "family-x"],
      }).ok,
    ).toBe(true);
  });

  it("运行时缩短禁止项被拒，且 code 一样而 detail 里给 removed_flags", () => {
    const v = forbiddenFlagBlock({
      baseline: BASELINE,
      effective: ["--yolo"], // 把另两条丢了
      args: ["--sandbox", "read-only"],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("forbidden_flag");
      expect(v.reason).toContain("缩短");
      expect((v.detail?.["removed_flags"] as string[]).sort()).toEqual(
        ["dangerously-skip-permissions", "no-sandbox"].sort(),
      );
    }
  });

  it("缩短判据不被「长度没变短」糊过去：换名与重复项", () => {
    // 这两条是「用长度代替集合比较」这个写法独有的漏洞。
    const renamed = forbiddenFlagBlock({
      baseline: ["--yolo"],
      effective: ["--yolo-2"], // 等长，但不是同一条
      args: [],
    });
    expect(renamed.ok).toBe(false);
    const dup = forbiddenFlagBlock({
      baseline: ["--yolo"],
      effective: ["--yolo", "--yolo"], // 更长，但基线里那条其实还在（所以这条【该放行】）
      args: [],
    });
    expect(dup.ok).toBe(true);
  });

  it("运行时【追加】禁止项是允许的（§20.2 只能收窄不能放宽）", () => {
    expect(
      forbiddenFlagBlock({
        baseline: BASELINE,
        effective: [...BASELINE, "--afk"],
        args: ["--sandbox", "read-only"],
      }).ok,
    ).toBe(true);
    // 而追加的那条立刻生效 —— 收紧不是装饰：
    expect(
      forbiddenFlagBlock({ baseline: BASELINE, effective: [...BASELINE, "--afk"], args: ["--afk"] }).ok,
    ).toBe(false);
  });
});

describe("normalizeFlag：等价形状归一到同一个键", () => {
  it("一组等价写法归一后相等", () => {
    const same = ["--yolo", "--YOLO", "-yolo", "--yolo=true", "  --yolo  ", "--yolo=FALSE"];
    const keys = new Set(same.map(normalizeFlag));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("yolo");
  });

  it("无法归一的形状不返回空串（返回原串小写，宁可多拦不误放）", () => {
    expect(normalizeFlag("--")).toBe("--");
    expect(normalizeFlag("  ")).toBe("");
    // ⚠ 空串这一格值得钉住：它是「参数里一个空字符串」的归一结果，
    // 而只要没人把空串放进禁止项，它就不可能命中（禁止项的 schema 是 min(1) 且归一后不为空的形状）。
    const v = forbiddenFlagBlock({ baseline: ["--yolo"], effective: ["--yolo"], args: [""] });
    expect(v.ok).toBe(true);
  });
});

describe("第 1 层：工具白名单", () => {
  it("白名单为空 ⇒ 任何工具都不放行", () => {
    // 这份断言的方向要说清：它挡的是「一份没写 tool_permissions 的岗位书得到一个全能执行器」。
    expect(toolAllowed("Read", [], undefined)).toBe(false);
    expect(toolWhitelistBlock("Read", [], {}).ok).toBe(false);
  });

  it("全等匹配大小写敏感：授了 Edit 不等于授了 edit", () => {
    expect(toolAllowed("Edit", ["Edit"], {})).toBe(true);
    expect(toolAllowed("edit", ["Edit"], {})).toBe(false);
  });

  it("Bash(git:*) 只放行 git 前缀的参数", () => {
    const list = ["Bash(git:*)"];
    expect(toolAllowed("Bash", list, { command: "git status" })).toBe(true);
    expect(toolAllowed("Bash", list, { command: "rm -rf /" })).toBe(false);
    // 另一种写法（Claude 文档风格）也收：
    expect(toolAllowed("Bash", ["Bash(git *)"], { command: "git commit" })).toBe(true);
  });

  it("不带括号的条目放行该工具任意参数 —— 这是【已知的宽松】，所以钉一条用例", () => {
    // 若哪天有人把它「顺手收紧」成必须带括号，这条会红，而那正是我们想要的信号：
    // 那是一次语义变更（会让所有写了裸 `Bash` 的岗位书一次都调不动），不是修 bug。
    expect(toolAllowed("Bash", ["Bash"], { command: "rm -rf /" })).toBe(true);
  });

  it("前缀比的是参数的字符串形态，所以 {command:'git status'} 与 'git status' 一样", () => {
    expect(toolAllowed("Bash", ["Bash(git:*)"], "git status")).toBe(true);
    expect(toolAllowed("Bash", ["Bash(git:*)"], { command: "git status" })).toBe(true);
  });
});

describe("第 2 层：沙箱档位", () => {
  it("档位排序是 read-only < workspace-write < danger（判据直接比下标）", () => {
    expect(sandboxTierIndex("read-only")).toBeLessThan(sandboxTierIndex("workspace-write"));
    expect(sandboxTierIndex("workspace-write")).toBeLessThan(sandboxTierIndex("danger"));
  });

  it("提级被拒；同级与降档放行", () => {
    expect(sandboxTierBlock("read-only", "workspace-write").ok).toBe(false);
    expect(sandboxTierBlock("workspace-write", "danger").ok).toBe(false);
    expect(sandboxTierBlock("danger", "danger").ok).toBe(true);
    // §12.5 的缺陷修复流程正是「read-only 分析 → workspace-write 修复」两次调用，
    // 所以降档必须是放行，否则那个流程做不出来。
    expect(sandboxTierBlock("workspace-write", "read-only").ok).toBe(true);
  });

  it("两侧任一是没听过的档位 ⇒ 拒（不能替它挑一个档位）", () => {
    // 请求侧被 schema 的 enum 卡住，进不来陌生值；真正会走到这里的是**授权侧**：
    // 它来自岗位书 YAML / 路由表，是「读进来再转型」的，类型拦不住一个写错的名字。
    // 若按「未知 ⇒ danger」处理，会得到【岗位书里打错一个档位名 ⇒ 该角色拿到最高档】。
    const bad = sandboxTierBlock("workspace" as never, "read-only");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("sandbox_tier_unknown");
  });

  it("sandboxTierIndex 把未知值排到最严档（这一格只在【请求侧】才是多拦）", () => {
    expect(sandboxTierIndex("super-user")).toBe(sandboxTierIndex("danger"));
    // 上面那条测试已经说明为什么这里不能只靠下标函数：
    // 同一个「未知 ⇒ 最严」在授权侧的语义正好反了（最严 = 什么都不算提级 = 放行）。
    expect(sandboxTierIndex("read-only")).toBe(0);
  });
});

describe("工作区越界", () => {
  it("/repo-evil 不在 /repo 里面（第一版就是在这里判错的）", () => {
    expect(isInsideWorkspace("/repo", "/repo-evil/x.ts")).toBe(false);
    expect(isInsideWorkspace("/repo", "/repo/x.ts")).toBe(true);
    expect(isInsideWorkspace("/repo", "/repo")).toBe(true);
    expect(isInsideWorkspace("/repo/", "/repo/x")).toBe(true);
  });

  it(".. 归一之后再比：/repo/../etc/passwd 是越界", () => {
    expect(isInsideWorkspace("/repo", "/repo/../etc/passwd")).toBe(false);
    expect(isInsideWorkspace("/repo", "/repo/a/../b/x.ts")).toBe(true);
  });

  it("相对路径不会被误判成在工作区内", () => {
    expect(isInsideWorkspace("/repo", "etc/passwd")).toBe(false);
  });

  it("越界的报错点出两侧路径（不然当事人不知道该改哪儿）", () => {
    const v = workspaceContainmentBlock("/repo", "/etc/passwd");
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("workspace_escape");
      expect(v.reason).toContain("/repo");
      expect(v.reason).toContain("/etc/passwd");
    }
  });
});

describe("第 3 层：要不要停下来问人", () => {
  it("不可逆的子串 ⇒ 要审批", () => {
    expect(needsApproval({ tool: "Bash", args: { command: "git push --force origin main" } })).toBe(true);
    expect(needsApproval({ tool: "Bash", args: { command: "rm -rf build" } })).toBe(true);
    expect(needsApproval({ tool: "Bash", args: "部署到生产" })).toBe(true);
  });

  it("只读的子串 ⇒ 不审批", () => {
    expect(needsApproval({ tool: "Bash", args: { command: "git status" } })).toBe(false);
    expect(needsApproval({ tool: "Bash", args: { command: "pnpm test" } })).toBe(false);
  });

  it("⭐ 认不出的工具参数形状 ⇒ 默认不可逆 ⇒ 一律要审批", () => {
    // 这条不是 bug 的自白，是【复用 §9.1 那张表的结果被钉住】：
    // classifyAction 的口径是「未知动作默认 irreversible」，而 harness 传进来的是
    // 机器形状（`{"path":"/repo/x.ts"}`），那张表里全是人类语言子串，所以多半不命中 ⇒ 默认档。
    // 方向是对的（宁可多问），但它意味着**一期上线前审批队列会一条工具调用一张卡**。
    // 降噪的正确改法是把 harness 的工具名映射进 §9.1 那张表共用的 KIND_TIERS
    // （Read→read_file、Write→edit_file…），而【不是】在 safety 里再写一张表 ——
    // 两张表的必然结果是「同一次调用两处判成不同档」（0020 里记过同一类错）。
    expect(needsApproval({ tool: "Read", args: { path: "/repo/x.ts" } })).toBe(true);
    expect(needsApproval({ tool: "Write", args: { path: "/repo/x.ts" } })).toBe(true);
  });

  it("⭐ 同一次调用在 §9.1 与 §12.7 两处判成同一档（两张表同源）", () => {
    // 「safety 不另写一份不可逆表」这个立场的机器证明：**同一句话**分别喂给
    // policy/engine 的 classifyAction 与这里的 needsApproval，答案必须一致。
    // 上面那条只断言了 needsApproval 一侧，那是**同义反复**（0013 §那条「零判别力的测试」
    // 与 0016 记的同一类错：断言与被测函数其实是同一句话），所以这里必须引入第二个函数。
    const sentences = [
      "git push --force origin main",
      "git status",
      "把改动 merge to main",
      "部署到生产",
      "pnpm test",
      "把这段 refactor 一下",
      "付款给供应商",
      "完全不认识的一句胡话",
    ];
    for (const cmd of sentences) {
      expect(
        needsApproval({ tool: "Bash", args: { command: cmd } }),
        "两侧对 [" + cmd + "] 判得不一样 ⇒ 两张表已经分叉：" +
          JSON.stringify({
            harness: needsApproval({ tool: "Bash", args: { command: cmd } }),
            policy: classifyAction({ kind: "Bash", detail: cmd }) === "irreversible",
          }),
      ).toBe(classifyAction({ kind: "Bash", detail: cmd }) === "irreversible");
    }
  });
});

describe("第 3 层：审批本身", () => {
  it("没人可问 ⇒ 拒，而且 code 是 handler_missing 而不是 denied", () => {
    // 两个码必须分开：一个是【缺陷】（装配漏传参数），一个是【正常业务结果】（有人审过说不了）。
    // 混成一个码的话，「审批回调没接上」这件事在审计统计里与「CEO 拒了」同形。
    return approvalBlock({ tool: "Bash", args: {}, reason: "r" }, undefined).then((v) => {
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("approval_handler_missing");
    });
  });

  it("批了 ⇒ 放行，且把 decidedBy 带出来（§12.7 第四层要「谁批准了什么」）", async () => {
    const v = await approvalBlock(
      { tool: "Bash", args: {}, reason: "r" },
      () => ({ approved: true, decidedBy: "ceo" }),
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.decidedBy).toBe("ceo");
  });

  it("批了但没署名 ⇒ decidedBy=null，而不是编一个名字", async () => {
    const v = await approvalBlock({ tool: "Bash", args: {}, reason: "r" }, () => ({ approved: true }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.decidedBy).toBeNull();
  });

  it("拒了 ⇒ approval_denied，备注进 detail 与 reason", async () => {
    const v = await approvalBlock(
      { tool: "Bash", args: {}, reason: "因为要推主线" },
      () => ({ approved: false, decidedBy: "ceo", note: "等测试" }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe("approval_denied");
      expect(v.decidedBy).toBe("ceo");
      expect(v.reason).toContain("等测试");
      expect(v.reason).toContain("因为要推主线");
    }
  });

  it("审批回调抛错 ⇒ 往上冒，不吞成「拒」", async () => {
    // 吞成拒的话，「审批系统挂了」与「有人拒了」在审计里同形，
    // 而前者意味着整条流水线停摆需要人去看，后者意味着一次正常的业务往返。
    await expect(
      approvalBlock({ tool: "Bash", args: {}, reason: "r" }, () => {
        throw new Error("审批存储不可用");
      }),
    ).rejects.toThrow("审批存储不可用");
  });
});

describe("脱敏", () => {
  it("按键名脱敏，且【不改入参】", () => {
    const src = { command: "x", api_key: "sk-live-123", nested: { token: "t", safe: "ok" } };
    const out = redact(src) as Record<string, unknown>;
    const nested = out["nested"] as Record<string, unknown>;
    expect(out["api_key"]).toBe(REDACTED);
    expect(nested["token"]).toBe(REDACTED);
    expect(nested["safe"]).toBe("ok"); // 非密钥键必须【原样留着】，否则审计等于没记
    expect(out["command"]).toBe("x");
    // 入参必须还是原样：它来自适配器的事件流，改了会污染适配器后续要用的那份数据。
    expect(src.api_key).toBe("sk-live-123");
  });

  it("命令行形状按位置脱敏：--token X 与 --token=X 两种", () => {
    expect(redactArgs(["--model", "x", "--token", "sk-live-1"])).toEqual([
      "--model",
      "x",
      "--token",
      REDACTED,
    ]);
    expect(redactArgs(["--token=sk-live-1"])).toEqual(["--token=" + REDACTED]);
  });

  it("⭐ 密钥【不会】原样进审计：数组形状用 redactArgs 而不是 redact", () => {
    // 这条用例存在的理由是我第一版的实际错法：对 string[] 用 redact ——
    // redact 只认对象键名，对数组里的字符串是**原样返回**，
    // 于是得到一条「看起来调过脱敏而实际原样入库」的密钥，而 events 是 append-only。
    const args = ["--token", "sk-live-1"];
    expect(redact(args)).toEqual(args); // 证明用错函数确实是静默失效
    expect(redactArgs(args)).not.toContain("sk-live-1");
  });

  it("循环引用不抛错（落一条被打码的占位，胜过这次调用没留痕）", () => {
    const a: Record<string, unknown> = { safe: 1 };
    a["self"] = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });
});
