/**
 * 监听边界（src/http/bind.ts，计划 Task 4.1 第一半）。
 *
 * ── 这个文件在证什么 ────────────────────────────────────────────────
 * 一句话：**在一次性 token 通道接上之前，拿不到一个非回环的 socket。**
 * 「默认值是 127.0.0.1」是这份实现里最不重要的一条性质 —— 默认值会被改。
 * 所以这里的用例分成三档，缺一档都会让一条偷懒的实现通过：
 *   ① 默认与显式回环：能用、不报警、与 token 通道接没接无关；
 *   ② 非回环：通道没接 ⇒ 【拒绝】（不是警告、不是退回回环）；接上 ⇒ 放行且必带告警；
 *   ③ 形状与方向：名字被拒、垃圾串被拒、127/8 整段算回环、IPv4-mapped 算回环，
 *      以及最要紧的一条 —— **伪造一个 BindDecision 需要付出可见的代价**。
 *
 * ── 为什么不写「连一次非回环地址试试」那种用例 ──────────────────────────
 * 那是本机最容易写出【恒真】的一类用例：拿 os.networkInterfaces() 找一个非回环 IPv4
 * 去连一个只绑了回环的端口，ECONNREFUSED 是【操作系统】给的，
 * 不是我这个模块给的 —— 把 bind.ts 整个删掉它照样绿。
 * （这不是猜测：本文件第一版就写了这么一条，跑完去做变异时才发现它杀不掉，
 *   见 0026 §7.1 那个形状的第四次。所以这里改成【判据层】的断言 +
 *   一条真 listen 的【形状】断言，两条都能被变异杀掉。）
 */
import { describe, expect, it } from "vitest";
import {
  BindDecision,
  bindFailureIsFatal,
  FATAL_BIND_REASON,
  isIPv4Literal,
  isIPv6Literal,
  isLoopbackAddress,
  LOOPBACK_HOST,
  LOOPBACK_HOST_V6,
  type BindRejection,
} from "../../src/http/bind.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIND_SRC = readFileSync(join(HUB, "src", "http", "bind.ts"), "utf8");
const SERVER_SRC = readFileSync(join(HUB, "src", "http", "server.ts"), "utf8");

/** 取拒绝分支。不写成 as —— 写错分支时这里就该红。 */
function rej(o: ReturnType<typeof BindDecision.resolve>): BindRejection {
  if (o.ok === true) throw new Error("期望被拒，实到放行：" + o.decision.host);
  return o;
}
function dec(o: ReturnType<typeof BindDecision.resolve>): BindDecision {
  if (o.ok !== true) throw new Error("期望放行，实到拒绝：" + o.reason + " / " + o.message);
  return o.decision;
}

describe("① 默认与显式回环", () => {
  it("⭐ 什么都不传 ⇒ 127.0.0.1，且【不要求】token 通道", () => {
    // 「不要求」这一半是承重的：若默认路径也去查 remoteApprovalsWired，
    // 一个 Phase 4 的可选能力会变成 Phase 2 的启动依赖 —— 现在的桌面端根本起不来。
    const d = dec(BindDecision.resolve({ remoteApprovalsWired: false }));
    expect(d.host).toBe(LOOPBACK_HOST);
    expect(d.exposure).toBe("loopback");
    expect(d.warning).toBeNull();
  });

  it("空串与纯空白同于没传，而不是「绑到所有接口」", () => {
    // 空 host 交给 listen() 是最【暴露】的取值，而它在配置里长得像【没填】。
    // 这一发钉的就是这个歧义被定成哪一边。
    for (const raw of ["", "   "]) {
      const d = dec(BindDecision.resolve({ requested: raw, remoteApprovalsWired: false }));
      expect(d.host, JSON.stringify(raw)).toBe(LOOPBACK_HOST);
    }
  });

  it("显式 --bind 127.0.0.1 与没传完全同形（少一格会让人以为显式写法有额外含义）", () => {
    // toEqual 而不是 toBe：两个分支各 new 一个对象，恒不等，那条断言会变成恒假；
    // 反过来若用 toBe 写它就一直红，然后被人改成 toEqual —— 而改的过程中很容易顺手
    // 把【要比什么】也改掉。这里要比的是三个字段的取值。
    expect(
      dec(BindDecision.resolve({ requested: LOOPBACK_HOST, remoteApprovalsWired: false })),
    ).toEqual(dec(BindDecision.resolve({ remoteApprovalsWired: false })));
  });

  it("127.0.0.2 也是回环：整段 127/8，不只是 .1", () => {
    const d = dec(BindDecision.resolve({ requested: "127.0.0.2", remoteApprovalsWired: false }));
    expect(d.exposure).toBe("loopback");
  });

  it("⭐ ::1 放行但【必须带一句提示】：它连不上 127.0.0.1 的客户端", () => {
    const d = dec(BindDecision.resolve({ requested: LOOPBACK_HOST_V6, remoteApprovalsWired: false }));
    expect(d.exposure).toBe("loopback");
    // 提示非空是【判据】不是文案偏好：绑 ::1 而桌面端连 v4 的症状是「服务起来了但连不上」，
    // 一句不说会让人去查防火墙。
    expect(d.warning).not.toBeNull();
    expect(String(d.warning)).toMatch(/127\.0\.0\.1/u);
  });
});

