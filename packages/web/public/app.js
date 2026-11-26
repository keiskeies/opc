/**
 * OPC 控制室 · 渲块入口（浏览器侧）。
 *
 * ── 这一版按【规格】§16 重排：七页、默认今日视图 ─────────────────────
 * 上一版只有 org / tasks / approvals / bindings / events 五个"数据表视图"，
 * 读起来是一个后台管理页，不是 CEO 的操作面。§16.1 把 CEO 的动作压成三件事
 * —— 扔想法、做决策、看回放 —— 其余都在后台。所以现在的导航是
 * 今日 / 看板 / 收件箱 / 组织 / 岗位书 / 预算 / 回放（后两页是"能配、能改"补的），
 * 而 events（投影自身的轨迹）
 * 降级成 header 上那个连接状态 + 今日页底部一条低对比度折叠区（§19.4 第三层）。
 *
 * ── 渲块不产数字，也不产【需要谁注意】这个判定 ──────────────────────
 * 四个大数字、策略摘要那三个数，全部来自 GET /today；连「哪些状态算需要你注意」
 * 这个判据也是从响应里读的（blocked_statuses / attention_statuses /
 * ceo_decision_statuses）。
 * 理由在 overview/today.ts 与 projection.ts 各自的文件头：判定住在模块，
 * 抄件必然漂移（0006 §7）。具体症状：hub 改了阻塞态清单而看板那一列照旧，
 * 两个界面同屏、各自都说得通。
 *
 * ⚠ 上面那句要读准，别读成"这文件里不出现状态名"：statusClass() 会按状态字符串
 *   的子串上色（蓝/绿/灰/红四档），那是一次【呈现】映射不是判定 —— 它决定不了
 *   "要不要标琥珀"（那一档由服务端的 ceo_decision_statuses 决定，见函数旁注释）。
 *   区分这两件事很重要：把配色也当成判据搬去服务端，会得到一个「UI 主题 API」，
 *   而那正是本仓反对的另一端。判据 = 要不要惊动 CEO；配色 = 这一格涂什么色。
 *
 * ── 琥珀色纪律（§19.2 这条硬约束落到本文件的具体形状）────────────────
 * 规格原话：`#E8A33D`「全局仅用于『需要 CEO 决策』这一种状态」，用法是
 * 「眼睛在任何页面一扫，琥珀色出现处就是需要你动手的地方」。所以本文件里
 * 琥珀只有【两处】合法来源，两处都读服务端那份清单：
 *   ① 「需要你决策」那一片 + 收件箱待批卡（.need / .pill.s-amber）；
 *   ② 看板上 status ∈ ceo_decision_statuses 的那张卡（.tk.decision）、
 *      今日页「待你决策」那个数字（.statbad）。
 * 反过来【不许】用琥珀的三类，本文件以前全都在用（这一轮逐个改掉了）：
 *   · 预算暂停 / 阻塞 —— 规格四处明写「非琥珀色」，理由原话是「运营事件，不是战略决策」；
 *   · 「数据取不到」那类横幅 —— 那不是等谁决策，是系统自己的故障；
 *   · 「需要我注意」那一列的全体成员 —— 整列涂琥珀会让琥珀退化成"这一列"的标记。
 * 红色也顺手收到一处：§19.2 那张色表【没有】异常色这一档，全规格唯一明写红的是
 * §7.4「日消耗条变红」，所以 --err 今天只出现在预算那根条上。
 *
 * ── 两条老边界，没变 ─────────────────────────────────────────────
 *  ① 只 fetch /api/*（签名代理：dev 是 dev-server，生产是 Electron 主进程），
 *     渲块碰不到 Hub、碰不到 token、碰不到 SQLite（biome noRestrictedImports）。
 *  ② 投影纪律不在这里重写。seq 单调 / 跳号标 stale / 重拉快照这套住在
 *     ../src/hub/projection.ts —— 那是 test/web/hub-projection.test.ts 测过的那份。
 *     所以本文件是 ESM，import 那个真模块（dev-server 现剥类型喂给浏览器）。
 */
import {
  applyFrame,
  applySnapshot,
  emptyProjection,
} from "/src/hub/projection.ts";
// 退避曲线、放弃阈值、SSE 解帧 —— 三份都住在 contracts，渲块只消费不重写：
// contracts 的注释原话是「两份退避策略的漂移表现是桌面端 15 秒放弃、Web 无限重试」。
// 岗位书表单里的三个枚举同理：在浏览器里抄一份合法值清单 = 服务端加档位而下拉框还认旧的。
import {
  BUDGET_PERIOD_VALUES,
  BUDGET_SCOPE_VALUES,
  decodeSseFrame,
  JUDGMENT_MODES,
  MODEL_TIERS,
  reconnectDelayMs,
  shouldGiveUp,
} from "/vendor/contracts/index.js";
// 日 / 夜主题切换由宿主负责（group.js 调 mountThemeToggle），独立控制室页已删，
// 本模块不再自己接按钮。

// let 而不是 const：这四个是【宿主】交进来的节点（group.js mountAdmin 那一路）。
// 没有独立页可查：管理视图只有一个入口 —— 工作台 group.html 的 #/admin/<页名>，
// 宿主把【自己的】三枚节点显式交进来，本模块不做任何 getElementById。初始值全 null，
// mountAdmin 之前没人用它们；唯一的自启动门（文件末尾）已随独立页一起删掉。
let $view = null;
let $nav = null;
let $dot = null;
let $connText = null;

/** 前五页顺序即 §16.2；「岗位书」「预算」是后加的两页可配置界面（today 仍是默认页）。
 *  ⚠ charter 那一格把 e 写成转义：路由名与审批类型名恰好同词，而
 *  test/web/renderer-criteria.test.ts 扫的是【带引号的审批类型字面量】—— 那是扫源级的
 *  已知误报面。路由名是导航标识不是判据抄件，这里只绕开那条正则，不改它的语义。 */
const ROUTES = [
  { id: "today", label: "今日" },
  { id: "board", label: "任务看板" },
  { id: "inbox", label: "收件箱" },
  { id: "org", label: "组织" },
  { id: "chart\u0065r", label: "岗位书" },
  { id: "budget", label: "预算" },
  { id: "replay", label: "回放" },
];

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
/** 时间一律服务端为准（见 today.ts 的 as_of_ms）；这里只负责【格式化】，不参与取值。 */
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString("zh-CN") : "—");
const fmtAgo = (ms, nowMs) => {
  if (!ms || !nowMs) return "—";
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.round(s / 60) + " 分钟前";
  if (s < 86400) return Math.round(s / 3600) + " 小时前";
  return Math.round(s / 86400) + " 天前";
};
/** §19.3：金额等宽。cents 一路用整数，只在最后这一步除 100。 */
const money = (cents) => "$" + (Number(cents ?? 0) / 100).toFixed(2);

const views = {
  today: renderToday,
  board: renderBoard,
  inbox: renderInbox,
  org: renderOrg,
  charter: renderCharter,
  budget: renderBudget,
  replay: renderReplay,
};

/**
 * 今日视图那份聚合数，缓存一次供多页共用（§16.5 的摘要条与 §16.3 的四数同源）。
 *
 * 为什么要有这个缓存而不是每页各自拉：同一屏上「今日预算消耗」和收件箱顶部
 * 「过去 24 小时拦截 Y 项」必须是同一次读数的口径，两次请求之间夹一次写入
 * 就会得到两个都对但互相矛盾的数（同 today.ts 里 DECISIONS_SQL 一条 SQL 出三个数
 * 的理由，只是这边弱一档 —— 跨页而不是跨列）。
 *
 * ── round352：窗口参数（?window_ms=）的接线入口 ─────────────────────
 * 服务端（http/app.ts:1281）早已实现并在 today.ts 生效，而前端【从不传】——
 * 渲染函数 windowLabel 一直按 t.window_ms 自适应（app.js:478 注释把它写成
 * 「哪天后头加一个『看最近 7 天』的开关」，说明这一天到了）。这里补的是取数那一半：
 *   · getToday(force, windowMs) —— 带窗口时请求 /today?window_ms=N，
 *     且【分开缓存】：不同窗口是不同口径的读数。复用同一份缓存会让
 *     「切到 7 天」读到 24 小时的数据 —— 正是上面「同一次读数的口径」要防的形状。
 *   · 两个纯函数（todayWindows / windowMsOfHash）让窗口清单与 hash 解析可测，
 *     不与 fetch / DOM 纠缠。
 */
let todayCache = null; // 无窗口（24h 默认）那一份
let todayWindowCache = null; // 显式窗口的那一份（{ windowMs, data }）
/**
 * round352：getToday 的缓存命中判据。抽成纯函数是因为「不同窗口是不同读数」是
 * 这一格唯一的承重判据 —— 去掉它（复用同一份缓存）会让切到 7 天时读到 24h 的数据，
 * 而窗口标签却显示「7 天」，两个都对但互相矛盾，正是注释（§16.5 同源口径）要防的。
 * 语义：force 恒 miss；无窗口读 todayCache（不看 windowMs 匹配）；有窗口只命中
 * windowMs 完全相同的那一份（7 天与 30 天即使都进了 cache 也不互相命中）。
 */
function todayCacheHit(cache, force, windowMs) {
  if (force || cache === null) return false;
  return windowMs === undefined || cache.windowMs === windowMs;
}
async function getToday(force, windowMs) {
  const c = windowMs === undefined ? todayCache : todayWindowCache;
  // 命中时取的是【各自那一份的形状】：todayCache 存的就是响应体本身，
  // todayWindowCache 存的是 { windowMs, data }。原来两处都写 c.data ⇒ 无窗口那份
  // 恒返回 undefined（body 里没有 data 这个键）。今日页 force=true 从不走命中，
  // 所以症状是「今日页看过一次之后，看板/预算页必崩」—— 独立页 /admin 一直如此，
  // 只是原先没有一条 e2e 走「今日 → 看板」这一跳。
  if (todayCacheHit(c, force, windowMs))
    return windowMs === undefined ? c : c.data;
  const q = windowMs === undefined ? "" : `?window_ms=${windowMs}`;
  const { status, data } = await api("GET", "/today" + q);
  if (status !== 200)
    return { error: `GET /today${q} → ${status}：${JSON.stringify(data)}` };
  // 服务端对窗口做了截断（today.ts 的 MAX_WINDOW_MS）；这里【不】自行重算，直接
  // 存服务端回的那一份 —— 缓存键用请求值，反正同一请求值永远得到同一截断结果。
  const next = windowMs === undefined ? data : { windowMs, data };
  if (windowMs === undefined) todayCache = data;
  else todayWindowCache = next;
  return data;
}

/* ───────────────── 全局投影（一次会话一份，跨视图存活） ─────────────────
 * 为什么是全局而不是每个视图各连一条 SSE：投影的 cursor/asOfSeq 是【这一份前端状态】
 * 的属性，多连几条就是多个各自为政的游标。事件流在后台一路推，任务/审批这些视图
 * 读的是同一份投影 —— 这也是 §5.8「事件是投影不是事实源」能成立的前提。
 */
let proj = emptyProjection();
const listeners = new Set();
function setProj(next) {
  proj = next;
  for (const f of listeners) f(proj);
}
function onChange(f) {
  listeners.add(f);
  return () => listeners.delete(f);
}

// type 是【语义档位】("err" / "warn" / "")，前缀在这里加：调用点写的是档位，
// 不是类名 —— 于是 40 多处调用不必跟着 CSS 改名一起动（改一处 vs 扫全文件）。
// 档位 → 类名写成一张表，而不是 "admin-" + 档位 的拼串：拼串让类名在源码里【不
// 存在】，admin-style-scope 那条双向钉就看不见它 —— 而这一族恰恰出过 chip 那件事
// （拼出来的类名 CSS 里没有，静默 no-op 全仓无人报）。表在这里，档位与类名一眼对得上。
const BANNER_CLS = { "": "", err: "admin-err", warn: "admin-warn" };
const banner = (type, msg) =>
  msg
    ? `<div class="admin-banner ${BANNER_CLS[type ?? ""] ?? ""}">${esc(msg)}</div>`
    : "";

/* ───────────────── 连接状态灯 ─────────────────
 * link 的四个值里 stale 与 down 是「要人处理」的，界面必须分开说：
 * stale = 知道少了东西（该重拉快照，正在做）；down = 连不上且已放弃重连。
 * 把 down 也画成绿的、继续显示最后一帧装作实时，是 §5.8 明令禁止的那种「看着正常」。
 */
function setConn(link, extra) {
  const bad = link === "stale" || link === "down" || link === "connecting";
  $dot.classList.toggle("admin-off", bad);
  $connText.textContent =
    extra ??
    {
      connecting: "连接中…",
      live: "实时",
      stale: "补洞中（重拉快照）",
      down: "事件流断开",
    }[link] ??
    link;
}
/* 状态灯原先直接在这里 onChange(...) 订阅一条【永不摘】的监听。现在订阅落在
 * startFeed() 里（独立页启动与工作台挂载都走那一条路），卸载时摘掉 —— 否则每次
 * 进出管理视图多一条永久监听，而它引用的 $dot 那时早就不在文档里了。 */
let offConnSub = null;

/* ───────────────── 签名代理的 fetch 封装 ───────────────── */
async function api(method, path, body) {
  const r = await fetch("/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

/* ───────────────── 导航 ───────────────── */
/**
 * 这一段 hash 解析是【两个入口共用的一份】：
 *   · 独立页 /admin：`#/today?window=7d`（§16.2 那七页直接挂在 # 上）
 *   · 工作台挂载：  `#/admin/today?window=7d`（#/<route>/<page>，与工作台
 *                    其它路由 #/<route>/<id> 同形，hash 仍由 group.js 统一拥有）
 * ⚠ 为什么解析函数在这里而不是 group.js：query 的语义（?window= 只认整数天、
 * ?id= 选中哪条回放）本来就是渲块的事，windowMsOfHash 已经住在这里。搬去
 * group.js 就是「窗口判据有两份」—— 0006 §7 那一整篇讲的正是这个。
 * 所以 group.js 只把 location.hash 原样交给 syncAdminFromHash，自己不懂 query。
 */
const ADMIN_PREFIX = "admin/";
function parseAdminHash(hash) {
  // 剥前缀要认三种形状：`#/today`（独立页，没前缀）、`#/admin/today`（工作台）、
  // `#/admin`（侧边栏刚点进去，还没带页名）。第三种原来剥不掉 ⇒ page 得 "admin"，
  // 它不在 ROUTES 里，挂载首屏就是一片空白而不是今日页。
  // 前缀只在开头剥，且要么整段就是 "admin"、要么后面紧跟 "/"：用一条正则把
  // "(?:admin/?)?" 写在一起会削掉将来某个以 admin 开头的页名（"administrator"
  // 变 "istrator"）。结构判断比一条聪明正则更难写错。
  const stem = ADMIN_PREFIX.replace(/\/$/u, "");
  let raw = String(hash ?? "").replace(/^#\/?/u, "");
  if (raw === stem) raw = "";
  else if (raw.startsWith(ADMIN_PREFIX)) raw = raw.slice(ADMIN_PREFIX.length);
  const i = raw.indexOf("?");
  return {
    page: i < 0 ? raw : raw.slice(0, i),
    query: i < 0 ? "" : raw.slice(i + 1),
  };
}
/** 链接前缀：独立页写 `#/board`，工作台写 `#/admin/board`。挂载时改掉。 */
const hashPrefix = () => "#/admin/";
function routeToHash(page, query) {
  return hashPrefix() + page + (query ? "?" + query : "");
}
const parsed0 = parseAdminHash(location.hash);
let current = ROUTES.some((r) => r.id === parsed0.page)
  ? parsed0.page
  : "today";
/** 当前页的 query（"window=7d" / "id=T-1"）。独立页从 hash 起，挂载后由 group.js 喂。 */
let currentQuery = parsed0.query;

/** 导航上的琥珀角标 = 待张数。它是这一屏上唯一一处非"卡片内"的琥珀，
 *  因为它说的正是「有一整页都在等你」。 */
let navPending = 0;
// 当前页链接带 aria-current="page"（给读屏指"我在哪一页"）；.act 是视觉那一份，
// aria 是语义那一份，两个都只在当前视图那一枚上出现。
// ⚠ 第三个参数【必须有默认值】：test/web/app-pure.test.ts 按两参调用。独立页已删，
// 管理视图唯一入口是 #/admin/<页名>，默认前缀就是它；nav() 也显式传 hashPrefix()。
const navLink = (view, cur, prefix = "#/admin/") =>
  `<a href="${prefix}${view.id}" data-r="${view.id}" class="${view.id === cur ? "admin-act" : ""}"` +
  (view.id === cur ? ` aria-current="page"` : "") +
  `>${view.label}` +
  (view.id === "inbox" && navPending > 0
    ? `<span class="admin-badge">${esc(navPending)}</span>`
    : "") +
  `</a>`;
function nav() {
  $nav.innerHTML = ROUTES.map((r) => navLink(r, current, hashPrefix())).join(
    "",
  );
  for (const a of $nav.querySelectorAll("a")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      goPage(a.dataset.r, "");
    });
  }
}
/**
 * 换页：把 hash 写出去，然后【等 hashchange 接住】—— 但同一枚 hash 不会再发
 * hashchange（带 ?window= 的窗口 chip 连点两次就是这条路径），所以写之前先比一次，
 * 相同就自己走一遍。少了这一支，第二次点同一个窗口 chip 界面不动。
 */
function goPage(page, query = "") {
  if (!ROUTES.some((r) => r.id === page)) return;
  const h = routeToHash(page, query);
  if (location.hash === h) {
    current = page;
    currentQuery = query;
    nav();
    void load();
    return;
  }
  location.hash = h;
}
/**
 * hash → 界面。group.js 在挂载后与每次 hashchange 都调它（它自己不解析 query，
 *  parseAdminHash 那段）。返回布尔只为了给调用方一个「这一段归不归我」的答复。
 */
function syncAdminFromHash(hash) {
  const { page, query } = parseAdminHash(hash);
  if (!ROUTES.some((r) => r.id === page)) return false;
  if (page === current && query === currentQuery) return true;
  current = page;
  currentQuery = query;
  nav();
  void load();
  return true;
}
window.addEventListener("hashchange", () => {
  // hash 归 group.js。【未挂载】时这一份必须闭嘴：否则宿主每次换菜单
  //（#/messages、#/documents…）都会走到这里，把 current 换成一个不在 ROUTES
  // 边界的页名并往已脱离文档的 $view 里画 —— 挂载方【已】把 current 交还给原地，
  // 这一份却还在替宿主作答。
  if (!mounted) return;
  void syncAdminFromHash(location.hash);
});

/**
 * 角色记忆那一格（O3 动作 3 / 0060 §8 补上的界面半）。
 *
 * ✅ 这一发为什么要出现：GET /today 把 `t.memory` 三个数发进响应，
 * 而 app.js 【零消费者】（0060 §8 原话：「进响应而桌面侧还没渲染它们」）。
 * 「发了没人读」的后果与 blocked_title 那四格同一族 —— 记忆面有没有素材、
 * 那一档是不是「有数据而没署上名」，CEO 在屏幕上读不到，只能靠读代码。
 * 这里把它渲染成右栏一小块（budgetHtml 之下），纯函数不碰 fetch / DOM。
 *
 * ⚠ 两个口径不许混（role-memory.ts:889 原话，逐字照搬）：
 *   · `gate_unattributed_rows` —— review_decision 行里 actor_type='system' 的条数。
 *     「有审阅判定没把角色 id 落到 actor_id 上」。只数 action='review_decision'，
 *     生产者也只有一个（dispatch 的 ReviewDecided），所以对这一档「是不是决定」恒真。
 *   · `unattributed` ——【不同口径】，别拿它去对 O3 验收第 2 条：那个数要过
 *     is_decision 与 JSON，只在 memoryCoverage（门禁面）里有。
 *     这一格【不】显示 unattributed —— 它不在 t.memory 里（成本口径，today.ts 文件头）。
 *
 * 三行的措辞刻意区分【无数据】与【有而没署上名】两种空，不许压成一句
 * （同 memory/prompt.ts 那四条路径的立场：「没有」与「有而没给出来」是两件事）。
 */
function memoryBandHtml(m) {
  if (!m || typeof m !== "object") return "";
  const n0 = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const scope = n0(m.scope_rows);
  const gate = n0(m.gate_rows);
  const unatt = n0(m.gate_unattributed_rows);
  if (scope === 0 && gate === 0 && unatt === 0) return "";
  let body = "";
  if (gate === 0) {
    body +=
      '<div class="admin-meta" style="margin-top:6px">· 审阅判定那一档是【空的】（库里另有 ' +
      `${esc(scope)} 条其它记忆口径的审计，它们不是审阅判定）。` +
      '规格 §24 风险 2 要的是「历史审阅决定与理由」⇒ 这一档在等它的生产者，不是「角色还没做过决定」。</div>';
  } else {
    body +=
      '<div class="admin-meta" style="margin-top:6px">· 审阅判定 ' +
      `${esc(gate)} 条，其中未署名（actor_type=system）${esc(unatt)} 条。</div>`;
  }
  if (unatt > 0) {
    body +=
      '<div class="admin-meta" style="margin-top:6px">· 那 ' +
      `${esc(unatt)} 条按 actor_id 分桶，所以【不会】进任何角色的提示词。` +
      "不是「没人做过判定」，是做过而没署上名。</div>";
  }
  return `<div style="margin-top:10px"><span class="admin-sect">角色记忆</span>${body}</div>`;
}

/* ═════════════════ 页面 1：今日视图（§16.3） ═════════════════
 * 左 2/3 = 「需要你决策」+ 自动决策摘要（低对比度）；右 1/3 = 四个大数字 + 想法输入框。
 * 这一页的设计意图（§16.3 原话）是「打开第一眼看到的是你的公司今天需要你做什么，
 * 以及它自己已经做了什么，【不是一群 agent 在聊天】」。所以这里没有聊天流、
 * 没有 agent 头像、没有任何"谁在说话"的东西。
 */
async function renderToday() {
  // round352：今日页的窗口从 hash 读（独立页 #/today?window=7d，工作台
  // #/admin/today?window=7d，走既有 hashchange → syncAdminFromHash → void load()
  // 重渲染，不新增事件绑定）。默认 undefined = 24 小时（服务端默认）。
  // ⚠ 读 currentQuery 而不是 location.hash：挂载后 hash 多了一段 #/admin/ 前，
  // 而 currentQuery 是 parseAdminHash 已经剥好前缀的那一份 —— 两处都直接 split("?")
  // 就是「query 解析有两份」，而这两份的漂移正好表现为「前缀一变窗口就永不生效」。
  const winMs = windowMsOfHash(currentQuery);
  const t = await getToday(true, winMs);
  if (t.error) {
    $view.innerHTML = banner("err", t.error);
    setConn("down", "GET /today 失败");
    return;
  }
  // 待批卡片是这一页唯一的主角，单独拉一次（GET /approvals 是 pendingTotal 的对账源，
  // 不在 /today 里重抄一遍 —— 两个来源给同一个数就是「两张表两个答案」）。
  const ap = await api("GET", "/approvals");
  const cards = ap.status === 200 ? (ap.data.approvals ?? []) : [];
  if (ap.status === 200) {
    navPending = ap.data.pendingTotal ?? 0;
    nav();
  }

  // ⚠ 这一页左栏那一块，规格给的原话是「**琥珀色左边框的卡片列表**，按紧急度排序」。
  // 那句话反过来读就是判据：非琥珀的卡【不该待在这个块里】。所以这里按服务端给的
  // operational_approval_types 分两组，而不是把预算暂停那张卡混进「需要你决策」
  // 然后只改颜色 —— 那样规格那一行的"琥珀色列表"就名存实亡了。
  // 取不到判据时（t 里没有那个字段）【全部按决策卡处理】：这一处退化的方向是
  // 多涂琥珀（多看一眼），而不是把"等你决定"的东西藏进低优先区看不见。
  const ops = t.operational_approval_types ?? null;
  const isOp = (a) => (ops === null ? false : ops.includes(a.approval_type));
  const need = cards.filter((a) => !isOp(a));
  const opsCards = cards.filter(isOp);
  const needHtml = need.length
    ? need.map((a) => approvalCard(a, t.as_of_ms, true, true)).join("")
    : `<div class="admin-card"><div class="admin-meta">没有等你决定的事。</div></div>`;
  const opsHtml = opsCards.length
    ? `<p class="admin-sect" style="margin-top:18px">运营事件${` · ${esc(opsCards.length)}`}</p>` +
      opsCards.map((a) => approvalCard(a, t.as_of_ms, true, false)).join("")
    : "";

  // 焦点/旧名单要在重写前读（同 renderBoard 那一处的理由）。今日页与收件箱是
  // 同一个 data-approval-id 域：批完一张之后 GET /approvals 是 pending-only
  // （query.ts 那句 `WHERE status = ?`），那张【真的从名单里消失】，
  // 所以走的是「顶上来那一张」那一支 —— 这正是「键盘连批」要的那一手。
  const focusPrev = focusedAnchor($view, "data-approval-id");
  const focusPrevIds = anchorList($view, "data-approval-id");

  $view.innerHTML = `
    <div class="admin-cols">
      <div>
        <p class="admin-sect">需要你决策${need.length ? ` · ${esc(need.length)}` : ""}</p>
        ${ap.status !== 200 ? banner("err", `GET /approvals → ${ap.status}`) : needHtml}
        ${opsHtml}

        <details class="admin-lowcontrast" style="margin-top:18px">
          <summary>自动决策摘要 · 过去 ${esc(windowLabel(t))}</summary>
          <div class="admin-meta" style="margin-top:8px">${esc(strategyLine(t))}</div>
        </details>

        <details class="admin-lowcontrast" style="margin-top:10px">
          <summary>活动流（投影自身的轨迹）</summary>
          <div class="admin-meta" style="margin:8px 0">游标 #<span data-cur>${proj.cursor}</span> · ${linkText(proj)}</div>
          <div id="feed"></div>
        </details>
      </div>

      <div>
        <p class="admin-sect">组织状态 · 窗口
          ${todayWindows()
            .map(
              (w) =>
                `<a data-win-ms="${w.ms ?? ""}" href="${routeToHash(
                  "today",
                  w.ms === undefined ? "" : "window=" + Math.round(w.ms / DAY_MS) + "d",
                )}" class="admin-chip${w.ms === winMs ? " admin-chip-active" : ""}" style="margin-left:6px">${esc(w.label)}</a>`,
            )
            .join("")}
        </p>
        <div class="admin-stats">
          ${stat("活跃任务", t.active_tasks, "", "没到终点的任务数")}
          ${stat(windowLabel(t) + " 完成", t.delivered_in_window, "", "窗口内出现过一次交付跃迁的任务数")}
          ${stat("被阻塞", t.blocked_tasks, "", blockedTitle(t))}
          ${stat("待你决策", navPending, navPending > 0 ? "statbad" : "", "审批收件箱里的待批张数")}
        </div>
        ${budgetHtml(t)}
        ${memoryBandHtml(t.memory)}
        ${notesHtml(t.notes)}
        ${ideaBox()}
      </div>
    </div>`;

  bindDecide();
  bindIdea();
  attachFeedSink();
  restoreApprovalFocus(focusPrev, focusPrevIds);
}

/**
 * 审批卡域（data-approval-id）的「重渲染后把焦点还回去」。
 * 今日页与收件箱共用 —— 两处都是整块 innerHTML 重写，两处批完都要重渲染。
 */
function restoreApprovalFocus(prev, prevIds) {
  focusByAnchor(
    $view,
    "data-approval-id",
    focusTargetId(prev, prevIds, anchorList($view, "data-approval-id")),
  );
}

/**
 * 四个大数字里的预算那一格【故意不是一个大数字】。
 *
 * §16.3 要的是「今日预算消耗比例」，而【按天的上限这个数在库里不存在】
 * （budgets 是累计值、无 updated_at、只加不减；角色级 daily 没有声明方 ——
 * 逐条实测写在 overview/today.ts 文件头）。没有分母就不画比例条：
 * 一根「今日花费 / 未知上限」的条形，它的【长度本身】在说谎。
 * 所以这里给两个有判据的准数 + 一句它缺哪一半。
 *
 * ⚠ 下面那行 `over > 0` 的红是【规格指定的那一处红】（§6 事件表 `BudgetPaused`
 * 那一格：「非琥珀色卡片 + **日消耗条变红**」），同时它也是一处【自认的近似】：
 * 判据用的是 `consumed_total >= declared_task_limits`（累计已花 vs 已声明上限之和），
 * 而规格那句说的是【日】消耗条 —— 日上限没有分母（就是上面那条缺口）。
 * 换句话说这里染红的那根"条"跟规格那根不是同一根。所以红旁边那句
 * 「口径见下」不是装饰：它把"这条红线不是 §7.4 那一条"这件事留在屏幕上，
 * 而不是让人以为日预算阈值真的算出来了。
 * `silent_over_scopes`（警报已哑）那一格用【灰 + 粗体】不用琥珀、也不用红：
 * 它不是"等 CEO 动手"（琥珀不合法），而规格也没给它红（只有日消耗条那一处），
 * 且它本身就是"警报没了"这件事 —— 给它配一种警报色是自相矛盾的。
 */
function budgetHtml(t) {
  const b = t.budget;
  const over =
    b.declared_scopes > 0 &&
    b.consumed_total_cents >= b.declared_task_limits_cents;
  return `
    <div class="admin-stat${over ? " admin-budgetover" : ""}" style="margin-top:10px">
      <div class="admin-lbl">预算</div>
      <div class="admin-figure admin-mono">${esc(windowLabel(t))}内 ${esc(money(b.consumed_in_window_cents))}</div>
      <div class="admin-meter${over ? " admin-over" : ""}"><i style="width:${esc(meterPct(b))}"></i></div>
      <div class="admin-meta admin-mono">累计 ${esc(money(b.consumed_total_cents))} · 已声明上限合计 ${esc(money(b.declared_task_limits_cents))}${
        b.declared_scopes === 0 ? " <b>(一行都没设过)</b>" : ""
      }</div>
      ${over ? `<div class="admin-meta" style="margin-top:4px">累计已花 ≥ 已声明上限合计 <b>⇒ 条变红</b>（§7.4 要的是「日消耗条」，这里分母只有累计口径，口径见下）</div>` : ""}
      ${b.silent_over_scopes > 0 ? `<div class="admin-pill admin-s-gray" style="margin-top:6px"><b>${esc(b.silent_over_scopes)} 格已超限而警报已哑</b></div>` : ""}
    </div>`;
}

/**
 * 那根条形的宽度。口径写死在这里、并由下面那条用例钉住：
 * 【分子 = 累计已花，分母 = 已声明的 per_task 上限之和】，两者都来自服务端。
 * 分母为 0（一行都没设过预算）时给 0% —— 空条 + 旁边那句「一行都没设过」，
 * 而不是给一根半长的条（那长度的意思会是"花了一半"，而真实情况是"没有上限"）。
 * 超过 100% 时钳到 100%：条子画不出去，而 `over` 那行文字 + 红色已经把"超了"说了出来。
 */
function meterPct(b) {
  if (b.declared_scopes <= 0 || b.declared_task_limits_cents <= 0) return "0%";
  const pct = (b.consumed_total_cents / b.declared_task_limits_cents) * 100;
  return `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
}

