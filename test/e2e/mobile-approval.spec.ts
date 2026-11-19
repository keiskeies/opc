/**
 * Task 4.7 的出口门工件：移动端这一侧真实可达的那两件事（O11 / O12 / O13）。
 *
 * ── 射程（这条 spec 到底证到哪一格）────────────────────────────────
 * 真 Hub 进程（boot 走生产默认装配：真写队列、真 tokens.ts、真 decide 写路径）、
 * 真 TCP 连接、真 HTTP 状态码，两条凭据各走各的门：
 *  ① 可逆卡的一次一签：桌面侧（回环 + HMAC）POST /approvals/:id/token 签票 201
 *     → 远程侧（非回环对端 + x-opc-approval-token 头）POST /approvals/:id 兑换并批准 200
 *     → 卡片真的变 approved、任务真的走 CHARTER_PENDING → CHARTER_APPROVED
 *     → 同一张票第二次打过来被拒 401（判据是 already_used）。
 *  ② 不可逆卡的两道防线，位置不同、各测各的（这是本文件最要紧的一格）：
 *     · 签发侧：桌面侧给不可逆卡签票 → 403（precheckIssue 在 INSERT 之前就挡，
 *       「不可逆在签发侧根本签不出票」——这是 §11.4 的第一道、也是主防线）；
 *     · 兑换侧：一张【已经躺在库里的】不可逆卡票打远程 decide → 403
 *       （redeemToken 在烧票之前判 irreversible_denied，票不被消耗）。
 *     这两格是【两格不同的防线】，位置一个在 mint、一个在 redeem。只测兑换侧会让
 *     「签发侧就挡」这句话没有读者；只测签发侧则挡不住「票经由别的路径（未来的
 *     建卡同事务签发）进了库」那一格。所以两条都断言，且各自单独成段。
 *
 * ── 刻意偏离（必须说清，不许假装）────────────────────────────────
 * 这一发【不走浏览器点击】，走真 Hub + 真 fetch。理由不是偷懒，是结构性的：
 *  ① packages/web 今天没有任何一处消费 x-opc-approval-token（全仓 grep 只有
 *     hub 侧的签发/兑换实现），移动端界面【没有】那条按钮路径可点；
 *  ② 桌面 HMAC 密钥按设计只在 Hub 进程内存里（auth.ts 文件头），浏览器页面
 *     【永远拿不到】签名材料 —— 远程这一侧的身份本来就是一个【没有本机密钥的
 *     第二进程】，用 fetch 扮演它不是降级，是那条路的真实形状。
 * 「远程对端」不是 mock：Hub 以 bind=0.0.0.0 监听（这正是 --bind 判据兑现的那格：
 * 非回环要求一次性 token 通道已装配，buildHubDeps 恒装），spec 从本机自己的
 * 非回环 IPv4 连进来 —— 服务端 socket 看到的 peer 就是那块网卡的 IP，
 * isLoopbackAddress 判 false，走的正是手机在同一 WiFi 上会走的那一条分支。
 *
 * ── 不含哪几格（与上面同等的诚实义务）────────────────────────────
 *  · 飞书沙箱真投递（Task 4.7 的另一半「手工验证记录」）：卡在真 app_secret
 *    凭据上，与 playwright 无关，本文件一行都不碰。
 *  · 真机手机：对端是同机自连的 LAN IP，不是物理设备；差别只在链路，不在分支。
 *  · mint 路由上的【第二道门】（app.ts mintToken 顶上那句 peer 检查）：一个远程
 *    请求走 HTTP 永远先被 remoteTokenAuth（第一道门）弹掉，第二道门端到端不可达
 *    —— app.ts:854 那段论证与 tokens-route.test.ts 的变异读数都写明了这件事。
 *    本文件断言「远程自签 401」，它测的是【第一道门】，不冒充测第二道。
 *  · 桌面端回环批准路径（那是 ceo-loop.spec.ts 的射程）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openDb } from "../../packages/hub/src/db/driver.js";
import { migrate } from "../../packages/hub/src/db/migrate.js";
import { HEADER_APPROVAL_TOKEN } from "../../packages/hub/src/http/app.js";
import { signedHeaders } from "../../packages/hub/src/http/auth.js";
import {
  hashToken,
  issueToken,
  newApprovalToken,
} from "../../packages/hub/src/http/tokens.js";
import type { BootResult } from "../../packages/hub/src/serve/assemble.js";
import { boot } from "../../packages/hub/src/serve/assemble.js";
import { HEARTBEAT_FLOOR_MS } from "../../packages/hub/src/serve/config.js";

/**
 * 端口写死而不是 0：与 ceo-loop 的 8899 错开（workers:1 是串行，不撞，但两个
 * 固定数各自可查）。0.0.0.0 绑定在本机实测可行（8898/8902/8903 都能起）。
 */
