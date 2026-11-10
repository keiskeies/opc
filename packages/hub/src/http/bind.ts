/**
 * Hub 监听哪一块网卡（计划 Task 4.1 的第一半，【规格】§20.3 的边界那一维）。
 *
 * ── 这个文件存在的理由：原来「只绑回环」是【写死】的，而写死守得住的东西有限 ──
 * `http/server.ts` 文件头把这件事写得很清楚，原文值得抄一遍，因为它决定了本篇的形状：
 *
 *   「这里【没有】host 选项：写死回环。要暴露到远程是 Task 4.1 的事，而那一层必须先有
 *    真正的远程鉴权（一次性配对 + 长期 token 轮换），届时删掉这个写死是一次【显式的、
 *    会被 review 的】改动。」
 *
 * 也就是说本篇拿到的不是一个「把常量改成参数」的活儿，而是一个**条件句**：
 * 允许删掉写死的那个【前提】是远程鉴权先到位。所以这个模块的判据不是
 * 「默认值对不对」，而是「**在远程鉴权不存在的时候，能不能拿到一个非回环的 socket**」。
 * 答案必须是【不能】，而且不能靠注释提醒。
 *
 * ── 为什么「加一个 --bind 参数、默认 127.0.0.1」是不够的 ──────────────────
 * 那是把安全性质交给【默认值】维持。默认值会被改：一次「本地起不来，先绑 0.0.0.0 试试」
 * 的临时排查，一次 docker-compose 里的顺手覆盖，一次 env 里躺着的 OPC_BIND。
 * 每一次的症状都不是报错 —— 服务照常起，桌面端照常连，而【整个局域网都能以 CEO 身份
 * 批准付款】，因为那个 HMAC 密钥就在同一个进程的内存里（auth.ts 文件头）。
 * 与本仓反复抓的那族「能绕过的那条路不要留在那里，而不是写注释提醒别人别绕」
 * （real-deps.ts 的条件 UPDATE、0026 §5 的索引去重、0026 §2.1 的排除表）是同一件事。
 *
 * ── 判据长这样：一个【造不出来】的凭据 + 一道运行期核验 ──────────────────
 * 1. resolveBind() 是唯一的 host 来源，产出一个 BindDecision。
 * 2. BindDecision 的构造函数是【私有的】：外部写不出 `new BindDecision(...)`，
 *    也写不出一个字段齐全的对象字面量（private 字段在 TS 里是名义的，字面量缺它）。
 * 3. ⚠ 光有 2 是【假的】—— 这一条本篇被一条红测试当场纠正过：
 *    TS 的 private constructor 编译后什么都不剩，运行时 `new (BindDecision as any)()`
 *    我实测【成功】。所以真正生效的是【运行期那道钥匙】：构造函数校验一个模块内私有的
 *    symbol（CONSTRUCTION_KEY，刻意用 Symbol() 而不是 Symbol.for() —— 后者在全局
 *    注册表里，任何模块都能凭名字取到，那就等于没有）。
 *    于是「伪造一个 decision」必须【import 一条内部符号】，到那一步已经不是顺手改一下。
 *    ⚠ 仍然【不是绝对】挡不住，准确说法是：**没有一条安静的路**。
 *    把这一维写成「类型上不可表达」是本仓反复抓的那种夸大（0026 §2 那条
 *    「不新增枚举成员」的近亲），所以连注释一起把它按回准确版本 ——
 *    而这条准确版本本身也是【第二次】写错之后才对的（第一次写的是「编译期就拦住」）。
 *
 * ── 一处我刻意【不做】的事：不接受 "localhost" ─────────────────────────
 * 看着像最宽容的选择，实际是把边界交给 /etc/hosts：`localhost` 在双栈机器上可能解析成
 * `::1`、也可能解析成 `127.0.0.1`，还可能被改成任意地址（它是**一个名字**，不是一个地址）。
 * 一个安全边界不该由一个可变的名字来指认。要绑回环就写 `127.0.0.1` 或 `::1`，
 * 写 `localhost` 会被拒并拿到这句解释 —— 报错里教一遍，比让人去 grep 这个注释便宜。
 *
 * ── 一处【已知会误伤】的取舍，写在这里而不是藏在代码里 ───────────────────
 * `0.0.0.0` 与 `::` 被一视同仁地当成「对外暴露」，即使调用方的本意是
 * 「用默认路由族绑定但机器上只有回环」。我不去查本机网卡清单来区分这两种意图：
 * 那会让同一行命令的**安全含义**取决于**这台机器今天插了几块网卡**，
 * 而那正是最容易在换网络时悄悄改变的东西。要暴露就显式说要暴露，这条命令在
 * 任何一台机器上的含义都一样。
 */

