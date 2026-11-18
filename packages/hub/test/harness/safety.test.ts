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

  it("工作区【自己】带 .. / . / 尾斜杠 ⇒ 先归一再比（旧实现本来就有的一半，也钉住）", () => {
    // round303 补这一发的理由不是「想多测一条」：新加的格③ 只改了【target 侧的拆法】，
    // 而 M4 变异（只归一 target、不归一 workspace）证明【原来这一半根本没被测到】——
    // 一个恒过的判式就是一句装饰。workspace 来自配置/路由表，形状是
    // `/work/runs/../repo` 这种完全正常（拼接出来的），所以「根要归一」是真需求。
    expect(isInsideWorkspace("/repo/a/../b", "/repo/b/x.ts")).toBe(true);
    expect(isInsideWorkspace("/repo/./ws", "/repo/ws/x.ts")).toBe(true);
    expect(isInsideWorkspace("/repo/ws//", "/repo/ws/x.ts")).toBe(true);
    // 反向：根归一之后仍然挡得住越界（不许为了「根要归一」把 target 那侧放松）。
    expect(isInsideWorkspace("/repo/a/../b", "/repo/other/x.ts")).toBe(false);
  });

  /* ═════ round303：分隔符不统一 ⇒ 越界被放行（实测过危害方向是 fail-OPEN）═════
   * 本轮用真函数量过（.workbuddy/probe303-direction.probe.ts）：旧写法只按 `/` 拆，
   * 于是【混合形状】那一型是【放行】的 —— `x\..\..\secret\k.txt` 在只认 / 的拆法里
   * 是【一个】文件名段，`..` 从不被看见，前缀匹配就过了。Windows 上 OS 认 `\` 为
   * 分隔符 ⇒ 同一串字节的两个读法一个在里面一个在外面，而旧代码只读其中一个。
   *
   * ⚠ 可达性要说清楚，别把下面几发读成「现网可打」：`target` 确实是工具调用参数里的
   *   原样字符串（gateway 的 pathArg，上游零归一化），但 safety.ts 今天【零生产 import】
   *   （文件头横幅 + dead-modules 的 claimSites 盯着那句）。所以这几发钉的是
   *   【接线即成真】的那扇门 —— 判据先修对，接线那天它才是对的。
   *
   * ⭐ 判据取两种读法的【交集】⇒ 只要有一种读法说在外面就拒。这一族的取舍、
   *   以及「本轮到底改了哪几对」的实测对照，写在下面那几发里（其中两发是
   *   【被量纠正过的假话】，那两次改口也留在原地 —— 它们比结论更有信息量）。 */
  it("⭐ 混合形状：`x\\..\\..` 那种链条在 Windows 读法下越界 ⇒ 必须拒（旧写法放行）", () => {
    expect(isInsideWorkspace("/repo/ws", "/repo/ws/x\\..\\..\\secret\\k.txt")).toBe(false);
    expect(isInsideWorkspace("/repo/ws", "/repo/ws/a\\..\\..\\b.ts")).toBe(false);
    // 同一条链嵌得更深也一样：只要有一种读法跳出根，就不算在里面。
    expect(isInsideWorkspace("/repo/ws", "/repo/ws/deep/dir\\..\\..\\..\\etc\\passwd")).toBe(false);
    // 根带末尾斜杠也一样（那一支走的是 startsWith 那条路，不是 p === root）。
    // ⚠ 这一对【旧口径也拒】（旧口径按 / 拆时 `ws\..\x` 是一个段）——它不属于本轮
    //   改了行为的 3 对，写在这里是为了钉住「带尾斜杠的根」这条分支没有回归。
    expect(isInsideWorkspace("/repo/ws/", "/repo/ws\\..\\x")).toBe(false);
  });

  it("⭐ 反向：两种读法【都】说在里面 ⇒ 不许因为加了 Windows 读法而误伤", () => {
    // 这一发是上面那组的【方向对照】：只判「越界要拒」可以把判据写成恒拒也过。
    // 少了这几行，把 isInsideWorkspace 改成 `return false` 全场照样绿。
    expect(isInsideWorkspace("/repo", "/repo/a/b.ts")).toBe(true);
    expect(isInsideWorkspace("/repo", "/repo/x.ts")).toBe(true);
    expect(isInsideWorkspace("/repo", "/repo")).toBe(true);
    // ⚠ 下面这几行是【实测纠正了我对代价的想象】：我一开始写的是「文件名里真带 \
    //   一律被拒」，探针量出来不是那样 —— 只要两种读法【都】落在根里就照旧放行。
    //   一个假想的代价写进测试，等于用测试替我编一个不存在的取舍（round300 那一族）。
    expect(isInsideWorkspace("/repo", "/repo/weird\\name.ts")).toBe(true);
    expect(isInsideWorkspace("/repo/ws", "/repo/ws/a\\b\\c.ts")).toBe(true);
    expect(isInsideWorkspace("/repo/ws", "/repo/ws/x\\..\\y")).toBe(true);
    expect(isInsideWorkspace("/repo/ws", "/repo/ws/only\\backslash")).toBe(true);
  });

  it("两侧都是反斜杠形状：今天到不了这里（gateway 先拦非 / 开头的 workspace），钉住是【拒】", () => {
    // 这一发钉的不是「正确行为」而是【已知的 fail-closed 一侧】：
    // workspace 不以 / 开头 ⇒ POSIX 读法把整串当【一个相对段】⇒ 与 target 不同解 ⇒ 拒。
    // gateway.ts 那条「workspace 必须以 / 开头」在前，所以这一型在产线上不可达；
    // 写在这里是为了让下一个人知道【它现在拒】，而不是以为它能工作。
    expect(isInsideWorkspace("D:\\repo\\ws", "D:\\repo\\ws\\packages\\a\\file.ts")).toBe(false);
    // 而斜杠写的 Windows 盘符路径【能】正常工作（两侧同形状、同读法）：
    expect(isInsideWorkspace("D:/repo/ws", "D:/repo/ws/packages/a/file.ts")).toBe(true);
    expect(isInsideWorkspace("D:/repo/ws", "D:/repo/ws/../secret/k.txt")).toBe(false);
  });

  it("交集口径的【代价】实测为零：根边界后紧跟 `\\` 那一型，旧口径本来就拒", () => {
    // 这一发【本轮改过两次】，两次都是被量纠正的：
    //  ⑴ 我先写成「文件名里真带 \ ⇒ 一律被拒」，探针证否（见上面反向对照那一发）；
    //  ⑵ 我再写成「这是本轮多拦的那一型」——那是【出处的假话】。
    // .workbuddy/probe303-compare.probe.ts 把【旧字节】（`git show HEAD:` 切出来的
    // probe303-old-safety.ts）与新字节放在同一张表上对：21 对里只有 3 对变了，
    // 全是【混合形状逃逸】那一族；这一对【旧也拒、新也拒】⇒ 本轮【没有多拦任何东西】。
    // 为什么交集不会多拦：交集 ⊆ 旧（POSIX）那一侧，而 POSIX 本来就把 `ws\a` 当成
    // 【一个叫 ws\a 的文件名】⇒ 它不在 /repo/ws/ 下面 ⇒ 旧口径同样拒。
    // ⇒ 「为了安全必须牺牲一批合法路径」这句话，在这一格上【量出来是假的】。
    expect(isInsideWorkspace("/repo/ws", "/repo/ws\\a")).toBe(false);
    // 工作区根自己带 `\` 时两种读法同解 ⇒ 照旧放行：
    expect(isInsideWorkspace("/repo/w\\s", "/repo/w\\s/ok.ts")).toBe(true);
  });

  it("⭐ 本轮改了行为的那几对，成对钉住（对照 .workbuddy/probe303-compare.txt）", () => {
    // 分母来源：新旧对照表实测 21 对里【恰好 3 对】变了，全是下面这三行。
    // 为什么把「只改了这几对」钉住：一条安全判据的改动，最需要知道的不是
    // 「它现在拦什么」，而是【它比昨天多拦了什么、少拦了什么】——
    // 少拦一条就是回归。把三对写死，下次有人再动 normalizeAbs 时这里会红。
    const ESCAPES: [string, string][] = [
      ["/repo/ws", "/repo/ws/x\\..\\..\\secret\\k.txt"],
      ["/repo/ws", "/repo/ws/a\\..\\..\\b.ts"],
      ["/repo/ws", "/repo/ws/deep/dir\\..\\..\\..\\etc\\passwd"],
    ];
    for (const [ws, t] of ESCAPES) {
      expect(isInsideWorkspace(ws, t), ws + " + " + t).toBe(false);
      const v = workspaceContainmentBlock(ws, t);
      expect(v.ok, ws + " + " + t + " 被放行 ⇒ 越界").toBe(false);
      if (!v.ok) expect(v.code).toBe("workspace_escape");
    }
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

  it("⭐ harness 的工具名已经进那张表（0021 §10 第 2 条那条已知坏味道的修法）", () => {
    // 这一条**被改写过一次**，改写的理由要留在这儿：
    // Task 5.2 那一版钉的是「Read/Write 传机器形状参数 ⇒ 判成默认不可逆 ⇒ 一律要审批」，
    // 并把「修它需要一份 harness 工具名表，而那份表该由路由（Task 5.3）与岗位书一起定」
    // 写在注释里。Task 5.3 就是那一次，所以断言翻过来了 ——
    // 这不是「测试碍事所以改掉」，而是**被钉住的那个前提已经不再成立**（0021 §9 第 12 条
    // 讲的是同一件事：先确认新行为更对，再改断言，并把理由留在测试里）。
    //
    // 翻过来的代价说清楚：光看名字的降噪放掉了一批审批，兜住它的只剩
    // 「参数文本过那三张模式表」+「白名单」+「工作区越界」。所以这里同时钉住
    // **仍然是 true 的那三例** —— 它们是这次降噪的边界。
    expect(needsApproval({ tool: "Read", args: { path: "/repo/x.ts" } })).toBe(false);
    expect(needsApproval({ tool: "Write", args: { path: "/repo/x.ts" } })).toBe(false);
    // 边界 1：名字降噪**盖不住参数里的不可逆描述**（这条是那次加表的风险兜底）。
    expect(
      needsApproval({ tool: "Write", args: { path: "/repo/x.ts", new_string: "改完直接发布上线" } }),
    ).toBe(true);
    // 边界 2：**没被列进来的**工具名照旧默认不可逆（表不是白名单，漏名字只会多问）。
    expect(needsApproval({ tool: "Bash", args: { command: "do Something Weird" } })).toBe(true);
    expect(needsApproval({ tool: "SomeVendorTool", args: { x: 1 } })).toBe(true);
  });

  it("⭐ 那张表**只有这一份**（safety 与 policy 两处必须同判）", () => {
    // 加表的这一轮最容易犯的错是「在 safety 里加一份 harness 表」，
    // 于是同一次调用两处判成不同档（0020 记过同一类错）。这条用例是那个错误的机器防线：
    // 它不测任何新逻辑，只要求两侧对**同一批工具名**给出同一个答案。
    const names = ["Read", "Write", "Edit", "Grep", "Glob", "WebSearch", "WebFetch", "MultiEdit"];
    for (const tool of names) {
      const args = { path: "/repo/x.ts" };
      expect(
        needsApproval({ tool, args }),
        "工具 [" +
          tool +
          "] 在 safety 与 policy 两处判得不一样 ⇒ 表已经分叉（safety 里长出了第二份表）",
      ).toBe(classifyAction({ kind: tool, detail: JSON.stringify(args) }) === "irreversible");
    }
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