describe("② 非回环：通道没接 ⇒ 拒绝；接上 ⇒ 放行且告警", () => {
  it("⭐ 0.0.0.0 而 token 通道没接 ⇒ 拒绝，且这一档是【致命】的（不许退回回环）", () => {
    const r = rej(BindDecision.resolve({ requested: "0.0.0.0", remoteApprovalsWired: false }));
    expect(r.reason).toBe(FATAL_BIND_REASON);
    expect(bindFailureIsFatal(r)).toBe(true);
    // 报错必须给【出路】。只说「不行」的报错，下一步就是有人加 --force。
    expect(r.message).toMatch(/tokens\.ts/u);
    expect(r.message).toMatch(/--bind 127\.0\.0\.1/u);
  });

  it("局域网具体地址同样被拒（不是只挡 0.0.0.0 这一个写法）", () => {
    for (const host of ["192.168.115.50", "10.0.0.5", "172.16.9.9", "::"]) {
      const r = rej(BindDecision.resolve({ requested: host, remoteApprovalsWired: false }));
      expect(r.reason, host).toBe(FATAL_BIND_REASON);
    }
  });

  it("⭐ 通道接上 ⇒ 放行，且【一定】带告警（放行而不说，等于偷偷放宽）", () => {
    const d = dec(BindDecision.resolve({ requested: "0.0.0.0", remoteApprovalsWired: true }));
    expect(d.exposure).toBe("lan");
    expect(d.host).toBe("0.0.0.0");
    expect(d.warning).not.toBeNull();
    expect(String(d.warning)).toMatch(/不可逆/u); // §11.4 那条限制要随告警一起说
  });

  it("放行的那一支仍不带任何「绕过 token」的口子：exposure 只有两个取值", () => {
    // 这一发看着像恒真（类型就只有两个取值），它钉的是【有人加了第三种取值而没加用例】：
    // 第三个取值（比如 "custom"）一旦存在，所有按 exposure 分档的下游都会走进 default 分支。
    const kinds = new Set<string>();
    for (const [host, wired] of [
      [undefined, false],
      [LOOPBACK_HOST, false],
      ["0.0.0.0", true],
    ] as const) {
      kinds.add(dec(BindDecision.resolve({ requested: host, remoteApprovalsWired: wired })).exposure);
    }
    expect([...kinds].sort()).toEqual(["lan", "loopback"]);
  });
});