/**
 * 回环的两个合法写法。IPv4 那一个是全仓默认，也是 desktop 侧硬编码连的那个。
 *
 * ⚠ 定义的**家**在这里而不是 http/server.ts（那边原来有这份常量、现在 re-export 这一份）。
 * 理由是 import 图：server.ts 要用 BindDecision（bind.ts 产出），bind.ts 又要知道
 * 「什么算回环」。若常量留在 server.ts 而 bind.ts 去 import 它，两个模块就互相 import，
 * 而「绑定策略」这个【本该最独立】的模块从此需要一个 HTTP server 才能被加载 ——
 * 独立性能测的东西变得要连带起服务才能测。方向定死为 bind ← server（单向）。
 */
export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_HOST_V6 = "::1";

/** 拒绝理由的分类。测试钉的是这一维，不是文案 —— 文案会改，判据不该跟着文案走。 */
export type BindRejectReason =
  /** 是个名字（localhost / en0 / mybox），不是一个 IP。 */
  | "not_an_ip_literal"
  /** 是个合法的非回环 IP，而一次性 token 通道没接。 */
  | "lan_without_approvals_channel";

/**
 * 唯一【致命】的那一档。
 *
 * 单独导出而不是让调用方去比对字符串：这一维在两个地方被读（本模块的
 * bindFailureIsFatal、serve/config.ts 选退出码），两处各写一遍 `"lan_without..."`
 * 就会漂，而漂了的症状是「配置错了本该拒绝启动，结果退回了回环」——
 * 一个静默的方向错误。所以只有这一处定义。
 */
export const FATAL_BIND_REASON: BindRejectReason = "lan_without_approvals_channel";

export type BindRejection = {
  readonly ok: false;
  readonly reason: BindRejectReason;
  /** 给进程/CLI 的报错原文。带修法：报「不行」而不说怎么才能行，等于把人推向 --force。 */
  readonly message: string;
};

export type BindOutcome = { readonly ok: true; readonly decision: BindDecision } | BindRejection;

/**
 * 一次监听决定。构造点是私有的 —— 见文件头那条「造不出来的凭据」。
 *
 * ⚠ **TS 的 private constructor 只是编译期的**，这一点在本篇被一条红测试当场抓到：
 *   `new (BindDecision as unknown as Ctor)()` 在运行时**完全成功**。
 *   所以这里额外要一把【运行期】的钥匙（下面 CONSTRUCTION_KEY）：构造时校验，
 *   对不上就抛。于是「伪造一个 decision」需要同时拿到这个模块内的 symbol，
 *   而那必须是 `import` 一条**内部符号**才能做到 —— 到那一步已经不是「顺手改一下」了。
 *   仍然【不是绝对】挡不住（Symbol.for 那类全局注册表能跨模块拿到，本实现刻意用
 *   Symbol() 而不是 Symbol.for() 正是为此），准确说法还是文件头那句：**没有一条安静的路**。
 *
 * 字段少而每个都在承担理由：
 *  · host —— 交给 server.listen 的第二参。
 *  · exposure —— 这次监听的**安全含义**，不是 host 的另一种写法。两个都要是因为
 *    `127.0.0.1` 与 `::1` 是同一含义的两种写法，而 `0.0.0.0` 与 `192.168.1.7` 也是
 *    同一含义的两种写法 —— 光看 host 分辨不了这两族，而日志与鉴权层要的是含义。
 *  · warning —— 启动时要打印的告警。**loopback 时是 null 而不是空串**：空串让
 *    「这件事不需要说」在类型上仍然像一个消息，调用方一写成 log(warning) 就打出个空行。
 */