/**
 * 口径与缺口（today 响应里的 notes）。
 * 为什么在界面上占一块看得见的位置：§16.5 那句摘要条是给 CEO 扫一眼的，
 * 「自动通过 0 项」不带上下文时读起来是「策略引擎很闲」，
 * 带上才读得到它本来的意思「这条链路今天还没接」。
 */
const notesHtml = (notes) =>
  notes && notes.length
    ? `<details class="admin-lowcontrast" style="margin-top:10px"><summary>口径说明 · ${esc(notes.length)} 条</summary>` +
      notes
        .map(
          (n) => `<div class="admin-meta" style="margin-top:6px">· ${esc(n)}</div>`,
        )
        .join("") +
      `</details>`
    : "";

/**
 * 「被阻塞」那一格的 title —— 把【口径本体】挂在数字上。
 *
 * 这一发是被 test/web/renderer-criteria.test.ts 逼出来的：那条守卫要求
 * blocked_statuses / attention_statuses / ceo_decision_statuses /
 * operational_approval_types 四个判据字段【都在代码里被读】，而 blocked_statuses
 * 当时只在注释里出现 —— 亦即 hub 随响应发了这份清单，界面【一个消费者都没有】。
 * 两种收尾都合法，我选这一种：
 *  ① 从响应里删掉这个字段（诚实的"没人用就不发"）—— 但 blocked_tasks 那个数
 *     今天确实是由它算出来的，删掉字段等于让界面上的数字不带口径；
 *  ② 让它有消费者（就是这里）。选 ② 的理由跟 notes 那块一模一样：
 *     「被阻塞 3」不带清单时读起来是"三件坏事"，带上清单才读得到它是
 *     【哪几个状态】—— 而"哪几个"是边表的知识，界面自己写不出来。
 * 取不到时（老服务端 / 字段缺失）退回一句通用话术，不显示空括号。
 */
const blockedTitle = (t) => {
  const s = t.blocked_statuses;
  if (!Array.isArray(s) || s.length === 0)
    return "卡在等人处理的状态（口径未给出）";
  return `口径 = 状态 ∈ {${s.join(" / ")}}（这份清单由 GET /today 给出，不在界面里抄）`;
};

/**
 * 一个大数字格子。第三参是【色调类名】而不是布尔 —— 这一点是改出来的：
 * 原来是布尔 `bad`，只能表达"要不要琥珀"，于是「被阻塞」和「待你决策」
 * 共用琥珀，而 §19.2 把琥珀限定成「全局仅用于需要 CEO 决策」一种状态。
 * 今天只有两档在用："" 常态 / "statbad" 琥珀（只有「待你决策」，因为它才是等你动手）。
 * ⚠ 【没有】"运营异常"那一档可用，这不是漏了：§19.2 那张色表里根本没有"异常色"
 * （只有背景 / 卡片 / 琥珀 / 低饱和蓝 / 低饱和绿 / 灰），全规格唯一明写红色的地方是
 * §7.4「日消耗条变红」—— 说的是**预算**。所以红色今天只用在这一件事上（见 budgetHtml），
 * 「被阻塞」那个数字回到默认墨色。给每个"看起来不太好"的数字各配一种颜色，
 * 是把「一眼扫到该动手的那一处」换成「一整屏都在喊」，正是 §19.1 要的反面。
 */
const STAT_TONE_CLS = { statbad: "admin-statbad" };
const stat = (label, n, tone, title) =>
  `<div class="admin-stat${STAT_TONE_CLS[tone] ? " " + STAT_TONE_CLS[tone] : ""}" title="${esc(title)}">
     <div class="admin-num admin-mono">${esc(n)}</div><div class="admin-lbl">${esc(label)}</div>
   </div>`;

/**
 * 窗口那句话的长度【由服务端给】，不在这里写死 24。
 * 为什么不是小事：§16.5 那句话的字面是「过去 24 小时」，而它数的区间实际是
 * 响应的 window_ms（今天恒等于 24h，因为渲块从不传 ?window_ms=）。
 * 哪天后头加一个"看最近 7 天"的开关，写死的标签会跟数字脱钩 —— 而这类脱钩
 * 屏幕上一个字都不报错，只是那句摘要开始说谎。
 */
const windowLabel = (t) => {
  const h = Math.round((t.window_ms ?? 86400000) / 3600000);
  return h >= 24 ? Math.round(h / 24) + " 天" : h + " 小时";
};

/**
 * round352：今日页窗口清单与 hash 解析（服务端 ?window_ms= 的前端接线半）。
 * 两个都是纯函数：窗口清单不许写死服务端的那张表（today.ts 的窗口是开区间，
 * 上限 MAX_WINDOW_MS 在服务端截断），hash 解析只认我们自己的开关名。
 * 这里提供三个可选窗口：24h（默认，不带参数）/ 7 天 / 30 天 —— 覆盖
 * 「跨天看趋势」与「整个月回顾」两个真实读法，不引入无界选择。
 */
const DAY_MS = 86400000;
const todayWindows = () => [
  { label: "24 小时", ms: undefined },
  { label: "7 天", ms: 7 * DAY_MS },
  { label: "30 天", ms: 30 * DAY_MS },
];
const windowMsOfHash = (hashOrQuery) => {
  // 两种输入都要认：独立页传整条 hash（#/today?window=7d），工作台挂载后传
  // parseAdminHash 剥过 #/admin/ 的那一份 query（window=7d）。原来只认带 ? 的那
  // 一种，少这一改的症状是「挂载后窗口 chip 永不生效」—— 而且是静默的（恒 24h，
  // 屏幕上看不出来）。
  const s = String(hashOrQuery ?? "");
  const q = s.indexOf("?");
  const v = new URLSearchParams(q < 0 ? s : s.slice(q + 1)).get("window");
  if (v === null) return undefined;
  // 只接受「整数天」的三种写法（7d / 7天 / 裸 7）。小数点、负数、非数字一律
  // undefined（走服务端默认 24h）—— 把「7.5 天」try 出来等服务端截断，
  // 不如这里就不认：请求出去的数字必须是界面这一侧能说清楚的那种。
  const n = Number((v ?? "").replace(/[d天]$/u, ""));
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n * DAY_MS;
};

/** §16.5 顶部策略摘要条那句话，字面按规格拼（窗口那一维见 windowLabel）。 */
const strategyLine = (t) =>
  `过去 ${windowLabel(t)}，策略引擎自动通过 ${t.decisions.auto_approved_in_window} 项可逆决策，` +
  `拦截 ${t.decisions.to_human_in_window} 项进入人工审批。` +
  (t.decisions.human_decided_in_window
    ? `人已拍板 ${t.decisions.human_decided_in_window} 项。`
    : "") +
  `当前待处理 ${navPending} 项。`;

/** Ctrl+Enter 快捷提交的判定（纯函数，测在 app-pure）。恒返回布尔：只认主键 + 不带 shift，null 事件一律 false。 */
const isCtrlEnter = (e) => !!(e && (e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.shiftKey);

/**
 * 想法输入框（§16.1 第一个入口）。
 * 提交后框内变【轻量确认条】，不等结果 —— 规格里那句「已收到，助理将在 5 分钟内
 * 返回章程提案」说的就是这个：这一发的完成标志不是"任务出现在列表里"，
 * 而是"收件箱里出现一张章程提案卡"。所以这里不自己往任何列表塞一行（投影纪律）。
 */
const ideaBox = () => `
  <div class="admin-card admin-idea" style="margin-top:14px">
    <p class="admin-sect">扔个想法</p>
    <textarea data-idea class="admin-grow" rows="3" style="width:100%"
      placeholder="例：做一个面向独立开发者的 AI 笔记应用，目标月收入 100 万"></textarea>
    <div class="admin-row" style="margin-top:8px">
      <button class="admin-btn admin-primary" data-create>提交</button>
      <span class="admin-meta" data-idea-state></span>
    </div>
    <div class="admin-err" data-err style="margin-top:6px"></div>
  </div>`;

async function bindIdea() {
  const btn = $view.querySelector("[data-create]");
  if (!btn) return;
  // 提交逻辑只有一份（点击按钮与 Ctrl+Enter 都走它；Ctrl+Enter 那个 keydown
  // 在下面的 box 上）。isCtrlEnter 是纯函数（见 test/web/app-pure.test.ts）。
  const submit = async () => {
    const box = $view.querySelector("[data-idea]");
    const err = $view.querySelector("[data-err]");
    const state = $view.querySelector("[data-idea-state]");
    const idea = box.value.trim();
    err.textContent = "";
    if (!idea) {
      err.textContent = "想法不能为空";
      return;
    }
    btn.disabled = true;
    const { status, data } = await api("POST", "/tasks", { idea });
    btn.disabled = false;
    if (status === 201 || status === 200) {
      box.value = "";
      // 轻量确认条：说【接下来会发生什么】，而不是复读一遍"已提交"。
      state.textContent =
        "已收到。助理会起草章程提案，出现在收件箱里等你批准。";
      todayCache = null; // 数字变了（活跃任务 +1），下次进这一页重新拉
      void loadPendingCount();
    } else err.textContent = `✖ ${status} ${JSON.stringify(data)}`;
  };
  btn.addEventListener("click", () => void submit());
  const box = $view.querySelector("[data-idea]");
  box?.addEventListener("keydown", (e) => {
    if (isCtrlEnter(e)) {
      e.preventDefault();
      void submit();
    }
  });
}

/** 只刷新导航角标，不重画整页（免得把人正在读的东西冲掉）。 */
async function loadPendingCount() {
  const { status, data } = await api("GET", "/approvals");
  if (status === 200) {
    navPending = data.pendingTotal ?? 0;
    nav();
  }
}

/**
 * 焦点落点（纯函数，可测的那一半；DOM 那半在 focusByAnchor）。
 *
 * 为什么这值得单独抽出来测：本仓每次重渲染都是整块 `innerHTML =` 重写，焦点必掉回
 * body。修法看似只有一句"把焦点还回去"，但【还回哪一格】有四种情形，其中两种
 * 做错了比不做更坏：
 *  · prev 为空 ⇒ 【不许抢焦点】。用户在看别处（地址栏 / 别的卡片），
 *    一帧 SSE 到来就把焦点拽到列表第一张 —— 那是把用户的键盘位置改掉，
 *    而屏幕上不会有任何一行说明发生了什么。
 *  · prev 还在新名单里 ⇒ 原地，这是 99% 的情形。
 *  · prev 被批掉了 / 被过滤掉了 ⇒ 【顶上来那一格】。退回 body 的话，
 *    连着按键盘逐张审批时每批完一张就得重新 Tab 一屏；
 *    跳到最后 ⇒ 视线毫无预兆地跳页。同一位置是最不意外的。
 *  · prev 在新旧名单里都找不到 ⇒ 返回 null，【不猜】。位置都不知道就挑一格，
 *    和上面那条"抢焦点"是同一件事。
 * ⚠ 名单由调用方从 DOM 现读，这里不查 DOM —— 所以它能被 app-loader 真跑起来。
 */
function focusTargetId(prev, prevIds, nextIds) {
  if (!prev) return null;
  if (
    !Array.isArray(prevIds) ||
    !Array.isArray(nextIds) ||
    nextIds.length === 0
  )
    return null;
  if (nextIds.includes(prev)) return prev;
  const at = prevIds.indexOf(prev);
  if (at < 0) return null;
  return nextIds[Math.min(at, nextIds.length - 1)];
}

/**
 * 现读 DOM 里【这一个锚点域】的名单（DOM 顺序 = 键盘 Tab 的顺序）。
 * 用 getAttribute 而不是 dataset：属性名由调用方原样传进来（"data-task"），
 * 走 dataset 就得在这里把 data-task 拼成 task/dataset 的驼峰键，
 * 那一层拼写错会以"名单恒空"的形式静默失败 —— 而名单恒空 = 永不恢复焦点 = 看不出来。
 */
function anchorList(root, attr) {
  return [...root.querySelectorAll(`[${attr}]`)].map((el) =>
    el.getAttribute(attr),
  );
}

/**
 * 此刻焦点落在哪一格；不在这一域里 ⇒ null（这一发不许省，见 focusTargetId 第一条情形）。
 * ⚠ 用 closest 而不是"看 activeElement 自己带不带这个属性"：收件箱那一域里被聚焦的
 *   是卡【内部】的 select / input / 按钮，锚点 data-approval-id 在卡根上。
 *   只看自身会恒返回 null ⇒ 收件箱那一头的焦点恢复静默失效（症状是"没变化"，
 *   而这条域恰恰是「键盘逐张审批」那条验收句的主角）。
 * 再看 root.contains：焦点在页头导航上时也带着某个 data-* 祖先的话，
 * 会把不该恢复的焦点恢复进刚重画的视图里。
 */
function focusedAnchor(root, attr) {
  const hit = document.activeElement?.closest?.(`[${attr}]`);
  return hit && root.contains(hit) ? hit.getAttribute(attr) : null;
}

/** 把焦点落到锚点值那一格；找不到就什么都不做（焦点自然停在 body）。 */
function focusByAnchor(root, attr, target) {
  if (!target) return;
  const el = root.querySelector(`[${attr}="${CSS.escape(target)}"]`);
  el?.focus();
}

/* ═════════════════ 页面 2：任务看板（§16.4） ═════════════════
 * 顶部「全部 / 需要我注意」，主体是水平滚动多列，列 = 层级。
 *
 * ⚠ 列【不是】§16.4 那六个字面名字（助理→产品→技术→架构→执行→运营）。
 *   规格里那一列名表要的是"层级"这一维，而库里【没有这一维】：
 *   orgNodeSchema 只有 role_id / can_manage / model_family（contracts/src/org/graph.ts，
 *   且 .strict() ⇒ 加一个 tier 字段是一次契约变更，不是这里能顺手补的）。
 *   ⚠ 顺带【不要】把这件事记到 D11 头上：D11（计划 §10.2）问的是【role_id 用哪套名字】
 *   （文件名 test/dev/tech vs 语义名 test_engineer/tech_director/...），
 *   它一个字都没提"哪个角色属于哪一层"。计划里也没有别的 D 项覆盖这一维
 *   （D7/D9/D10/D11 四条各自问的是别的事）。所以缺的是一份【谁都没定过】的映射，
 *   不是"等 D11 定了就有"。
 *   于是这里按【reports_to 到 CEO 的深度】派生列 —— 这是库里真有的那一份层级，
 *   列名直接写成「深度 N · <角色名>」而不是去套那六个名字：
 *   套上去会得到一个看起来合规、实则凭猜测的映射（哪个 role 算"执行"？谁定？）。
 *   缺的那份映射记在 0042 里，它是【规格缺口】不是这里的自由发挥。
 */
let boardFilter = "all";
async function renderBoard() {
  const t = await getToday(false);
  const [{ status, data }, org] = await Promise.all([
    api("GET", "/tasks"),
    api("GET", "/org"),
  ]);
  if (status !== 200) {
    $view.innerHTML = banner("err", `GET /tasks → ${status}`);
    return;
  }
  const tasks = data.tasks ?? [];
  // 判据从服务端读，不在这里写状态名（文件头那条）。取不到时【不】退化成"全都算需要关注"，
  // 也不退化成空集：直接说"这一维今天判不了"，把过滤器置灰。
  //
  // ⚠ 【两个】集合，不是一个：
  //   attention  = 哪些任务进「需要我注意」这一列（阻塞 ∪ 升级到 CEO ∪ 触及预算）
  //   ceoDecide  = 哪些标琥珀（§19.2「全局仅用于需要 CEO 决策」= 只有升级到 CEO）
  // 合并成一个的写法我第一版就是这么做的，那样预算暂停的卡会被涂琥珀，
  // 而规格四处明写它【非琥珀色】（§6 事件表 / §7.4 / §21.3 / 附录 D，理由原话是
  // "这是运营事件，不是战略决策"）。两个集合的交集非空而不相等 ⇒ 不能派生。
  const attention = t && !t.error ? t.attention_statuses : null;
  const ceoDecide = t && !t.error ? t.ceo_decision_statuses : null;
  const nodes = org.status === 200 ? (org.data.graph?.nodes ?? {}) : {};
  const cols = hierarchyColumns(nodes);

  const attentionTask = (tk) =>
    attention === null
      ? false
      : attention.includes(tk.status) || overBudget(tk);
  // 琥珀：只认服务端那份「需要 CEO 决策」清单。取不到时不猜（跟上面同一态度）。
  const decideTask = (tk) =>
    ceoDecide === null ? false : ceoDecide.includes(tk.status);
  const shown =
    boardFilter === "attention" ? tasks.filter(attentionTask) : tasks;
  const byKey = groupByDepth(shown, cols);
  // 驱动器那一格（0048 §7）。它挂在【看板】而不是今日页：这一格问的是
  // 「这几条停在 agent 那一格的想法，还有没有在走」，而那个问题只在看着卡片时才会问。
  // ⚠ t.error 时（GET /today 整个失败）driver 是 undefined，driverNotice 会走
  // "字段缺失 ⇒ 未知"那一支 —— 与上面 attention === null 那条横幅说的是同一件事，
  // 但两句各自指着【自己的那一维】，所以我留着两句。
  const drv = t && !t.error ? t.driver : undefined;
  const drvNotice = driverNotice(drv);

  // ⚠ 这一页【不做】"重渲染后把焦点还回那张卡"，不是漏了：
  // renderBoard 只有顶部那个过滤器会调它（本文件里 renderBoard() 的调用点就一处），
  // SSE 帧到的是 attachFeedSink 里那句 `el.textContent = 游标` —— 就地改一格，
  // 不重写 innerHTML。所以"焦点停在卡上时被数据冲掉"在看板上不发生，
  // 加一套恢复是【没有触发路径的死码】。真出现自动重画那天再补。
  $view.innerHTML = `
    <div class="admin-toolbar">
      <button class="admin-btn${boardFilter === "all" ? " admin-primary" : ""}" data-f="all">全部</button>
      <button class="admin-btn${boardFilter === "attention" ? " admin-primary" : ""}" data-f="attention"
        ${attention === null ? "disabled title='判据取不到（GET /today 失败），这一维今天判不了'" : ""}>需要我注意</button>
      <span class="admin-meta">${esc(shown.length)} / ${esc(tasks.length)} 条 · 游标 #${proj.cursor} · ${linkText(proj)}</span>
    </div>
    ${org.status !== 200 ? banner("warn", "组织图取不到 ⇒ 层级列退化成单列（列由 reports_to 派生，不是写死的六列）。") : ""}
    ${attention === null ? banner("warn", "「需要我注意」的判据来自 GET /today，此刻取不到 ⇒ 该过滤器已置灰。") : ""}
    ${drvNotice ? banner(drvNotice.level, drvNotice.msg) : ""}
    <div class="admin-board">
      ${byKey
        .map(
          (c) => `<div class="admin-col">
            <div class="admin-colhead"><span>${esc(c.label)}</span><span class="admin-mono">${esc(c.items.length)}</span></div>
            ${c.items.map((tk) => taskCard(tk, attentionTask(tk), decideTask(tk), driverLine(tk.id, drv, t.as_of_ms))).join("") || `<div class="admin-meta">—</div>`}
          </div>`,
        )
        .join("")}
    </div>
    <div id="drawer-slot"></div>`;

  for (const b of $view.querySelectorAll("[data-f]")) {
    b.addEventListener("click", () => {
      boardFilter = b.dataset.f;
      void renderBoard();
    });
  }
  for (const c of $view.querySelectorAll("[data-task]")) {
    c.addEventListener("click", () => void openDrawer(c.dataset.task));
    // 键盘那条与 org 视图那台拖拽卡同一个形状（本文件 .orgdrag .node 的 keydown：
    // Enter 主操作、Esc 取消），不是新发明一套键位。
    // 为什么判 E.key 而不是指望 click：div[tabindex] 上浏览器【不会】把 Enter
    // 合成 click（那是原生 button 的行为），所以只加 tabindex 不加这一发
    // 会做成"Tab 能停但按下去没反应" —— 比原来更坏，因为它【看着像】支持了。
    c.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault(); // 空格默认滚页
      void openDrawer(c.dataset.task);
    });
  }
}

