/**
 * 证据包（Evidence Bundle）契约 —— 计划 Task 1.1 / 规格 §8.1。
 *
 * 为什么证据要独立成契约而不是塞进岗位书：§8.1 那一整张表讲的是【交接方向】
 * （产品→技术、技术→开发、开发→测试、测试→上报、运营→CEO），每一次交接一份包。
 * 岗位书定义的是【角色长期能做什么】，证据包定义的是【这一次产出凭什么被采信】，
 * 两者的生命周期不同：前者版本化后长期生效，后者一次性、且被 review_gates 外键引用。
 *
 * 「可验证的引用，不是总结」这条要求落在这里的最小形态：claims[].evidence_refs
 * 必须非空（计划 Test 项第一条）。但【非空】只保证有引用，不保证引用能对上号 ——
 * 见 hasResolvableEvidence()：那条判据要求引用至少命中本包声明的某个制品路径或
 * 显式的外部链接，否则「引用了不存在的文件」这条假绿无人拦（§8.2 第 2 条）。
 *
 * 依赖边界：这里只做校验，不碰文件、不碰数据库（packages/contracts 在 desktop/web
 * 侧也要能 import，规格 §5.6.1 的编译期边界）。哈希与实际文件内容的比对在 hub 侧的
 * EvidenceStore.verify()，那是 I/O。
 */
import { z } from "zod";

/**
 * 六种包类型，逐字取计划 Task 1.1 的枚举。
 *
 * 注意它与 review_gates.evidence_bundle_id 指向的表里 bundle_type 列的注释
 * （'prd'|'tech_plan'|...）【不同名】：那一列的注释是附录 C 的旧口径。以本枚举为准
 * —— 规格 §5.11 写明 zod schema 是证据包的唯一 schema 来源，DB 注释不是。
 * 这里的取舍口径：DB 注释不参与校验（SQLite 注释只是文本，改它不影响任何行为），
 * 所以不为了「注释一致」去改 0001_init.sql —— 已应用的迁移文件一经落库【不可改】
 * （改了就和已存在的库对不上，见 decisions/0004 §迁移的幂等口径）。
 * 唯一真正的口径载体是本枚举 + 0002 迁移里那列的 CHECK 约束。
 */
export const BUNDLE_TYPES = [
  "spec",
  "design",
  "code_diff",
  "test_report",
  "ops_plan",
  "approval_card",
] as const;
export type BundleType = (typeof BUNDLE_TYPES)[number];

/**
 * UUID 形状。用 regex 而不是 z.string().uuid()：后者在 zod 4 已标记废弃，
 * 而【废弃 ≠ 立即失效】—— 它会安静工作到某个大版本再消失，那种失效方式与本仓库
 * 反对的「静默」同源。形状写在这里是可 grep 的常量。
 */
export const UUID_RE: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * sha256 的 64 位【十六进制小写】。
 *
 * 计划接口写的是 z.string().length(64)。这里换成 regex，是一处刻意的收紧，理由不是
 * 口味：length(64) 接受 64 个任意字符，于是 "x".repeat(64) 是合法哈希，而它永远不可能
 * 与实际内容相符 —— store.verify() 会恒返回 false，表现为「证据总是对不上」而不是
 * 「写错了」。十六进制小写是 Node crypto 与 git 的输出形状；不收大小写会让同一文件
 * 在两处登记成两个不同的 sha256，于是 verify() 对同一份字节一真一假 —— 那种「偶尔
 * 对不上」的报错比恒失败更难查。
 */
export const SHA256_RE: RegExp = /^[0-9a-f]{64}$/;