const HUB_PORT = Number(process.env["E2E_MOBILE_HUB_PORT"] ?? 8902);
const DESK_TOKEN = "e2e-mobile-token-not-a-secret";

/**
 * 远程对端从哪连进来：本机第一块【非 internal】IPv4 网卡地址（排除链路本地段）。
 * 连这个地址时服务端看到的 peer 就是它自己 —— 同机自连也要走真实路由表那一跳，
 * 于是 remoteTokenAuth / mintToken 看到的 peer 与真手机同形。
 * ⚠ 找不到任何非回环 IPv4（机器只挂着回环）⇒ 直接抛并说明，而不是退回 127.0.0.1：
 *   退回去发的就是【桌面请求】，整个文件的断言会绿在一条假话上。
 */
function lanIp(): string {
  const forced = process.env["E2E_LAN_IP"];
  if (forced !== undefined && forced.trim() !== "") return forced.trim();
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (
        a.family === "IPv4" &&
        !a.internal &&
        !a.address.startsWith("169.254.")
      ) {
        return a.address;
      }
    }
  }
  throw new Error(
    "找不到本机非回环 IPv4：这条 spec 的『远程侧』必须从一个非回环地址连进来，" +
      "否则服务端判的是回环分支，测的就不是远程。可用 E2E_LAN_IP 显式指定。",
  );
}

const NOW = Date.now();

/**
 * 一次启动攒下的票原文。库里只有 sha256（tokens.ts 文件头那条立场），
 * 原文【只存在于签发那一刻的调用方手里】—— 所以这两格都必须登记在这里，
 * 而签发点全文件唯一：rev 走 HTTP 201 响应体，irr 走 makeDb 里那一发直签。
 */
const tickets = new Map<string, string>();

/**
 * 一份真库 + 两张卡：
 *  · apv-rev：可逆章程卡（card_key 与 engine/charter.ts 的 CHARTER_CARD_KEY 同值，
 *    任务停在 CHARTER_PENDING —— 这样兑换后的 decide 走的是真引擎写路径
 *    approveCard：认领 + CHARTER_PENDING→CHARTER_APPROVED 状态边 + 两条审计）。
 *  · apv-irr：不可逆卡（approval_type=irreversible_action，§11.4 的第一判据）。
 *    它的票是【绕过 mint、直接 issueToken 落库】的 —— 今天的 HTTP 签不出它
 *    （这正是要断言的第一道防线），而 redeem 侧那一判【只有票已在库时才可达】
 *    （未来建卡同事务直签 issueToken 那条路，real-deps.ts:587 写明了它存在的计划）。
 */
function makeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "opc-e2e-mobile-"));
  const path = join(dir, "hub.db");
  const db = openDb(path);
  migrate(db);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('task-rev', '可逆：等 CEO 签章程', 'CHARTER_PENDING', 'intake', 'intake', ?, ?)",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('task-irr', '不可逆：删生产库', 'CHARTER_PENDING', 'intake', 'intake', ?, ?)",
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, status, created_at, card_key) " +
      "VALUES ('apv-rev', 'task-rev', 'charter', '章程提案：远程批它', '{\"irreversible\": false}', 'pending', ?, 'charter:proposal')",
  ).run(NOW);
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, status, created_at) " +
      "VALUES ('apv-irr', 'task-irr', 'irreversible_action', '删生产库：远程不许了断', '{\"irreversible\": true}', 'pending', ?)",
  ).run(NOW);
  // 绕过 HTTP 直签一张不可逆票（见上面 makeDb 文件头那句「只有票已在库时才可达」）。
  // 用的是生产同一个 issueToken，不是另造一份形状。
  const irrRaw = newApprovalToken();
  issueToken(db, { rawToken: irrRaw, approvalId: "apv-irr", nowMs: NOW });
  tickets.set("apv-irr", irrRaw);
  db.close();
  return path;
}