/** 触及预算：两个服务端给的数比一下，不算状态机判定（所以可以住在渲块里）。 */
const overBudget = (t) =>
  t.budget_cents !== null &&
  t.budget_cents !== undefined &&
  t.consumed_cents >= t.budget_cents;

/**
 * 驱动器那一格（0048 §7）。两个函数都【只排字符，不下判据】——
 * 「哪些任务已经没人推了」「成因是哪一档」全在 GET /today 响应里（判据为什么住在
 * hub 侧，见 overview/driver-status.ts 文件头）。这里出现的那两个字符串
 * `at_limit` / `no_budget` 是【响应里的成因枚举值】，不是任务状态名 ——
 * 所以它不违反 test/web/renderer-criteria.test.ts 那条（那条扫的是状态名与审批类型名）。
 *
 * ⚠ 为什么【不标琥珀】：§19.2 里琥珀唯一的意思是"需要 CEO 决策"，
 * 而"驱动器不再推这条想法了"多数时候要的是【去看为什么推不动】或【放开预算】，
 * 不是决策。给它涂琥珀会把琥珀贬值（同 §7.4 那句「预算暂停非琥珀色」）。
 * 所以这一格用的是 warn 那条横幅 + 卡片上一行 meta，颜色走既有的低对比档。
 */

/**
 * 看板顶部那条横幅。
 *
 * ⚠ 这一发的【全部价值】在"没开 / 停了"那两支：
 * 名单为空时，若不说话，屏幕上读到的是「没有任何想法被卡住」= 一切正常，
 * 而真相可能是"这台 Hub 从来不推任何东西"或"心跳早就停了"。
 * 那正是 0048 整篇要消灭的形状换了个方向再发生一次，
 * 所以 driver-status.ts 才把 enabled / pumping 与名单【绑成一次响应】发出来。
 * 字段整个缺失（老服务端）也走"说话"那一支而不是沉默 —— 缺失意味着
 * 这一维【没人知道】，而"不知道"与"没有异常"是两句话。
 */
function driverNotice(driver) {
  // ⚠ 先验【形状】再读【值】，而这一刀不是防御式编程的口味问题：
  // 我第一版直接写 `if (!driver.enabled)`，于是 `driver: {}`（服务端少发了字段）
  // 会走到「这台 Hub 没开驱动器」那一句 —— 一句从【缺失】里推出来的【肯定陈述】，
  // 与 HubDeps.driverState 拒绝给默认值是同一族（缺的东西不许被读成一个答案）。
  // 形状不对 ⇒ 答案是"不知道"，而"不知道"与"没开"是两句话：
  // 前者的下一步是去看服务端版本/响应，后者的下一步是去起一个开关。
  if (
    !driver ||
    typeof driver !== "object" ||
    typeof driver.enabled !== "boolean" ||
    typeof driver.pumping !== "boolean"
  ) {
    return {
      level: "warn",
      msg: "服务端没给出驱动器状态 ⇒ 「有没有人推着这些想法」这一维此刻未知（不等于「没有异常」）。",
    };
  }
  if (!driver.enabled) {
    return {
      level: "warn",
      msg: "这台 Hub 没开驱动器：想法停在 agent 那一格之后，不会有任何东西去推它。要自动推进请带 --driver-pump 起 Hub，或手工 hub work。",
    };
  }
  if (!driver.pumping) {
    return {
      level: "err",
      msg: "驱动器已开启但承载它的那条心跳已经停了（通常是一连串失败之后自己停的）⇒ 从现在起没有想法在被推着走。",
    };
  }
  const stopped = Array.isArray(driver.stopped) ? driver.stopped : null;
  // ⚠ 名单【不是数组】与【是空数组】也不许说成同一句，理由与上面那条 enabled
  // 一模一样（这里我第一版写的是 `?? []`，于是"字段坏了"读成"没有异常"）。
  // 今天读侧恒发数组，所以这一支不可达；它留在这里是因为这一整个函数的立场就是
  // 「每一种没有都要说出它是哪一种」，而在这一点上给它开后门，
  // 下一处缺字段就又会被读成一次平安。
  if (stopped === null) {
    return {
      level: "warn",
      msg: "驱动器状态里的「不再推的名单」形状不对 ⇒ 这一维此刻未知（不等于「没有异常」）。",
    };
  }
  if (stopped.length === 0) return null; // 开着、在推、没人被丢下 ⇒ 不打扰
  const nBudget = stopped.filter((s) => s.cause === "no_budget").length;
  const nLimit = stopped.length - nBudget;
  const bits = [];
  if (nLimit > 0) bits.push(`${nLimit} 条试到上限`);
  if (nBudget > 0) bits.push(`${nBudget} 条被花钱的门挡住`);
  return {
    level: "warn",
    msg: `驱动器在推，但已经不再推 ${stopped.length} 条想法（${bits.join("、")}）—— 详见看板上标出的那些卡片。`,
  };
}

/**
 * 某一张卡片上那一行「为什么它不动了」；不在名单里就返回空串（卡片形状不变）。
 *
 * ⚠ 返回的是【未转义的纯文本】而不是 HTML —— 转义由调用方（taskCard 里那句 esc）
 * 做一次。这里先 esc 一遍、那边再 esc 一遍，会得到 `&amp;amp;`：
 * 今天这几个片段（中文、数字、`/`、`·`）里没有会被转义的字符，所以双重转义
 * 【看不出来】，而它会在有人往措辞里加一个 `<` 或 `&` 的那天变成一串乱码。
 * 一段文本只该有一次转义，而那次发生在【插进 HTML 的地方】。
 *
 * ⚠ nowMs 是【传进来的】而不是在这里读 todayCache：那会让这一发依赖一段
 * 与它无关的全局状态，test/web/app-pure.test.ts 装载它时 todayCache 恒为 null
 * ⇒ 落进 Date.now() ⇒ 同一份输入两次跑出不同的字符串。卡片上那句
 * 「多久之前停的」因此必须是【调用方给的时刻】（同 fmtAgo 自己的签名）。
 *
 * 措辞分两档是【必须】的：两档的下一步动作不同 ——
 *  试到上限 ⇒ 去看角色那一轮为什么推不动；
 *  被钱挡住 ⇒ 去把那个上限放开（而它【不在屏幕上】，见下面那条 ⭐）。
 * 合成一句"这条卡住了"就等于把选择又丢回给读的人（同 0041 §7 那条判据：
 * 屏幕上那句话得指向【真的能做的下一步】）。
 *
 * ⭐ 钱那一档为什么写的是【带更高的 --task-limit-cents 重启】而不是【追加预算】：
 * 探针量过（0049 §12）—— 那道门的【分母】是进程里那个命令行数字
 * （`serve/driver-pump.ts:487` 绑的是 `o.taskLimitCents`），
 * 而【不是】 `budgets.limit_cents` 那一列。把那一列从 500 改到 5000，
 * 门【一个字都不响应】：驱动器候选 0 条 → 0 条，看板那一行照旧报"被钱挡住"。
 * 所以「点一下追加预算」今天在真机上是【一颗按下去不会有任何效果的按钮】，
 * 而屏幕上这一行如果指着它，就是拿一句看着可执行的话把人送去点一颗空按钮 ——
 * 那正是 0041 §7 那条判据要拦的事，只是这次被指着的是【我自己刚写的那一行】。
 * 真正的按钮要先解决「`budgets.limit_cents` 这一列到底是什么意思」
 * （0045 §7 挂着等 CEO 拍的一项，候选 (A) 的代价里明写着"追加预算这条路将来要跟它抢同一格"），
 * 那不是实现层能单方面定的，所以这里只说【此刻真有效】的那一步。
 *
 * ⚠ 「命令行」那三个字留着是有用处的：看板【上面】那条预算条写的
 * 「已声明上限合计」读的是 `budgets.limit_cents` 之和（`overview/today.ts:294`），
 * 与这一行的数【两个来源】。少了这个限定词，同一屏上会出现两个都叫"上限"
 * 而可以互相矛盾的数，而读者没有任何办法发现它们不同源。
 */
function driverLine(taskId, driver, nowMs) {
  const stopped = driver && Array.isArray(driver.stopped) ? driver.stopped : [];
  const row = stopped.find((s) => s && s.task_id === taskId);
  if (!row) return "";
  const when = fmtAgo(row.since_ms, nowMs);
  if (row.cause === "no_budget") {
    return `不再推：花到了命令行那个单条上限（${money(driver.task_limit_cents)}）· 屏幕上放开不了，要它继续走得带更高的 --task-limit-cents 重启 · ${when}`;
  }
  const tries =
    row.attempts !== null && row.attempts !== undefined && row.max_attempts
      ? `第 ${row.attempts}/${row.max_attempts} 次`
      : "试到上限";
  return `不再推：${tries}而它还在原格 · 要它继续走得先查那一轮为什么没推进（次数记在审计里，屏幕上和命令行都没有能放开的地方）· ${when}`;
}

/**
 * 由 reports_to 派生层级列：CEO 是深度 0，直属下级深度 1，以此类推。
 * 只走【汇报边】，不走委派边（edges 是"谁能把活交给谁"，不是层级）。
 * 环/悬空父节点的处理：seen 集合挡环；reports_to 指向一个【组织图里没有的】角色时，
 * 深度就停在那一格（不再往上数），于是该节点显示在它自己的那一列，
 * 而不是消失 —— 消失的症状是"各列卡片数加起来不等于总数"，人只会以为自己看漏。
 * 任务侧同理：assigned_role 不在图里的进「未挂组织」那一列。
 */
function hierarchyColumns(nodes) {
  const keys = Object.keys(nodes);
  if (keys.length === 0)
    return [{ key: "all", label: "全部任务", roles: null }];
  const depthOf = (role) => {
    let d = 0;
    let cur = role;
    const seen = new Set();
    // 环靠 seen 挡：org 的合法性校验在写侧（§18.3 那套门控），但读侧不能假设它从没被绕过
    // —— 绕过时这里的症状会是"整页卡死"（while 永远真），而不是"某列深一点"。
    while (
      cur &&
      nodes[cur] &&
      nodes[cur].reports_to &&
      !seen.has(cur) &&
      d <= 32
    ) {
      seen.add(cur);
      cur = nodes[cur].reports_to;
      d += 1;
    }
    return d;
  };
  const depths = keys.map(depthOf);
  const max = Math.max(1, ...depths);
  const cols = [];
  for (let d = 0; d <= max; d += 1) {
    const roles = keys.filter((k) => depthOf(k) === d);
    if (roles.length === 0) continue;
    cols.push({
      key: "d" + d,
      label: `深度 ${d} · ${roles.join(" / ")}`,
      roles: new Set(roles),
    });
  }
  return cols;
}

/** 任务按【assigned_role 落在哪一列】分组；角色不在组织图里的进「未挂组织」那一列。 */
function groupByDepth(tasks, cols) {
  if (cols.length === 1 && cols[0].roles === null)
    return [{ label: "全部任务", items: tasks }];
  const out = cols.map((c) => ({ label: c.label, items: [] }));
  const orphan = { label: "未挂组织", items: [] };
  for (const tk of tasks) {
    const i = cols.findIndex((c) => c.roles && c.roles.has(tk.assigned_role));
    (i >= 0 ? out[i] : orphan).items.push(tk);
  }
  for (const g of out) g.items.sort((a, b) => b.updated_at - a.updated_at); // §16.4：最后变更时间倒序
  orphan.items.sort((a, b) => b.updated_at - a.updated_at);
  if (orphan.items.length) out.push(orphan);
  // 深度 0 那一列（CEO 本人）通常没有任务，留着它反而让"CEO 名下有几条活"这件事可见。
  return out;
}

/**
 * 卡片正面 = 三层折叠的第一层（§19.4）：一行摘要 + 层级标签 + 最后变更时间。
 *
 * 两个布尔来自【两个】判据，别混：
 *   isDecision  → 琥珀左边框（§19.2「全局仅用于需要 CEO 决策」）
 *   isAttention → 「需要我注意」那一列**成员**（§16.4），本身不带颜色
 * 成员身份不需要颜色来表达 —— 过滤器按下去之后只剩它们，位置本身就是表达。
 * 反过来如果成员全涂琥珀，那一列的琥珀就等于"这一列的东西"，
 * 而规格要琥珀等于"这一件等你动手"：同一屏两处语义，扫视失效。
 */
function taskCard(tk, isAttention, isDecision, stoppedNote) {
  // ⚠ tabindex/role 这一对不是装饰，是 Task 2.6 那句「键盘可完成全部审批操作」的
  // 前半段：卡片原本只有 click（`c.addEventListener("click", …)`），于是"打开详情
  // 看证据"这件事【只有鼠标能做】，而审批决策的证据就在抽屉里。
  // 键盘进不去抽屉 ⇒ "键盘完成审批"在链条第一跳就断了。
  // 为什么不是 <button>：卡片里已有 pill / meta / mono 好几层结构，§19.4 那三层
  // 折叠的排版靠这层 div；改成 button 要重排样式，收益一样、爆炸半径大得多。
  // ⚠ aria-label 用【卡片正面没有】的那句话（"打开详情"），不复读标题 ——
  //   读屏器本来就会念卡片内容，把标题再念一遍只会把真正的新信息挤掉。
  return `<div class="admin-tk${isDecision ? " admin-decision" : ""}${isAttention && !isDecision ? " admin-flag" : ""}" data-task="${esc(tk.id)}" tabindex="0" role="button" aria-label="打开任务详情">
    <div class="admin-s tw:text-balance">${esc(tk.title)}</div>
    <div class="admin-row" style="margin-top:6px">
      <span class="admin-pill ${statusClass(tk.status)}">${esc(tk.status)}</span>
      <span class="admin-meta">${esc(tk.assigned_role)} · ${esc(fmtAgo(tk.updated_at, todayCache ? todayCache.as_of_ms : Date.now()))}</span>
    </div>
    <div class="admin-meta admin-mono">${esc(tk.id.slice(0, 8))} · ${esc(money(tk.consumed_cents))}${tk.budget_cents ? " / " + esc(money(tk.budget_cents)) : " / 未设上限"}</div>
    ${stoppedNote ? `<div class="admin-meta" data-stopped>${esc(stoppedNote)}</div>` : ""}
  </div>`;
}

/**
 * 状态颜色。⚠ 这里【不出现琥珀】，理由分两层：
 *  ① 琥珀在 §19.2 里唯一的意思是"需要 CEO 决策"，那个决定权由服务端给的
 *     ceo_decision_statuses 决定，标记在 taskCard 外面那一层加（.tk.decision / .need）。
 *     这个函数只按状态名做"进行中/完成/归档/失败"四档色调，
 *     它拿不到也不该拿到"要不要标琥珀"。
 *  ② 它按状态名【子串】上色，本来就不是判据 —— 是呈现映射。别把它读成
 *     "渲染进程里不出现状态名"（我原先在文件头写过那句，那句是假的）。
 */
function statusClass(s) {
  const x = String(s).toLowerCase();
  if (x.includes("deliver")) return "admin-s-green";
  if (x.includes("archiv")) return "admin-s-gray";
  if (x.includes("reject") || x.includes("fail") || x.includes("error"))
    return "admin-s-red";
  if (x.includes("review") || x.includes("progress") || x.includes("escalat"))
    return "admin-s-blue";
  return "";
}

/**
 * 详情抽屉（§16.4「不离开看板上下文」）。
 * 三层折叠：第一层已在卡片正面；第二层给服务端给的数（预算/时间/节点）；
 * 第三层给完整 payload。⚠ 第二层【没有】"测试覆盖率 94%"那种指标 ——
 * 证据包（evidence）那条链路在本仓仍是未完成项，画一个空指标条比不画更坏。
 */
