/**
 * 开发服务器：让 web 渲块在这台机器上跑起来看（本机 Electron 壳装不上，见 memory）。
 *
 * 职责与生产装配【分界明确】：
 *  - 生产里，签名代理住在 Electron 主进程（desktop/src/main/channels.ts），
 *    渲块只能拿到白名单 IPC；本服务器是它的【离线替身】，干同一件事——
 *    拿本机部署 token 给每个请求签名、代理到 Hub，渲块永远碰不到 token。
 *  - 渲块（public/ 下的静态浏览器 JS）只 fetch 本服务器导出的 /api/*，没有对
 *    Hub 的直接访问，也不 import SQLite（biome noRestrictedImports 挡着）。
 *
 * ⚠ 这不是生产者成品：它是把「渲块 + 签名代理」这条链拉到这台能点的那一步；
 *    空白 token 时签名全 401，由渲块把「未配置」显示成连接错误而非假数据。
 */
import { createServer, request as createRequest } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
// public/ 是包根下的目录（不在 src/ 里，所以不会被 tsc 的 rootDir 管着、也不 emit）。
const PUBLIC = join(ROOT, "packages/web/public");
// /src/ 与 /vendor/ 两个虚拟挂载点：见 serveModule 的注释。
const MOUNTS: Record<string, string> = {
  "/src/": join(ROOT, "packages/web/src"),
  "/vendor/contracts/": join(ROOT, "packages/contracts/src"),
  "/vendor/zod/": join(ROOT, "node_modules/zod"),
};

const HUB = { host: "127.0.0.1", port: Number(process.env.HUB_PORT ?? 8787) };
const TOKEN = process.env.ORG_TOKEN ?? "";
const PORT = Number(process.env.WEB_PORT ?? 9797);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * 签名实现在 dev-sign.ts（同目录）。拆出去的理由写在那边文件头：
 * 这个文件末尾有 server.listen()，测试 import 不进来，而那份规范串【必须有测试】。
 */
import { devSign } from "./dev-sign.js";

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c: string) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/api/")) { serveStatic(url.pathname, res); return; }
  proxy(url, req, res);
});

/** /api/xxx → Hub 的 /xxx，带上本机部署 token 的签名。渲块永远到不了 Hub，也到不了 token。 */
function proxy(url: URL, req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  // 签名用带 query 的整串 target，不是 pathname —— hub 的鉴权签的就是原始 target
  // （app.ts 里 HubRequest.target 那段：拿剥过 query 的 path 去签名 ⇒ `/events?cursor=17`
  //  恒 401 ⇒ 断线续订整条死）。所以这里不能「先把 query 摘掉再签」。
  const target = url.pathname.slice("/api".length) + url.search;
  const m = (req.method ?? "GET").toUpperCase();
  const send = (body: string) => {
    const up = createRequest({ host: HUB.host, port: HUB.port, path: target, method: m, headers: devSign(m, target, body) }, (r) => {
      const ct = r.headers["content-type"] ?? "application/json; charset=utf-8";
      // 一律按流透传（SSE 的 GET /events 靠这个才活着：先攒成字符串等于等连接关闭，
      // 界面会一直空白。普通 JSON 也是流，多这一致性没有代价）。
      res.writeHead(r.statusCode ?? 502, { "content-type": ct, "cache-control": "no-cache" });
      r.pipe(res);
      // 浏览器关掉页签 / 切走视图 ⇒ 必须把上游一起拆掉。
      // SSE 上游是一条【长期挂着的订阅】（sse.ts 的 finally 里那次 sub.close() 是
      // 本仓认定的唯一回收证据），而它只有在流被销毁时才走得到 finally。
      // 漏了这一行 ⇒ 每刷新一次页泄漏一条订阅，且症状是「什么都没坏」。
      const abort = () => { r.destroy(); up.destroy(); };
      res.on("close", abort);
      r.on("error", abort);
    });
    up.on("error", (e: Error) => fail(res, e));
    if (body) up.end(body);
    else up.end();
  };
  if (METHODS_WITH_BODY.has(m)) {
    readBody(req).then(send, (e: unknown) => fail(res, e));
  } else {
    send("");
  }
}

