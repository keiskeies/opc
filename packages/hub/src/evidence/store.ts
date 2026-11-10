/**
 * 证据包存储（计划 Task 1.1，规格 §5.10 / §6.4）。
 *
 * 一句话职责：文件落文件系统，SQLite 只存路径与 sha256；verify() 把「声明的哈希」
 * 与「磁盘上那份内容」对账。
 *
 * 为什么制品不进 SQLite（规格 §5.10 的理由，这里补一条工程侧的）：evidence_bundles
 * 与 events 一样是审计侧的表，把几十 KB 的代码 diff 塞进 TEXT 列会让回放查询与 FTS
 * 索引一起变大，而回放从不需要 diff 的字节 —— 它需要的是「当时那份东西还在不在、
 * 是不是那一份」。
 *
 * ⚠ 本模块的 verify() 判的是【完整性】，不是【正确性】：sha256 相符只证明这份文件
 * 和提交时说的那份一致，不证明它内容属实。§8.2 第 2 条要的「可验证证据」= 完整性
 * （这里）+ 独立审阅（Task 1.3 的作者/审阅人分离）。把这两件事混为一谈，就会以为
 * 「有哈希就不用独立审阅」—— 那正是 §24 风险 1 的共谋形态。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { EvidenceBundle } from "@opc/contracts";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";

/**
 * 制品根目录。规格 §5.10 写 `~/.opc-os/artifacts/`。
 *
 * 【不读 env、不猜 HOME】：调用方必须显式传 root。理由不是洁癖 —— 这个包同时被测试
 * 与真实 Hub 使用，测试若靠 env 覆盖就会在忘设 env 时往真实用户的 ~/.opc-os 里写
 * 制品（写进去还删不干净，因为路径由 bundle_id 决定）。让「写到哪」成为一个必填参数，
 * 忘了传就是编译不过。生产入口传 artifactsRoot()。
 */
export function artifactsRoot(home = defaultHome()): string {
  return join(home, ".opc-os", "artifacts");
}

function defaultHome(): string {
  const h = process.env["HOME"];
  if (h === undefined || h.trim() === "") {
    throw new Error(
      "取不到 HOME，无法定位制品根目录 ~/.opc-os/artifacts。显式传 root 给 " +
        "EvidenceStore，不要退回 cwd —— 那会把审计制品写进仓库工作区。",
    );
  }
  return h;
}

/**
 * 制品在磁盘上的路径：{root}/{task_id}/{bundle_type}/{bundle_id}.{ext}（规格 §5.10 逐字）。
 *
 * 三段全部要做路径安全校验，因为这三个值都来自【不可信输入】（agent 产出的证据包）：
 * task_id 写成 "../../etc" 就能把制品写到任意位置。校验放在这里而不是靠调用方自觉，
 * 与 §20.1「不可信输入」的立场一致。
 */
export function artifactPath(
  root: string,
  bundle: Pick<EvidenceBundle, "task_id" | "bundle_type" | "bundle_id">,
  ext: string,
): string {
  const safe = (v: string, what: string): string => {
    if (v === "" || v.includes("\0")) {
      throw new Error(
        "制品路径的 " + what + " 段非法（空串或含 NUL）—— 拒绝写出，宁可报错。",
      );
    }
    // 只拒两类真危险的：路径分隔符与上跳。不锁字符集，否则中文 task_id 之类合法值会被误杀。
    if (v.includes("/") || v.includes("\\") || v === ".." || v === ".") {
      throw new Error(
        "制品路径的 " +
          what +
          " 段含路径分隔符或上跳 [" +
          v +
          "]。这三段拼进文件系统路径，含 / 或 .. 就能把制品写到 root 之外。",
      );
    }
    return v;
  };
  const cleanExt = ext.replace(/^[.]+/u, "").replace(/[^A-Za-z0-9_-]/gu, "");
  return join(
    root,
    safe(bundle.task_id, "task_id"),
    safe(bundle.bundle_type, "bundle_type"),
    safe(bundle.bundle_id, "bundle_id") + (cleanExt === "" ? "" : "." + cleanExt),
  );
}

/**
 * 防目录穿越的第二道闸：算出的绝对路径必须仍在 root 之内。
 *
 * 为什么不满足于上面那个 safe()：resolve 之后的形状才是最终事实，而 join 的行为依赖
 * root 本身的形状（root 里带 .. 时，段内干净也可能跳出）。两道校验的判据【不同】，
 * 所以两条都要 —— 只留一条的话，另一条防的那类输入就没人管了。
 */