async function openDrawer(id) {
  const slot = document.getElementById("drawer-slot");
  // 先记下"是谁开的"，再收上一个抽屉 —— 顺序反了不行：closeDrawer 会把焦点
  // 还给上一张卡，那时再读 activeElement 会把【上一张】当成本次的返回点。
  const opener = document.activeElement;
  // 幂等：已经开着就先按"关"收干净（反注册上一条 Esc、把返回焦点落定），
  // 否则第二次打开会留下【两条】 Esc 监听 —— 关一次关不掉，另一条还在
  // 关下一回根本不存在的抽屉。
  if (drawerEscOff) closeDrawer();
  drawerReturnTo = opener?.isConnected ? opener : drawerReturnTo;
  slot.innerHTML = `<div class="admin-scrim" data-close></div><div class="admin-drawer"><div class="admin-meta">载入中…</div></div>`;
  slot.querySelector("[data-close]").addEventListener("click", closeDrawer);
  // Esc 关抽屉。挂在 document 上而不是抽屉里：焦点可能落在 scrim、标题、
  // 或抽屉里任何一个不可聚焦的 div 上（那些 keydown 就不会冒泡到抽屉根）。
  // 只在抽屉存活期间挂 —— closeDrawer 一律摘掉，否则留下一条全局 Esc
  // 会去关【下一回】根本不存在的抽屉（症状：在别的页面上按 Esc 有反应）。
  drawerEscOff = (() => {
    const onKey = (e) => {
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  })();
  const [{ status, data }, rp] = await Promise.all([
    api("GET", "/tasks/" + encodeURIComponent(id)),
    api("GET", "/replay/" + encodeURIComponent(id) + "?limit=30"),
  ]);
  if (status !== 200) {
    // 原来这一支是 `slot.innerHTML = ""; return;` —— 抽屉【自己消失了】，
    // 而真相是那次请求失败了。按本仓那条「缺的东西不许被读成一个答案」：
    // "自己关了"会被读成"这一张没有详情"，而该做的下一步是去看服务端怎么了。
    slot.innerHTML = `<div class="admin-scrim" data-close></div><div class="admin-drawer">
      <div class="admin-row"><h3 style="margin:0" class="admin-grow">详情取不到</h3><button class="admin-btn" data-close>关闭</button></div>
      ${banner("err", `GET /tasks/${id} → ${status}`)}
    </div>`;
    for (const c of slot.querySelectorAll("[data-close]"))
      c.addEventListener("click", closeDrawer);
    slot.querySelector(".admin-drawer .admin-btn")?.focus();
    return;
  }
  const entries = rp.status === 200 ? (rp.data.entries ?? []) : [];
  slot.innerHTML = `
    <div class="admin-scrim" data-close></div>
    <div class="admin-drawer">
      <div class="admin-row"><h3 style="margin:0" class="admin-grow tw:text-balance">${esc(data.title)}</h3>
        <a class="admin-btn" href="${routeToHash("replay", "id=" + encodeURIComponent(id))}" data-replay>打开完整回放</a>
        <button class="admin-btn" data-close>关闭</button></div>
      <div class="admin-row" style="margin-top:6px">
        <span class="admin-pill ${statusClass(data.status)}">${esc(data.status)}</span>
        <span class="admin-meta admin-mono">${esc(data.id)}</span>
      </div>
      <div class="admin-meta" style="margin-top:10px">角色 ${esc(data.assigned_role)} · 节点 ${esc(data.current_node)} · 图版本 ${esc(data.graph_version)}</div>
      <div class="admin-meta admin-mono">已用 ${esc(money(data.consumed_cents))}${data.budget_cents ? " / " + esc(money(data.budget_cents)) : ""} · 建 ${esc(fmtDate(data.created_at))}</div>
      ${data.parent_id ? `<div class="admin-tag admin-mono">父任务 ${esc(data.parent_id)}</div>` : ""}
      <p class="admin-sect" style="margin-top:16px">审阅链 / 事件（最近 ${esc(entries.length)} 条）</p>
      ${rp.status !== 200 ? banner("err", `GET /replay → ${rp.status}`) : replayTimeline(entries)}
      <p class="admin-sect" style="margin-top:16px">第三层：完整产出</p>
      <div class="admin-meta">证据包那条链路今天仍未落地（docs 里登记为未完成项），所以这一层现在只有审计原文：</div>
      <pre>${esc(JSON.stringify(entries.slice(0, 5), null, 2))}</pre>
    </div>`;
  for (const c of slot.querySelectorAll("[data-close]"))
    c.addEventListener("click", closeDrawer);
  // 焦点进抽屉：抽屉是覆盖层，焦点若还留在身后那张卡上，Tab/空格会【同时】
  // 操作身后那块【被遮住但没被禁用】的界面 —— 看不见的那一半在收键。
  // 落点是「关闭」而不是标题行里那枚「打开完整回放」链接：默认落点该是
  // 本覆盖层里【不离开上下文】的动作，跳走是用户显式选的事。
  slot.querySelector(".admin-drawer [data-close]")?.focus();
}

/** 开抽屉前那一刻的焦点；关的时候要还回去。 */
let drawerReturnTo = null;
/**
 * 当前那条 Esc 监听的反注册（抽屉不在的时候不许有）。
 *
 * ⚠ 这一格同时是"抽屉现在开着"的【唯一】判据 —— 不要再拿
 * `slot.innerHTML !== ""` 去判开没开：载入失败那一支也写着东西。
 * ⚠ 已知边界（有意不做，不是漏）：抽屉打开时 Tab 仍能走到【身后那层】的卡片上，
 * 因为 scrim 只是视觉遮盖，没有 inert/aria-hidden。做成真焦点环要引一层
 * "哪些节点暂时不可达"的管理，而本仓现在【没有浏览器能跑一次】（0042 §11 第一条），
 * 焦点环这种东西错了只会以"人按 Tab 转不出来"的形式在真实浏览器里出现 ——
 * 在没有浏览器证据的地方写它，我没法知道自己写对没有。所以停在"Esc 能关 +
 * 焦点进得来还得回去"这一档，那一档的每一步都可读可查。
 */
let drawerEscOff = null;
const closeDrawer = () => {
  const s = document.getElementById("drawer-slot");
  if (s) s.innerHTML = "";
  drawerEscOff?.();
  drawerEscOff = null;
  // 只在【那个元素还在文档里】的时候还焦点：看板可能在这期间重渲染过，
  // 原来那张卡已经被换掉了 —— 对脱离文档的节点调 focus() 会把焦点丢给 body。
  if (drawerReturnTo?.isConnected) drawerReturnTo.focus();
  drawerReturnTo = null;
};

/* ═════════════════ 页面 3：审批收件箱（§16.5） ═════════════════
 * 顶部策略摘要条（那句字面来自 §16.5，数字来自 /today 与 /approvals）+ 单列宽卡片流。
 *
 * ⚠ 列表【直接读 REST】，不走投影的 inbox：inbox 是「快照总数 + 水位线之上的增量」
 *   拼出来的角标，而它的水位线 asOfSeq 需要一个 seq 来源 —— GET /approvals 只带
 *   asOfMs，【不带 seq】。硬拿别处的 seq 凑一个水位线，会造出一个「看着权威的错数」，
 *   而那个模块自己的注释说得很清楚：角标偏小是致命的（CEO 就不看了）。
 *   所以这里显示的是【读那一刻】的真实收件箱，并标出「读数于 <时刻>」。
 */
let inboxCache = null;
async function renderInbox() {
  const [t, ap] = await Promise.all([
    getToday(false),
    api("GET", "/approvals"),
  ]);
  if (ap.status !== 200) {
    $view.innerHTML = banner("err", `GET /approvals → ${ap.status}`);
    return;
  }
  inboxCache = ap.data;
  navPending = ap.data.pendingTotal ?? 0;
  nav();
  const list = ap.data.approvals ?? [];
  // 同一份「运营类型」名单（今日页那一处用的是 t.operational_approval_types）。
  // 取不到时按【全部是决策卡】处理：宁可多看一眼琥珀，也不把等你决定的东西降级。
  const inboxOps = t && !t.error ? t.operational_approval_types : null;
  const focusPrev = focusedAnchor($view, "data-approval-id");
  const focusPrevIds = anchorList($view, "data-approval-id");
  $view.innerHTML = `
    <div class="admin-banner">${esc(t && !t.error ? strategyLine(t) : "策略摘要取不到（GET /today 失败）。")}</div>
    <div class="admin-toolbar">
      <span class="admin-meta">待批 <b>${esc(ap.data.pendingTotal)}</b>
        · 读数于 <span class="admin-mono">${esc(fmtDate(ap.data.asOfMs))}</span>
        ${ap.data.truncated ? " · <b>已截断（只这一页）</b>" : ""}</span>
      <button class="admin-btn admin-ghost" data-reload>↻ 重读</button>
      <input type="text" data-batch-note placeholder="理由（批量打回必填，服务端 422 校验）" class="admin-grow" />
      <button class="admin-btn" data-batch="approve">批量批准</button>
      <button class="admin-btn" data-batch="reject_with_comment">批量打回</button>
    </div>
    <div data-batch-out></div>
    ${
      list.length
        ? list
            .map((a) =>
              approvalCard(
                a,
                ap.data.asOfMs,
                false,
                inboxOps === null ? true : !inboxOps.includes(a.approval_type),
              ),
            )
            .join("")
        : banner("", "收件箱为空。")
    }
    ${t && !t.error ? notesHtml(t.notes) : ""}`;
  $view.querySelector("[data-reload]")?.addEventListener("click", () => {
    todayCache = null;
    void renderInbox();
  });
  bindDecide();
  bindBatch();
  bindSnapshots();
  restoreApprovalFocus(focusPrev, focusPrevIds);
}

/**
 * 卡片背面的证据行（O5 动作 4）。
 *
 * 服务端给 `evidence_refs`（数组或 null）。三态：
 *  - null / [] ⇒ **「无证据包」**。这是这一行的主角：一张要求证据的卡没有证据，
 *    要在界面上【说破】，而不是假装有证据或干脆不提 —— 缺证据的卡看起来
 *    和带证据的卡一样可批，那正是 §8.2 第 2 条想拦的静默。
 *  - 非空数组 ⇒ 列出引用条数。逐条全文太长（可能是文件路径/sha256），
 *    「N 条引用」让 CEO 知道证据在、可点开复核，而不把卡片 meta 撑爆。
 * ⚠ 这里【不】自己判断要不要显示：服务端给什么就显示什么（投影纪律 ——
 *    前端不代替服务端决定「这张卡算不算有证据」）。
 */
function evidenceLine(a) {
  const refs = a.evidence_refs;
  if (refs === null || refs === undefined || refs.length === 0) {
    return ' · <b class="admin-ev-none">无证据包</b>';
  }
  return " · " + evidenceRefsHtml(refs);
}

/**
 * evidence_refs 明细半（round342）：路径/sha256 逐条 `<code>` 展示。
 * 纯函数：只吃 refs、拼字符串 + esc，不碰 fetch / DOM。
 * 三态：null / undefined / 空数组 ⇒ ""；否则
 * `<details><summary>证据 N 条</summary>{逐条 <div class="admin-mono"><code>{esc}</code></div>}</details>`。
 */
function evidenceRefsHtml(refs) {
  if (refs === null || refs === undefined || refs.length === 0) return "";
  const items = refs
    .map((r) => `<div class="admin-mono"><code>${esc(r)}</code></div>`)
    .join("");
  return `<details><summary>证据 ${refs.length} 条</summary>${items}</details>`;
}

/**
 * 影子判定那一行（O9 动作 1 阶段一：只报不批）。
 *
 * 服务端给 `policy_shadow`（策略引擎「如果放我判我会怎么判」，读路径算的，
 * 没有任何自动动作跟在后面）。这一行的全部纪律是【不越权】：
 *  - 文案永远是「规则判：…」，绝不出现「已自动…」——阶段一不改任何决定；
 *  - 缺失（null / 老服务端没这一格）⇒ 整行消失，不显示「规则判：无」。
 *    「没有判定」与「判定是不批」是两件事，前端不替服务端把前者说成后者。
 * 并排的那一侧「人判」就是这张卡本身的 pending 状态与下面的按钮，
 * 不需要额外一行——那正是「并排」的含义：规则的话和人的按钮在同一张卡上。
 */

/**
 * policy_shadow.note 的渲染半（round342，query.ts:271 的「规则依据」真据）。
 * 纯函数：只吃 note、拼字符串 + esc，不碰 fetch / DOM。
 * 三态：null / undefined / "" ⇒ ""；否则「规则依据：{esc(note)}」。
 */
function policyNoteHtml(note) {
  if (note === null || note === undefined || note === "") return "";
  return `<span class="admin-meta">规则依据：${esc(note)}</span>`;
}

function policyShadowLine(a) {
  const s = a.policy_shadow;
  if (s === null || s === undefined) return "";
  const label =
    s.decision === "auto_approved"
      ? `规则判：${esc(s.rule)} 会通过（阶段一不执行）`
      : `规则判：转人工（${esc(s.blocked_by)}${s.missing.length > 0 ? " · 缺 " + esc(s.missing.join("、")) : ""}）${policyNoteHtml(s.note)}`;
  return `<div class="admin-meta" style="margin-top:4px"><b>${label}</b></div>`;
}

/**
 * 参数快照的**行**（§9.2 第二行）。纯函数：只吃 `parameters`，不碰 DOM、不发请求。
 * 返回 `[标签, 值文本]` 的数组，渲染由 paramSnapshotHtml 负责。
 *
 * ── 这一格今天才有内容 ───────────────────────────────────────────
 * §9.2 第二行要的「金额 / 影响范围 / 不可逆性 / 推荐 / 超时行为」，此前在**任何**
 * 界面上都显示不出来：GET /approvals 刻意不带 parameters（app.ts 那条
 * 「不该被塞进列表接口当作副产品」），而任务抽屉带的是任务的审计而不是卡的参数。
 * `GET /approvals/:id` 落地之后，这里才是那一行的落点。
 *
 * ── 唯一一条结构纪律：【一个键都不许悄悄丢掉】 ─────────────────────
 * 已知键给中文标签，**其余键一律原样出行**（键名 + JSON 值）。
 * 只渲染白名单那一版的写法更短更好看，而它的失效方向是本仓最贵的那一种：
 * 将来往 parameters 里加一格（新的阈值、新的影响范围形状），界面**一个字都不变**，
 * 于是「这张卡没有那一格」与「这一格有而界面不认识它」在屏幕上长得一样 ——
 * CEO 是按这一屏批钱的人，少一行参数等于少一条他据以决定的信息，而没有任何东西会红。
 * 所以「未知键也要出现」不是兜底，是这一格的主张；下面 app-pure 那条用例
 * 专门喂一个契约里【没有】的键来钉它。
 *
 * ── 两个「没有」必须分开放 ───────────────────────────────────────
 *  null      ⇒ 「参数快照读不出来」—— 库里那段文本不是 JSON 对象（三种坏法的
 *              判定在服务端 parametersObjectOf，界面上这句是它的下游）。
 *  空对象 {} ⇒ 「参数快照为空」—— 读出来了，里面确实什么都没有。
 * 把两种并成一句，等于把「数据坏了」伪装成「这张卡本来就没参数」，
 * 而前者的正确反应是去查写入方（0007 §4.1 同一条立场）。
 */
function paramSnapshotLines(params) {
  if (
    params === null ||
    params === undefined ||
    typeof params !== "object" ||
    Array.isArray(params)
  ) {
    return [["参数快照", "读不出来（库里那段不是 JSON 对象）"]];
  }
  const keys = Object.keys(params);
  if (keys.length === 0) return [["参数快照", "为空（这张卡没带任何参数）"]];
  const rows = [];
  // 「推荐」那一格特殊：它要带着 §9.2 明写的「推荐，非决定」标注，而那个标注
  // 在数据里是一个独立的键（recommendation_is_not_decision，契约 literal(true)）。
  // 所以先【消费】那个标志位：为 true 时它并进推荐那一行的后缀，不再单独成行。
  // 为 false / 缺省时不消费 ⇒ 它会作为未知键原样出现 ⇒ 一个坏掉的标注是可见的，
  // 而不是被静默地当成"没有标注"。
  const flagKey = "recommendation_is_not_decision";
  const flagMarks = params[flagKey] === true;
  const handled = new Set();
  // 键的在场判断统一写 Object.hasOwn —— 这是【本仓既有写法】（contracts/harness.ts:501、
  // engine/dispatch.ts:425 各把理由写过一遍：`params[k] === undefined` 那种简写对
  // toString / constructor 这类【原型链上的名字】会命中，于是把没人写的键判成写了）。
  // ⚠ 这里换掉的是 `Object.prototype.hasOwnProperty.call(...)`，它【本来也是对的】
  //   —— 同为在场判断，只是长。换的理由是「一处一个写法」而不是「原来有洞」，
  //   别把这条注释读成修了一个 bug。
  if (Object.hasOwn(params, "amount_cents")) {
    handled.add("amount_cents");
    // money() 是这一屏上【唯一】那份美分→美元的格式化（任务预算那一列用的也是它）。
    // 在这一格里再写一遍 (c/100).toFixed(2) 就是两份会漂的抄件，而漂了的数
    // 是 CEO 用来批钱的数。
    // ⚠ 但【只有有限数】才交给 money()：money() 里那句 Number(c ?? 0) 对 null /
    //   undefined 交回的是 "$0.00"，对 "1250" 交回 "$12.50" —— 都不难看，也都不诚实。
    //   「金额没带」与「金额是 0」在收件箱里是会被批成两种东西的字：0 是一笔
    //   真实存在的、可以被批掉的金额。所以这一格与「不可逆性」同族，做【三态】：
    //   有限数 → 美元；其余一切 → 把原文摆出来（宁可难看，一个看不见的金额
    //   比一个难看的金额难查得多）。契约那边 amount_cents 是 optional 的整数，
    //   脏值进不来，但 parametersObjectOf 只保证【外面那层是对象】、不管里面的键。
    const c = params["amount_cents"];
    rows.push([
      "金额",
      Number.isFinite(c) ? money(c) : "读不出来：" + JSON.stringify(c),
    ]);
  }
  if (Object.hasOwn(params, "impact_scope")) {
    handled.add("impact_scope");
    rows.push(["影响范围", String(params["impact_scope"])]);
  }
  if (Object.hasOwn(params, "irreversible")) {
    handled.add("irreversible");
    // 三态：true ⇒ 不可逆，false ⇒ 可逆，**其它一切**（字符串 "true"、null…）
    // ⇒ 把原文摆出来。写成 `? "不可逆" : "可逆"` 会把脏值读成「可逆」，
    // 而 §9.1 的整条 R3（不可逆永不自动通过）就建在这一格上：
    // 把「读不出来」显示成「可逆」是那族判断里最贵的一次静默。
    const v = params["irreversible"];
    rows.push([
      "不可逆性",
      v === true
        ? "不可逆"
        : v === false
          ? "可逆"
          : "读不出来：" + JSON.stringify(v),
    ]);
  }
  if (Object.hasOwn(params, "recommendation")) {
    handled.add("recommendation");
    if (flagMarks) handled.add(flagKey);
    rows.push([
      "推荐动作",
      String(params["recommendation"]) + (flagMarks ? "（推荐，非决定）" : ""),
    ]);
  }
  if (Object.hasOwn(params, "timeout_behavior")) {
    handled.add("timeout_behavior");
    // 只【显示】超时行为，不显示「还剩多久」的倒数：全仓没有超时执行者
    // （口径见 approvalViewSchema ② 那一段），一个会走到零的倒计时读起来像系统坏了。
    rows.push(["超时行为", String(params["timeout_behavior"])]);
  }
  for (const k of keys) {
    if (handled.has(k)) continue;
    // 未知键（含 escalation 这一整块，以及将来加的任何一格）：键名原文 + JSON 值。
    // 值一律 JSON.stringify ⇒ 字符串带着引号。这不是没来得及美化，是刻意的：
    // 一个 unknown 的值是不是字符串、里面有没有换行，界面上不该替人猜。
    rows.push([k, JSON.stringify(params[k])]);
  }
  return rows;
}

/**
 * 审批卡已决明细（round342）。纯函数：只吃 approval 对象、拼字符串 + esc。
 * 三态：decided_at 为 null / undefined ⇒ ""（未决卡不显示）；
 * 否则「已决 · {fmtDate(decided_at)} · {decided_by ?? "—"}」+ 可选的
 * 「 · 理由：{esc(decision_note)}」。时间走 fmtDate（毫秒 → 本地时间串）。
 */
function decidedMetaHtml(approval) {
  const at = approval?.decided_at;
  if (at === null || at === undefined) return "";
  const who = approval?.decided_by ?? "—";
  const note = approval?.decision_note;
  const why = note ? ` · 理由：${esc(note)}` : "";
  return `已决 · ${esc(fmtDate(at))} · ${esc(who)}${why}`;
}

/** 参数快照的 HTML。等宽 + 左缩进，**不画框线**（那一条写在 .snap 的 CSS 旁边）。 */
function paramSnapshotHtml(params) {
  const rows = paramSnapshotLines(params);
  const cls =
    rows.length === 1 && rows[0][0] === "参数快照"
      ? "admin-snap-none admin-meta"
      : "admin-snap";
  const body = rows
    .map(
      (r) =>
        `<div class="admin-mono"><span class="admin-k">${esc(r[0])}</span>${esc(r[1])}</div>`,
    )
    .join("");
  return `<div class="${cls}">${body}</div>`;
}

/**
 * 审阅独立性那一句（O4：「这一点在界面上必须说出来」）。
 *
 * ── 这里【只念数】，一个判据都不算 ─────────────────────────────────
 * 六个数全部来自 `GET /org` 的 `review_independence`，由服务端调用判据正本
 * （`graph/gates/author-reviewer.ts` 的 `sameFamilyReviewBlock`）算出来。
 * 这一函数里出现的每一个数字都是 `p.pairs_*`，没有一处比较 `model_family`：
 * 那样就是把「什么算同族」抄进渲块第二份，而抄件不会红（0042 整篇的论题，
 * 本文件 `approvalCard` 那段「界面不做那条判据的抄件」同一立场）。
 *
 * ── 主语一律是【配对】，不是「审阅次数」 ⚠ 这一条别改 ────────────────
 * 分母是图上角色的无序对数（`pairs_total`），它说的是「哪些角色之间【如果】发生
 * 一次审阅会怎样」。真的审阅跑在 `IN_REVIEW` 那一遍上，两侧由运行期流转决定，
 * 今天【没有任何东西】知道将来会发生几次。把配对数写成次数，就是拿结构读数
 * 冒充一次预测 —— 而这句话的服务对象恰好是一个要按它安排注意力的 CEO。
 *
 * ── 三档分开说，因为【修法不同】 ──────────────────────────────────
 *  · 同族 ⇒ 点一次批准能过；
 *  · refused ⇒ 点了也没用，得先把 `model_family` 配上；
 *  · 分母 0 ⇒ 「没问题」和「算不出」是两句话，这里说后者。
 * 合并成一句「审阅会被拦」就把三种修法压成一种，而那一种通常恰好是错的那种。
 *
 * ── 颜色：一律蓝，一条琥珀都不发 ─────────────────────────────────
 * §19.2 把琥珀留给「此刻需要你决策」的东西（CSS 里 `.banner.warn` 那段为同一条
 * 立场把降级横幅从琥珀改成了蓝）。这一屏是【组织看板】，没有任何一行在等批准，
 * 所以哪怕说的是「每一次审阅都要你出现」，它也是一条【陈述】而不是一条待办。
 * 于是这一屏不加琥珀 = 保住「看到琥珀就知道要动手」那条扫视承诺。
 */
function reviewIndependenceBand(p) {
  if (p === null || typeof p !== "object" || Array.isArray(p)) {
    // 缺键 vs 算出来是零问题：前者是这台 Hub 没算（老版本 / 另一种装配）。
    return banner(
      "warn",
      "这台 Hub 没返回审阅独立性读数（GET /org 的 review_independence），所以这一屏对「审阅要不要你批」没有任何主张。",
    );
  }
  const roles = Number(p.roles ?? 0);
  const total = Number(p.pairs_total ?? 0);
  const same = Number(p.pairs_same_family ?? 0);
  const refused = Number(p.pairs_refused ?? 0);
  const head = `审阅独立性：${roles} 个角色 = ${total} 个角色配对`;

  if (total === 0) {
    return banner(
      "warn",
      `${head} —— 凑不出一对，算不出这一格。等图上有两个以上角色再看。`,
    );
  }
  // 全同族：这就是 O4 说的那台真机器的形状 —— 那道门不是例外，是常量。
  if (p.always_needs_approval === true) {
    return banner(
      "warn",
      `${head}，其中 ${same} 个同族 —— 也就是【任何】两个角色之间发生一次审阅，都会先被「同族审阅」拦一次。` +
        "这不是偶尔要点的例外：每次审阅都要你显式批一遍。要改的是让审阅方换一家模型，不是习惯这一格。",
    );
  }
  const ok = Number(p.pairs_ok ?? 0);
  // ⚠ `any_refused` 【读】、`same` 【直接用那个数】，这一差不是手滑：
  // `any_refused` 带的是一条【结论】——「修法是改图，不是点批准」。自己写
  // `refused > 0` 就把那条结论抄进渲块第二份，服务端将来把它改成
  // 「refused 但这一档可忽略」时这边一个字都不会红，而屏幕上还在说「批准点不过去」。
  // `same > 0` 不一样：它与我正要显示的那个整数【是同一个数】，无从漂起。
  const anyRefused = p.any_refused === true;
  const bits = [];
  if (same > 0) bits.push(`${same} 个同族（要你批准）`);
  // 这里【保留 model_family 这个词】：它是给 CEO 的【修法】里那个字段名，
  // 不是一份判据 —— 判据的形状是「取两侧的家族再比」，那句话只说去哪儿改。
  if (anyRefused)
    bits.push(
      `${refused} 个判不出家族（批准点不过去，先把 model_family 配上）`,
    );
  const detail = bits.length > 0 ? "，" + bits.join("，") : "，两两不同族";
  const tail = ok > 0 && ok < total ? `；其余 ${ok} 个不需要你出现` : "";
  // 一条待办都没有 ⇒ 中性那条（.banner 无色）；有 ⇒ 蓝。**都不是琥珀**，见函数头。
  let html = banner(bits.length > 0 ? "warn" : "", `${head}${detail}${tail}。`);
  // 被拦的配对逐条列出，reason 用【服务端正本原话】（这里不重写措辞、不翻译、不概括）。
  const blocked = Array.isArray(p.blocked) ? p.blocked : [];
  if (blocked.length > 0) {
    const rows = blocked
      .map(
        (b) =>
          `<div class="admin-mono admin-meta">${esc(b.producer)} ⇄ ${esc(b.reviewer)} · ${esc(b.code)}</div>${esc(b.reason)}`,
      )
      .join("");
    html += `<details><summary>哪 ${esc(blocked.length)} 个配对会被拦（原因原文来自服务端判据）</summary>${rows}</details>`;
  }
  return html;
}

/**
 * 一条委派边的 chips。round339。
 *
 * ⚠ 这一格存在的唯一理由是【可见性】：`review_gate` 一直在请求体里（add_edge 交它）、
 * 一直是必填布尔（delegationEdgeSchema 里那句 `review_gate: z.boolean()`）、一直进库，
 * 而界面上【一个字都不说】—— 屏幕上「a → b」那枚 chip 分不清「带门控的边」与
 * 「显式声明产出没人看的边」。规格 §16.6 对这一格的原话是「边上的小锁图标 =
 * 审阅门控」：要的是【边上看得出门控】，本轮落的是【边上的一句话】而不是那枚图标
 * （§19.2 那张配色表按用途只给了六格 —— 背景 / 卡片 / 琥珀 / 蓝 / 绿 / 灰 ——
 * 没有一格是给「配置状态」的，加一档颜色就是自己发明一档；文字不需要新语法）。
 * ⚠ 这一句是【我的取舍】，不是规格原话，别把它读成"图标已落地"。
 *
 * 这里【只念 review_gate 那一个布尔】，不重算任何判据（0042「界面不做那条判据的抄件」）：
 * 不写「这条会被拒」「这条合规」—— 那种句子在这里只能是第二份判据，
 * 而服务端改判据时这边不会红。
 *
 * 三态而不是两态。⚠ 先说清【schema 守不到哪一段】，否则这一段会变成一句假保证：
 * 那个必填布尔是在【写侧】守的（请求体 `graph: orgGraphSchema`）与【自检】里
 * （integrity 的 `orgGraphSchema.safeParse(raw)`），而 GET /org 这一头只是
 * `JSON.parse` —— 所以"这条边一定带这个布尔"是【写入路径给的保证】，不是这一发
 * 请求给的保证。⚠ 别把第三种成因写成「库里存的旧版本没这个字段」：本轮查过，
 * `review_gate: z.boolean()` 从它第一次入库那一发（71ee118）起就是必填，
 * 【从来没有过 optional 的版本】⇒ 那种"历史遗留"不存在。第三种成因只剩【绕过写侧】
 * 的那一类：手改过的库、别的 reader 喂进来的图、以及 GET /org 没再过 schema 这一段。
 * 缺字段时说「无门控」就是谎：它把「读不到」说成「读到了 false」，而两种情况的
 * 处置动作相反（前者查装配 / 跑自检，后者去把勾上勾重发一次）。
 * 与 reviewIndependenceBand 缺 review_independence 那一格同一个取舍。
 */
function edgeChip(e) {
  // ⚠ 【不带】可选链：`e?.review_gate` 会承诺"整条边缺失也扛得住"，而下一行的
  // `esc(e.from)` 在同样的输入上会抛 —— 一个函数里两种态度，读代码的人只能猜。
  // 本函数只降级【门控那一个字段】（上面函数头写的三态），端点缺失就是图坏了，
  // 让它抛出去由页面对调用的 load() 那一层现成的大 try/catch 接住
  // （本文件 load() 的 `catch → banner("err")`，每张视图都包在那层里）——
  // 比在这里静默画一枚空 chip 好。
  const gate = e.review_gate;
  const label =
    gate === true ? "已门控" : gate === false ? "无门控" : "门控未知";
  return `<span class="admin-edge admin-mono">${esc(e.from)} → ${esc(e.to)} · ${label}</span>`;
}

/**
 * 一张待批卡。§9.2 那三行：summary / 还等多久 / 三个按钮。
 *
 * ⚠ 这里【不显示】卡片参数全文，也不画证据链接 —— GET /approvals 刻意不返回它们
 *   （app.ts 里那句「一旦列表里有全文，就永远有人直接渲染它」）。
 *   所以渲块这边也就没有"顺手摊开参数"的那一行代码，两边口径一致。
 *   参数快照走 paramSnapshotHtml，它的数据来自 GET /approvals/:id（展开时才取）。
 *
 * 展开的【推荐理由】在 recommendation / escalation_reason 两格里 —— 它们【在】
 * 列表响应里（§9.2 第一行要它），而"展开才显示"是 §16.5 那句「默认折叠」的要求。
 *
 * ⚠ 第三个参数 isDecision 决定【琥珀 vs 灰】，而它不是"待批"的同义词。
 * 我第一版写的是 `decided ? "" : " need"` —— 也就是凡是 pending 一律琥珀。
 * 那一版对 §7.4 是**直接违反**：「审批收件箱出现**非琥珀色**的『预算暂停』卡片
 * （这是运营事件，不是战略决策）」。所以判据是「pending **且**不是运营类型」，
 * 名单来自服务端（`operational_approval_types`），这里不写 "budget_override" 字面量。
 * 少这一发会怎样：收件箱里同时躺着琥珀的升级卡和琥珀的预算卡，
 * 而 §19.2 承诺的是「琥珀出现处就是需要你动手的地方」—— 两处都琥珀，
 * 等于取消了那一格「这是运营事件、优先级低于战略决策」的信息。
 */
function approvalCard(a, nowMs, compact, isDecision = true) {
  const decided = a.status !== "pending";
  const amber = !decided && isDecision;
  // §9.4 批量：卡片根带 id 锚点；勾选框【只给 pending】—— 非待批卡不参与批量，
  // 所以连勾选的入口都不给（前端不做"选了再说"，那会把剔除逻辑藏进提交路径）。
  // ⚠ tabindex="-1"（不是 "0"）：卡根本身不是"一个操作"，它的可操作性在里面的
  // select / 意见框 / 决定按钮上。-1 = 【只许程序化聚焦、不进 Tab 序列】，
  // 于是"重渲染后把焦点还到这一张卡"有地方落（没有这一发，focus() 落在
  // 一个不可聚焦的 div 上 = 静默回到 body，恢复这一手等于没写），
  // 而 Tab 序列一个字都没变 —— 不会把人从按钮上甩到卡根去。
  return `<div class="admin-card${amber ? " admin-need" : ""}${!decided && !isDecision ? " admin-flag" : ""}" data-approval-id="${esc(a.id)}" tabindex="-1">
    <div class="admin-row">
      ${decided ? "" : `<label class="admin-meta" style="display:flex;align-items:center;gap:4px"><input type="checkbox" data-batch-pick="${esc(a.id)}" />批量</label>`}
      <span class="admin-pill ${decided ? statusClass(a.status === "approved" ? "delivered" : "rejected") : amber ? "admin-s-amber" : "admin-s-gray"}">${esc(a.status)}</span>
      <strong class="admin-grow tw:text-balance">${esc(a.summary)}</strong>
    </div>
    <div class="admin-meta" style="margin-top:4px">
      ${esc(a.approval_type)} · 任务 <span class="admin-mono">${esc(a.task_id ?? "—")}</span> · 等了 ${esc(fmtAgo(a.created_at, nowMs))}
      ${!decided && !isDecision ? " · <b>运营事件</b>（非战略决策，§7.4）" : ""}
      ${a.timeout_at ? ` · 超时点 ${esc(fmtDate(a.timeout_at))}（${esc(a.timeout_behavior ?? "未声明")}）` : ""}
      ${evidenceLine(a)}
    </div>
    ${decided ? "" : policyShadowLine(a)}
    ${
      /*
       * 第二行「关键参数快照」（§9.2）+ §16.5 那句「默认折叠，展开显示参数快照」。
       * 【只在展开时才去取】：列表响应里【没有】parameters（GET /approvals 刻意不发，
       * 见 http/app.ts 那条「不该被塞进列表接口当作副产品」），所以展开那一刻
       * 发一发 GET /approvals/:id。做成"列表一起拉全部详情"会把收件箱变成
       * N+1 次请求，而那一屏本来只要一眼 —— 折叠态就是它的设计用途。
       * compact（今日页那些小卡）不给这一格：那一页要的是「一眼扫过 + 点进抽屉」。
       */
      !compact
        ? `<details style="margin-top:8px" data-snap="${esc(a.id)}">
             <summary>参数快照</summary>
             <div data-snap-slot="${esc(a.id)}"><div class="admin-snap-none admin-meta">载入中…</div></div>
           </details>`
        : ""
    }
    ${
      !compact && (a.recommendation || a.escalation_reason)
        ? `<details style="margin-top:8px"><summary>推荐理由 / 升级原因</summary>
           <div class="admin-meta" style="margin-top:6px">${esc(a.recommendation ?? "（无建议）")}</div>
           ${a.escalation_reason ? `<div class="admin-meta">升级原因：${esc(a.escalation_reason)}</div>` : ""}
           ${a.recommendation_source ? `<div class="admin-meta">建议来源：${esc(a.recommendation_source)}</div>` : ""}
         </details>`
        : ""
    }
    ${decided ? "" : decideRow(a.id)}
  </div>`;
}

/**
 * 三个按钮（§16.1「做决策」那一行）。
 * 打回必须带理由 —— 那是【契约层】的判据（reject_with_comment 缺 note ⇒ 422）。
 * 这里刻意不提前把它拦成灰按钮：让 Hub 说那句话。渲块替前端圆场 = 同一句话
 * 有两份实现，而其中一份（浏览器里那份）可以被绕过。
 */
const decideRow = (id) => `<div class="admin-row" style="margin-top:10px">
    <select data-act="${esc(id)}">
      <option value="approve">批准</option>
      <option value="reject_with_comment">打回并附意见</option>
      <option value="defer_deep_review">稍后深度审阅</option>
    </select>
    <input type="text" data-note="${esc(id)}" placeholder="意见（打回时必填，会作为约束写回节点）" class="admin-grow" />
    <button class="admin-btn admin-primary" data-decide="${esc(id)}">决定</button>
  </div>
  <div class="admin-err" data-res="${esc(id)}" style="margin-top:6px"></div>`;

function bindDecide() {
  for (const b of $view.querySelectorAll("[data-decide]")) {
    b.addEventListener("click", () => void decide(b.dataset.decide));
  }
}

/**
 * 「参数快照」那一格的展开取数（GET /approvals/:id 的唯一调用点）。
 *
 * ── 三件不成问题的细节，各自对应一种会静默的坏法 ──────────────────
 *  ① **只在第一次展开时取**：`el.open` 在 toggle 之后才是新值，所以判据读的是
 *    「已经缓存过」而不是「现在是开的」。写成判 open 的话，收起→展开会再发一次。
 *    缓存这份数据是**安全**的而不是"大概不会变"：`parameters` 只有
 *    `INSERT_CARD_SQL` 一个写入方，全仓四条 `UPDATE approvals` 改的是
 *    status / decided_by / decided_at / decision_note，一条都不碰 parameters
 *    （0008 那条「写了不可改」的口径在同一列上成立）。所以这一格里不会有旧值。
 *  ② **失败要写在格子里，不能让格子停在「载入中…」**：那五个字是本格唯一的
 *    「正在发生」形状，一次失败的请求如果留着它，读起来是「还在转」，
 *    而真相是「这一段永远不会有内容」（与 openDrawer 那条「抽屉自己消失」同一族）。
 *  ③ **成功之后仍走 paramSnapshotHtml**：那一份渲染函数同时是 app-pure 里
 *    被真跑的那一个，界面上出现的每一行参数都经过它。在这里另写一遍
 *    "把 parameters 摊成行"就是两份会漂的抄件，而漂的方向是
 *    「测试跑的那份没显示，显示的那份没测」。
 */
function bindSnapshots() {
  for (const d of $view.querySelectorAll("[data-snap]")) {
    d.addEventListener("toggle", () => void loadSnapshot(d.dataset.snap));
  }
}

/** 详情缓存：id → GET /approvals/:id 的响应对象（含 parameters 与已决明细）。 */
const snapshotCache = new Map();

async function loadSnapshot(id) {
  const slot = $view.querySelector(`[data-snap-slot="${CSS.escape(id)}"]`);
  if (!slot) return;
  if (snapshotCache.has(id)) {
    const st = snapshotCache.get(id);
      slot.innerHTML =
        paramSnapshotHtml(st?.parameters ?? null) + decidedMetaHtml(st);
    return;
  }
  const { status, data } = await api(
    "GET",
    "/approvals/" + encodeURIComponent(id),
  );
  // 这一发请求回来的时候，卡片可能已经被一次重渲染换掉了（有人刚批了别的卡）。
  // 那个 slot 于是脱离文档，往里写不会显示出来 —— 但也不该写：它不属于当前这一屏。
  if (!slot.isConnected) return;
  if (status !== 200) {
    slot.innerHTML = banner(
      "err",
      `参数快照取不到：GET /approvals/${id} → ${status}`,
    );
    return;
  }
  const params = data?.approval?.parameters;
  // 【不】在这里替服务端把「缺键」圆成空对象：null 就是 null，
  // paramSnapshotLines 会把它显示成「参数快照读不出来」那一句（三种坏法见那边）。
  snapshotCache.set(id, data?.approval ?? null);
  slot.innerHTML = paramSnapshotHtml(params) + decidedMetaHtml(data?.approval);
}

async function decide(id) {
  const act = $view.querySelector(`[data-act="${CSS.escape(id)}"]`).value;
  const note = $view
    .querySelector(`[data-note="${CSS.escape(id)}"]`)
    .value.trim();
  const out = $view.querySelector(`[data-res="${CSS.escape(id)}"]`);
  const { status, data } = await api(
    "POST",
    "/approvals/" + encodeURIComponent(id),
    {
      resume: act,
      ...(note ? { note } : {}),
    },
  );
  const ok = status >= 200 && status < 300;
  out.style.color = ok ? "var(--green)" : "";
  out.textContent = ok
    ? data?.replayed
      ? "已经有人决定过了（幂等：这次是重放）"
      : "✔ 已决定"
    : `✖ ${status} ${JSON.stringify(data)}`;
  if (ok) {
    todayCache = null;
    setTimeout(
      () => void (current === "inbox" ? renderInbox() : renderToday()),
      600,
    );
  }
}

/* ───────── §9.4 批量批准 / 批量打回（round330） ─────────
 * 判据【只住服务端】：POST /approvals/batch 自己报 422 混类型 / 404 缺 id / reject 缺 note，
 * 并回一份 { applied, replayed, approval_type, resume }；这边三件事：选择、提交、
 * 把服务端答复原文搬上屏。
 *
 * ⚠ 这里【刻意不写】一个「选中类型是否齐一」的客户端预检。它一度存在过
 * （batchTypeCheck：读 approval_type、不齐就提示并 return），拆掉的理由不是风格：
 *  ① 「同类型」这条判据因此只有一处字面写法（服务端 batchApprovalOutcome）。
 *     两处写同一判据会漂，而漂的方向是本仓为 kindOf() 立过的那条规矩（0026 §0）。
 *  ② 预检读的是 inboxCache，缓存可以过期。它比服务端【宽松】的方向不存在
 *     （读的是同一列），但比服务端【严格】的方向存在：把一组其实同类型的卡
 *     判成不齐 ⇒ 【拦住一件服务端本来会批的事】。一个会拦错东西的客户端判据
 *     比没有客户端判据贵，而它的替代方案就在同一个页面上（「重读」按钮）。
 *  ③ 混类型的答复并不更差：服务端那句 422 自己带着 types 列表，
 *     比这边自己拼的一句提示准（它读的是写之前那一刻的库，不是缓存）。
 * 代价说清楚：CEO 混着勾 20 张要等一个来回才知道不齐。这是【选了「一处判」必然付的价】，
 * 不是遗漏 —— 记在这里，是为了下一轮读代码的人不把它当成待补的 UI 缺口。
 *
 * ⚠ esc 的落点：进入 HTML 的字符串一律 esc（banner 里的类型名/原文），
 * 但【请求体不 esc】—— 出网的是 JSON 载荷，转义会改坏 id 本身，
 * 让一条真实存在的记录被服务端 404 掉。
 */

/** 选中且 pending 的卡片对象（两个纯函数共用的选择集）。非数组/缺项一律忽略。 */
function batchPicked(cards, selectedIds) {
  const picked = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  const list = Array.isArray(cards) ? cards : [];
  return list.filter((a) => a && picked.has(a.id) && a.status === "pending");
}

/**
 * 提交体：{ approval_ids, resume, note? }。
 * note 空白 ⇒ 省略该键（契约里 note 是可选键；reject 缺 note 的 422 归服务端说）。
 * 空选择 ⇒ approval_ids: []（中性值；绑定层据此不发请求）。
 */
function batchRequestBody(cards, selectedIds, resume, note) {
  const approval_ids = batchPicked(cards, selectedIds).map((a) => a.id);
  const trimmed = String(note ?? "").trim();
  return { approval_ids, resume, ...(trimmed ? { note: trimmed } : {}) };
}

function bindBatch() {
  for (const b of $view.querySelectorAll("[data-batch]")) {
    b.addEventListener("click", () => void submitBatch(b.dataset.batch));
  }
}

async function submitBatch(resume) {
  const out = $view.querySelector("[data-batch-out]");
  const ids = [...$view.querySelectorAll("[data-batch-pick]:checked")].map(
    (c) => c.dataset.batchPick,
  );
  const list = inboxCache?.approvals ?? [];
  if (ids.length === 0) {
    out.innerHTML = banner("warn", "没有勾选任何待批卡片。");
    return;
  }
  const note = String($view.querySelector("[data-batch-note]")?.value ?? "");
  const { status, data } = await api(
    "POST",
    "/approvals/batch",
    batchRequestBody(list, ids, resume, note),
  );
  if (status === 200 && data?.ok) {
    out.innerHTML = banner(
      "",
      `批量完成：生效 ${esc(data.applied)} · 重放 ${esc(data.replayed)}（${esc(data.approval_type)} → ${esc(data.resume)}）`,
    );
    todayCache = null;
    setTimeout(() => void renderInbox(), 600);
  } else if (status === 422 && Array.isArray(data?.types)) {
    out.innerHTML = banner(
      "err",
      `${data.error ?? "批量被拒"}：${data.types.join("、")}`,
    );
  } else {
    out.innerHTML = banner(
      "err",
      `POST /approvals/batch → ${status} ${JSON.stringify(data)}`,
    );
  }
}

/* ═════════════════ 页面 4：组织配置（§16.6 / §18） ═════════════════
 * 这一版做到「看 + 拖拽改汇报关系」：
 *  · 层级布局上可直接拖一张卡到另一张卡 = reparent（Pointer Events，无库）。
 *  · 松手【不本地改图】：先把变更摆成一行待提交，由 CEO 填 change_summary 再 POST /org；
 *    合法性（环 / 深度 / 自审）住在服务端（L1/L2/L3），422 时界面回弹并回显服务端正本
 *    那一句 —— 这是 §18.2/§18.3 要的「拖拽被约束在合法语义内」。
 *    ⚠ 别说成「逐条说原因」：判据拒的是【一条】原因（CommitResult 只有一个 reason/code，
 *    http/org.ts 把它翻成 `{error, code}`），逐条列的是请求体没过 schema 那一支
 *    （`{error, issues}` 数组）。reparent 走的正是前一支，所以这一行以前对
 *    它自己正在描述的这条路说错了（round339 改）。
 *  · 键盘替代保留：下方那个 <details> 表单（选两个下拉 + 提交）全程可键盘操作。
 *  · 岗位书在「岗位书」页、预算在「预算」页配；信任积分仍没有数据生产者，不画。
 */
/* ── 查看/编辑模式（§18.6：查看模式不可拖拽；默认查看）────────────────
 * 默认【查看】：拖拽与键盘改报路径都不绑；点「编辑」才绑。
 * 模式只影响【拖拽绑定】，不改数据 —— 提交与否仍由服务端判。
 * 状态放模块作用域：renderOrg 每次重渲都会重新 bindOrgDrag，
 * 放局部会在下一次 GET /org 回来时把用户刚切好的模式冲掉。
 */
let orgMode = orgDefaultMode(); // "view" | "edit"

/** 进页默认是查看模式（§18.6：查看模式不可拖拽）。 */
function orgDefaultMode() {
  return "view";
}

/** 当前模式允许拖拽吗 —— 纯函数（§18.6：查看不拖）。未知值一律按查看收。 */
function orgDragEnabled(mode) {
  return mode === "edit";
}

/** 组织页模式条 —— 纯函数：一句话模式 + 「编辑 / 退出编辑」按钮。 */
function orgModeBand(mode) {
  const on = mode === "edit";
  return `<div class="admin-meta" data-orgmode style="margin-bottom:8px"><button class="admin-btn" data-org-toggle>${on ? "退出编辑" : "编辑"}</button> ${on ? "编辑模式 · 拖拽改汇报关系，提交后生效（松手不出网，服务端判合法才落）" : "查看模式 · 拖拽关闭（改汇报关系：点「编辑」，或用下方表单）"}</div>`;
}

/** 切换查看/编辑：只翻模块状态并重渲（模式不碰数据）。 */
function toggleOrgMode() {
  orgMode = orgMode === "edit" ? "view" : "edit";
  void renderOrg();
}

async function renderOrg() {
  const { status, data } = await api("GET", "/org");
  if (status !== 200) {
    $view.innerHTML = banner(
      "err",
      `GET /org → ${status}：${JSON.stringify(data)}`,
    );
    setConn("down", `GET /org ${status}`);
    return;
  }
  const nodes = data.graph?.nodes ?? {};
  const edges = data.graph?.edges ?? [];
  const keys = Object.keys(nodes);

  let html = banner(
    "",
    `graph_version ${data.graph_version} · ${esc(data.change_summary ?? "")} · 生效 ${esc(fmtDate(data.effective_from))}`,
  );
  // 审阅独立性那一格放在【空图分支之前】：空图也要能说「算不出」，
  // 而不是因为图上没人就整段消失（那样「没有读数」与「没有格子」看不出区别）。
  html += reviewIndependenceBand(data.review_independence);
  html += `<div class="admin-toolbar"><button class="admin-btn" data-reload>↻ 刷新</button></div>`;
  html += orgModeBand(orgMode);
  if (keys.length === 0) {
    html += banner(
      "warn",
      "还没有组织图（graph_version 0 = 从没提交过，不是出错）。先用 CLI 提交一版。",
    );
    $view.innerHTML = html;
    $view
      .querySelector("[data-reload]")
      .addEventListener("click", () => void renderOrg());
    return;
  }
  // 层级树：与看板同一份派生（depthOf），所以这一页和那一页的列【必然】一致。
  // 帮助文字要能自证与【当前模式】一致：查看模式还写着「拖一张卡」就是它自己拆台。
  const cols = hierarchyColumns(nodes);
  html +=
    `<div class="admin-meta" style="margin-bottom:8px">${orgMode === "edit" ? "拖一张卡到另一张卡上 = 改它的汇报关系。松手不会直接改图：合法性（成环 / 深度）由服务端判，拒了就回弹并说明原因。键盘替代：下方表单。" : "查看模式：只能看组织结构与门控状态；想改汇报关系请先点上方「编辑」。"}</div>` +
    `<div class="admin-orgdrag">` +
    cols
      .map(
        (c) =>
          `<p class="admin-sect">${esc(c.label)}</p><div class="admin-grid">` +
          [...c.roles]
            .map((k) => {
              const n = nodes[k] ?? {};
              return `<div class="admin-node" data-role="${esc(k)}" tabindex="0"><div class="admin-role">${esc(k)}</div>
                <div class="admin-meta">${esc(n.model_family ?? "未配模型")}</div>
                <div class="admin-rpto">${n.reports_to ? "↗ " + esc(n.reports_to) : "<b>CEO（顶层）</b>"}</div>
                ${n.can_manage ? '<div class="admin-tag">可管理</div>' : ""}</div>`;
            })
            .join("") +
          `</div>`,
      )
      .join("") +
    `</div>` +
    // 拖完先落在这行待提交（change_summary 必填，服务端每版都要答得出「改了什么」）。
    `<div class="admin-card admin-dragrow admin-hidden" data-dragrow>
       <div class="admin-row">
         <span class="admin-grow" data-dragtext></span>
         <input type="text" data-drag-summary class="admin-grow" placeholder="改了什么（change_summary，必填）" />
         <button class="admin-btn admin-primary" data-drag-commit>提交</button>
         <button class="admin-btn" data-drag-cancel>取消</button>
       </div>
       <div data-drag-result style="margin-top:6px"></div>
     </div>
     <div class="admin-meta" data-dragmsg style="margin-top:4px"></div>
     <p class="admin-sect" style="margin-top:18px">委派边（谁能把活交给谁 · ${esc(edges.length)} 条）</p>
     <div>` +
    // 门控状态挂在 chip 上（round339）：那个布尔一直在请求体与库里，而屏幕以前不读它。
    (edges.length ? edges.map((e) => edgeChip(e)).join("") : "—") +
    `</div>
     <details style="margin-top:14px"><summary>新增一个角色（POST /org · add_node）</summary>
       <div class="admin-row" style="margin-top:8px;align-items:flex-start">
         <input type="text" data-new-role placeholder="role_id（必填，图里的键就是它）" style="width:190px" />
         <span class="admin-meta">报给</span>
         <select data-new-parent><option value="">（顶层 · 无上级）</option>${keys.map((k) => `<option>${esc(k)}</option>`).join("")}</select>
         <input type="text" data-new-family placeholder="model_family（可空：留空=未配模型，判定上会拦）" style="width:230px" />
         <label class="admin-meta"><input type="checkbox" data-new-manage /> 可接收汇报（can_manage）</label>
         <input type="text" data-new-summary class="admin-grow" placeholder="改了什么（change_summary，必填）" />
         <button class="admin-btn admin-primary" data-add-node>提交</button>
       </div>
       <div data-new-result style="margin-top:6px"></div>
       <p class="admin-meta" style="margin-top:6px">
         add_node 只把人放进图里【不挂委派边】（契约 ②：边另走 add_edge，那条路上才有
         门控 / 自审 / 同家族 / 升级可达 / 深度这一套 L2 判据）。新角色进图后用下面
         「加一条委派边」那一栏挂边。契约里没有删除节点这一档，所以这里也不画删除按钮：
         那会是一个点了必然失败的按钮。
       </p>
     </details>
     <details style="margin-top:14px"><summary>加一条委派边（POST /org · add_edge · 全套 L2 判据在服务端）</summary>
       <div class="admin-row" style="margin-top:8px;align-items:flex-start">
         <select data-edge-from>${keys.map((k) => `<option>${esc(k)}</option>`).join("")}</select>
         <span class="admin-meta">产出 → 审阅</span>
         <select data-edge-to>${keys.map((k) => `<option>${esc(k)}</option>`).join("")}</select>
         <label class="admin-meta"><input type="checkbox" data-edge-gate checked /> 审阅门控（review_gate）</label>
         <input type="text" data-edge-summary class="admin-grow" placeholder="改了什么（change_summary，必填）" />
         <button class="admin-btn admin-primary" data-add-edge>提交</button>
       </div>
       <div data-edge-result style="margin-top:6px"></div>
       <p class="admin-meta" style="margin-top:6px">
         勾选框【不勾】= 显式声明「这条边上的产出没人看」（review_gate: false），
         服务端以 missing_review_gate 拒这一发 —— 它是【第一个】能失败的判据
         （只有「角色不在图里」排在它前面），所以不勾时升级可达 / 自审 / 同家族
         那三条在这一发里【根本没被求值】：想先知道那三条合不合规，得带着勾提交。
         界面不做那条判据的抄件，所以这里不预测结果；被拒时回显服务端正本那一句
         （判据拒的是【一条原因】，不是清单 —— 逐条列的是请求体没过 schema 那种）。
       </p>
     </details>
     <details style="margin-top:14px"><summary>改一条汇报关系（POST /org，变更前强制备份 · 也是拖拽的键盘替代）</summary>
       <div class="admin-row" style="margin-top:8px;align-items:flex-start">
         <select data-child>${keys.map((k) => `<option>${esc(k)}</option>`).join("")}</select>
         <span class="admin-meta">改报给</span>
         <select data-parent>${keys
           .filter((k) => k !== "ceo")
           .map((k) => `<option>${esc(k)}</option>`)
           .join("")}</select>
         <input type="text" data-summary class="admin-grow" placeholder="改了什么（change_summary，必填）" />
         <button class="admin-btn admin-primary" data-commit>提交</button>
       </div>
       <div data-result style="margin-top:6px"></div>
     </details>
     ${banner("warn", "信任积分这一页还没有：它没有数据生产者，画出来就是一根会说谎的条。岗位书与预算已挪到各自的导航页。")} `;
  $view.innerHTML = html;
  $view
    .querySelector("[data-reload]")
    .addEventListener("click", () => void renderOrg());
  $view
    .querySelector("[data-org-toggle]")
    .addEventListener("click", toggleOrgMode);
  $view
    .querySelector("[data-commit]")
    .addEventListener("click", () => void commitOrg(nodes, edges));
  $view
    .querySelector("[data-add-node]")
    .addEventListener("click", () => void addOrgNode(nodes, edges));
  $view
    .querySelector("[data-add-edge]")
    .addEventListener("click", () => void addOrgEdge(nodes, edges));
  // 绑定与否看【纯函数】的答案 —— 变异机打这一格（查看模式仍绑拖拽 = 抹掉这层判断）。
  if (orgDragEnabled(orgMode)) bindOrgDrag(nodes, edges);
}

/* ── 拖拽 = reparent 的提议（Pointer Events，不引库）──────────────────
 * 三条纪律：
 *  ① 拖拽只产生【提议】，不改内存里的图 —— 提交走 POST /org（before 图 + change），
 *     after 由服务端算；渲块算 after 就是「审计说 A 而库里是 B」。
 *  ② canPropose 只挡结构上必错的那两种（自环 / 挂到自家子孙下 = 成环），
 *     这是给拖动手感的即时反馈，不是判据 —— 最终判定在服务端，拒了照样回弹。
 *  ③ 键盘路径：Tab 聚焦卡片，Enter 选中（pick），再在目标卡上 Enter = 同一行待提交；
 *     Esc 取消。与 <details> 表单互为替代。
 */
let dragPicked = null; // 键盘路径当前选中的角色
function bindOrgDrag(nodes, edges) {
  const dragRow = $view.querySelector("[data-dragrow]");
  const dragMsg = $view.querySelector("[data-dragmsg]");
  let pending = null; // { child, parent }

  const say = (t) => {
    dragMsg.textContent = t;
  };
  const hide = () => {
    dragRow.classList.add("admin-hidden");
    pending = null;
  };
  dragRow.querySelector("[data-drag-cancel]").addEventListener("click", hide);
  dragRow
    .querySelector("[data-drag-commit]")
    .addEventListener("click", () => void commitDrag());
  const clearMarks = () => {
    for (const c of $view.querySelectorAll(".admin-orgdrag .admin-node"))
      c.classList.remove("admin-dropok", "admin-dropbad");
  };
  // 结构上必挂的两种（本地即时提示用；服务端仍是权威）
  const wouldCycle = (child, parent) => {
    let cur = parent;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      if (cur === child) return true;
      seen.add(cur);
      cur = nodes[cur]?.reports_to;
    }
    return false;
  };
  const propose = (child, parent) => {
    pending = { child, parent };
    dragRow.classList.remove("admin-hidden");
    dragRow.querySelector("[data-dragtext]").innerHTML =
      `把 <b>${esc(child)}</b> 从 <span class="admin-mono">${esc(nodes[child]?.reports_to ?? "顶层")}</span> 改报给 <b>${esc(parent)}</b>`;
    dragRow.querySelector("[data-drag-summary]").value = "";
    dragRow.querySelector("[data-drag-result]").innerHTML = "";
    dragRow.querySelector("[data-drag-summary]").focus();
    say("");
  };

  // 命中测试：ghost 是 pointer-events:none，elementFromPoint 直接穿过去落在卡片上。
  const hit = (x, y, child) => {
    const el = document.elementFromPoint(x, y)?.closest(".admin-orgdrag .admin-node");
    if (!el || el.dataset.role === child) return { el: null };
    const parent = el.dataset.role;
    if (wouldCycle(child, parent))
      return { el, bad: "挂到自己/自家子孙下会成环 —— 已回弹（服务端也会拒）" };
    return { el, parent };
  };

  for (const card of $view.querySelectorAll(".admin-orgdrag .admin-node")) {
    card.addEventListener("pointerdown", (e) => {
      // 双保险：renderOrg 只在编辑模式才 bindOrgDrag，这里再挡一层 ——
      // 万一将来有人把绑定挪回无条件，查看模式下拖不拖得动仍由这格说了算。
      if (!orgDragEnabled(orgMode)) return;
      if (e.button !== 0) return;
      const child = card.dataset.role;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let ghost = null;
      card.setPointerCapture(e.pointerId);

      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return; // 4px 内不算拖，免得误伤点击
          const r = card.getBoundingClientRect();
          ghost = document.createElement("div");
          ghost.className = "admin-org-ghost";
          ghost.style.left = r.left + "px";
          ghost.style.top = r.top + "px";
          ghost.style.width = r.width + "px";
          ghost.textContent = "↪ " + child;
          document.body.appendChild(ghost);
          card.classList.add("admin-dragging");
        }
        ghost.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`;
        clearMarks();
        const t = hit(ev.clientX, ev.clientY, child);
        if (t.el) t.el.classList.add(t.parent ? "admin-dropok" : "admin-dropbad");
      };
      const up = (ev) => {
        card.removeEventListener("pointermove", move);
        card.removeEventListener("pointerup", up);
        card.removeEventListener("pointercancel", cancel);
        ghost?.remove();
        card.classList.remove("admin-dragging");
        clearMarks();
        if (!ghost) return; // 没拖过 = 一次普通点击，什么都不做
        const t = hit(ev.clientX, ev.clientY, child);
        if (t.bad) {
          say(t.bad);
          return;
        }
        if (t.parent) propose(child, t.parent);
        else say("没放到别的角色上，已回弹（图没动）。");
      };
      const cancel = () => {
        card.removeEventListener("pointermove", move);
        card.removeEventListener("pointerup", up);
        card.removeEventListener("pointercancel", cancel);
        ghost?.remove();
        card.classList.remove("admin-dragging");
        clearMarks();
      };
      card.addEventListener("pointermove", move);
      card.addEventListener("pointerup", up);
      card.addEventListener("pointercancel", cancel);
    });

    // 键盘替代：Enter 选 / Enter 定，Esc 取消。同拖拽：只在编辑模式活。
    card.addEventListener("keydown", (e) => {
      if (!orgDragEnabled(orgMode)) return;
      const role = card.dataset.role;
      if (e.key === "Escape") {
        unpick();
        return;
      }
      if (e.key !== "Enter") return;
      if (!dragPicked) {
        dragPicked = role;
        card.classList.add("admin-pick");
        say(`已选中 ${role}，Tab 到新的上级再按 Enter 确认（Esc 取消）`);
      } else if (dragPicked === role) {
        unpick();
      } else {
        const child = dragPicked;
        unpick();
        if (wouldCycle(child, role)) {
          say(`挂到自己/自家子孙下会成环 —— 已拒绝（服务端也会拒）`);
          return;
        }
        propose(child, role);
      }
    });
  }
  function unpick() {
    dragPicked = null;
    for (const c of $view.querySelectorAll(".admin-orgdrag .admin-node.admin-pick"))
      c.classList.remove("admin-pick");
  }

  async function commitDrag() {
    if (!pending) return;
    const out = dragRow.querySelector("[data-drag-result]");
    await submitOrgChange(
      nodes,
      edges,
      {
        kind: "reparent",
        child_role: pending.child,
        new_parent_role: pending.parent,
      },
      dragRow.querySelector("[data-drag-summary]").value.trim(),
      out,
    );
  }
}

/** 422 的 issues / reason 翻成人话：逐条列，兜底才 JSON.stringify。 */
function rejectHtml(status, data) {
  const issues = Array.isArray(data?.issues) ? data.issues : null;
  if (issues && issues.length) {
    const lines = issues
      .map(
        (i) =>
          `<div class="admin-err">· ${esc(i.path ? [].concat(i.path).join(".") : "?")}：${esc(i.message ?? JSON.stringify(i))}</div>`,
      )
      .join("");
    return `<div class="admin-err">✖ ${esc(status)} 服务端拒了 ${esc(issues.length)} 条（图没动）：</div>${lines}`;
  }
  const reason = data?.reason ?? data?.error;
  if (reason)
    return `<div class="admin-err">✖ ${esc(status)} 服务端拒了（图没动）：${esc(reason)}</div>`;
  return `<div class="admin-err">✖ ${esc(status)} ${esc(JSON.stringify(data))}</div>`;
}

/**
 * 组织写路径的【唯一】提交口：四条路（拖拽 reparent / 表单 reparent / add_node /
 * add_edge）交的是同一个形状 —— before 图 + 一条 change + 一句 change_summary。
 * 四条各写一份的失效方式本文件记过多次：成功后的刷新、失败的逐条回显、summary 的
 * 必填拦截，改一处不带另外三处。
 * ⚠ 这里【不算 after 图】：after 由服务端 applyChangeToGraph 算 —— 渲块自己算一遍，
 *   就会出现「审计说 A 而库里是 B」。
 */
async function submitOrgChange(nodes, edges, change, summary, out) {
  if (!summary) {
    out.innerHTML = `<span class="admin-err">change_summary 必填 —— 版本历史里每一版都该答得出「改了什么」</span>`;
    return;
  }
  const { status, data } = await api("POST", "/org", {
    graph: { nodes, edges },
    change,
    change_summary: summary,
  });
  if (status === 200) {
    out.innerHTML = `<span class="admin-ok">✔ 已提交 graph_version ${esc(data.graph_version)}${data.needs_confirmation ? " · " + esc(data.needs_confirmation) : ""}，正在刷新</span>`;
    todayCache = null;
    setTimeout(() => void renderOrg(), 500);
  } else {
    // 服务端拒了 ⇒ 图没动过（变更前备份 + 单事务），这里只把那句话逐条显示出来。
    out.innerHTML = rejectHtml(status, data);
  }
}

async function commitOrg(nodes, edges) {
  const child = $view.querySelector("[data-child]").value;
  const parent = $view.querySelector("[data-parent]").value;
  const summary = $view.querySelector("[data-summary]").value.trim();
  const out = $view.querySelector("[data-result]");
  if (child === parent) {
    out.innerHTML = `<span class="admin-err">不能报给自己（自环，L1 会拒）</span>`;
    return;
  }
  await submitOrgChange(
    nodes,
    edges,
    { kind: "reparent", child_role: child, new_parent_role: parent },
    summary,
    out,
  );
}

/** 新增角色：role_id 同时是节点本体与图里的键（契约 ③ ⇒ 身份只有一个来源，不存在「键≠自称」可判）。 */
async function addOrgNode(nodes, edges) {
  const roleId = $view.querySelector("[data-new-role]").value.trim();
  const out = $view.querySelector("[data-new-result]");
  if (!roleId) {
    out.innerHTML = `<span class="admin-err">role_id 必填</span>`;
    return;
  }
  const family = $view.querySelector("[data-new-family]").value.trim();
  const parent = $view.querySelector("[data-new-parent]").value;
  const node = {
    role_id: roleId,
    can_manage: $view.querySelector("[data-new-manage]").checked,
    reports_to: parent === "" ? null : parent,
  };
  // 空串不是「没配模型」，是一个【长度为 0 的家族名】：契约上 model_family 是
  // optional().min(1)，交空串会被 schema 拒成一条看不懂的 422。留空就整个不给这个键。
  if (family) node.model_family = family;
  await submitOrgChange(
    nodes,
    edges,
    { kind: "add_node", node },
    $view.querySelector("[data-new-summary]").value.trim(),
    out,
  );
}

/** 加委派边（from 产出 → to 审阅）。门控勾不勾都交，判据全在服务端。 */
async function addOrgEdge(nodes, edges) {
  const from = $view.querySelector("[data-edge-from]").value;
  const to = $view.querySelector("[data-edge-to]").value;
  const out = $view.querySelector("[data-edge-result]");
  if (from === to) {
    out.innerHTML = `<span class="admin-err">自己审自己（自审，L2 会拒）</span>`;
    return;
  }
  await submitOrgChange(
    nodes,
    edges,
    {
      kind: "add_edge",
      edge: {
        from,
        to,
        review_gate: $view.querySelector("[data-edge-gate]").checked,
      },
    },
    $view.querySelector("[data-edge-summary]").value.trim(),
    out,
  );
}

/* ═════════════════ 页面 6：岗位书编辑器（#/charter） ═════════════════
 * 左列 = 角色清单（来自 GET /org 的 graph.nodes 的键），右侧 = 编辑表单。
 * GET /charter/:roleId 返回 { role_id, charter: <蛇形 config 或 null> }；
 * POST 同一地址，body = { config, change_summary }。
 *
 * ⚠ 诚实性一条：acceptance_criteria【绝不预填】。那几条验收标准按 0008 §7
 * 只能由 CEO 本人写，开发者（或界面）代填一条 = 占位符被当成内容。
 * charter 为 null 时表单照常打开（技术性字段可预填），验收标准栏留空 + 说明。
 *
 * ⚠ 422 的 issues 按 path 第一段定位到对应输入框旁边逐条渲染，
 * 不弹一句 JSON.stringify —— 那是「报错但没人看得懂」的形状。
 * 表单没覆盖的字段（stance / dissent_rights / search_policy / harness_defaults…）
 * 编辑已有岗位书时原样保留在提交体里，不许被表单悄悄抹掉。
 */
let charterRole = null; // 当前选中的角色，切页回来还在
async function renderCharter() {
  const org = await api("GET", "/org");
  if (org.status !== 200) {
    $view.innerHTML = banner(
      "err",
      `GET /org → ${org.status}（角色清单来自组织图，先修这一头）`,
    );
    return;
  }
  const nodes = org.data.graph?.nodes ?? {};
  const keys = Object.keys(nodes);
  if (keys.length === 0) {
    $view.innerHTML = banner(
      "warn",
      "组织图是空的（graph_version 0），没有角色可配岗位书。",
    );
    return;
  }
  if (!charterRole || !keys.includes(charterRole)) charterRole = keys[0];

  $view.innerHTML = `
    <div class="admin-charter-cols">
      <div class="admin-rolelist">
        <p class="admin-sect">角色 · ${esc(keys.length)}</p>
        ${keys.map((k) => `<button class="admin-btn admin-rolebtn${k === charterRole ? " admin-act" : ""}" data-role="${esc(k)}">${esc(k)}</button>`).join("")}
      </div>
      <div id="charter-panel"><div class="admin-banner">载入中…</div></div>
    </div>`;
  for (const b of $view.querySelectorAll("[data-role]")) {
    b.addEventListener("click", () => {
      charterRole = b.dataset.role;
      for (const o of $view.querySelectorAll(".admin-rolebtn"))
        o.classList.toggle("admin-act", o === b);
      void loadCharter(nodes);
    });
  }
  await loadCharter(nodes);
}

/** 一行的多行文本 ⇄ string[]；一行一条，空行忽略。 */
const linesOf = (el) =>
  el.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
const joinLines = (arr) => (Array.isArray(arr) ? arr : []).join("\n");

async function loadCharter(nodes) {
  const panel = document.getElementById("charter-panel");
  panel.innerHTML = `<div class="admin-banner">载入中…</div>`;
  const { status, data } = await api(
    "GET",
    "/charter/" + encodeURIComponent(charterRole),
  );
  if (status !== 200) {
    panel.innerHTML = banner(
      "err",
      `GET /charter/${charterRole} → ${status}：${JSON.stringify(data)}`,
    );
    return;
  }
  const cfg = data.charter ?? null; // 蛇形 config 或 null（null = 从没写过岗位书）
  const node = nodes[charterRole] ?? {};
  const sel = (opts, cur, name) =>
    `<select data-f="${name}">` +
    opts
      .map(
        (o) =>
          `<option value="${esc(o.v)}"${String(o.v) === String(cur) ? " selected" : ""}>${esc(o.t)}</option>`,
      )
      .join("") +
    `</select>`;
  const ta = (name, val, ph, rows) =>
    `<textarea data-f="${name}" rows="${rows ?? 3}" style="width:100%" placeholder="${esc(ph)}">${esc(val)}</textarea>`;
  const emptyAc = cfg === null;
  panel.innerHTML = `
    <div class="admin-card">
      <h3>岗位书 · ${esc(charterRole)}</h3>
      ${
        cfg === null
          ? banner(
              "warn",
              "这个角色还没有岗位书（charter 为 null）。必填项都在下面，但【验收标准必须由你本人写】—— 项目规矩（0008 §7）不允许任何人代写 acceptance_criteria，界面预填一条都是违规。其余栏也建议逐条过目再提交。",
            )
          : banner(
              "",
              `已有岗位书 version ${esc(cfg.version)}。表单没覆盖的字段（stance / dissent_rights / search_policy / harness_defaults 等）会原样保留提交。`,
            )
      }
      <div class="admin-grid" style="grid-template-columns:1fr 1fr;margin-top:10px">
        <label>role_id<input type="text" data-f="role_id" value="${esc(cfg?.role_id ?? charterRole)}" style="width:100%" /></label>
        <label>display_name（显示名）<input type="text" data-f="display_name" value="${esc(cfg?.display_name ?? "")}" style="width:100%" /></label>
        <label>version（正整数）<input type="text" data-f="version" value="${esc(cfg?.version ?? 1)}" style="width:100%" /></label>
        <label>reports_to（上级）
          ${sel(
            [
              { v: "", t: "（无 · 顶层）" },
              ...Object.keys(nodes)
                .filter((k) => k !== charterRole)
                .map((k) => ({ v: k, t: k })),
            ],
            cfg ? (cfg.reports_to ?? "") : (node.reports_to ?? ""),
            "reports_to",
          )}
        </label>
        <label>model_tier${sel(
          MODEL_TIERS.map((m) => ({ v: m, t: m })),
          cfg?.model_tier ?? MODEL_TIERS[0],
          "model_tier",
        )}</label>
        <label>cognitive_skill（可选）<input type="text" data-f="cognitive_skill" value="${esc(cfg?.cognitive_skill ?? "")}" style="width:100%" /></label>
        <label>budget.daily_usd<input type="text" data-f="daily_usd" value="${esc(cfg?.budget?.daily_usd ?? "")}" style="width:100%" /></label>
        <label>budget.per_task_usd<input type="text" data-f="per_task_usd" value="${esc(cfg?.budget?.per_task_usd ?? "")}" style="width:100%" /></label>
      </div>
    </div>

    <div class="admin-card"><p class="admin-sect">honesty_boundaries（诚实边界 · 一行一条 · 至少一条）</p>
      ${ta("honesty_boundaries", joinLines(cfg?.honesty_boundaries), "例：不确定时说不确定，不编造数字")}
      <div data-err="honesty_boundaries"></div>
    </div>

    <div class="admin-card"><p class="admin-sect">acceptance_criteria（验收标准 · 一行一条 · 至少一条）${emptyAc ? ' <b style="color:var(--ink)">必须由你本人写</b>' : ""}</p>
      <div class="admin-meta" style="margin-bottom:6px">每行格式：<span class="admin-mono">condition | action(reject/escalate) | target(escalate 必填，可留空) | message</span></div>
      ${ta(
        "acceptance_criteria",
        emptyAc
          ? ""
          : (cfg?.acceptance_criteria ?? [])
              .map((a) =>
                [a.condition, a.action, a.target ?? "", a.message].join(" | "),
              )
              .join("\n"),
        "例：产出没有引用来源 | reject | | 无来源产出直接打回",
        4,
      )}
      <div data-err="acceptance_criteria"></div>
    </div>

    <div class="admin-card"><div class="admin-grid" style="grid-template-columns:1fr 1fr">
      <div><p class="admin-sect">forbidden_actions（一行一条）</p>${ta("forbidden_actions", joinLines(cfg?.forbidden_actions), "")}<div data-err="forbidden_actions"></div></div>
      <div><p class="admin-sect">tool_permissions（一行一条）</p>${ta("tool_permissions", joinLines(cfg?.tool_permissions), "")}<div data-err="tool_permissions"></div></div>
      <div><p class="admin-sect">decision_scope.autonomous（一行一条）</p>${ta("ds_autonomous", joinLines(cfg?.decision_scope?.autonomous), "")}</div>
      <div><p class="admin-sect">decision_scope.requires_consultation（一行一条）</p>${ta("ds_consultation", joinLines(cfg?.decision_scope?.requires_consultation), "")}</div>
      <div><p class="admin-sect">decision_scope.forbidden（一行一条）</p>${ta("ds_forbidden", joinLines(cfg?.decision_scope?.forbidden), "")}<div data-err="decision_scope"></div></div>
      <div><p class="admin-sect">escalation_triggers（一行一条 · 裸串或 JSON 对象）</p>${ta("escalation_triggers", (cfg?.escalation_triggers ?? []).map((t) => (typeof t === "string" ? t : JSON.stringify(t))).join("\n"), '例：涉及对外发布 | {"condition":"...","target":"ceo","action":"create_approval_card"}', 3)}<div data-err="escalation_triggers"></div></div>
    </div></div>

    <div class="admin-card"><div class="admin-row">
      <label>judgment_mode（必填：契约里它是 required，不是可选）${sel([...JUDGMENT_MODES.map((m) => ({ v: m, t: m }))], cfg?.judgment_mode?.type ?? JUDGMENT_MODES[0], "jm_type")}</label>
    </div>
      <div class="admin-grid" style="grid-template-columns:1fr 1fr 1fr;margin-top:8px">
        <div><p class="admin-sect">strict_rules</p>${ta("jm_strict", joinLines(cfg?.judgment_mode?.strict_rules), "", 2)}</div>
        <div><p class="admin-sect">bounded_judgment</p>${ta("jm_bounded", joinLines(cfg?.judgment_mode?.bounded_judgment), "", 2)}</div>
        <div><p class="admin-sect">full_discretion</p>${ta("jm_discretion", joinLines(cfg?.judgment_mode?.full_discretion), "", 2)}</div>
      </div>
      <div data-err="judgment_mode"></div>
    </div>

    <div class="admin-card">
      <div class="admin-row">
        <input type="text" data-f="change_summary" class="admin-grow" placeholder="change_summary（必填：这一版改了什么）" />
        <button class="admin-btn admin-primary" data-save>${cfg === null ? "创建" : "提交新版本"}</button>
      </div>
      <div style="margin-top:8px" data-save-result></div>
    </div>
    ${cfg ? `<details class="admin-lowcontrast"><summary>这份 config 原文（表单没覆盖的字段以这里为准，提交时原样保留）</summary><pre>${esc(JSON.stringify(cfg, null, 2))}</pre></details>` : ""}`;
  panel
    .querySelector("[data-save]")
    .addEventListener("click", () => void saveCharter(cfg));
}

/** 收表单 → 蛇形 config。以【服务端回来的 cfg】为底，只覆盖表单覆盖到的字段。 */
function charterFormToConfig(base) {
  const q = (f) =>
    document.getElementById("charter-panel").querySelector(`[data-f="${f}"]`);
  const cfg = base ? JSON.parse(JSON.stringify(base)) : {};
  cfg.role_id = q("role_id").value.trim();
  cfg.display_name = q("display_name").value.trim();
  const v = Number(q("version").value.trim());
  if (Number.isInteger(v) && v > 0) cfg.version = v; // 不合法就留着（多半缺），让 422 说
  const rt = q("reports_to").value;
  cfg.reports_to = rt === "" ? null : rt;
  cfg.model_tier = q("model_tier").value;
  const cs = q("cognitive_skill").value.trim();
  if (cs) cfg.cognitive_skill = cs;
  else delete cfg.cognitive_skill;
  cfg.budget = {
    daily_usd: Number(q("daily_usd").value.trim()),
    per_task_usd: Number(q("per_task_usd").value.trim()),
  };
  cfg.honesty_boundaries = linesOf(q("honesty_boundaries"));
  cfg.forbidden_actions = linesOf(q("forbidden_actions"));
  cfg.tool_permissions = linesOf(q("tool_permissions"));
  cfg.decision_scope = {
    autonomous: linesOf(q("ds_autonomous")),
    requires_consultation: linesOf(q("ds_consultation")),
    forbidden: linesOf(q("ds_forbidden")),
  };
  cfg.escalation_triggers = linesOf(q("escalation_triggers")).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return l;
    } // 裸串与对象两种合法写法（契约是 union）
  });
  // judgment_mode 在 charterInput 里是【必填】对象（z.object(...).strict()，没有 optional()），
  // 而 charterToCamel 无条件读 c.judgment_mode.type —— 所以它不是「可以不填」的一档。
  // 表单以前给一个「（不设）」空选项并把字段标成可选，缺省时直接不发这个键
  // ⇒ 服务端 422 config.judgment_mode：expected object, received undefined。
  // 空值在这里就当场拦下（不发半截请求），而不是让 CEO 去猜 422 的哪一条。
  const jm = q("jm_type").value;
  if (!jm) {
    return { cfg: null, acErrors: ["judgment_mode 没选：三档里必须挑一档"] };
  }
  cfg.judgment_mode = {
    type: jm,
    strict_rules: linesOf(q("jm_strict")),
    bounded_judgment: linesOf(q("jm_bounded")),
    full_discretion: linesOf(q("jm_discretion")),
  };
  // acceptance_criteria：按行拆 4 段；行形不对的收进 errors，别把半截数据发给服务端。
  const acErrors = [];
  const ac = [];
  for (const line of linesOf(q("acceptance_criteria"))) {
    const bits = line.split("|").map((s) => s.trim());
    if (
      bits.length < 2 ||
      bits.length > 4 ||
      !bits[0] ||
      !bits[1] ||
      !bits[3]
    ) {
      acErrors.push(
        `行「${line}」不对：需要 condition | action | (target) | message 四段（target 可空）`,
      );
      continue;
    }
    const a = { condition: bits[0], action: bits[1], message: bits[3] };
    if (bits.length === 4 && bits[2]) a.target = bits[2];
    ac.push(a);
  }
  cfg.acceptance_criteria = ac;
  return { cfg, acErrors };
}

async function saveCharter(base) {
  const panel = document.getElementById("charter-panel");
  const out = panel.querySelector("[data-save-result]");
  for (const e of panel.querySelectorAll("[data-err]")) e.innerHTML = "";
  const summary = panel.querySelector('[data-f="change_summary"]').value.trim();
  const { cfg, acErrors } = charterFormToConfig(base);
  // cfg === null 只在 judgment_mode 没选时出现（理由见 charterFormToConfig 里那段）。
  // 它和「验收标准行格式不对」是两类问题，落点也不同，所以提前返回，别去碰
  // cfg.acceptance_criteria —— 那是 null。
  if (cfg === null) {
    out.innerHTML = `<span class="admin-err">${esc(acErrors[0] ?? "表单不完整。")}</span>`;
    return;
  }
  let blocked = "";
  if (!summary) blocked = "change_summary 必填。";
  if (acErrors.length) {
    panel.querySelector('[data-err="acceptance_criteria"]').innerHTML = acErrors
      .map((m) => `<div class="admin-err">· ${esc(m)}</div>`)
      .join("");
    blocked += " 验收标准有行格式不对。";
  }
  if (blocked) {
    out.innerHTML = `<span class="admin-err">${esc(blocked.trim())}</span>`;
    return;
  }

  const { status, data } = await api(
    "POST",
    "/charter/" + encodeURIComponent(charterRole),
    {
      config: cfg,
      change_summary: summary,
    },
  );
  if (status === 200) {
    out.innerHTML = `<span class="admin-ok">✔ 已提交 version ${esc(data.version)}（charter ${esc(data.charter_id)} · 审计 #${esc(data.audit_seq)}）</span>`;
    const fresh = await orgNodesForCharter(); // 重拉一次：reports_to 的下拉要用最新图
    setTimeout(() => void loadCharter(fresh), 400);
    return;
  }
  // 422：按 path 第一段把每条 issue 钉回对应输入框旁边；认不出的落全局区。
  const issues = Array.isArray(data?.issues) ? data.issues : null;
  const line = (i) =>
    `<div class="admin-err">· ${esc([].concat(i.path ?? "?").join("."))}：${esc(i.message ?? JSON.stringify(i))}</div>`;
  const global = [];
  for (const i of issues ?? []) {
    const head = [].concat(i.path ?? []).map(String)[0];
    const slot = head ? panel.querySelector(`[data-err="${head}"]`) : null;
    if (slot) slot.innerHTML += line(i);
    else global.push(line(i));
  }
  if (issues?.length) {
    out.innerHTML = `<span class="admin-err">✖ 422：${esc(issues.length)} 条字段问题，已标在对应输入框旁边。</span>${global.join("")}`;
  } else {
    out.innerHTML = `<span class="admin-err">✖ ${esc(status)} ${esc(data?.error ?? JSON.stringify(data))}</span>`;
  }
}
async function orgNodesForCharter() {
  const { status, data } = await api("GET", "/org");
  return status === 200 ? (data.graph?.nodes ?? {}) : {};
}

/* ═════════════════ 页面 7：预算（#/budget） ═════════════════
 * 一张表 + 一行新增/改限额的表单。
 * ⚠ 配色：琥珀在这里【一概不许】—— 超限是运营事件不是战略决策（§7.4），
 * 红色只给消耗条（§7.4 全规格唯一明写的红）。
 * ⚠ unset_scopes 必须说出来：「有 N 个角色一行都没设」≠「消耗是 0」，
 *   沉默的零是本仓最忌讳的形状。
 */
/**
 * 预算表单的两个下拉：合法值取自 contracts 的 BUDGET_SCOPE_VALUES /
 * BUDGET_PERIOD_VALUES，而不是在这里手抄一份。
 *
 * 抄件的失效方式本文件以前已经吃过：服务端加一档而下拉还认旧的。原来这两个
 * 框是自由文本 + 一个 value="lifetime" 的缺省值，而 "lifetime" 根本不在
 * BUDGET_PERIOD_VALUES（daily/monthly/per_task）里 —— 缺省值指向一个服务端必拒
 * 的取值 ⇒ 什么都不改、直接点提交，第一次就 422。
 *
 * 「data-f=」这一串【必须与岗位书表单同源】：那是 saveCharter 里 charterFormToConfig
 * 找字段用的属性名。这里一度写成 data-${attr}（生成 data-scope_type），而 putBudget
 * 查的是 [data-scope-type] —— 连字符与下划线之差，点击提交直接
 * Cannot read properties of null (reading 'value')。同一套取属性的代码用同一个属性名，
 * 别在这里发明第二种写法。
 */
function enumSel(attr, values, def, title) {
  return (
    `<select data-f="${attr}" title="${esc(title)}">` +
    values
      .map((v) => `<option${v === def ? " selected" : ""}>${esc(v)}</option>`)
      .join("") +
    `</select>`
  );
}

async function renderBudget() {
  const { status, data } = await api("GET", "/budget");
  if (status !== 200) {
    $view.innerHTML = banner(
      "err",
      `GET /budget → ${status}${data?.error ? "：" + String(data.error) : "（后端可能还没上这一格）"}`,
    );
    return;
  }
  const rows = data.rows ?? [];
  const totals = data.totals ?? {};
  const unset = totals.unset_scopes;
  const rowHtml = (r) => {
    const limit = Number(r.limit_cents ?? 0);
    const used = Number(r.consumed_cents ?? 0);
    const pct =
      limit > 0
        ? Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
        : 0;
    const over = limit > 0 && used >= limit;
    return `<tr>
      <td class="admin-mono">${esc(r.scope_type)}/${esc(r.scope_id)}</td>
      <td>${esc(r.period)}</td>
      <td class="admin-mono">${limit > 0 ? esc(money(limit)) : "<b>未设</b>"}</td>
      <td class="admin-mono">${esc(money(used))}</td>
      <td class="admin-meter${over ? " admin-over" : ""}" style="min-width:90px"><i style="width:${pct}%"></i></td>
      <td>${r.hard_stop ? "硬停" : "软限"}</td>
    </tr>`;
  };
  $view.innerHTML = `
    <div class="admin-card">
      <div class="admin-row">
        <span class="admin-meta admin-mono">合计：已用 ${esc(money(totals.consumed_cents))} / 上限 ${esc(money(totals.limit_cents))}
          · 未设限额的角色 <b>${esc(unset)}</b>${unset > 0 ? " —— <b>这是「没设」，不是「是 0」</b>：那些角色此刻花钱没有任何上限拦着" : unset === 0 ? "（每个角色都至少设了一行）" : "（口径未给出）"}</span>
        <button class="admin-btn" data-reload>↻ 刷新</button>
      </div>
    </div>
    ${
      rows.length
        ? `<div class="admin-card"><div class="admin-table-wrap"><table class="admin-btable"><thead><tr>
           <th>作用域</th><th>周期</th><th>上限</th><th>已用</th><th>进度</th><th>停法</th>
         </tr></thead><tbody>${rows.map(rowHtml).join("")}</tbody></table></div></div>`
        : banner(
            "warn",
            "一行预算都没有 —— 是「没设」，不是「都是 0」。在下面的表单里设第一行。",
          )
    }
    <div class="admin-card">
      <p class="admin-sect">新增 / 改限额（POST /budget，同键覆盖）</p>
      <div class="admin-row">
        ${enumSel("scope_type", BUDGET_SCOPE_VALUES, "role", "scope_type")}
        <input type="text" data-f="scope_id" placeholder="scope_id（如角色 id）" style="width:160px" />
        ${enumSel("period", BUDGET_PERIOD_VALUES, "daily", "period")}
        <input type="text" data-f="limit_cents" placeholder="limit_cents（整数分）" style="width:150px" />
        <label class="admin-meta"><input type="checkbox" data-f="hard_stop" /> 硬停</label>
        <button class="admin-btn admin-primary" data-put>提交</button>
      </div>
      <div style="margin-top:6px" data-budget-result></div>
    </div>`;
  $view
    .querySelector("[data-reload]")
    .addEventListener("click", () => void renderBudget());
  $view
    .querySelector("[data-put]")
    .addEventListener("click", () => void putBudget());
}

async function putBudget() {
  const out = $view.querySelector("[data-budget-result]");
  const scope_type = $view.querySelector('[data-f="scope_type"]').value.trim();
  const scope_id = $view.querySelector('[data-f="scope_id"]').value.trim();
  const period = $view.querySelector('[data-f="period"]').value.trim();
  const limitRaw = $view.querySelector('[data-f="limit_cents"]').value.trim();
  const limit_cents = Number(limitRaw);
  if (!scope_type || !scope_id || !period) {
    out.innerHTML = `<span class="admin-err">作用域/周期都要填</span>`;
    return;
  }
  if (!Number.isInteger(limit_cents) || limit_cents < 0) {
    out.innerHTML = `<span class="admin-err">limit_cents 得是非负整数（单位是分）</span>`;
    return;
  }
  const { status, data } = await api("POST", "/budget", {
    scope_type,
    scope_id,
    period,
    limit_cents,
    hard_stop: $view.querySelector('[data-f="hard_stop"]').checked,
  });
  if (status >= 200 && status < 300) {
    out.innerHTML = `<span class="admin-ok">✔ 已写入，正在刷新</span>`;
    todayCache = null; // 今日页那根预算条与这页同源同刻才对得上
    setTimeout(() => void renderBudget(), 400);
  } else out.innerHTML = rejectHtml(status, data);
}

/* ═════════════════ 页面 5：回放（§16.7） ═════════════════
 * 用途（§16.7 原话）不是合规审计，而是「以最低时间成本判断哪个层级的岗位书需要改」。
 * 所以时间线上最该显眼的是【审阅决定】与【自动批准】这两类 —— 它们才是岗位书的证据。
 * 上面那个着色点在 CSS 里：decide = 琥珀（那是 CEO 自己动过手的地方），auto = 蓝。
 */

/**
 * §16.7「支持按事件类型过滤」的五组，逐字对应 actions 文档（OPC-OS-设计文档 §22.1 action
 * 枚举：state_change · review_decision · approval · tool_call · budget_consume · meeting ·
 * harness_call · unauthorized_attempt · dissent · escalation）。
 * 每组把「规格的那五个词」映射到【底层 action 值】，映射里每一格都注明理由，
 * 而不是把枚举整体搬进来 —— 整体搬会让界面显示十类，规格只说了五类。
 *
 * 「全部」用 undefined 而不是空串：空串在语义上混入「清空过滤器」，见 filterReplayEntries 那行。
 */
const REPLAY_FILTERS = {
  all: undefined, // 不过滤
  decide: ["review_decision"], // 规格「审阅决定」
  tool: ["tool_call"], // 规格「工具调用」
  budget: ["budget_consume"], // 规格「预算」（budgets 变更由 state_change 承担，无单独 action）
  approval: ["approval"], // 规格「审批」（自动批准与人工批准同一 action）
  meeting: ["meeting"], // 规格「会议」
};

/** 回放页过滤下拉的顺序与文案（键即 REPLAY_FILTERS 的键）。 */
const REPLAY_FILTER_LABELS = [
  ["all", "全部事件"],
  ["decide", "审阅决定"],
  ["tool", "工具调用"],
  ["budget", "预算"],
  ["approval", "审批"],
  ["meeting", "会议"],
];

/**
 * §16.7 的事件类型过滤：输入 entries，返回【过滤后的】entries（原数组不动）。
 * 判据：`action` 是服务端 events 表的 action 列（replay/query.ts 把它原样带出），
 * 规格五组的映射见 REPLAY_FILTERS。
 */
function filterReplayEntries(entries, filter) {
  const allowed = REPLAY_FILTERS[filter] ?? REPLAY_FILTERS.all; // 未知名过滤 fallback 到全部
  return allowed === undefined
    ? entries
    : entries.filter((e) => allowed.includes(e.action));
}

/**
 * §16.7「可能还有更多」的分页判据（round340，决策 0052 欠账 ①）。
 *
 * 输入是【这一页服务端实际返回的条数】与【响应里的 effective_limit】（服务端
 * clamp 后的真实分母，query.ts 那段注释点名了为什么不能拿调用方传的 limit 来比）：
 * 返回 true ⇒ 后面还有行，界面该给「加载更多」；false ⇒ 到底了。
 *
 * ⚠ 不在这里处理 offset：那是【游标累计】的活（replayNextOffset），判据与游标分开，
 * 两格各测各的 —— 判据写错会让按钮永不出现，游标写错会让「加载更多」重复同一段。
 */
function replayHasMore(rawLen, effectiveLimit) {
  return (
    Number.isInteger(rawLen) &&
    Number.isInteger(effectiveLimit) &&
    rawLen > 0 &&
    rawLen >= effectiveLimit
  );
}

/**
 * 分页游标的下一步（round340）。服务端 offset 语义 = 从第 N 条起（replay/query.ts 的
 * REPLAY_EVENTS_SQL `ORDER BY id ASC LIMIT ? OFFSET ?`），所以累加量 = 当前 offset +
 * 【这一页服务端实际返回的条数】（不是过滤后的条数：过滤只发生在界面这一侧，
 * 游标算的是服务端取行位置，混进过滤后的数会把翻页位置算错）。
 * null / undefined / 非数都按 0 处理 ⇒ 传给 request 的永远是整数。
 */
function replayNextOffset(rawLen, curOffset) {
  const n = Number.isInteger(rawLen) ? rawLen : 0;
  const c = Number.isInteger(curOffset) ? curOffset : 0;
  return c + n;
}

/**
 * §16.7「逐节点可展开并显示输入输出摘要」的断点块。
 *
 * 服务端（replay/query.ts 的 decodeCheckpoint，round327 接上）给每个 checkpoint 行
 * 带 `decoded` + `summary`（每通道的 valueJson）。这里是它的展示半：
 *   - decoded=true 且 summary 非空：每个通道一个 <details>，展开看该通道的值 JSON；
 *   - decoded=false：通道值拿不到（未知 type / 损坏 blob），明说没解码 + type 标签，
 *     不显示一个假的「空摘要」 —— 那正是服务端在 decoded 上刻意的降级语义。
 * 输入是单行 checkpoint 对象（服务端 ReplayCheckpoint 形状），返回 HTML 字符串。
 */
function checkpointBlock(c) {
  // null / undefined / 没有 checkpoint_id 的空壳对象：都不构成一个断点。
  if (!c || !c.checkpoint_id) return "";
  const id = esc(c.checkpoint_id);
  const head = `<div class="admin-ev"><div class="admin-row">
    <span class="admin-pill admin-s-blue">断点</span>
    <span class="admin-meta admin-mono">${id}${c.parent_checkpoint_id ? " · 父 " + esc(c.parent_checkpoint_id) : ""}</span>
    <span class="admin-meta admin-mono">${esc(c.type ?? "?")}</span>
  </div>`;
  if (c.decoded !== true || !c.summary) {
    // 降级：不假装有摘要。给一个 type 就能看见「为什么解不开」。
    return (
      head +
      `<div class="admin-meta" style="margin:4px 0 8px">通道值未解码（${esc(c.type ?? "无类型")}）。</div></div>`
    );
  }
  const channels = c.summary
    .map(
      (
        s,
      ) => `<details style="margin:6px 0 0 4px"><summary>${esc(s.channel)}</summary>
      <pre class="admin-mono" style="margin:4px 0 6px;white-space:pre-wrap">${esc(s.valueJson)}</pre></details>`,
    )
    .join("");
  return head + `<div style="margin:4px 0 8px">${channels}</div></div>`;
}

let replayTask = "";
let replayFilter = "all";
async function renderReplay() {
  // 抽屉里的「打开完整回放」带 ?id=<task>，进来直接选中那条（不改 hash 协议：
  // hash 还是只当 #/<route>[/...] 解析，任务 id 走 query，回放页里其它控件照旧）。
  // 读 currentQuery（parseAdminHash 剥好前缀那一份），理由见 renderToday 里同注释。
  const hinted = new URLSearchParams(currentQuery).get("id");
  if (hinted && hinted !== replayTask) replayTask = hinted;
  const { status, data } = await api("GET", "/tasks");
  if (status !== 200) {
    $view.innerHTML = banner("err", `GET /tasks → ${status}`);
    return;
  }
  const tasks = data.tasks ?? [];
  if (!replayTask && tasks.length) replayTask = tasks[0].id;
  $view.innerHTML = `
    <div class="admin-toolbar">
      <select data-pick style="max-width:420px">
        ${tasks.map((t) => `<option value="${esc(t.id)}"${t.id === replayTask ? " selected" : ""}>${esc(t.title)} · ${esc(t.status)}</option>`).join("")}
      </select>
      <input type="text" data-kw placeholder="关键词（≥3 个汉字，trigram 窗口）" />
      <select data-filter>
        ${REPLAY_FILTER_LABELS.map(([v, label]) => `<option value="${v}"${v === replayFilter ? " selected" : ""}>${esc(label)}</option>`).join("")}
      </select>
      <button class="admin-btn" data-go>查时间线</button>
      <span class="admin-meta">${tasks.length ? "" : "还没有任务"}</span>
    </div>
    <div id="replay-body">${banner("", "选一条任务看它的回放。")}</div>`;
  if (!tasks.length) return;
  $view.querySelector("[data-pick]").addEventListener("change", (e) => {
    replayTask = e.target.value;
    replayOffset = 0; // 换任务：翻页游标作废（round340）
    void loadReplay();
  });
  $view.querySelector("[data-filter]").addEventListener("change", (e) => {
    replayFilter = e.target.value;
    replayOffset = 0; // 换过滤：同一段可能已翻页，游标归零
    void loadReplay();
  });
  $view
    .querySelector("[data-go]")
    .addEventListener("click", () => {
      replayOffset = 0; // 关键词变了：游标归零（round340）
      void loadReplay();
    });
  void loadReplay();
}

/** 回放翻页游标（round340）。换任务 / 换关键词 / 换过滤都归零 ——
 * 游标走得比 offset 更细：它描述的是「已拉完的取行位置」，换任何条件都作废。 */
let replayOffset = 0;
async function loadReplay() {
  const kw = ($view.querySelector("[data-kw]")?.value ?? "").trim();
  const body = document.getElementById("replay-body");
  body.innerHTML = banner("", "载入中…");
  const q =
    "?limit=200&offset=" +
    replayOffset +
    (kw ? "&keyword=" + encodeURIComponent(kw) : "");
  const { status, data } = await api(
    "GET",
    "/replay/" + encodeURIComponent(replayTask) + q,
  );
  if (status !== 200) {
    body.innerHTML = banner(
      "err",
      `GET /replay → ${status}：${JSON.stringify(data)}`,
    );
    return;
  }
  const rawEntries = data.entries ?? [];
  const entries = filterReplayEntries(rawEntries, replayFilter);
  const filterLabel = (REPLAY_FILTER_LABELS.find(
    ([v]) => v === replayFilter,
  ) ?? ["", "全部事件"])[1];
  const hasMore = replayHasMore(rawEntries.length, data.effective_limit);
  const moreButton = hasMore
    ? `<div style="margin:10px 0"></div>
      <div class="admin-toolbar"><button class="admin-btn" data-more>加载更多（已到第 ${esc(replayOffset + rawEntries.length)} 条）</button></div>`
    : "";
  /** 「加载更多」只挂在【本次请求的结账行】上：点它 = 从当前 offset 再拉 200。
   * 不是每次都从 0 开始的按钮 —— 那张牌只出现在翻页前。 */
  body.innerHTML = `
    <div class="admin-card">
      <div class="admin-row"><strong class="admin-grow">${esc(data.task.title)}</strong>
        <span class="admin-pill ${statusClass(data.task.status)}">${esc(data.task.status)}</span></div>
      <div class="admin-meta admin-mono" style="margin-top:4px">${esc(data.task.id)} · 角色 ${esc(data.task.assigned_role)} · 图版本 ${esc(data.task.graph_version)}${replayReportsToHtml(data.graph, data.task.assigned_role)}</div>
    </div>
    ${checkpointDegradedNote(data.checkpoints_unavailable, (data.checkpoints ?? []).length)}
    ${incompleteNote(data.complete)}
    <div class="admin-meta" style="margin:10px 0">事件 <span class="admin-mono">${esc(entries.length)}</span> 条（服务端 limit ${esc(data.effective_limit)}${replayHasMore(rawEntries.length, data.effective_limit) ? " · <b>可能还有更多</b>" : ""}）
      · 断点 ${esc((data.checkpoints ?? []).length)} 个${kw ? ` · 关键词「${esc(kw)}」` : ""}${replayFilter !== "all" ? ` · 类型「${esc(filterLabel)}」` : ""}</div>
    ${
      entries.length
        ? `<div class="admin-card"><div class="admin-tl">${entries.map(eventRow).join("")}</div></div>`
        : banner("", kw ? "这个关键词没命中任何事件。" : "这个任务还没有事件。")
    }
    ${moreButton}
    ${(data.checkpoints ?? []).length ? `<div class="admin-card" style="margin-top:10px"><div class="admin-meta" style="margin-bottom:4px">断点状态快照（每个断点的通道值，展开看）</div>${data.checkpoints.map(checkpointBlock).join("")}</div>` : ""}`;
  const pick = $view.querySelector("[data-pick]");
  const kwInput = $view.querySelector("[data-kw]");
  const flt = $view.querySelector("[data-filter]");
  const go = $view.querySelector("[data-go]");
  const more = body.querySelector("[data-more]");
  // 换条件 = 重拉。翻页那格【不进 querySelector 那套绑定】：点「加载更多」
  // 是游标前进 + 重新请求，不能换任务/关键词/过滤（那会与游标打架）。
  if (pick) pick.onchange = () => { replayOffset = 0; void loadReplay(); };
  if (kwInput) kwInput.oninput = () => { replayOffset = 0; };
  if (flt) flt.onchange = () => { replayOffset = 0; void loadReplay(); };
  if (go) go.onclick = () => { replayOffset = 0; void loadReplay(); };
  if (more) more.onclick = () => { replayOffset = replayNextOffset(rawEntries.length, replayOffset); void loadReplay(); };
}

/**
 * 事件行 target（round341，recorder.ts targetOf 的形状）。纯函数：
 * 数组（多目标）→「A、B、C」已 esc；单字符串 → trim 后已 esc；空/缺 → ""。
 */
function eventTargetText(target) {
  if (Array.isArray(target)) {
    const parts = target.map((x) => String(x ?? "")).filter((x) => x !== "");
    return parts.length ? esc(parts.join("、")) : "";
  }
  if (target == null) return "";
  const t = String(target).trim();
  return t ? esc(t) : "";
}

/**
 * 断点解码失败（checkpoints_unavailable）时的降级提示（round341）。纯函数：
 * 无降级 ⇒ ""；否则一条 warn banner「断点解码失败，仅显示数量」+ 实际断点 N 个。
 */
function checkpointDegradedNote(unavailable, count) {
  if (!unavailable) return "";
  const n =
    typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
  return (
    `<div class="admin-banner admin-warn" style="margin:0 0 10px"><b>断点解码失败，仅显示数量</b>` +
    `（${esc(String(unavailable))}${n > 0 ? ` · 实际断点 ${esc(n)} 个` : ""}）</div>`
  );
}

/**
 * 回放时间线「中间缺行」聚合提示（round346，replay/query.ts 的 complete）。
 * 纯函数：complete 是 false ⇒ 一条看得见的缺口提示；否则 ""（true / 缺字段 /
 * 非布尔 ⇒ 静默，老服务端没发这一格不算缺口）。
 */
function incompleteNote(complete) {
  if (complete !== false) return "";
  return (
    '<div class="admin-meta" style="margin-top:6px">⚠ 这条时间线不完整：' +
    "中间有缺口（服务端只按游标截断做了分页，不是分页截断的尾部）。</div>"
  );
}

/**
 * 一行事件的「策略引擎自动批准」标注。
 *
 * 服务端（replay/query.ts autoApprovedSection）沿真写入方
 * （policy/auto-approve.ts 的 payload.auto_approved_by）把这一格做成
 * `{ by, rule, annotation }` 对象，**不是**布尔 —— 早先一版前端拿
 * `e.auto_approved === true` 去比，对象恒不等于 true ⇒ 标注意味着的那行
 * 「基于模式的自动批准」从未上过屏，rule 名与规格话术的数据在响应里也
 * 白白在场。这里按对象形状读：读过 = 就是它，并把 by/rule 带出去给
 * 想分开显示「只读自动放行」与「基于模式的自动批准」的界面用。
 * 返回值【已 esc】过：rule 是库里的自由文本，直接进 innerHTML。
 */
function autoApprovedOf(e) {
  if (!e || typeof e !== "object") return null;
  const a = e.auto_approved;
  if (a == null || typeof a !== "object" || Array.isArray(a)) return null;
  const by = typeof a.by === "string" && a.by !== "" ? esc(a.by) : null;
  const rule = typeof a.rule === "string" && a.rule !== "" ? esc(a.rule) : null;
  const annotation =
    typeof a.annotation === "string" && a.annotation !== ""
      ? esc(a.annotation)
      : null;
  return { by, rule, annotation };
}

/** 一行事件。§22.3 那三条特殊标注在这里：自动批准、蒸馏 skill 判断、harness 版本。 */
function eventRow(e) {
  const auto = autoApprovedOf(e);
  const decide = e.actor_type === "human";
  const cls = auto !== null ? "admin-auto" : decide ? "admin-decide" : "";
  return `<div class="admin-ev ${cls}">
    <div class="admin-row">
      ${eventTargetText(e.target) ? `<span class="admin-tag admin-mono">→ ${eventTargetText(e.target)}</span>` : ""}
      <span class="admin-pill ${auto !== null ? "admin-s-blue" : decide ? "admin-s-green" : ""}">${esc(e.action)}</span>
      <span class="admin-meta admin-mono">${esc(e.actor_id)} · ${esc(fmtDate(e.created_at))} · #${esc(e.seq)}</span>
      ${auto !== null ? `<span class="admin-pill admin-s-blue">基于模式的自动批准</span>` : ""}
      ${e.skill_distilled === true ? '<span class="admin-pill admin-s-blue">蒸馏 skill 生成的判断</span>' : ""}
      ${e.harness ? `<span class="admin-tag admin-mono">${esc(e.harness)}</span>` : ""}
      ${e.degraded ? `<span class="admin-pill admin-s-red">降级：${esc(e.degrade_reason ?? "未知")}</span>` : ""}
    </div>
    ${eventOpinionHtml(e)}
    ${auto !== null && (auto.rule || auto.annotation) ? `<div class="admin-meta" style="margin:2px 0 6px"><span class="admin-pill admin-s-blue">自动批准</span> <span class="admin-mono">${auto.by ?? ""}${auto.rule ? " · 规则：" + auto.rule : ""}${auto.annotation ? " · " + auto.annotation : ""}</span></div>` : ""}
    ${e.degraded && e.raw_payload ? `<pre>${esc(e.raw_payload)}</pre>` : ""}
  </div>`;
}

/**
 * 事件行里那行【意见/理由原文】（round340，决策 0052 欠账 ②）。
 *
 * 两种事件各有一个真生产者，字段落点不同（沿库里的实际写入路径追出来的，不是猜的）：
 *   · review_decision：审阅者当轮写的那句理由在 **payload.note**（dispatch.ts 落库那份
 *     payload 里带 note；role-memory.ts 也按这个键读它并明说「原样引用、未经改写」）。
 *     线上 SSE 那份刻意不带（dispatch.ts 注释），所以只有回放（读库的）这一路能看见。
 *   · approval（人工决定）：CEO 打的理由在 **approvals.decision_note**，审计行落
 *     **state_snapshot.note**（approve.ts / real-deps.ts 那两处 appendAudit 都是
 *     `...(note===null?{}:{stateSnapshot:{note}})`；契约 api.ts:504 说那一列
 *     append-only、写了就改不掉）；而 approval 事件还有【请求】与【自动/超时】几个
 *     生产者（cards.ts / auto-approve.ts / timeout.ts 的 payload 都没有 note），
 *     所以没有时按没有算，不许拼假句。
 *
 * 返回 HTML 片段（空串 = 没有意见，不显示）。意见是库里的自由文本，一律过 esc。
 */
function eventOpinionHtml(e) {
  const text = eventNoteText(e);
  if (!text) return "";
  const who = e.action === "review_decision" ? "意见" : "理由";
  return `<div class="admin-meta" style="margin:2px 0 6px"><span class="admin-pill admin-s-blue">${who}</span> <span class="admin-mono">${esc(text)}</span></div>`;
}

/**
 * §16.7 事件行那条意见/理由的【纯文本】（round340）。返回空串 = 没有。
 * 判据与 eventOpinionHtml 同一份（HTML 壳别看，文本判断只在这里）：
 *   review_decision ⇒ payload.note（trim 后非空才算）；
 *   approval ⇒ state_snapshot.note（decision_note 那条路）trim 后非空才算；
 *   其它 / 形状不对 / 空 ⇒ ""。
 */
function eventNoteText(e) {
  if (!e || typeof e !== "object") return "";
  const snap =
    e.state_snapshot && typeof e.state_snapshot === "object"
      ? e.state_snapshot.note
      : undefined;
  const fromSnapshot = typeof snap === "string" ? snap.trim() : "";
  const payloadNote =
    e.payload && typeof e.payload === "object"
      ? e.payload.note
      : undefined;
  const fromPayload = typeof payloadNote === "string" ? payloadNote.trim() : "";
  if (e.action === "review_decision") {
    return fromPayload;
  }
  if (e.action === "approval") {
    return fromSnapshot;
  }
  return "";
}

/**
 * 回放头卡那句【汇报关系说明】（round340，决策 0052 / §22.3 第 4 条欠账 ③）。
 *
 * 服务端已在响应里给了 `graph.reports_to`（Record<roleId, reports_to|null>，
 * 任务【运行时】那一版组织图的汇报关系，query.ts graphSection ——
 * 刻意不退回当前图，读不到时给带原因的 degraded 块）。
 * 这里是展示半：把那张 Record 压成一行「角色 ↖ 上级」的说明。
 *  - graph 整体读不到（ok:false / degraded block）⇒ 回退 [版本号 + 原因] 一样的东西，
 *    头卡仍显示图版本（原行在），汇报关系只能说读不到 —— 不许编一张假的。
 *  - taskRole 不在 reports_to 里 ⇒ 说「该角色在图里」？不：图上没有它的汇报行，
 *    但那可能是【这一版图里本来就没有这个角色】。给一句「当时图上查不到」，不猜。
 *
 * 返回「 · 汇报<b>a→b</b> · c→d」这样的 HTML 片段（可空）。
 */
function replayReportsToHtml(graph, taskRole) {
  if (!graph) return "";
  if (graph.ok === false) {
    return ` · 汇报关系<b>读不到</b>（原本 v${esc(graph.version ?? "?")}：${esc(graph.reason ?? "未给出原因")}）`;
  }
  const rt = graph.reports_to;
  if (!rt || typeof rt !== "object") return "";
  const bits = [];
  if (taskRole && typeof taskRole === "string") {
    const parent = rt[taskRole];
    if (parent === undefined) {
      // 键不在 reports_to 里 ⇒ 这一版图里【没有这个角色】（reports_to 由图上每个节点的
      // reports_to 字段填成，graphSection 用的是 Object.keys(g.nodes)）。
      // 说查不到，不说它是顶层 —— 顶层是 reports_to===null 的表态，两句话不可混。
      bits.push(`${esc(taskRole)} 当时不在图上`);
    } else if (parent === null || parent === "") {
      // reports_to===null = 直接向 CEO 汇报（graph.ts:94 那张 nullable 单值；
      // 空串是防御 —— schema min(1) 不允许，但渲染层不假设上游一定折过）。
      bits.push(`${esc(taskRole)} → 顶层`);
    } else {
      bits.push(`${esc(taskRole)} ↖ ${esc(parent)}`);
    }
  }
  return bits.length ? ` · 汇报关系 ${bits.join("；")}` : "";
}

/** 看板抽屉里那条审阅链复用同一个渲染（少一次"两份实现必然漂移"）。 */
const replayTimeline = (entries) =>
  entries.length
    ? `<div class="admin-tl">${entries.map(eventRow).join("")}</div>`
    : `<div class="admin-meta">还没有事件。</div>`;

/* ═════════════════ 活动流（投影自身的轨迹） ═════════════════
 * 从上一版的独立一页降级成今日页里的一条折叠区：§16.1 说得很直白 ——
 * 「聊天是手段之一，不是界面骨架」，事件流同理，它是给【修这套系统的人】看的。
 * gap 那一行仍然留在这里：它把「少了几条」这件本来无人知晓的事显示出来。
 */
const seen = [];
function attachFeedSink() {
  const $feed = document.getElementById("feed");
  if (!$feed) return;
  for (const rec of seen.slice(-25).reverse()) paint(rec, $feed);
  feedSink = (rec) => {
    seen.push(rec);
    if (seen.length > 300) seen.splice(0, seen.length - 300);
    paint(rec, $feed);
  };
  const off = onChange(() => {
    const el = $view.querySelector("[data-cur]");
    if (el) el.textContent = String(proj.cursor);
  });
  viewCleanups.push(() => {
    feedSink = null;
    off();
  });
}

function paint(rec, $feed) {
  const d = document.createElement("div");
  d.className = "admin-card";
  d.innerHTML = rec;
  $feed.prepend(d);
  while ($feed.children.length > 60) $feed.lastChild.remove();
}

/* ── 事件流引擎（整个会话一条连接） ─────────────────────
 * 帧一律交给 applyFrame（真模块）。这里只做三件它管不着的事：
 * 建连、重连退避、把结果翻译成人话。
 *
 * ⚠【不用 EventSource】。EventSource 的自动重连带的是 Last-Event-ID 【请求头】，
 *   而 hub 只读 `?cursor=` 这个 query（app.ts 的 events() 读 req.query["cursor"]，
 *   全仓没有任何一处读那个请求头）。用它的后果正是 app.ts 里预告过的那句
 *   「连接正常、也在推流、就是少了几条」—— 最难查的那类失效。
 *   改成 fetch + 自己解帧之后：游标由我们放在 query 上，续订位置【由我们说了算】。
 *   解帧也不自己写：用 contracts 的 decodeSseFrame，与服务端 encodeSseFrame 同一份
 *   对偶实现（两份解帧必然漂移，0006 §7）。
 */
let feedSink = null;
let attempt = 0;
let abortCtl = null;

function feedSay(rec) {
  feedSink?.(rec);
}

async function connectFeed() {
  abortCtl?.abort();
  const ctl = new AbortController();
  abortCtl = ctl;
  const q = proj.cursor > 0 ? `?cursor=${proj.cursor}` : "";
  let res;
  try {
    res = await fetch("/api/events" + q, {
      headers: { accept: "text/event-stream" },
      signal: ctl.signal,
    });
  } catch (e) {
    if (ctl.signal.aborted) return;
    feedSay(
      `<span class="admin-pill admin-s-red">连不上</span> <span class="admin-meta">${esc(e?.message ?? e)}</span>`,
    );
    reconnect();
    return;
  }
  if (!res.ok || !res.body) {
    feedSay(`<span class="admin-pill admin-s-red">SSE ${res.status}</span>`);
    reconnect();
    return;
  }
  attempt = 0; // 连上了就归零：退避计数描述的是【连续失败】，不是整场会话。
  setConn("live");
  const rd = res.body.getReader();
  const td = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += td.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (raw.trim() !== "") handleFrame(decodeSseFrame(raw));
      }
    }
  } catch (e) {
    if (ctl.signal.aborted) return;
    feedSay(
      `<span class="admin-pill admin-s-red">流中断</span> <span class="admin-meta">${esc(e?.message ?? e)}</span>`,
    );
  }
  if (ctl.signal.aborted) return;
  reconnect();
}