const CONSTRUCTION_KEY = Symbol("opc/http/bind#decision");

export class BindDecision {
  private constructor(
    readonly host: string,
    readonly exposure: "loopback" | "lan",
    readonly warning: string | null,
    key: symbol,
  ) {
    // 运行期核验。少了这一行，上面那个 private 在 JS 里等于没写（它会被擦掉），
    // 而本模块的全部价值就建立在「LAN 决定不能被随手造出来」上。
    if (key !== CONSTRUCTION_KEY) {
      throw new Error(
        "BindDecision 只能由 BindDecision.resolve() 产出：它是一次【安全决策】的凭据，" +
          "手搓一个等于绕过「非回环要求一次性 token 通道」那条判据（见 bind.ts 文件头）。",
      );
    }
  }

  /**
   * 唯一的构造出口。`remoteApprovalsWired` 是【必填】的，理由与本仓给
   * applyDecision 的 publish 参数同一条（real-deps.ts:209 那段）：
   * 可选参数会让「装配时忘了接 token 存储」成为一个 TS 不响、测试照绿、
   * 只有「整个局域网能批付款」这个后果能被看见的缺陷。
   * 测试不关心远程时【显式传 false】—— 「我选择不接」与「我忘了接」
   * 在代码上必须长得不一样。
   */
  static resolve(o: {
    readonly requested?: string;
    readonly remoteApprovalsWired: boolean;
  }): BindOutcome {
    const requested = o.requested?.trim();
    // 没填 ⇒ 回环。这一支【不查】remoteApprovalsWired：默认路径不该因为
    // 「远程通道没接」就起不来，那会把一个 Phase 4 的可选能力变成 Phase 2 的启动依赖。
    if (requested === undefined || requested === "") {
      return ok(new BindDecision(LOOPBACK_HOST, "loopback", null, CONSTRUCTION_KEY));
    }

    // 回环字面量 ⇒ 直接放行，与 remoteApprovalsWired 无关。
    if (isLoopbackAddress(requested)) {
      // ::1 单独提示一句，因为它是【另一个】栈：绑了 ::1 就连不上 127.0.0.1，
      // 而 desktop 侧现在连的是 v4 —— 这不是安全问题，是一个会让人以为服务没起来的坑。
      if (requested === LOOPBACK_HOST_V6) {
        return ok(new BindDecision(requested, "loopback", LOOPBACK_V6_NOTE, CONSTRUCTION_KEY));
      }
      return ok(new BindDecision(requested, "loopback", null, CONSTRUCTION_KEY));
    }

    // 到这里 requested 一定是【非回环】。先分「它到底是不是个 IP」。
    // 判据是「不是 IP 字面量」而不是「含字母」：后者只挡住字母开头的名字，
    // `999999` 这种纯数字垃圾会漏到 listen 那一层，报一个指向别的方向的错。
    if (!isIPv4Literal(requested) && !isIPv6Literal(requested)) {
      return {
        ok: false,
        reason: "not_an_ip_literal",
        message:
          "--bind 要的是一个 IP 字面量，不是主机名（收到「" +
          requested +
          "」）。名字把安全边界交给名字解析系统：" +
          "localhost 在双栈机器上可能是 127.0.0.1 也可能是 ::1，还可能被 /etc/hosts 改掉。" +
          "本机回环请写 " +
          LOOPBACK_HOST +
          "（或 " +
          LOOPBACK_HOST_V6 +
          "）。",
      };
    }

    // 是个合法的非回环 IP ⇒ 必须有远程审批通道，否则【拒绝】而不是警告。
    if (!o.remoteApprovalsWired) {
      return {
        ok: false,
        reason: FATAL_BIND_REASON,
        message:
          "拒绝绑定 " +
          requested +
          "：非回环监听要求【一次性 token 的远程审批通道】先接上。\n" +
          "现在接上的是回环专用鉴权（http/auth.ts 的 HMAC，密钥在本进程内存里），" +
          "它防的是链路窃听，防不了「同一局域网里任何人以 CEO 身份批准付款」。\n" +
          "要开远程：装配时提供一次性 token 存储（http/tokens.ts），装配成功后本判据自动放行。\n" +
          "只想本机用：去掉 --bind（默认 " +
          LOOPBACK_HOST +
          "），或显式写 --bind " +
          LOOPBACK_HOST +
          "。",
      };
    }
    return ok(new BindDecision(requested, "lan", lanWarning(requested), CONSTRUCTION_KEY));
  }
}