const artifactSchema = z
  .object({
    /** 制品的相对路径或外部链接；实际内容不在 SQLite 里（规格 §5.10）。 */
    path: z.string().min(1),
    sha256: z.string().regex(SHA256_RE),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

const claimSchema = z
  .object({
    text: z.string().min(1),
    /**
     * 非空是【下限】而不是要求本身。空数组意味着「这句话没有任何依据」，
     * 而证据包存在的全部理由就是把「总结」换成「可验证的引用」。
     */
    evidence_refs: z.array(z.string().min(1)).min(1),
  })
  .strict();

const evidenceBundleInput = z.object({
  bundle_id: z.string().regex(UUID_RE),
  task_id: z.string().min(1),
  bundle_type: z.enum(BUNDLE_TYPES),
  produced_by_role: z.string().min(1),
  /**
   * 模型家族，不是模型 id。§24 风险 1 与 §5.9 第 1 条要判的是「审阅方与产出方是否
   * 同源」，同源判定必须在【家族】粒度上做：同家族的不同版本号（gpt-x 与 gpt-x-lite）
   * 高度相关，共谋风险与同模型没有本质区别。存具体 model id 会让这道判定失效。
   */
  produced_by_model_family: z.string().min(1),
  artifacts: z.array(artifactSchema),
  claims: z.array(claimSchema),
  /** 角色自认做不到什么（§14.4 红线二在证据层的延伸）。允许为空数组：
   *  诚实边界是【有则声明】，缺它不该让整包被拒 —— 拒了就会逼人写一句空话来过校验，
   *  那比空数组更糟。岗位书那一侧强制非空是对的（角色长期存在，必须声明）。 */
  honesty_boundaries: z.array(z.string()),
  /**
   * 可机械判定的数值指标（覆盖率、缺陷数、首屏毫秒数…）。
   *
   * 这是相对计划接口的【新增可选字段】，不是随意加字段：规格 §8.2 第 5 条要求门控
   * 「检查覆盖率数值」且是确定性代码，而纯函数要判『coverage >= 80』这类条件，
   * 唯一出路是数值随证据一起进来。没有这个字段，evaluateGate 对所有数值条件只能
   * 一律升级到人工 —— 那 §23.1 的「八成审批由规则自动决定」这条北极星就无从谈起。
   * 缺省即「本包没带任何可判定数值」，此时门控不臆断通过（见 gates.ts）。
   */
  metrics: z.record(z.string(), z.number().finite()).optional(),
});

/**
 * 证据包。校验后的形状与输入形状【同名同字段】（不做 camelCase 重命名）：
 * 岗位书做了 snake→camel 映射，这里刻意不做，因为证据包整体以 JSON 文本存进
 * evidence_bundles.artifacts / 审计 payload，读回来要与写进去逐字对得上。
 * 一旦中间加了改名层，「库里那行 JSON 就是当初那个包」这个不变量就没了。
 *
 * 【外层也 strict】。artifacts / claims 两个内层对象一直是 strict，外层曾经漏了 ——
 * 而外层恰恰是字段改名会发生的地方：内层改名会让整条记录对不上形状、当场报错，
 * 外层改名（produced_by_role → producer_role）却只会让旧字段变成「缺失但没人发现」，
 * 只要新字段一起传上来就通过校验。
 * 代价说清楚：多带一个字段会让整包被拒。这是【要的】方向（fail-closed，与 policy
 * 引擎「未知即不可逆」同一立场）—— 宁可当场拒一个包，也不要门控读不到
 * produced_by_model_family 却照样判「审阅者不同源」。
 */
export const evidenceBundleSchema = evidenceBundleInput.strict();

export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
export type EvidenceArtifact = z.infer<typeof artifactSchema>;
export type EvidenceClaim = z.infer<typeof claimSchema>;

/**
 * claims 引用的证据是否【至少有一条】能在本包内对上号。
 *
 * 为什么需要独立一个函数而不是靠 schema：schema 只能判「refs 非空」，判不了
 * 「ref 指向的东西存不存在」。一条指向从未声明的制品的引用，形状完全合法。
 *
 * 判定口径（必须写死，否则两侧各按一种读法实现）：
 *  - ref 等于某个 artifact 的 path ⇒ 命中；
 *  - ref 形如 "path#锚点"（指向包内制品的某一段）⇒ 去掉 # 之后的部分按上一条比；
 *  - ref 是 http/https 绝对 URL ⇒ 视为外部链接，命中（§8.1 允许「外部链接」类依据）。
 * 除此之外都不算命中。
 *
 * 返回的是【没对上的 claim 下标】而不是布尔：报错要能指到具体哪句话没依据，
 * 只说「有引用无效」的报错无法修。
 */
export function unresolvableClaimIndexes(
  bundle: Pick<EvidenceBundle, "artifacts" | "claims">,
): number[] {
  const paths = new Set(bundle.artifacts.map((a) => a.path));
  const out: number[] = [];
  bundle.claims.forEach((c, i) => {
    const hit = c.evidence_refs.some((r) => {
      if (/^https?:\/\//i.test(r)) return true;
      const head = r.split("#")[0] as string;
      return paths.has(head);
    });
    if (!hit) out.push(i);
  });
  return out;
}

/** 交接方向 → 该方向必须出现的包类型（规格 §8.1 那张表的机器可读形态）。 */
export const HANDOFF_BUNDLE_TYPES: Readonly<Record<string, BundleType>> = {
  "product_to_tech": "spec",
  "tech_to_dev": "design",
  "dev_to_test": "code_diff",
  "test_upward": "test_report",
  "ops_to_ceo": "ops_plan",
};

/**
 * 按交接方向取该来的包类型。未知方向【抛错】而不是返回 undefined：
 * 传错方向名会让调用方拿到 undefined 后走「不做类型比对」的分支，
 * 于是门控对拼错的方向静默放行 —— 与 §8.2 第 4 条「不可绕过」相反。
 */
export function requiredBundleType(gate: string): BundleType {
  const t = Object.hasOwn(HANDOFF_BUNDLE_TYPES, gate)
    ? HANDOFF_BUNDLE_TYPES[gate]
    : undefined;
  if (t === undefined) {
    throw new Error(
      "未知的交接方向 [" +
        gate +
        "]。已知方向：" +
        Object.keys(HANDOFF_BUNDLE_TYPES).join(" | ") +
        "。新增交接方向必须同时在这里登记包类型，否则该门控等于不做类型校验。",
    );
  }
  return t;
}