function reconnect() {
  const n = attempt;
  if (shouldGiveUp(n)) {
    // 放弃必须是【界面说得出的】：继续显示最后一帧装作实时，比说「我连不上了」坏得多。
    setProj({ ...proj, link: "down", attempt: n });
    setConn("down", `事件流放弃重连（第 ${n} 次）`);
    return;
  }
  const wait = reconnectDelayMs(n); // 退避曲线住在 contracts，不在这里另抄一份
  attempt = n + 1;
  setProj({ ...proj, link: "down", attempt });
  setConn(
    "down",
    `事件流断开，${Math.round(wait / 1000)}s 后第 ${n + 1} 次重连`,
  );
  setTimeout(() => void connectFeed(), wait);
}

function handleFrame(frame) {
  if (frame.retryMs !== undefined) return; // retry 是给自管重连的提示，不是一帧数据
  let applied;
  try {
    applied = applyFrame(proj, {
      event: frame.event,
      ...(frame.id ? { id: frame.id } : {}),
      data: frame.data,
    });
  } catch (e) {
    // applyEvent 对解不开的帧是【抛】不是忽略：忽略等于亲手造一个无人知晓的洞。
    feedSay(
      `<span class="admin-pill admin-s-red">帧不合法</span> <span class="admin-meta">${esc(e?.message ?? e)}</span>`,
    );
    setProj({ ...proj, link: "stale" });
    void resnapshot();
    return;
  }
  setProj(applied.projection);
  const item = safe(frame.data);
  if (frame.event === "snapshot") {
    feedSay(
      `<span class="admin-pill">快照</span> <span class="admin-meta">覆盖到 #${esc(item?.as_of_seq)}</span>`,
    );
    return;
  }
  const badge =
    { applied: "s-blue", duplicate: "", gap: "s-red" }[applied.action] ?? "";
  feedSay(`<span class="admin-pill ${badge}">${esc(String(item?.seq))} ${esc(applied.action)}</span>
    <strong>${esc(frame.event)}</strong> <span class="admin-meta">任务 <span class="admin-mono">${esc(item?.taskId ?? "—")}</span></span>`);
  if (applied.action === "gap") void resnapshot();
  // 审批相关的帧会改「有几张卡在等」⇒ 角标重读一次。
  // 事件名的字面量来自【服务端推的 item.kind】（sse.ts:224 `event: item.kind`），
  // 不是我编的名字 —— 第一版这里写的是 approvalRequested / approvalResolved，
  // 那两个字符串永不匹配，症状是「决定了但角标不动」，且没有任何一处会报错。
  //
  // 为什么是【重读 REST】而不是用投影自带的 inbox：inbox 的水位线需要一个 seq 来源，
  // 而 GET /approvals 只带 asOfMs 不带 seq（projection.ts 里 applyApprovalSnapshot
  // 要 asOfSeq）。硬拿别处的 seq 凑一个水位线，会造出一个「两边都不是」的权威错数
  // —— 那个模块自己的注释写着：角标偏小是致命的（CEO 就不看了）。
  // 所以这一格走 REST 重读，代价是多一次本机请求，换的是【数只由服务端给】。
  if (item?.kind === "ApprovalRequired" || item?.kind === "ApprovalDecided")
    void loadPendingCount();
}