function ok(decision: BindDecision): BindOutcome {
  return { ok: true, decision };
}

/**
 * 「给我那个默认决定」，而【不许】调用方自己 `resolve(...).decision as BindDecision`。
 *
 * 为什么单独一个静态方法而不是让两处调用方各自 unwrap：BindOutcome 是一个带 ok 判别的
 * 联合，`.decision` 在联合上不可访问 —— 这是【好事】，它逼这里写一次
 * 「回环那一档不可能被拒」的**证明**（下面那个 throw），而不是让编译器闭嘴。
 * 而这件事若散在两个调用方（server.ts 的默认路径、assemble.ts 的 --bind 被拒后回退），
 * 两处都会想「这里显然不会拒」而各自 as 一下 —— 那就得到两条【各自成立、各自会漂】的默认路径。
 * 一处定义，两处调用，默认值就只有一个来源。
 *
 * 如果哪天 resolve 改成「连回环都要查 token 通道」，这一发会【运行期炸出来】，
 * 而不是悄悄变成一个 undefined.host。
 */
export function defaultBindDecision(): BindDecision {
  const o = BindDecision.resolve({ remoteApprovalsWired: false });
  if (o.ok !== true) {
    throw new Error(
      "默认（回环）绑定决策被拒了（reason=" +
        o.reason +
        "）。回环那一档按本模块的实现不可能被拒；走到这里说明 resolve 的判据变了，" +
        "而那条变化会把【不传 --bind 的桌面端】一起挡在启动之外。",
    );
  }
  return o.decision;
}

const LOOPBACK_V6_NOTE =
  "监听 " +
  LOOPBACK_HOST_V6 +
  "：这只覆盖 IPv6 回环，连 127.0.0.1 的客户端（含现在的桌面端）会连不上。" +
  "两端都要的话，起两个进程或改绑 " +
  LOOPBACK_HOST +
  "。";

function lanWarning(host: string): string {
  return (
    "⚠ 监听 " +
    host +
    "：这台机器【同一网络里的任何设备】都能到达 Hub。\n" +
    "此刻起生效的是【一次性 token】那套凭据（http/tokens.ts），不是桌面端那个 HMAC 密钥；" +
    "并且按【规格】§11.4，标记为不可逆的审批在远程一律拒批。\n" +
    "用完请把 --bind 去掉：这个告警每次启动都会打，是刻意的。"
  );
}

/**
 * 一次配置错误的默认处置：**退回回环** 还是 **拒绝启动**。
 *
 * 只有「要暴露而通道没接」是致命的。名字/垃圾串那一类是打字错误，调用方真正想要的是
 * 「能用」，退回回环对；而「写了 0.0.0.0 而 token 没接」这一类，用户【明确要暴露】，
 * 我们悄悄不暴露，他会去查防火墙而不是查这里，然后花半小时在【不存在的问题】上。
 * 两类分开（而不是写成一句「都拒绝」），是因为它们的**症状**不同：
 * 一类安静可用，一类必须响。
 */
export function bindFailureIsFatal(o: BindRejection): boolean {
  return o.reason === FATAL_BIND_REASON;
}