function assertInsideRoot(root: string, target: string): void {
  const base = resolve(root);
  const abs = resolve(target);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(
      "制品路径越出根目录：[" +
        abs +
        "] 不在 [" +
        base +
        "] 之内。拒绝读写 —— 审计制品写到 root 之外，等于让证据包决定文件系统的哪部分被写。",
    );
  }
}

/**
 * 制品的 sha256。
 *
 * 【当前是整读进内存，不是流式】—— 函数名与实现要一致，所以不叫 streamSha256。
 * 计划里几十 MB 的 diff 场景确实该流式（createReadStream + pipe），但那需要一个
 * 真正的流式入口与对应的错误路径测试；现在写成「看起来流式」的样子最坏：注释承诺了
 * 实现没有的性质，将来按注释判断内存上限的人会算错。改真流式时把这条注释一起改掉。
 */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 与 sha256File 同口径的字符串版（测试与「内存里的制品」用）。 */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 一条 verify 结论。分开写 cause，是为了让 UI 能区分「文件没了」与「内容被改过」。 */
export type VerifyFailure =
  | { path: string; cause: "missing" }
  | { path: string; cause: "size_mismatch"; declared: number; actual: number }
  | {
      path: string;
      cause: "hash_mismatch";
      declared: string;
      actual: string;
    };

export interface VerifyReport {
  /**
   * true 的含义【仅指】：所有【可比对的本地制品】都在、字节数与哈希都对上，
   * 且至少比对过一份（见 checked 与 skipped：一条都没比对过时 ok 必须是 false）。
   * 它不覆盖外链类依据，也不覆盖内容正确性（见文件头的 ⚠）。
   */
  ok: boolean;
  failures: VerifyFailure[];
  /** 真的比对过（读到文件并比了哈希）的份数。 */
  checked: number;
  /**
   * 因是外链而【无从】磁盘对账的份数。
   *
   * 为什么要把这个数暴露出来而不是直接 continue 掉：不暴露的话，「一份本地制品 +
   * 一条外链」的包会报 ok=true，读起来像「全部核对过」—— 这是一个【沉默的盲区】。
   * 门控与 UI 需要能区分「全查过且通过」与「查过一部分且通过」，这个字段就是那条分界。
   */
  skipped: number;
}

const INSERT_BUNDLE_SQL =
  "INSERT INTO evidence_bundles (id, task_id, producer_role, bundle_type, artifacts, " +
  "self_check, created_at, model_family, claims, honesty_boundaries) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/** 外链类制品（§8.1 允许「外部链接」作依据）。它没有「本地那一份」可对账。 */
export function isExternalLink(path: string): boolean {
  return /^https?:\/\//iu.test(path.trim());
}

/**
 * 声明形状 → root 内绝对路径。三条口径写死在这里，因为 §6.4 与 §5.10 的样例【差一层】：
 * 前者写 "artifacts/{task_id}/code_diff/{bundle_id}.patch"（相对 ~/.opc-os），
 * 后者写制品落在 ~/.opc-os/artifacts/{task_id}/…。不钉死口径，两侧会各按一种读法实现。
 *
 *  1) 相对路径以【root】为基准，不是进程 cwd。默认取 cwd 是踩坑写法：测试跑在仓库里、
 *     生产跑在 Hub 的工作目录里，同一个声明值会解析到两个地方，于是「verify 通过」
 *     依赖进程从哪启动 —— 审计结论不该依赖启动目录。（本函数原先默认 cwd，改掉了。）
 *  2) 开头的 "artifacts/" 前缀剥掉：root 已经【就是】artifacts 目录，留着那层会在
 *     root 下再造一个 artifacts/，同一份制品于是有两个合法路径。
 *  3) 解析结果必须仍在 root 之内，否则抛错。
 *     这一条以前【缺】：那时 verify() 会拿 agent 写的 ../../etc/passwd 直接
 *     existsSync + readFileSync —— 等于让证据包决定 Hub 读文件系统的哪一部分。
 *     更糟的是它的失败形状：读到真实的 /etc/passwd 后报 hash_mismatch，看起来像
 *     「哈希对不上」，实际是一次目录穿越。这类【把安全问题伪装成数据问题】的失效
 *     比直接崩更难查，所以宁可在这里抛错。
 */