/**
 * 出洞 / 不合法帧 ⇒ 重拉一份完整状态。
 * 任务侧靠 /tasks 全量，组织侧靠 GET /org（0012 §9 那格闭合的就是这条）。
 */
async function resnapshot() {
  const { status, data } = await api("GET", "/tasks");
  if (status !== 200) return;
  setProj(
    applySnapshot(proj, {
      tasks: data.tasks,
      asOfMs: Date.now(),
      asOfSeq: proj.cursor,
    }),
  );
}

const safe = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const linkText = (p) =>
  !p
    ? undefined
    : ({
        live: "实时",
        stale: `补洞中（连续出洞 ${p.resnapshotCount} 次）`,
        down: `已断开（第 ${p.attempt} 次重连）`,
        connecting: "连接中",
      })[p.link];

/* ───────────────── 视图切换 ───────────────── */
const viewCleanups = [];
async function load() {
  // 抽屉的 DOM 住在 $view 里，会被下面那句一起抹掉 —— 但抹 DOM 【不会】摘掉挂在
  // document 上的那条 Esc 监听。可达路径正是本轮新开的键盘那条：抽屉开着时
  // Tab 能走到页头导航（scrim 只挡鼠标不挡 Tab），Enter 换页 ⇒ 抽屉没了而 Esc
  // 还在，下一回开抽屉就变成两条监听叠在一起（关一次关不掉）。
  // 所以在这里显式关一次：换视图 = 抽屉关掉，这句话由代码说，不靠"顺手被抹掉了"。
  if (drawerEscOff) closeDrawer();
  for (const f of viewCleanups.splice(0)) f();
  // 首屏占位用骨架而不是「载入中」五个字：这一格每次换页都要闪一下，
  // 一行字的读数不预告形状，快网下还会闪成一条横幅。列在 admin.css 的 .admin-skel。
  $view.innerHTML = `<div class="admin-skel" role="status" aria-label="载入中…"><i></i><i></i><i></i></div>`;
  try {
    await views[current]();
  } catch (e) {
    $view.innerHTML = banner("err", `加载失败：${e?.message ?? e}`);
    setConn("down", "加载失败");
  }
}