function fail(res: import("node:http").ServerResponse, e: unknown) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
}

function serveStatic(pathname: string, res: import("node:http").ServerResponse) {
  const mod = serveModule(pathname, res);
  if (mod) return;
  const p = pathname === "/" ? "/index.html" : pathname;
  const file = join(PUBLIC, p);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end("forbidden"); return; }
  if (!existsSync(file)) { res.writeHead(404); res.end("not found: " + p); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

/**
 * 把【真正的 TS 模块】当 ESM 喂给浏览器：/src/** → packages/web/src，
 * /vendor/contracts/** → packages/contracts/src，/vendor/zod/** → node_modules/zod。
 *
 * 为什么要这一层：packages/web/src/hub/projection.ts 是【已测过】的那份投影纪律
 * （seq 跳号 ⇒ stale ⇒ 重拉快照；收件箱角标的水位线与「宁可不显示也不显示 0」）。
 * 在 public/app.js 里用裸 JS 重写一遍，就是本仓反复记过的那个形状 —— 两份必然漂移
 * （0006 §7 第 55、56 条）。所以浏览器加载的是同一个源文件，而不是它的抄本。
 *
 * 三件翻译，全在这一个函数里：
 *  ① .ts 过 node:module 的 stripTypeScriptTypes（剥类型、保留行位，source map 大致对得上）；
 *  ② `@opc/contracts` 这个裸名浏览器解不出（import map 也解不出，它不带扩展名）
 *     ⇒ 改写成 /vendor/contracts/index.js；
 *  ③ zod 是自带 .js 扩展名的 ESM ⇒ 挂到 /vendor/zod/ 下按相对路径自洽解析。
 *
 * ⚠ 这只在【开发服务器】成立：产物是逐文件现剥的，没打包、没 tree-shake。
 *    生产那条路是 Electron + 打包器（本机装不上，见 memory），不是这里。
 */
function serveModule(pathname: string, res: import("node:http").ServerResponse): boolean {
  const mount = Object.keys(MOUNTS).find((m) => pathname.startsWith(m));
  if (mount === undefined) return false;
  const dir = MOUNTS[mount];
  if (dir === undefined) return false; // noUncheckedIndexedAccess：键是刚 find 出来的，理论上到不了
  const base = resolve(dir, pathname.slice(mount.length));
  if (!base.startsWith(dir)) { res.writeHead(403); res.end("forbidden"); return true; }
  // TS 源树里的相对 import 写的是 `./api.js`（NodeNext 的写法：源码里带 .js，
  // 因为编译产物就叫 .js）。浏览器照原样要 /vendor/contracts/api.js，而磁盘上是
  // api.ts —— 这一层 .js→.ts 的回落就是把 tsc 已经在做的那件事，原样做给浏览器看。
  const file = existsSync(base) || !base.endsWith(".js") ? base : base.slice(0, -3) + ".ts";
  if (!existsSync(file)) { res.writeHead(404); res.end("not found: " + pathname); return true; }
  let src = readFileSync(file, "utf8");
  if (file.endsWith(".ts")) {
    src = stripTypeScriptTypes(src, { mode: "strip" });
  }
  // 裸模块名浏览器解不出（不是「没有 import map」的问题 —— import map 也帮不上，
  // 因为这些包 exports 里的键不带扩展名，映射不到一个具体 URL）。逐个改写成本服务器的挂载点。
  src = src
    .replaceAll('from "@opc/contracts"', 'from "/vendor/contracts/index.js"')
    .replaceAll('from "zod"', 'from "/vendor/zod/index.js"');
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
  res.end(src);
  return true;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`运营看板已在 http://127.0.0.1:${PORT} 启动（Hub=${HUB.port}，token 已配置=${TOKEN !== ""}）`);
});