let hub: BootResult | null = null;
let shutdownHub: (() => Promise<void>) | null = null;
let dbPath = "";
let lan = "";

test.beforeAll(() => {
  dbPath = makeDb();
  lan = lanIp();
});

test.beforeAll(async () => {
  hub = await boot(
    {
      dbPath,
      port: HUB_PORT,
      noBackup: true,
      heartbeatMs: HEARTBEAT_FLOOR_MS,
      // 0.0.0.0 = 显式把这台 Hub 摆到非回环网卡上 —— bind.ts 判据要 remoteApprovalsWired，
      // 而 buildHubDeps 恒装 redeem+issue（assemble.ts:1168 那条），所以放行的是【判据本身】。
      bind: "0.0.0.0",
    },
    {
      log: (m) => console.log("[hub] " + m),
      warn: (m) => console.warn("[hub] " + m),
    },
    { token: DESK_TOKEN },
  );
  if (!hub.ok) {
    throw new Error("Hub 起不来：" + hub.message + (hub.hint ?? ""));
  }
  shutdownHub = hub.shutdown;
});

test.afterAll(async () => {
  await shutdownHub?.();
  if (dbPath !== "")
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
});

const desk = (p: string): string => `http://127.0.0.1:${HUB_PORT}${p}`;
const phone = (p: string): string => `http://${lan}:${HUB_PORT}${p}`;

/** 桌面侧 = 回环 + HMAC（auth.ts 的规范串，真签名）。 */
async function deskFetch(
  method: "GET" | "POST",
  target: string,
  body = "",
): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> {
  const headers: Record<string, string> = {
    ...signedHeaders(DESK_TOKEN, {
      method,
      target,
      body: method === "POST" ? body : "",
      now: Date.now(),
    }),
  };
  if (method === "POST") headers["content-type"] = "application/json";
  const r = await fetch(desk(target), {
    method,
    ...(method === "POST" ? { body, headers } : { headers }),
  });
  return {
    status: r.status,
    json: () => r.json() as Promise<Record<string, unknown>>,
  };
}

/** 手机侧 = 非回环 + 一次性票头，没有任何 HMAC 材料（它也【拿不到】）。 */
async function phoneFetch(
  target: string,
  ticket: string,
  body = JSON.stringify({ resume: "approve" }),
): Promise<{ status: number; json: () => Promise<Record<string, unknown>> }> {
  const r = await fetch(phone(target), {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      [HEADER_APPROVAL_TOKEN]: ticket,
    },
  });
  return {
    status: r.status,
    json: () => r.json() as Promise<Record<string, unknown>>,
  };
}

async function cardStatus(id: string): Promise<string | null> {
  for (const status of ["approved", "pending"]) {
    const r = await deskFetch("GET", `/approvals?status=${status}&limit=1000`);
    const found = (
      (await r.json()).approvals as { id: string; status: string }[]
    ).find((a) => a.id === id);
    if (found !== undefined) return found.status;
  }
  return null;
}

test("①可逆卡：远程签票→兑换→approved，同一张票第二次用被拒（一次一签）", async () => {
  // 桌面侧签票：回环 + HMAC ⇒ 201，票原文只出现在这一次响应体里（tokens.ts 的立场）。
  const mint = await deskFetch("POST", "/approvals/apv-rev/token");
  expect(mint.status).toBe(201);
  const revTicket = String((await mint.json()).token);
  expect(revTicket.length).toBeGreaterThan(20);
  tickets.set("apv-rev", revTicket);

  // 手机侧兑换 + 批准：非回环对端 + 票头，跳 HMAC 直达【同一个】 decide handler。
  const decide = await phoneFetch("/approvals/apv-rev", revTicket);
  expect(decide.status).toBe(200);
  const body = await decide.json();
  expect(body.ok).toBe(true);
  expect(body.replayed).toBe(false); // 首次决策，不是幂等重放

  // 卡片与任务都真的动了（真引擎写路径：认领 + 状态边同事务）。
  await expect(cardStatus("apv-rev")).resolves.toBe("approved");
  const task = await deskFetch("GET", "/tasks/task-rev");
  expect((await task.json()).status as string).toBe("CHARTER_APPROVED");

  // 一次一签的反面证据：同一张票第二次打过来 ⇒ 401。
  // 判据是 already_used，而【响应体刻意不带 reason】（app.ts tokenRejectBody：
  // 凭据族只回一句 unauthorized，不让攻击者拿「你差哪一步」的预言机）——
  // 所以 reason 这一维在这里断言的是【库】：票的 used 位已置 1，且这条票只对应一行。
  const second = await phoneFetch("/approvals/apv-rev", revTicket);
  expect(second.status).toBe(401);
  expect((await second.json()).error as string).toBe("unauthorized");
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT used FROM im_tokens WHERE token = ?")
      .get(hashToken(revTicket)) as { used: number } | undefined;
    expect(Number(row?.used)).toBe(1);
  } finally {
    db.close();
  }
});