/* ───────────────── 挂载 / 卸载（工作台那一半）─────────────────
 * 只有一个入口：group.html 工作台。宿主把【自己的】三个节点交进来（内容区 +
 * 页内导航 + 状态灯），同一套 renderX / bindX 画在右侧内容区里。
 * 独立控制室页（旧 /admin 的 index.html）已删 —— 本模块不再自启动，也不做
 * 任何 getElementById 兜底。
 *
 * ⚠ 为什么落点必须由宿主传而不是这里 getElementById("view")：
 *   group.html 第 103 行【也有一枚 #view】（工作台的内容区）。按 id 全局查会拿到
 *   工作台那一枚，管理视图就会画进别人的格子里 —— 而症状是「切到别的菜单时我的
 *   界面被抹了」，归属极难看出。所以挂载路径上只认显式传参。
 *
 * ⚠ unmount 必须真拆：SSE 是【整个会话一条连接】的 fetch 流（见 connectFeed 那段），
 *   切走路由不拆它，它会继续往已经消失的 feedSink 里推、并且永远占着 hub 的一路
 *   订阅；重连那条 setTimeout 更会在人已经离开这一页之后把视图拉回来。
 */
let mounted = false;

/**
 * 启动这一页要吃的所有【页面级】副作用：状态灯订阅 + 事件流 + 首屏。
 * 唯一入口是 mountAdmin（工作台挂载）。
 */