/**
 * 一个地址是不是回环。**peer 分类与 host 校验共用这一发**，这是刻意的：
 * 两处各写一套判据，就会有一处认 `::ffff:127.0.0.1` 是回环而另一处不认，
 * 而那种分歧的症状是「同一条连接在一侧被当成本机、在另一侧被当成远程」——
 * 于是同一台机器上的同一个客户端，两次请求可能给出不同的鉴权结论。
 *
 * 三条实现细节，每条对应一种真实输入：
 *  · **先剥 `::ffff:` 前缀**：IPv4-mapped IPv6 地址。Node 在绑定 `::` 时给出的对端
 *    地址就是这个形态，不剥它会把 `::ffff:127.0.0.1` 判成远程，于是
 *    **本机自己的桌面端被 403**。
 *  · **整段 127/8 都算回环**，不只是 `127.0.0.1`：`127.0.0.2` 在同机可达性上与
 *    `127.0.0.1` 没有任何区别（RFC 6890 把它列为 Node-Local）。只认 `.1` 会让
 *    「绑定在 127.0.0.2 上的服务」被自己的鉴权层当成远程而来要求一次性 token
 *    —— 一条永远拿不到 token 的死路。
 *  · **不解析名字**：与上面「不接受 localhost」同一条理由。传名字进来是调用方的错，
 *    这里返回 false 而不是去 lookup（在鉴权路径上做 DNS 查询是另一类事故）。
 *
 * ⚠ 与 bind 侧的一条**刻意不对称**：这里认 `::ffff:127.0.0.1`，而 resolve 【不】允许
 *   把 `::ffff:...` 当监听地址。理由不同源也不同性质 —— peer 那一侧的输入是
 *   **内核给的**，形态不由我们选；bind 那一侧的输入是**人打的**，形态由我们定，
 *   那就定成「只认干净的字面量」。共用判据的是「什么算回环」，不是「什么算合法输入」。
 */
export function isLoopbackAddress(raw: string): boolean {
  const addr = stripMappedPrefix(raw.trim());
  if (addr === LOOPBACK_HOST_V6 || addr === "0:0:0:0:0:0:0:1") return true;
  if (!isIPv4Literal(addr)) return false;
  // 判 127 之前必须已经确认是合法四段：否则 "127.evil.com" 会因为
  // startsWith("127.") 被判成回环。垃圾输入被判成「本机」是本模块最不能犯的方向错误。
  return Number(addr.split(".")[0]) === 127;
}

/** IPv4-mapped IPv6 前缀。只认这一个形态，别的设计（6to4、Teredo）不在 Node 会给的范围里。 */
function stripMappedPrefix(addr: string): string {
  return addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
}

/** 四段点分十进制，每段 0–255，不接受加号/十六进制/前后空白。 */
export function isIPv4Literal(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/u.test(p) && Number(p) <= 255);
}

/**
 * IPv6 字面量的**宽松**判定：含 `:` 且只含十六进制字符（外加一个可选的 `%<iface>`
 * 作用域后缀，链路本地地址要用它）。
 *
 * 宽松是有意的，也是本文件里最该被质疑的一行：这里【不做】完整的 RFC 4291 校验，
 * 因为「校验 host 的语法」不是这个模块的职责 —— Node 的 listen() 会拒绝非法地址，
 * 而它给的原文比我自造的任何文案都准。这里只回答一个问题：
 * **「这是不是一个 IPv6 形状的东西」**，用来把 `localhost` / `en0` / `999999`
 * 与真的 IPv6 分开。所以 `:::bad` 会被放过、交给 listen 报错，那是可接受的
 * （它的失败方向仍然正确：起不来，而不是悄悄放宽）。
 */
export function isIPv6Literal(s: string): boolean {
  const body = s.includes("%") ? s.slice(0, s.indexOf("%")) : s;
  return body.includes(":") && /^[0-9a-f:]+$/iu.test(body);
}