describe("③ 形状与方向", () => {
  it("⭐ localhost 被拒：安全边界不能由一个可被 /etc/hosts 改掉的名字指认", () => {
    const r = rej(BindDecision.resolve({ requested: "localhost", remoteApprovalsWired: true }));
    expect(r.reason).toBe("not_an_ip_literal");
    expect(bindFailureIsFatal(r)).toBe(false); // 打字错误不该让进程起不来
    expect(r.message).toMatch(/\/etc\/hosts|名字解析/u);
  });

  it("其他主机名与纯数字垃圾同样被拒（判据是「不是 IP」，不是「含字母」）", () => {
    for (const raw of ["en0", "mybox.local", "999999", "1.2.3", "256.1.1.1", "-1"]) {
      const r = rej(BindDecision.resolve({ requested: raw, remoteApprovalsWired: true }));
      expect(r.reason, raw).toBe("not_an_ip_literal");
    }
  });

  it("名字那一档【不许】被当成致命：那是打字错误，退回回环比拒绝启动对用户更对", () => {
    const r = rej(BindDecision.resolve({ requested: "loclahost", remoteApprovalsWired: false }));
    expect(bindFailureIsFatal(r)).toBe(false);
  });

  it("isLoopbackAddress：IPv4-mapped 与全零形式都算回环", () => {
    for (const a of ["::ffff:127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "127.9.9.9", " 127.0.0.1 "]) {
      expect(isLoopbackAddress(a), a).toBe(true);
    }
    for (const a of ["192.168.1.1", "0.0.0.0", "::", "localhost", "127.0.0.1.example.com", ""]) {
      expect(isLoopbackAddress(a), a).toBe(false);
    }
  });

  it("⭐ 「127.0.0.1.example.com」必须是 false：判 127 之前先证它是合法四段", () => {
    // 一条 startsWith("127.") 的偷懒实现会让这一发过掉上面那条循环，
    // 而它的方向是【把垃圾输入判成本机】—— 本模块最不能犯的方向错误。
    expect(isLoopbackAddress("127.evil.com")).toBe(false);
    expect(isIPv4Literal("127.1.1.1")).toBe(true);
    expect(isIPv4Literal("127.1.1")).toBe(false);
    expect(isIPv6Literal("fe80::1%en0")).toBe(true);
    expect(isIPv6Literal("localhost")).toBe(false);
  });
});

describe("④ 造不出一个 LAN 决定（这一节是「不是靠默认值」的机制那一半）", () => {
  it("⭐ 运行期伪造一个 decision 会被拒（TS 的 private constructor 编译后什么都不剩）", () => {
    /*
     * 这一发是本文件写完【之后】才补的，因为它纠正了我对【自己写的守卫】的一个错误认知。
     * 我原本在 bind.ts 文件头写「构造函数是私有的，所以外面造不出来」，然后写了这条
     * `expect(() => new ctor()).toThrow()` 当作它的对偶 —— 结果【不抛】。
     * TS 的 `private constructor` 是一个【纯编译期】的东西，转译成 JS 之后是一个普通
     * 构造函数，`new (Cls as unknown as Ctor)()` 照样成功。
     * 也就是说【我那条断言一旦写出来就会红，而它红的不是测试的问题，是实现的问题】——
     * 这是本仓最想要的那种红：它推翻的是一条我自己写在注释里的【安全论断】。
     * 修法不是把断言改松，是实现里补一把运行期的钥匙（bind.ts 的 CONSTRUCTION_KEY）。
     * 于是这一格现在钉的是【真存在】的那道运行期检查，而不是一个我以为存在的编译期检查。
     */
    const spoofed = { host: "0.0.0.0", exposure: "lan", warning: null };
    const ctor = BindDecision as unknown as (
      ...a: unknown[]
    ) => BindDecision;
    // ① 直接 new（连 key 都不给）⇒ 抛。
    expect(() => new ctor("0.0.0.0", "lan", null)).toThrow(/resolve\(\)/u);
    // ② 把字段整个抄一遍当参数 ⇒ 也抛。这是【真威胁】的形状：
    //    攻击面不是「有人 new 一下」，是「有人拼出一个看着完全合法的 LAN 对象」。
    expect(() => new ctor(spoofed.host, spoofed.exposure, spoofed.warning)).toThrow(
      /resolve\(\)/u,
    );
    // ③ 反向对照：resolve 自己产的【确实】是这一个类 —— 否则上面两条是恒真的
    //    （一个永远抛的守卫也一样能让它们绿，而它同时会让 server.ts 全部拒收）。
    const real = dec(BindDecision.resolve({ requested: LOOPBACK_HOST, remoteApprovalsWired: false }));
    expect(real).toBeInstanceOf(BindDecision);
  });

  it("⭐ server.ts 拿不到裸 host：它只接受一个 BindDecision，且运行期核验身份", () => {
    // 两条源码形状断言，各挡一种退化：
    //  ① listen 的第二参必须来自 decision，而不是某个 string 变量 ——
    //     退化成 listen(port, host) 时编译期不响（host 就是 string），只有这条红。
    expect(SERVER_SRC).toMatch(/listen\([^)]*bind\.host/u);
    //  ② 必须有运行期的 instanceof。少了它，`as BindDecision` 就能凭空造一个 LAN 决定，
    //     而文件头明写「brand 让越界可见，真正挡住的是运行期核验」—— 这条钉它没被删。
    expect(SERVER_SRC).toMatch(/instanceof BindDecision/u);
    //  ③ 反向：server.ts 里不许出现第二个 listen 调用点，也不许出现写死的其他地址。
    const listens = SERVER_SRC.split("\n").filter((l) => /^\s*server\.listen\(/u.test(l));
    expect(listens.length).toBe(1);
  });

  it("bind.ts 自己不去 listen：绑定策略是个纯判据，才能不起服务就测", () => {
    expect(BIND_SRC).not.toMatch(/node:http|createServer|\.listen\(/u);
  });

  it("致命那一档只有【一个定义点】（两处各写字面量就会漂）", () => {
    /*
     * 判据是「赋值那一句只有一处」，不是「这个字符串只出现一次」——
     * 后者是我第一版写的，当场红：联合类型 BindRejectReason 里【必须】出现这个字面量
     * （TS 的字符串字面量类型没有别的写法），而那一处不是「第二个定义点」，是类型声明。
     * 一条红掉的断言先去问「是判据错了还是世界错了」，这次是世界是对的。
     */
    const assigned = BIND_SRC.split("\n").filter((l) =>
      /["']lan_without_approvals_channel["']\s*[;}]?\s*$/u.test(l.trim()) &&
      !/^\s*(\||export type|readonly)/u.test(l),
    );
    expect(assigned.length).toBe(1);
    expect(assigned[0]).toMatch(/export const FATAL_BIND_REASON/u);
  });
});