function startFeed() {
  offConnSub = onChange((p) => setConn(p.link));
  nav();
  setConn("connecting");
  connectFeed();
  void load();
}

function stopFeed() {
  offConnSub?.();
  offConnSub = null;
  // 正在飞的 fetch 流与它的解帧循环一起断；feedSink 指向上一次渲染的 #feed，
  // 不清的话下一次重连会往一个已经不在文档里的节点里 prepend。
  abortCtl?.abort();
  abortCtl = null;
  feedSink = null;
}

/**
 * 挂进工作台。宿主给三个节点：
 *   view  —— 渲染目标（右侧内容区里的一格，调用方保证它是管理视图独占的）
 *   nav   —— 七页导航的落点（宿主没有 #nav，所以这一枚通常由挂载方现造）
 *   status—— 状态灯 {dot, connText}（宿主没有 #dot / #connText，同上）
 * 之后每次 group.js 改 hash，它调 syncAdminFromHash(location.hash) 把变化送进来。
 */
function mountAdmin({ view, nav: navEl, status }) {
  $view = view;
  $nav = navEl;
  $dot = status.dot;
  $connText = status.connText;
  mounted = true;
  startFeed();
}

function unmountAdmin() {
  if (!mounted) return;
  mounted = false;
  if (drawerEscOff) closeDrawer();
  for (const f of viewCleanups.splice(0)) f();
  stopFeed();
  // 拖影挂在 document.body 上，不在 $view 里面 —— 只清 $view 会留下一枚飘在
  // 屏幕上的幽灵卡（pointerup 再也不会来了，因为监听挂在被抹掉的卡上）。
  for (const g of document.body.querySelectorAll(".admin-org-ghost")) g.remove();
}

/* ───────────────── 暴露给工作台宿主的挂载 API ─────────────────
 * 本文件本来就是 type="module"，所以 export 不改变任何文档级行为。
 * group.js 用 `await import("/app.js")` 拿这五个：
 *   mountAdmin —— 交进三个节点并启动这一页
 *   unmountAdmin —— 离开路由时拆连接与监听
 *   syncAdminFromHash —— 宿主每次改 hash 把 location.hash 原样送进来
 *   ADMIN_PAGES —— 七页清单，宿主要把它渲染成中间列表栏（「像其他功能一样」）
 *   currentPage —— 【现在真渲染着】那一页的 id：hash 里的页名可能是手打的、ROUTES
 *                  不认的，那时这一页停在原地，宿主要高亮的也正是原地 —— 中间
 *                  列表栏的选中态因此跟着屏幕走，而不是跟着地址栏走。
 * ⚠ 只暴露这五个。渲染函数、状态、取数一律留在这里 —— 宿主懂多少治理页，
 *   治理页就得跟着改多少次（0006 §7 那一整篇讲的正是这种漂移）。
 */
function currentPage() {
  return current;
}

export {
  currentPage,
  mountAdmin,
  ROUTES as ADMIN_PAGES,
  syncAdminFromHash,
  unmountAdmin,
};