test("②不可逆卡：签发侧 403 签不出票（票没被造出来），兑换侧 403 且票不烧（卡片停 pending）", async () => {
  // ── 防线一：签发侧。桌面侧【有合法 HMAC】也签不出这张票 ⇒ 403 + 带 reason。──
  // mint 只认回环对端（远程自签另有门，见文件头「不含」那一格），所以这一发从
  // 127.0.0.1 打 —— 挡住它的不是鉴权，是 precheckIssue 的 §11.4 判据（403 而非 401
  // 本身就是证据：凭据没问题，是这件事不许做）。
  const mint = await deskFetch("POST", "/approvals/apv-irr/token");
  expect(mint.status).toBe(403);
  expect((await mint.json()).reason as string).toBe("irreversible_denied");
  // 「签不出票」要断到【库里没多出一行】，而不是只断状态码：
  // 状态码 403 而票照签，防线就是纸糊的。
  const db = openDb(dbPath);
  try {
    const issued = db
      .prepare("SELECT COUNT(*) AS c FROM im_tokens WHERE approval_id = ?")
      .get("apv-irr") as { c: number | bigint };
    // 只有 beforeAll 里那发【绕过 HTTP】的直签票存在（它是防线二的分母），HTTP 一行都没签出。
    expect(Number(issued.c)).toBe(1);
    const used = db
      .prepare("SELECT used FROM im_tokens WHERE approval_id = ?")
      .get("apv-irr") as { used: number };
    expect(Number(used.used)).toBe(0); // 兑换被拒【不烧票】（tokens.ts:304 同一立场）
  } finally {
    db.close();
  }

  // ── 防线二：兑换侧。票已在库（makeDb 直签的那张，原文一直攥在"手机"手里）
  //    打远程 decide ⇒ 同样 403。──
  // 这一发不是把防线一重写一遍：它测的是 redeemToken 里【烧票之前】的那一判，
  // 覆盖的是「票经由非 HTTP 路径进了库」时远程仍然批不掉这一格。
  const redeem = await phoneFetch(
    "/approvals/apv-irr",
    tickets.get("apv-irr") ?? "",
  );
  expect(redeem.status).toBe(403);
  expect((await redeem.json()).reason as string).toBe("irreversible_denied");

  // 卡片停在 pending，一行没被改动（「移动端只做决定、不可逆不许在手机上了断」的落点）。
  await expect(cardStatus("apv-irr")).resolves.toBe("pending");
  const task = await deskFetch("GET", "/tasks/task-irr");
  expect((await task.json()).status as string).toBe("CHARTER_PENDING");

  // 顺带钉第一道门的远程自签那一面：手机给自己签票 ⇒ 401（远程没有 mint 授权）。
  // ⚠ 这一发测的是 remoteTokenAuth 那道白名单（第一道门），不是 mintToken 顶上
  //   的第二道门 —— 后者端到端不可达，见文件头「不含」。
  const selfMint = await fetch(phone("/approvals/apv-rev/token"), {
    method: "POST",
  });
  expect(selfMint.status).toBe(401);

  // 兑换被拒【不烧票】（tokens.ts:304 同一立场）：上面 403 之后 used 位仍是 0。
  const dbAfter = openDb(dbPath);
  try {
    const used = dbAfter
      .prepare("SELECT used FROM im_tokens WHERE approval_id = ?")
      .get("apv-irr") as { used: number };
    expect(Number(used.used)).toBe(0);
  } finally {
    dbAfter.close();
  }
});