function declaredInsideRoot(
  root: string,
  baseDir: string,
  declared: string,
): string {
  let rel = declared.trim();
  if (/^artifacts\//u.test(rel)) rel = rel.slice("artifacts/".length);
  const abs = resolve(baseDir, rel);
  assertInsideRoot(root, abs);
  return abs;
}

export interface EvidenceStoreOptions {
  /** 制品根目录（见 artifactsRoot 的说明：必填是刻意的）。 */
  root: string;
  /** 执行 SQL 的连接。与 events 用【同一个】连接才能同事务（规格 §6.3）。 */
  exec: (sql: string, params: readonly unknown[]) => void;
  now?: () => number;
  /**
   * 解析 artifact.path 里相对路径的基准目录。默认 = root 本身（见 declaredInsideRoot
   * 第 1 条）。给非默认值的唯一正当场景是「制品放在 root 之外但仍受控」的迁移期，
   * 且它仍受 root 的包含性检查约束 —— 传一个宽泛的 baseDir 不会放开越界。
   */
  baseDir?: string;
}

/**
 * 证据包仓库。
 *
 * 刻意【不 import DatabaseSync、不自己开连接】：同事务的要求意味着连接的归属在调用方
 * （超步事务的那一条，见 events/recorder.ts 的 StepTx）。这里只要一个 exec 回调 ——
 * 换成自己 openDb，包就会在事务外 autocommit，于是「证据写了、事件回滚了」这种半套
 * 状态重新可能出现，而这正是 §6.3 要消灭的。
 */
export class EvidenceStore {
  readonly #root: string;
  readonly #exec: (sql: string, params: readonly unknown[]) => void;
  readonly #now: () => number;
  readonly #baseDir: string;

  constructor(o: EvidenceStoreOptions) {
    this.#root = o.root;
    this.#exec = o.exec;
    this.#now = o.now ?? Date.now;
    // 缺省基准 = root 本身（不是 cwd）。见 declaredInsideRoot 第 1 条。
    this.#baseDir = o.baseDir ?? o.root;
  }

  get root(): string {
    return this.#root;
  }

  /**
   * 制品落盘（幂等：内容寻址，同内容重复写是覆盖同一份字节）。
   *
   * 返回【两个】路径而不是一个，因为它们是两种用途，混成一个会选错：
   *  - declared：root 相对形状（"{task_id}/{bundle_type}/{bundle_id}.{ext}"）。
   *    这个进 SQLite 的 artifacts 列 —— 它不含主目录，因此备份换机、§5.10 的 PG
   *    迁移、以及把库拷给别人看时都不会失效或泄出用户名。§6.4 的样例也是相对形状。
   *  - absolute：物理位置，给落盘与调试用。
   * 早先只返回绝对路径：那会让库里存满 /Users/x/…，换一台机器整库 verify 全红。
   */
  writeArtifact(
    bundle: Pick<EvidenceBundle, "task_id" | "bundle_type" | "bundle_id">,
    ext: string,
    bytes: string | Uint8Array,
  ): {
    declared: string;
    absolute: string;
    sha256: string;
    bytes: number;
  } {
    const target = artifactPath(this.#root, bundle, ext);
    assertInsideRoot(this.#root, target);
    mkdirSync(dirname(target), { recursive: true });
    const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
    const hash = createHash("sha256").update(buf).digest("hex");
    // 内容寻址 ⇒ 同内容重复写是 no-op；不同内容同 bundle_id 则不该发生（UUID v4 冲突级别），
    // 真发生就是调用方在复用 bundle_id，那是身份污染，必须炸而不是覆盖。
    if (existsSync(target) && sha256File(target) !== hash) {
      throw new Error(
        "同一 bundle_id 下出现不同内容：" +
          target +
          "。bundle_id 是制品包的身份，复用就等于把两份不同证据挂在同一个身份上 —— " +
          "审计回放将无法区分它们。",
      );
    }
    writeFileSync(target, buf);
    return {
      declared: relativize(this.#root, target),
      absolute: target,
      sha256: hash,
      bytes: buf.byteLength,
    };
  }

  /**
   * 登记一个证据包（写 evidence_bundles 那一行）。
   *
   * 注意它【不做】verify()：登记时制品刚写完，哈希必然相符，verify 在此刻恒真 ——
   * 一条恒真的断言不会带来任何保证，只会让人以为「登记时校验过了」。verify 的价值
   * 在【之后】：审阅时、回放时、以及备份恢复后（规格 §22.4）。所以这里只做形状校验
   * 与写库，把完整性检查留给真正需要它的调用点。
   */
  register(bundle: EvidenceBundle, selfCheck?: unknown): void {
    assertSingleStatement(INSERT_BUNDLE_SQL);
    const params: unknown[] = [
      bundle.bundle_id,
      bundle.task_id,
      bundle.produced_by_role,
      bundle.bundle_type,
      JSON.stringify(bundle.artifacts),
      selfCheck === undefined ? null : JSON.stringify(selfCheck),
      this.#now(),
      bundle.produced_by_model_family,
      JSON.stringify(bundle.claims),
      JSON.stringify(bundle.honesty_boundaries),
    ];
    assertParamCount(INSERT_BUNDLE_SQL, params);
    this.#exec(INSERT_BUNDLE_SQL, params);
  }

  /**
   * 声明路径 → 磁盘上的绝对路径（三条口径见 declaredInsideRoot 的注释）。
   * 越界【抛错】而不是返回一个可疑路径：调用方拿到路径就会去读，拒绝必须在这里做。
   */
  resolveDeclaredPath(declared: string): string {
    return declaredInsideRoot(this.#root, this.#baseDir, declared);
  }

  /**
   * 完整性对账：包里声明的每个 artifact，磁盘上那份的 sha256 与 bytes 是否相符。
   *
   * 三条判据分别对应三种不同的事故，合并成一个布尔就分不出修法：
   *   missing      —— 文件被删/搬走：修备份或重跑产出；
   *   size_mismatch—— 声明写错或写入被截断；
   *   hash_mismatch—— 内容被改过（篡改，或产出后又动了那个文件）。
   *
   * 【一个都不 checked 时判 false】：artifacts 为空数组的包，every() 会恒真，
   * 于是「一个字节都没提交的空包」被报成完整 —— 那正是 §8.2 第 2 条要拦的情形。
   * 空包是合法的（有些交接只有主张没有文件），但它不能算「完整性已验证」，
   * 所以 ok=false 且 failures 里放一条 cause: "missing" 的合成项来把话说清楚。
   */
  verify(bundle: EvidenceBundle): VerifyReport {
    const failures: VerifyFailure[] = [];
    let checked = 0;
    let skipped = 0;
    for (const a of bundle.artifacts) {
      // 外链不参与磁盘对账：它没有「本地那一份」可比（§8.1 允许外链类依据）。
      // 计入 skipped 而不是静默 continue —— 理由见 VerifyReport.skipped。
      if (isExternalLink(a.path)) {
        skipped += 1;
        continue;
      }
      const p = this.resolveDeclaredPath(a.path);
      if (!existsSync(p)) {
        failures.push({ path: a.path, cause: "missing" });
        continue;
      }
      checked += 1;
      const st = statSync(p);
      if (!st.isFile()) {
        failures.push({ path: a.path, cause: "missing" });
        continue;
      }
      if (st.size !== a.bytes) {
        failures.push({
          path: a.path,
          cause: "size_mismatch",
          declared: a.bytes,
          actual: st.size,
        });
        continue;
      }
      const actual = sha256File(p);
      if (actual !== a.sha256) {
        failures.push({
          path: a.path,
          cause: "hash_mismatch",
          declared: a.sha256,
          actual,
        });
      }
    }
    if (bundle.artifacts.length === 0) {
      failures.push({
        path: "(本包没有任何制品)",
        cause: "missing",
      });
    }
    // 【一条都没比对过 ⇒ 不算验证通过】。这一维覆盖两种包：完全没有制品的，以及
    // 制品【全是外链】的。后者尤其要说清理由：外链那一份内容在对方服务器上，
    // 提交证据之后还能被改掉 —— schema 里那条 sha256 因此是装饰性的（永远无从比对）。
    // 于是「全部依据都是外链」的包恰恰是【最不可验证】的那种，绝不能读成 ok=true。
    // 正确的修法就是把外链内容快照成本地制品（证据包的本分正是把内容钉住）。
    return {
      ok: failures.length === 0 && checked > 0,
      failures,
      checked,
      skipped,
    };
  }
}

/** 只用于测试与诊断：读回一个已落盘制品的内容。 */
export function readArtifact(path: string): Buffer {
  return readFileSync(path);
}

/** 供 SSE/回放用的相对化（把绝对路径折回 root 相对，避免把用户主目录泄给前端）。 */
export function relativize(root: string, path: string): string {
  assertInsideRoot(root, path);
  return relative(resolve(root), resolve(path)).split(sep).join("/");
}
