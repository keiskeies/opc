/* T11: same-origin desktop client. User content is always inserted as text/DOM nodes. */

import { renderMarkdown } from "/markdown.js";
import {
  avatarUrl,
  browserSpeech,
  generatedAvatarDataUrl,
  personaTagline,
  speakWithBrowser,
} from "/src/humanizer.ts";
import { mountThemeToggle } from "/theme.js";

const API = "/api/v1";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return node;
}
function button(label, onClick, variant = "", extra = {}) {
  return h(
    "button",
    { type: "button", class: `btn ${variant}`, onClick, ...extra },
    label,
  );
}
function iconButton(name, label, onClick, extra = {}) {
  return h(
    "button",
    {
      type: "button",
      class: "icon-button",
      title: label,
      "aria-label": label,
      onClick,
      ...extra,
    },
    icon(name),
  );
}
const fmtTime = (value) =>
  value
    ? new Date(value).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
const fmtDate = (value) =>
  value
    ? new Date(value).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : "—";
const fmtDateTime = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const dateInputValue = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
};
const titleCase = (value) =>
  String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
const labels = {
  group: "群聊",
  private: "私聊",
  meeting: "会议",
  backlog: "待办",
  scheduled: "已排期",
  doing: "进行中",
  done: "已完成",
  cancelled: "已取消",
  open: "进行中",
  concluded: "已散会",
  doc: "富文本",
  sheet: "表格",
  markdown: "Markdown",
  mindmap: "思维导图",
  owner: "所有者",
  editor: "可编辑",
  reader: "仅查看",
  management: "管理档",
  execution: "执行档",
  neutral: "中性",
  steady: "沉稳",
  direct: "直接",
  warm: "温和",
  precise: "严谨",
  active: "在职",
  archived: "已归档",
};
// 键集必须与 contracts 的 SEARCH_FACES 逐一对应（test/web/search-face-parity.test.ts
// 钉这条奇偶）：少一个键时 h() 对 undefined 是【静默跳过整个属性】，
// 那一面的徽标就是空白而不是报错。
const faceLabels = {
  group: "群",
  task: "任务",
  member: "成员",
  message: "消息",
  document: "文档",
  meeting: "会议",
  backlog: "待办",
};
const docKinds = ["doc", "sheet", "markdown", "mindmap"];
// 形态 → 图标精灵里的 symbol 名。不能直接 icon(kind)：精灵里只有 i-doc/i-board/
// i-list/i-tree，没有 i-sheet / i-markdown / i-mindmap，那样渲染出来是零尺寸的空白。
const docKindIcons = {
  doc: "doc",
  sheet: "board",
  markdown: "list",
  mindmap: "tree",
};
const rhythmKinds = [
  {
    value: "sprint_planning",
    label: "迭代计划",
    tone: "purple",
    empty: "记录本轮目标、范围与交付计划。",
  },
  {
    value: "standup",
    label: "每日站会",
    tone: "blue",
    empty: "记录进展、今日计划与需要协同的事项。",
  },
  {
    value: "review",
    label: "成果评审",
    tone: "green",
    empty: "记录交付成果、验收结论与改进项。",
  },
  {
    value: "retro",
    label: "复盘改进",
    tone: "amber",
    empty: "记录做得好的地方、根因与下一轮改进行动。",
  },
];
const rhythmPayloadFields = [
  ["summary", "摘要"],
  ["conclusion", "明确结论"],
  ["outcomes", "成果"],
  ["blockers", "卡点"],
  ["next_steps", "下一步"],
  ["owner", "负责人"],
];
const groupChatTabs = [
  ["messages", "消息"],
  ["tasks", "任务流"],
  ["documents", "文档区"],
];
const taskTabs = [
  ["backlog", "待办看板"],
  ["rhythm", "团队节奏"],
  ["research", "每日调研"],
];
const executors = [
  "claude-cli",
  "codex-cli",
  "qoder-cli",
  "platform-webhook",
  "builtin-plugin",
  "pure-model",
  "human",
];

class ApiError extends Error {
  constructor(status, message, code, payload) {
    super(message || `请求失败（HTTP ${status}）`);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}
async function request(
  path,
  { method = "GET", body, signal, binary = false } = {},
) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      `无法连接本机服务：${error.message}。请确认 Hub 与同源代理已启动。`,
      "network",
    );
  }
  if (binary) {
    if (!response.ok) throw await responseError(response);
    return response.blob();
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    if (response.status >= 500 && data?.error)
      throw new ApiError(
        response.status,
        `${data.error}${data.code ? `（${data.code}）` : ""}`,
        data.code,
        data,
      );
    throw new ApiError(
      response.status,
      data?.error || data?.reason || `请求失败（HTTP ${response.status}）`,
      data?.code,
      data,
    );
  }
  return data;
}
async function responseError(response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return new ApiError(
      response.status,
      data.error || data.reason || `下载失败（HTTP ${response.status}）`,
      data.code,
      data,
    );
  } catch {
    return new ApiError(response.status, `下载失败（HTTP ${response.status}）`);
  }
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function toast(message, error = false) {
  const item = h(
    "div",
    { class: `toast${error ? " error" : ""}` },
    icon(error ? "close" : "check"),
    h("span", { text: message }),
  );
  $("#toastRegion").append(item);
  setTimeout(() => item.remove(), error ? 7000 : 3500);
}
/**
 * 空状态。iconName 让每种空状态用自己那件事的图标 ——
 * 原来 20 处空状态一律画同一张「文档」，消息为空、待办为空、成员为空看起来一模一样。
 * @param {string} title
 * @param {string} description
 * @param {HTMLElement | null} [action]
 * @param {string} [iconName] sprite 里的 symbol 名
 */
function emptyState(title, description, action, iconName = "doc") {
  return h(
    "div",
    { class: "state" },
    icon(iconName),
    h("h3", { class: "tw:text-balance", text: title }),
    h("p", { text: description }),
    action || null,
  );
}
function loadingState(text = "正在加载…") {
  return h(
    "div",
    { class: "state" },
    h("div", { class: "spinner" }),
    h("p", { text }),
  );
}
/**
 * 骨架屏：形状就长成它要占位的那个组件，而不是一个孤零零的转圈。
 * 用在「列表/卡片还没回来」的场景——左中栏的会话列表、群工作区的任务/文档卡、
 * 成员行等。尺寸对齐它们要占位的真身（见 group.css 的 .skeleton-* 规则）。
 * 小格子（搜索下拉、群成员下拉、会议整页）仍用 loadingState 的 spinner，那格要的是
 * 「一件事在跑」而不是「一整屏的形状预告」。
 */
function skeletonRow() {
  return h(
    "div",
    { class: "skeleton-row", role: "presentation" },
    h("div", { class: "skeleton skeleton-avatar" }),
    h(
      "div",
      { class: "skeleton-lines" },
      h("div", { class: "skeleton skeleton-line" }),
      h("div", { class: "skeleton skeleton-line short" }),
    ),
    h("div", { class: "skeleton skeleton-time" }),
  );
}
function listSkeleton(count = 8) {
  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(skeletonRow());
  return h(
    "div",
    { class: "list-skeleton", role: "status", "aria-label": "正在加载…" },
    ...rows,
  );
}
function skeletonCard() {
  return h(
    "div",
    { class: "skeleton skeleton-card" },
    h("div", { class: "skeleton-line title" }),
    h("div", { class: "skeleton-line" }),
    h("div", { class: "skeleton-line short" }),
    h("div", { class: "skeleton-block" }),
  );
}
function cardSkeleton(count = 4) {
  const cards = [];
  for (let i = 0; i < count; i += 1) cards.push(skeletonCard());
  return h(
    "div",
    { class: "skeleton-stack", role: "status", "aria-label": "正在加载…" },
    ...cards,
  );
}
/** 消息流占位：左右交替 —— 右侧那颗对应老板消息，整列都在左边会预告错的会话形状。 */
function chatSkeleton(count = 3) {
  const rows = [];
  for (let i = 0; i < count; i += 1)
    rows.push(
      h(
        "div",
        { class: `skeleton-chat-row${i % 2 === 1 ? " own" : ""}` },
        h("div", { class: "skeleton skeleton-avatar" }),
        h("div", { class: "skeleton skeleton-bubble" }),
      ),
    );
  return h(
    "div",
    { class: "skeleton-chat", role: "status", "aria-label": "正在加载…" },
    ...rows,
  );
}
/** 文档正文占位：一条标题 + 一段段落流，形状对着 editor-card 画。 */
function docSkeleton() {
  const lines = [h("div", { class: "skeleton skeleton-line title" })];
  for (let i = 0; i < 7; i += 1)
    lines.push(h("div", { class: "skeleton skeleton-line" }));
  return h(
    "div",
    {
      class: "skeleton-doc card editor-card",
      role: "status",
      "aria-label": "正在打开文档…",
    },
    ...lines,
  );
}
function banner(message, tone = "error", retry) {
  return h(
    "div",
    { class: `banner ${tone}`, role: tone === "error" ? "alert" : "status" },
    icon(tone === "error" ? "close" : "search"),
    h("span", { text: message }),
    retry ? button("重试", retry, "small") : null,
  );
}
function pageHeader(title, subtitle, actions = []) {
  return h(
    "header",
    { class: "page-header" },
    h(
      "div",
      null,
      h("p", { class: "eyebrow", text: "OPC WORKSPACE" }),
      h("h2", { text: title }),
      // 副标题是整句人话，折行时末行常剩一两个字（实测 768 档 contacts 是 247px + 26px，
      // 末行只有首行的 11%）。balance 把两行拉平，实测三个视口 × 六条路由共 18 个样本
      // 行数与盒高【一格未变】—— 只推行内宽度，所以它不动版面。
      // utility 而不是写进 group.css：.page-header p 那族规则没一条管 text-wrap，
      // 分层规则里未分层声明恒赢，接在这上面不会挤走任何已有渲染。
      h("p", { class: "tw:text-balance", text: subtitle }),
    ),
    h("div", { class: "actions" }, ...actions),
  );
}
function field(labelText, control, help) {
  return h(
    "label",
    { class: "field" },
    labelText,
    control,
    help ? h("span", { class: "help", text: help }) : null,
  );
}
function fullField(labelText, control, help) {
  const node = field(labelText, control, help);
  node.classList.add("full");
  return node;
}
function input(name, value = "", type = "text", attrs = {}) {
  return h("input", { name, type, value, ...attrs });
}
function textarea(name, value = "", attrs = {}) {
  return h("textarea", { name, ...attrs }, value);
}
function select(name, options, value = "", attrs = {}) {
  return h(
    "select",
    { name, ...attrs },
    ...options.map((option) => {
      const [val, text] = Array.isArray(option) ? option : [option, option];
      return h(
        "option",
        { value: val, selected: String(val) === String(value) },
        text,
      );
    }),
  );
}
function formGrid(...children) {
  return h("div", { class: "field-grid" }, ...children);
}
function pill(text, tone = "") {
  return h("span", { class: `pill ${tone}`, text });
}
function memberById(id) {
  return state.members.find((member) => member.member_id === id);
}
function memberName(id) {
  return id === "boss" ? "老板" : memberById(id)?.name || id || "未指定";
}
function privatePeerId(conversation) {
  return [conversation?.member_a, conversation?.member_b].find(
    (id) => id && id !== "boss",
  );
}
function privatePeer(conversation) {
  return memberById(privatePeerId(conversation));
}
function privateConversationTitle(conversation) {
  const peer = privatePeer(conversation);
  if (
    peer &&
    conversation.member_a !== "boss" &&
    conversation.member_b !== "boss"
  ) {
    const other = memberById(
      conversation.member_a === peer.member_id
        ? conversation.member_b
        : conversation.member_a,
    );
    return other ? `${peer.name}、${other.name}` : peer.name;
  }
  return peer?.name || conversation.title || "私聊成员";
}
function roleName(id) {
  return state.roles.find((role) => role.role_id === id)?.name || id;
}
function groupName(id) {
  return (
    state.groups.find((group) => group.group_id === id)?.title || id || "未分组"
  );
}
/** 群头部副标题用：拿不到群行（老数据/未加载）时返回空串，由调用方的分隔符兜住。 */
function groupSeatSummary(id) {
  const group = state.groups.find((entry) => entry.group_id === id);
  const count = Number(group?.member_count);
  return Number.isFinite(count) ? `${count} 位成员` : "";
}
function avatar(member, size = "") {
  const node = h("span", { class: `avatar ${size}`, "aria-hidden": "true" });
  node.append(
    h("img", {
      src: member ? avatarUrl(member) : generatedAvatarDataUrl("?", "system"),
      alt: "",
      loading: "lazy",
    }),
  );
  return node;
}
function avatarForAuthor(authorKind, senderId) {
  return authorKind === "boss"
    ? h("span", { class: "avatar boss-avatar", text: "B" })
    : avatar(memberById(senderId));
}

const STORAGE_KEYS = {
  pinned: "opc:pinned-conversations",
  navOrder: "opc:nav-order",
  personalStatus: "opc:personal-status",
  docTreeCollapsed: "opc:doc-tree-collapsed",
  docListCollapsed: "opc:doc-list-collapsed",
};
const personalStatusLabels = {
  online: "在线",
  focus: "专注",
  busy: "忙碌",
};
function readStoredJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function storedStringArray(key) {
  const value = readStoredJson(key, []);
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string"))]
    : [];
}
function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式或配额不足时，本次交互仍可用，只是不持久化。 */
  }
}
function bossAttentionCount(conversation) {
  const count = Number(conversation?.boss_attention_count);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}
function conversationRecency(conversation) {
  // 契约（contracts/conversation.ts）里这两个时刻是 epoch 毫秒【数字】，不是 ISO 串：
  // Date.parse 只吃字符串，喂数字（连 String(数字) 也一样）恒 NaN ⇒ 排序整条静默失效。
  const value = conversation.last_message_at || conversation.created_at;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const state = {
  route: "messages",
  selectedConversation: null,
  selectedMeeting: null,
  selectedDocument: null,
  selectedMember: null,
  selectedGroup: null,
  selectedTalent: null,
  selectedBacklog: null,
  conversations: [],
  pinnedConversations: new Set(storedStringArray(STORAGE_KEYS.pinned)),
  navOrder: storedStringArray(STORAGE_KEYS.navOrder),
  personalStatus: "online",
  // 折叠偏好：true = 编辑文档时收起左栏。只影响「正在编辑文档」这一屏，见 applyDocListCollapse。
  docListCollapsed:
    readStoredJson(STORAGE_KEYS.docListCollapsed, false) === true,
  messages: [],
  // 会话历史翻页三格：游标（最旧已加载的 seq_in_conv）、是否还有更早、是否正在翻。
  // windowId 标这三格属于哪个会话 —— 换会话不许把上一群翻出来的那段和「到底」结论带过去。
  messagesWindowId: null,
  messagesCursor: null,
  messagesHasMore: false,
  loadingOlder: false,
  meetings: [],
  groups: [],
  members: [],
  roles: [],
  documents: [],
  templates: [],
  backlog: [],
  talents: [],
  plugins: [],
  groupMembers: new Map(),
  versions: [],
  permissions: [],
  cursor: 0,
  needsResume: false,
  link: "connecting",
  attempts: 0,
  replyTo: null,
  composerDrafts: new Map(),
  messageLoading: false,
  messageSending: false,
  searchTimer: null,
  searchAbort: null,
  docFilter: { q: "", kind: "", group: "" },
  // 与 docFilter 同形（0080）：待办列的是全部群的条目，此前只有一枚关键词框，
  // 「这个群的待办有哪几条」在界面上没有任何落点 —— 服务端 group_id 参数一直没人发。
  backlogFilter: { q: "", group: "" },
  chatTab: "messages",
  taskTab: "backlog",
  rhythmKind: "",
  rhythmGroup: "",
  rhythmEvents: [],
  researchCards: [],
  teamWorkLoading: false,
  teamWorkError: "",
  talentTab: "market",
  settingsSection: "member",
  settingsMember: null,
  settingsGroup: null,
  settingsPlugin: null,
  settingsRole: null,
  draft: null,
};
let renderToken = 0;
let messageRequestToken = 0;
// 会话历史一页取多少条 = 契约 listMessagesQuerySchema 的上界（limit 1..200）。
// 服务端把界是为了防全表拖取，界面取满它 = 首屏少一发翻页请求。
const MESSAGES_PAGE_LIMIT = 200;
/**
 * 「往前还有更早的消息吗」的判据：这一页服务端真返回的条数 == 请求的 limit。
 *
 * 与游标分开写（同 app.js 里 replayHasMore 那对：判据与游标各测各的 ——
 * 判据写错 = 按钮永不出现，游标写错 = 每次都重复同一段）。返回 false 时
 * 界面收起按钮，不再让人点一发注定空手而回。
 *
 * ⚠ 这一发不能拿 state.messages.length 来判：那是【累计已加载】，翻过一页之后
 * 它早就不等于「这一页返回了几条」。
 */
function historyHasMore(pageLen, limit) {
  return (
    Number.isInteger(pageLen) &&
    Number.isInteger(limit) &&
    pageLen > 0 &&
    pageLen >= limit
  );
}
/**
 * 往旧翻的游标 = 已加载消息里最旧那条的 seq_in_conv（服务端语义是
 * seq_in_conv < before_seq）。恒取最小值而不是直接读 messages[0]：页内升序
 * 是服务端的约定，游标取错会把整段历史静默跳过。取不到（空页）返回 null
 * = 没有可翻的位置。
 */
function historyCursor(messages) {
  let oldest = null;
  for (const message of messages) {
    const seq = message.seq_in_conv;
    if (!Number.isInteger(seq)) continue;
    if (oldest === null || seq < oldest) oldest = seq;
  }
  return oldest;
}
/**
 * 同会话背景重读时保留「比这一页更旧」的已加载行。
 *
 * 背景刷新读的是【最新一页】，它不知道用户已经往旧翻过：直接整体覆盖会把刚翻出来
 * 那段又吞回去，游标与「还有更早」也一并退回最新页 —— 屏幕上表现为「查看更早」
 * 到底之后自己复活、历史凭空少一截，而这两件事都不报错。只丢掉这一页已经覆盖的
 * 行（seq_in_conv 不小于这一页最旧那条），其余留在原位；页内升序 + 严格小于游标
 * 保证保留段与这一页不会有同一条消息两次。
 */
function retainOlderThan(current, page) {
  const floor = historyCursor(page);
  if (floor === null) return current;
  return current.filter((message) => {
    const seq = message.seq_in_conv;
    return !(Number.isInteger(seq) && seq >= floor);
  });
}
/**
 * 重读消息数组的唯一入口：数组、游标、「还有更早」三格一起重算。
 *
 * 两处首屏读取（loadMessages 与「用户正在输入时」的替身）都走这里 —— 游标必须
 * 跟着数组走，否则它会指着一条已经不在数组里的消息，下一发 before_seq 就从错误
 * 的位置往旧翻（静默跳掉一段历史）。分开写两次就会只改对一处。
 *
 * 窗口按 conversation_id 认：换会话才是真的换了一屏（旧会话翻出来的那段与「到底」
 * 的结论都不许带过去，否则新会话的按钮会凭空收起）。
 */
function applyHistoryWindow(id, page) {
  const retained =
    state.messagesWindowId === id ? retainOlderThan(state.messages, page) : [];
  const list = retained.concat(page);
  state.messages = list;
  state.messagesWindowId = id;
  state.messagesCursor = historyCursor(list);
  // 翻过页（retained 非空）时「还有更早」维持原值：最新那一页满不满 limit 只能证明
  // 它自己下面还有没有东西，证明不了用户已经翻到的那段之外还有 —— 拿它重算会让
  // 已经到底、已经收起的按钮在下一次背景刷新时复活。
  state.messagesHasMore =
    retained.length > 0
      ? state.messagesHasMore
      : historyHasMore(page.length, MESSAGES_PAGE_LIMIT);
}
/**
 * 「用户正贴在最新消息上」的容差（像素）。
 *
 * 不能写成 0：scrollTop 是浏览器【向下取整】的整数，分数 DPI / 分数行高下
 * scrollHeight - clientHeight 落在两行之间，滚到底读回来的「距底」可能是 0 也可能
 * 是 1；反过来差几像素没到底的人，被要求「精确为 0 才跟随」会莫名其妙地不再跟随。
 * 阈值同时兜住这两头：小于它算贴底，明显往上翻了才算「在读旧史」。
 */
const CHAT_BOTTOM_STICK_PX = 80;
/**
 * 重画消息流【之前】读一眼这一屏，产出一枚交给 applyChatScrollAnchor 的锚点。
 *
 * 返回 null = 屏幕上压根没有消息流（首次打开、切到别的会话、加载中），没什么可留的，
 * 由调用方走「落到最新一条」。
 *
 * ⚠ 唯一正确的测量时机是【重画之前、且屏幕上还是正文的那一帧】。renderChat 每发都
 * view.replaceChildren() 重建 .message-stream，新节点的 scrollTop 天然是 0；而
 * messageLoading=true 那一帧画的是 chatSkeleton（3 行、撑不满一屏 ⇒ 无溢出），在它
 * 上面量会得到「贴底」，于是每次背景重读都把视口送回底部：判据永远成立，实际量的是
 * 加载骨架。round392 在 0077 的判据上撞过同一个形状（见 0077 §5），本轮量的是它的前半段。
 * 所以这一格自己认骨架：流里一行正文都没有 ⇒ 交回 null（没位置可留），绝不在骨架上
 * 量出「贴底」。
 *
 * ⚠ 留住的是 scrollTop 本身，不是「距底距离」（loadOlderMessages 的锚点用的是后者）：
 * 背景重读新增的消息落在【下方】，上方那段一条没动，同一个 scrollTop 就是同一屏像素；
 * 距底距离在内容变高之后会把屏幕连着一块往下滑。往旧翻是往【上方】加内容，距底距离
 * 才是对的尺子 —— 两对锚点各管一头，别互相「统一」。
 */
function chatScrollAnchor(stream) {
  if (!stream || stream.querySelectorAll(".message-row").length === 0)
    return null;
  const pinned =
    stream.scrollHeight - stream.clientHeight <= CHAT_BOTTOM_STICK_PX ||
    stream.scrollHeight - stream.scrollTop - stream.clientHeight <=
      CHAT_BOTTOM_STICK_PX;
  return { pinned, top: stream.scrollTop };
}
/**
 * 把 chatScrollAnchor 读到的那一屏放回重画后的消息流上。锚点为空时不动（调用方自己决定去不去底部）。
 *
 * 未贴底那一支夹上界：重读可能把尾部几条读掉了（窗口换页），不夹就会写一个超界的
 * scrollTop，浏览器按它自己的口径乱夹 —— 判据就读不到「停在原地」这件事了。
 */
function applyChatScrollAnchor(stream, anchor) {
  if (!stream || !anchor) return false;
  stream.scrollTop = anchor.pinned
    ? stream.scrollHeight
    : Math.max(
        0,
        Math.min(anchor.top, stream.scrollHeight - stream.clientHeight),
      );
  return true;
}
let teamPanelToken = 0;
let coreLoaded = false;
let refreshTimer = null;
let refreshInFlight = null;
let refreshPending = false;
let reconnectTimer = null;
let streamController = null;
const relevantKinds = new Set();
const snapshotEventKinds = new Set([
  "GroupUpdated",
  "MemberHired",
  "MemberUpdated",
  "MessageReceived",
  "MeetingOpened",
  "MeetingTurnPosted",
  "MeetingConcluded",
  "MeetingCancelled",
  "MeetingSummaryReady",
  "BacklogChanged",
  "DocumentChanged",
  "ExecutorRunFinished",
  "RhythmEventRecorded",
  "ResearchCardCreated",
]);
let activeDocumentSession = null;
// 管理视图挂进工作台后的运行时状态。app.js 把渲染目标记在【模块级】的 $view 里，
// 所以宿主节点必须跨 renderMain 复用同一枚 —— renderMain 每次先 view.replaceChildren()，
// 若这里每次新建宿主，上一次的 $view 就成了不在文档里的孤儿节点：SSE 照常推数，
// 屏幕一个像素不动，症状与「页面卡死」一模一样。
let adminApi = null;
let adminHost = null;
let adminNodes = null;
let adminImport = null;
let adminMounted = false;
/** hash 第三段的镜像（#/admin/board ⇒ "board"），只是中间栏选中态的读数。 */
let adminPage = "today";

const routes = {
  messages: ["消息", "群聊、私聊与会议"],
  contacts: ["通讯录", "组织架构与成员"],
  documents: ["文档中心", "知识、模板与版本"],
  backlog: ["任务面板", "待办流转与拆分"],
  talent: ["人才市场", "招聘与人才蓝图"],
  settings: ["设置", "成员、群组、岗位与插件"],
  admin: ["管理视图", "底层治理控制室"],
};

/**
 * 设置页的分区。id 同时是 hash 的 id 段（#/settings/plugins），所以不能与
 * member_id 同形：成员 id 走带前缀的雪花串，这里全部是纯字母单词。
 * 判据用「名单先命中」而不是「带不带前缀」—— 将来加成员 id 形态不需要回改这里。
 */
const SETTINGS_SECTIONS = [
  { id: "member", label: "成员", hint: "人设、模型、语音、头像" },
  { id: "groups", label: "群组", hint: "改名、目标、席位与归档" },
  { id: "roles", label: "岗位", hint: "公司树、汇报线与模型档位" },
  { id: "plugins", label: "插件", hint: "能力源登记与探活" },
];

function navEntries() {
  return $$(".nav-entry", $(".rail-top"));
}
function navEntryRoute(entry) {
  return $(".nav-item[data-nav]", entry).dataset.nav;
}
function persistNavOrder() {
  state.navOrder = navEntries().map(navEntryRoute);
  writeStoredJson(STORAGE_KEYS.navOrder, state.navOrder);
}
function applyNavOrder() {
  const entries = new Map(
    navEntries().map((entry) => [navEntryRoute(entry), entry]),
  );
  const order = [
    ...new Set([...state.navOrder, ...Object.keys(routes)]),
  ].filter((route) => entries.has(route));
  for (const route of order) $(".rail-top").append(entries.get(route));
  state.navOrder = order;
}
function moveNavItem(route, direction) {
  const entries = navEntries();
  const from = entries.findIndex((entry) => navEntryRoute(entry) === route);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= entries.length) return;
  const entry = entries[from];
  if (direction < 0) $(".rail-top").insertBefore(entry, entries[to]);
  else $(".rail-top").insertBefore(entry, entries[to].nextSibling);
  persistNavOrder();
  $(".nav-item", entry).focus();
  toast(`${routes[route][0]}已${direction < 0 ? "上移" : "下移"}`);
}
function initNavigation() {
  applyNavOrder();
  let dragged = null;
  for (const entry of navEntries()) {
    const item = $(".nav-item", entry);
    item.title = `${item.title} · 拖拽或 Alt+↑/↓ 排序`;
    item.addEventListener("keydown", (event) => {
      if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key))
        return;
      event.preventDefault();
      moveNavItem(navEntryRoute(entry), event.key === "ArrowUp" ? -1 : 1);
    });
    entry.addEventListener("dragstart", (event) => {
      dragged = entry;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", navEntryRoute(entry));
      entry.classList.add("dragging");
    });
    entry.addEventListener("dragover", (event) => {
      if (dragged === null || dragged === entry) return;
      event.preventDefault();
      const bounds = entry.getBoundingClientRect();
      const after = event.clientY > bounds.top + bounds.height / 2;
      $(".rail-top").insertBefore(dragged, after ? entry.nextSibling : entry);
    });
    entry.addEventListener("drop", (event) => {
      if (dragged === null) return;
      event.preventDefault();
      persistNavOrder();
    });
    entry.addEventListener("dragend", () => {
      dragged?.classList.remove("dragging");
      dragged = null;
      persistNavOrder();
    });
  }
}

function setRoute(route, id = null) {
  if (!routes[route]) return;
  state.route = route;
  if (route === "messages" && id) {
    state.selectedConversation = id;
    state.selectedMeeting = null;
  }
  if (route === "messages" && id?.startsWith("meeting:")) {
    state.selectedMeeting = id.slice(8);
    state.selectedConversation = null;
  }
  if (route === "documents" && id) state.selectedDocument = id;
  if (route === "settings" && id) {
    // hash 的 id 位是「分区名或条目 id」二义：分区名单先命中，其余按条目认领，
    // 让 #/settings/<群 id> 这种手打地址落在群设置而不是成员总览。
    if (SETTINGS_SECTIONS.some((s) => s.id === id)) {
      // 落到分区名 = 回到该区总览：只放下【这一区】的条目，其它三区留着，
      // 分区之间来回切时各自回到原来那一条。
      state.settingsSection = id;
      state[SETTINGS_ITEM_KEYS[id]] = null;
    } else {
      const section = resolveSettingsSection(id);
      state.settingsSection = section;
      state[SETTINGS_ITEM_KEYS[section]] = id;
    }
  }
  // 管理页的页名住在 hash 的第三段（#/admin/board），走 id 这个位置进来。
  // 镜像【照抄 hash】而不是对着名单验一遍：hash 是唯一真相；手打一个不存在的
  // 页名时控制室本来就停在当前页，列表选中态跟着 hash 走，两边不会各说各话。
  if (route === "admin" && id) adminPage = id;
  $("#workspace")?.classList.remove("list-open");
  $(".workspace").classList.remove("list-open");
  $$(".nav-item[data-nav]").forEach((item) => {
    const active = item.dataset.nav === route;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  $("#listTitle").textContent = routes[route][0];
  $("#listSubtitle").textContent = routes[route][1];
  // 这一格的 hash 永远带上页名（adminPage 初值 "today"，且只被非空 id 改过）。
  // 不这么做的话：在看板里点侧栏「管理视图」会把地址打回 #/admin —— 屏幕还在
  // 看板，地址却说不出自己在哪一页，把这条地址复制给别人就是另一页了。
  // ⚠ 这里用【镜像】而不是 currentAdminPageId()：页名归不归控制室认，判据只有
  //   它那份 ROUTES；宿主若在这儿替它改写地址，「哪个页名存在」就有了两个答案。
  const hashId = route === "admin" ? adminPage : id;
  const hash = `#/${route}${hashId ? `/${encodeURIComponent(hashId)}` : ""}`;
  history.replaceState(null, "", hash);
  // 页名由 hash 带着，每次换 hash 都喂给控制室。只在【已挂载】时喂：挂载尚未
  // 落地时这一次不算数 —— ensureAdminMounted 在 mountAdmin 之后自己会补一次
  // sync(location.hash)，那里才是 hash 第一次真正进控制室的地方。
  if (adminMounted && adminApi) adminApi.syncAdminFromHash(hash);
  renderList();
  renderMain();
}
async function loadCore() {
  const [conversations, meetings, groups, members, roles, backlog, plugins] =
    await Promise.all([
      request("/conversations"),
      request("/meetings"),
      request("/groups"),
      request("/members"),
      request("/roles"),
      request("/backlog?limit=200"),
      request("/plugins"),
    ]);
  Object.assign(state, {
    conversations: conversations.conversations || [],
    meetings: meetings.meetings || [],
    groups: groups.groups || [],
    members: members.members || [],
    roles: roles.roles || [],
    backlog: backlog.items || [],
    plugins: plugins.plugins || [],
  });
  await Promise.allSettled(
    state.groups.map(async (group) => {
      const detail = await request(
        `/groups/${encodeURIComponent(group.group_id)}`,
      );
      state.groupMembers.set(group.group_id, detail.members || []);
    }),
  );
  coreLoaded = true;
  updateUnreadBadge();
}
async function loadAuxiliary() {
  const [documents, templates, talents] = await Promise.all([
    request("/documents?limit=100"),
    request("/templates"),
    request("/talent"),
  ]);
  Object.assign(state, {
    documents: documents.documents || [],
    templates: templates.templates || [],
    talents: talents.items || [],
  });
}
async function runRefreshAll() {
  try {
    await loadCore();
    await loadAuxiliary();
    renderList();
    if (state.route === "messages") {
      const editingComposer =
        document.activeElement?.closest(".composer") !== null;
      if (state.selectedConversation) {
        // 发送期间的快照可能早于 POST 提交；提交后的权威重读会覆盖它，避免旧空流覆盖 CoS 回话。
        if (!state.messageSending) {
          if (editingComposer) {
            const result = await request(
              `/conversations/${encodeURIComponent(state.selectedConversation)}/messages?limit=${MESSAGES_PAGE_LIMIT}`,
            );
            // 这一格是 loadMessages 的「用户在输入时」替身，同样整体覆盖数组，
            // 所以走同一个入口 —— 游标不跟着数组走就会指着一条已不在数组里的消息。
            applyHistoryWindow(
              state.selectedConversation,
              result.messages || [],
            );
          } else await loadMessages(state.selectedConversation, false);
        }
      } else if (state.selectedMeeting)
        await loadMeeting(state.selectedMeeting, false);
    } else if (
      // 控制室读的是自己那份 SSE，不吃工作台的核心快照；而 renderMain 会
      // replaceChildren —— 宿主节点虽然复用（adminHost 在模块级缓存着，不会被重
      // 新加载），但每次事件把整格摘下来再挂回去会丢掉滚动位置、焦点，以及抽屉
      // 打开时挂在 body 上的遮罩。这一格没有一样东西需要工作台的快照来重画。
      state.route !== "admin" &&
      (state.route !== "documents" || !state.selectedDocument)
    )
      renderMain();
  } finally {
    refreshInFlight = null;
  }
}
async function refreshAll() {
  // 合并刷新期间的 SSE 与手动请求：不并发占用连接，并保证调用方等到最新快照。
  if (refreshInFlight) refreshPending = true;
  else refreshInFlight = runRefreshAll();
  let lastError = null;
  for (;;) {
    if (!refreshInFlight) {
      if (!refreshPending) break;
      refreshPending = false;
      refreshInFlight = runRefreshAll();
    }
    try {
      await refreshInFlight;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
}
function updateUnreadBadge() {
  const total = state.conversations.reduce(
    (sum, conversation) => sum + (Number(conversation.unread_count) || 0),
    0,
  );
  const badge = $("#messageBadge");
  badge.hidden = total === 0;
  badge.textContent = total > 99 ? "99+" : String(total);
}
function renderList() {
  const content = $("#listContent");
  const toolbar = $("#listToolbar");
  content.replaceChildren();
  toolbar.replaceChildren();
  $("#listAction").hidden = false;
  if (state.route === "admin") {
    // 「像其他功能一样」在这条路由上的落点：中间栏列的就是控制室那七页，点一行换一页。
    // 不许 coreLoaded 挡它 —— 控制室自己直连 /api，核心数据没回来时这七页照样可选。
    // 七页没有「新建」这回事，中栏右上那颗按钮在这一格无事可做。
    $("#listAction").hidden = true;
    renderAdminPageList(content);
    return;
  }
  if (!coreLoaded) {
    content.append(listSkeleton());
    return;
  }
  if (state.route === "messages") renderConversationList(content);
  if (state.route === "contacts") renderGroupList(content, toolbar);
  if (state.route === "documents") renderDocumentList(content, toolbar);
  if (state.route === "backlog") renderBacklogList(content, toolbar);
  if (state.route === "talent") renderTalentList(content, toolbar);
  if (state.route === "settings") renderSettingsList(content, toolbar);
}
function conversationKindIcon(conversation) {
  if (conversation.kind === "private") {
    const peer = privatePeer(conversation);
    if (peer) return avatar(peer, "small");
  }
  return h(
    "span",
    { class: `kind-icon ${conversation.kind}` },
    icon(conversation.kind === "group" ? "users" : "chat"),
  );
}
function togglePinned(id) {
  const conversation = state.conversations.find(
    (item) => item.conversation_id === id,
  );
  if (!conversation) return;
  const pinned = !state.pinnedConversations.has(id);
  if (pinned) state.pinnedConversations.add(id);
  else state.pinnedConversations.delete(id);
  writeStoredJson(STORAGE_KEYS.pinned, [...state.pinnedConversations]);
  renderList();
  const pinButton = $$(".conversation-pin").find(
    (item) => item.closest(".conversation-row")?.dataset.conversationId === id,
  );
  pinButton?.focus({ preventScroll: true });
  toast(
    `${conversation.kind === "private" ? privateConversationTitle(conversation) : conversation.title}已${pinned ? "置顶" : "取消置顶"}`,
  );
}
function renderConversationList(content) {
  const conversations = [...state.conversations].sort(
    (a, b) =>
      conversationRecency(b) - conversationRecency(a) ||
      a.conversation_id.localeCompare(b.conversation_id),
  );
  const meetings = [...state.meetings].sort(
    (a, b) => b.opened_at - a.opened_at,
  );
  const section = (key, text, items) => {
    if (!items.length) return;
    content.append(
      h(
        "section",
        {
          class: "conversation-section",
          dataset: { section: key },
          "aria-label": text,
        },
        h(
          "div",
          {
            class: `list-section${key === "attention" ? " attention-heading" : ""}`,
          },
          text,
          key === "attention"
            ? h("span", {
                class: "attention-total",
                text: `${items.length} 个会话`,
              })
            : null,
        ),
        ...items,
      ),
    );
  };
  const convButton = (conversation) => {
    const attention = bossAttentionCount(conversation);
    const count = attention || Number(conversation.unread_count) || 0;
    const pinned = state.pinnedConversations.has(conversation.conversation_id);
    return h(
      "button",
      {
        type: "button",
        class: `conversation-item${attention ? " needs-attention" : ""}${state.selectedConversation === conversation.conversation_id ? " selected" : ""}`,
        dataset: { conversationId: conversation.conversation_id },
        onClick: () => openConversation(conversation.conversation_id),
        "aria-pressed":
          state.selectedConversation === conversation.conversation_id,
      },
      conversation.kind === "group"
        ? h("span", { class: "kind-icon" }, icon("users"))
        : conversationKindIcon(conversation),
      h(
        "span",
        { class: "conversation-copy" },
        h(
          "span",
          { class: "conversation-title" },
          pinned ? icon("pin") : null,
          h("span", {
            text:
              conversation.kind === "private"
                ? privateConversationTitle(conversation)
                : conversation.title,
          }),
        ),
        h("span", {
          class: "conversation-preview",
          text: conversation.last_message_preview || "暂无消息",
        }),
      ),
      h(
        "span",
        { class: "conversation-tail" },
        h("time", {
          class: "conversation-time mono",
          text: fmtTime(
            conversation.last_message_at || conversation.created_at,
          ),
        }),
        count > 0
          ? h("b", {
              class: `unread${attention ? " boss-count" : ""}`,
              "aria-label": attention ? `待你拍板 ${count} 条` : undefined,
              text: count > 99 ? "99+" : count,
            })
          : null,
      ),
    );
  };
  const convRow = (conversation, key) => {
    const pinned = state.pinnedConversations.has(conversation.conversation_id);
    return h(
      "div",
      {
        class: "conversation-row",
        dataset: { conversationId: conversation.conversation_id, section: key },
      },
      convButton(conversation),
      h(
        "button",
        {
          type: "button",
          class: `conversation-pin${pinned ? " is-pinned" : ""}`,
          "aria-label": pinned ? "取消置顶" : "置顶",
          "aria-pressed": String(pinned),
          title: `${pinned ? "取消置顶" : "置顶"}：${conversation.title}`,
          onClick: () => togglePinned(conversation.conversation_id),
        },
        icon("pin"),
        h("span", { text: pinned ? "取消" : "置顶" }),
      ),
    );
  };
  const meetingButton = (meeting) =>
    h(
      "button",
      {
        type: "button",
        class: `conversation-item${state.selectedMeeting === meeting.meeting_id ? " selected" : ""}`,
        onClick: () => openMeeting(meeting.meeting_id),
      },
      h("span", { class: "kind-icon meeting" }, icon("meeting")),
      h(
        "span",
        { class: "conversation-copy" },
        h(
          "span",
          { class: "conversation-title" },
          h("span", { text: meeting.topic }),
        ),
        h("span", {
          class: "conversation-preview",
          text: `${labels[meeting.status]} · ${meeting.turns.length} 轮发言`,
        }),
      ),
      h(
        "span",
        { class: "conversation-tail" },
        h("time", {
          class: "conversation-time mono",
          text: fmtTime(meeting.opened_at),
        }),
        meeting.status === "open" ? pill("进行中", "purple") : null,
      ),
    );
  const attention = conversations.filter(
    (item) => bossAttentionCount(item) > 0,
  );
  const attentionIds = new Set(attention.map((item) => item.conversation_id));
  const pinned = conversations.filter(
    (item) =>
      state.pinnedConversations.has(item.conversation_id) &&
      !attentionIds.has(item.conversation_id),
  );
  const pinnedIds = new Set(pinned.map((item) => item.conversation_id));
  const ordinary = conversations.filter(
    (item) =>
      !attentionIds.has(item.conversation_id) &&
      !pinnedIds.has(item.conversation_id),
  );
  section(
    "attention",
    "待你拍板",
    attention.map((item) => convRow(item, "attention")),
  );
  section(
    "pinned",
    "置顶",
    pinned.map((item) => convRow(item, "pinned")),
  );
  section(
    "group",
    "群聊",
    ordinary
      .filter((item) => item.kind === "group")
      .map((item) => convRow(item, "group")),
  );
  section(
    "private",
    "私聊",
    ordinary
      .filter((item) => item.kind === "private")
      .map((item) => convRow(item, "private")),
  );
  section("meetings", "会议记录", meetings.map(meetingButton));
  if (!conversations.length && !meetings.length)
    content.append(
      emptyState(
        "还没有会话",
        "创建一个群或会议，工作流会在这里出现。",
        button("新建群", () => openCreateModal("group"), "primary"),
        "chat",
      ),
    );
}
function renderGroupList(content, toolbar) {
  const search = input("groupSearch", "", "search", {
    placeholder: "筛选群或成员",
    "aria-label": "筛选群或成员",
    oninput: (event) => {
      const q = event.target.value.trim().toLowerCase();
      $$("[data-group-row]", content).forEach((row) => {
        row.hidden = !row.dataset.search.includes(q);
      });
    },
  });
  toolbar.append(search);
  if (!state.groups.length) {
    content.append(
      emptyState("暂无群组", "在顶栏点击“创建 → 新建群”。", null, "users"),
    );
    return;
  }
  for (const group of state.groups) {
    const groupId = group.group_id;
    const members = state.members.filter((member) =>
      state.groupMembers
        .get(groupId)
        ?.some((seat) => seat.member_id === member.member_id),
    );
    content.append(
      h(
        "div",
        {
          class: "org-group",
          dataset: {
            groupRow: "",
            search:
              `${group.title} ${members.map((m) => m.name).join(" ")}`.toLowerCase(),
          },
        },
        h(
          "button",
          {
            type: "button",
            class: `conversation-item${state.selectedGroup === groupId ? " selected" : ""}`,
            onClick: () => selectGroup(groupId),
          },
          h("span", { class: "kind-icon" }, icon("users")),
          h(
            "span",
            { class: "conversation-copy" },
            h(
              "span",
              { class: "conversation-title" },
              h("span", { text: group.title }),
            ),
            h("span", {
              class: "conversation-preview",
              text: `${group.member_count} 位成员 · ${group.goal || "暂无目标"}`,
            }),
          ),
          pill(
            group.status === "active" ? "活跃" : "归档",
            group.status === "active" ? "green" : "",
          ),
        ),
        members.length
          ? h(
              "div",
              { class: "org-members" },
              ...members.map((member) =>
                h(
                  "button",
                  {
                    type: "button",
                    class: `member-row${state.selectedMember === member.member_id ? " selected" : ""}`,
                    onClick: () => selectMember(member.member_id),
                  },
                  avatar(member, "small"),
                  h(
                    "span",
                    { class: "member-copy" },
                    h("strong", { text: member.name }),
                    h("small", { text: roleName(member.role_id) }),
                  ),
                ),
              ),
            )
          : null,
      ),
    );
  }
}
/**
 * 文档：中栏筛选栏（一次性构建）+ 行区重画。
 *
 * 拆成两半是必须的：筛选栏过去挂在 renderDocumentList 自己里，oninput/onchange 又回调
 * renderDocumentList 本身，而【清空】只在调用方 renderList 里做 —— 于是每敲一个字符，
 * 搜索框和两个下拉各多一套、整棵文档树多挂一份（实测敲「筛验」两下：搜索框 1→3、
 * 下拉 2→6、树 1→3）。
 *
 * 现在控件只在这函数里 append 一次，三个 handler 只叫 paintDocumentRows：被换的只有行区。
 *
 * ⚠ 别把它改成「handler 直接叫 renderList」——那是份数全对的另一种修法，但它每次把
 * 工具条整个清空：用户正在敲的那枚 input 当场离开文档，焦点落在新生成的空框上，
 * 下一个字符凭空丢失（中文输入法更糟：拼音还没上屏，承载组字的节点已经没了）。
 * 这一格的红由 e2e 的「焦点仍在打标记那一枚 input」那发钉住。
 */
function renderDocumentList(content, toolbar) {
  toolbar.append(
    h(
      "div",
      { class: "toolbar doc-filter-search" },
      input("docSearch", state.docFilter.q, "search", {
        placeholder: "筛选标题或作者",
        "aria-label": "筛选文档",
        oninput: (event) => {
          state.docFilter.q = event.target.value;
          paintDocumentRows(content);
        },
      }),
    ),
  );
  const kinds = h(
    "select",
    {
      "aria-label": "文档类型",
      onchange: (event) => {
        state.docFilter.kind = event.target.value;
        paintDocumentRows(content);
      },
    },
    h("option", { value: "", text: "全部类型" }),
    ...docKinds.map((kind) =>
      h(
        "option",
        { value: kind, selected: state.docFilter.kind === kind },
        labels[kind],
      ),
    ),
  );
  const groups = h(
    "select",
    {
      "aria-label": "所属群",
      onchange: (event) => {
        state.docFilter.group = event.target.value;
        paintDocumentRows(content);
      },
    },
    h("option", { value: "", text: "全部群组" }),
    ...state.groups.map((group) =>
      h(
        "option",
        {
          value: group.group_id,
          selected: state.docFilter.group === group.group_id,
        },
        group.title,
      ),
    ),
  );
  // 两个下拉并排（CSS 的 doc-filter-kinds）：306px 的栏里三个整行筛选器
  // 会把头部顶到 115px 高，树本来就要滚，头部不该先吃掉一屏的五分之一。
  toolbar.append(
    h("div", { class: "toolbar doc-filter-kinds" }, kinds, groups),
  );
  paintDocumentRows(content);
}
/** 文档：只重画行区（树或空态）。控件一个字节都不碰，见 renderDocumentList。 */
function paintDocumentRows(content) {
  const filtered = state.documents.filter(
    (doc) =>
      (!state.docFilter.kind || doc.kind === state.docFilter.kind) &&
      (!state.docFilter.group || doc.group_id === state.docFilter.group) &&
      (!state.docFilter.q ||
        `${doc.title} ${doc.owner}`
          .toLowerCase()
          .includes(state.docFilter.q.toLowerCase())),
  );
  content.replaceChildren();
  if (!filtered.length) {
    content.append(
      emptyState(
        state.documents.length ? "没有匹配的文档" : "文档中心还是空的",
        state.documents.length
          ? "调整类型、群组或关键词筛选。"
          : "从模板创建文档，或导入本地 Word、Excel、Markdown 文件。",
        null,
        "upload",
      ),
    );
    return;
  }
  content.append(docTree(filtered));
}
/**
 * 文档树。层级不是文件夹：documents 表没有 parent_id / folder / path
 * （0016_documents.sql 的列就是全部），所以能落库的层级只有【群 → 形态 → 文档】。
 * 想要真·文件夹得先加列，客户端造一个 parent 只会在刷新后蒸发。
 * 折叠态存 localStorage：树的展开状态属于「我这台机器的看法」，不该进业务库。
 */
const docTree = (docs) => {
  const collapsed = new Set(storedStringArray(STORAGE_KEYS.docTreeCollapsed));
  const byGroup = new Map();
  for (const doc of docs) {
    const key = doc.group_id || "";
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(doc);
  }
  // 未分组永远垫底（空串走上面两个 return，不进字典序），其余按名称、同名按 ID：
  // 刻意不按「有几篇文档」排 —— 按数量排的话，新建一篇文档整棵树就重排一次，
  // 用户刚建立的肌肉记忆当场作废。
  const groupKeys = [...byGroup.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    const ta = groupName(a);
    const tb = groupName(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  // 同名群是真实存在的（本项目 dev 库里「双十一大促落地页」就有两个不同 group_id），
  // 树上两行一模一样的字看起来像渲染坏了。悬停给群目标 + ID 尾号（groupTip），
  // 但悬停在截图里永远看不见，所以撞名时还要把尾号直接画出来（idTail）。
  // 统计必须按【显示名】数：按 group_id 数永远是 1，那个版本的判据从来不会触发。
  const nameTally = new Map();
  for (const key of groupKeys) {
    const name = key ? groupName(key) : "未分组";
    nameTally.set(name, (nameTally.get(name) || 0) + 1);
  }
  const idTail = (key) => {
    if (!key) return "";
    const name = groupName(key);
    return nameTally.get(name) > 1 ? `#${key.slice(-4)}` : "";
  };
  const groupTip = (key) => {
    if (!key) return "没有归群的文档";
    const group = state.groups.find((entry) => entry.group_id === key);
    if (!group) return key;
    return (group.goal ? `${group.goal} · ` : "") + `群 ID ${key.slice(-8)}`;
  };
  const sections = groupKeys.map((groupKey) => {
    const docsInGroup = byGroup.get(groupKey);
    const groupKeyNode = `g:${groupKey || "none"}`;
    const byKind = new Map();
    for (const doc of docsInGroup) {
      if (!byKind.has(doc.kind)) byKind.set(doc.kind, []);
      byKind.get(doc.kind).push(doc);
    }
    // 选中项所在节点强制展开：点开一篇文档却还要自己找折叠的分支，是树最容易做错的地方。
    const revealed = (nodeKey) =>
      !collapsed.has(nodeKey) ||
      docsInGroup.some(
        (doc) =>
          state.selectedDocument === doc.doc_id &&
          (nodeKey === groupKeyNode ||
            nodeKey === `${groupKeyNode}:${doc.kind}`),
      );
    // 折叠态靠原生 <details> 自己管，这里只在 toggle 时把它写回 localStorage。
    const remember = (nodeKey) => (event) =>
      event.target.open
        ? forgetDocTreeCollapse(nodeKey)
        : rememberDocTreeCollapse(nodeKey);
    const kindNodes = docKinds
      .filter((kind) => byKind.has(kind))
      .map((kind) => {
        const kindKey = `${groupKeyNode}:${kind}`;
        return h(
          "details",
          {
            class: "doc-tree-kind",
            open: revealed(kindKey),
            ontoggle: remember(kindKey),
          },
          h(
            "summary",
            null,
            icon(docKindIcons[kind] ?? "doc"),
            h("span", { class: "doc-tree-label", text: labels[kind] }),
            h("span", {
              class: "doc-tree-count",
              text: String(byKind.get(kind).length),
            }),
          ),
          h(
            "div",
            { class: "doc-tree-leaf" },
            ...byKind.get(kind).map((doc) => docTreeLeaf(doc)),
          ),
        );
      });
    return h(
      "details",
      {
        class: "doc-tree-group",
        open: revealed(groupKeyNode),
        ontoggle: remember(groupKeyNode),
      },
      h(
        "summary",
        { title: groupTip(groupKey) },
        icon(groupKey ? "users" : "panel"),
        // 标签 span 里只放群名本身：e2e 按 .doc-tree-label:text-is(群名) 定位分支，
        // 尾号搬进去就把那条判据撒掉了。冲突标记是另一个 span。
        h("span", {
          class: "doc-tree-label",
          text: groupKey ? groupName(groupKey) : "未分组",
        }),
        idTail(groupKey)
          ? h("span", { class: "doc-tree-tag", text: idTail(groupKey) })
          : null,
        h("span", {
          class: "doc-tree-count",
          text: String(docsInGroup.length),
        }),
      ),
      ...kindNodes,
    );
  });
  return h("div", { class: "doc-tree" }, ...sections);
};
function rememberDocTreeCollapse(key) {
  const collapsed = new Set(storedStringArray(STORAGE_KEYS.docTreeCollapsed));
  collapsed.add(key);
  writeStoredJson(STORAGE_KEYS.docTreeCollapsed, [...collapsed]);
}
function forgetDocTreeCollapse(key) {
  const collapsed = new Set(storedStringArray(STORAGE_KEYS.docTreeCollapsed));
  if (!collapsed.delete(key)) return;
  writeStoredJson(STORAGE_KEYS.docTreeCollapsed, [...collapsed]);
}
function docTreeLeaf(doc) {
  return h(
    "button",
    {
      type: "button",
      class: `doc-list-item${state.selectedDocument === doc.doc_id ? " selected" : ""}`,
      // 作者与日期收进 title：正文页头 .doc-sub 完整写着同一串，树里每行再占一行
      // 就是把 28 篇摊成 2226px 的那只手。水印也并进来 —— 行尾那个点没文字，
      // 悬停是它唯一的解释口（点自己不再挂 title，否则会盖掉这一整串）。
      title: `${memberName(doc.owner)} · ${fmtDate(doc.updated_at)}${
        doc.watermark_profile === "none"
          ? ""
          : ` · ${doc.watermark_profile === "internal" ? "内部水印" : "机密水印"}`
      }`,
      onClick: () => openDocument(doc.doc_id),
    },
    h("h3", { text: doc.title }),
    // 不挂形态 pill：叶子就在「形态」那一层分支下面，重复一遍只是噪音。
    // 不挂「已水印」pill：行尾一个小点说同一件事，且不会把行撑高。
    doc.watermark_profile !== "none"
      ? h("span", { class: "doc-leaf-watermark", "aria-hidden": "true" })
      : null,
  );
}
/**
 * 待办：与 renderDocumentList 同一拆法 —— 控件建一次，行区单独重画。
 * 理由见 renderDocumentList 上面那段（每敲一字多一枚搜索框 + 换掉正在敲的节点）。
 */
function renderBacklogList(content, toolbar) {
  toolbar.append(
    input("backlogSearch", state.backlogFilter.q, "search", {
      placeholder: "筛选待办",
      "aria-label": "筛选待办",
      oninput: (event) => {
        state.backlogFilter.q = event.target.value;
        paintBacklogRows(content);
      },
    }),
  );
  // 0080：按群筛。选项与文档栏「所属群」同源（state.groups），值走 group_id；
  // 与关键词是 AND —— 两维各自只写自己那格 state，一起交给 paintBacklogRows。
  toolbar.append(
    h(
      "select",
      {
        "aria-label": "所属群",
        onchange: (event) => {
          state.backlogFilter.group = event.target.value;
          paintBacklogRows(content);
        },
      },
      h("option", { value: "", text: "全部群组" }),
      ...state.groups.map((group) =>
        h(
          "option",
          {
            value: group.group_id,
            selected: state.backlogFilter.group === group.group_id,
          },
          group.title,
        ),
      ),
    ),
  );
  paintBacklogRows(content);
}
/** 待办：只重画行区。控件一个字节都不碰。 */
function paintBacklogRows(content) {
  const items = state.backlog.filter(
    (item) =>
      (!state.backlogFilter.group ||
        item.group_id === state.backlogFilter.group) &&
      (!state.backlogFilter.q ||
        item.title.toLowerCase().includes(state.backlogFilter.q.toLowerCase())),
  );
  content.replaceChildren();
  for (const item of items)
    content.append(
      h(
        "button",
        {
          type: "button",
          class: `doc-list-item${state.selectedBacklog === item.id ? " selected" : ""}`,
          onClick: () => selectBacklog(item.id),
        },
        h("h3", { text: item.title }),
        h("p", {
          text: `${groupName(item.group_id)} · 优先级 ${item.priority}`,
        }),
        h(
          "div",
          { class: "actions" },
          pill(
            labels[item.state],
            item.state === "doing"
              ? "blue"
              : item.state === "done"
                ? "green"
                : "",
          ),
          item.due_at
            ? h("span", {
                class: "small-text muted",
                text: fmtDate(item.due_at),
              })
            : null,
        ),
      ),
    );
  if (!items.length)
    content.append(
      emptyState(
        "没有匹配的待办",
        "创建条目后，可在这里按群组和优先级处理。",
        null,
        "board",
      ),
    );
}
function renderTalentList(content, toolbar) {
  toolbar.append(
    h(
      "div",
      { class: "tabs" },
      button(
        "市场蓝图",
        () => {
          state.talentTab = "market";
          renderList();
          renderMain();
        },
        state.talentTab === "market" ? "active" : "ghost",
      ),
      button(
        "在职成员",
        () => {
          state.talentTab = "members";
          renderList();
          renderMain();
        },
        state.talentTab === "members" ? "active" : "ghost",
      ),
    ),
  );
  if (state.talentTab === "market") {
    for (const item of state.talents)
      content.append(
        h(
          "button",
          {
            type: "button",
            class: `doc-list-item${state.selectedTalent === item.item_id ? " selected" : ""}`,
            onClick: () => {
              state.selectedTalent = item.item_id;
              renderList();
              renderMain();
            },
          },
          h("h3", { text: item.name }),
          h("p", {
            text: `${roleName(item.payload.role_id)} · ${item.source}`,
          }),
        ),
      );
  } else {
    for (const member of state.members.filter((m) => m.status === "active"))
      content.append(
        h(
          "button",
          {
            type: "button",
            class: `member-row${state.settingsMember === member.member_id ? " selected" : ""}`,
            onClick: () => {
              state.settingsMember = member.member_id;
              renderList();
              renderMain();
            },
          },
          avatar(member, "small"),
          h(
            "span",
            { class: "member-copy" },
            h("strong", { text: member.name }),
            h("small", { text: roleName(member.role_id) }),
          ),
        ),
      );
  }
  if (!(state.talentTab === "market" ? state.talents : state.members).length)
    content.append(
      emptyState(
        "暂无条目",
        state.talentTab === "market"
          ? "导入人才蓝图，或在在职成员页发布。"
          : "先完成一次招聘。",
        null,
        "talent",
      ),
    );
}
function renderMemberList(content, toolbar) {
  toolbar.append(
    input("memberSearch", "", "search", {
      placeholder: "搜索成员",
      "aria-label": "搜索成员",
      oninput: (event) => {
        const q = event.target.value.toLowerCase();
        $$("[data-member-row]", content).forEach((row) => {
          row.hidden = !row.dataset.search.includes(q);
        });
      },
    }),
  );
  for (const member of state.members)
    content.append(
      h(
        "button",
        {
          type: "button",
          class: `member-row${state.settingsMember === member.member_id ? " selected" : ""}`,
          dataset: {
            memberRow: "",
            search: `${member.name} ${member.role_id}`.toLowerCase(),
          },
          onClick: () => openSettingsItem("member", member.member_id),
        },
        avatar(member, "small"),
        h(
          "span",
          { class: "member-copy" },
          h("strong", { text: member.name }),
          h("small", {
            text: `${roleName(member.role_id)} · ${labels[member.status]}`,
          }),
        ),
        pill(labels[member.status], member.status === "active" ? "green" : ""),
      ),
    );
  if (!state.members.length)
    content.append(
      emptyState("暂无成员", "前往人才市场完成招聘。", null, "users"),
    );
}

/**
 * 文档编辑页的左栏折叠：编辑一篇文档时把 306px 的列表栏整栏让给正文。
 * 折叠偏好【只】作用于「正在编辑文档」这一屏：消息/通讯录/待办的列表是导航本身，
 * 不许被一次文档页上的点击连带收起（所以这里每次 renderMain 都按当前路由重算，
 * 而不是把类永久留在 .workspace 上）。
 * 读不到偏好（隐私模式/配额）时的默认态是【展开】—— 没人点过折叠就不该默认收起一棵树。
 */
function applyDocListCollapse() {
  const collapsed =
    state.route === "documents" &&
    state.selectedDocument !== null &&
    state.docListCollapsed;
  $(".workspace").classList.toggle("list-collapsed", collapsed);
  const toggle = $("#docListToggle");
  if (!toggle) return;
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const label = collapsed ? "展开文档列表" : "折叠文档列表";
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  toggle.classList.toggle("is-collapsed", collapsed);
}
/**
 * 管理视图【挂进】内容区：不再有 iframe，app.js 与工作台同处一份文档，样式隔离靠
 * .admin-root 作用域 + admin- 前缀（双向钉在 test/web/admin-style-scope.test.ts）。
 * 页导航也不在内容区里重复一份 —— 七页渲染进中间列表栏，与消息/文档同一个形状。
 */
function renderAdmin(view) {
  if (!adminHost) {
    adminNodes = {
      // hidden 一箭双雕：读屏不该读到一份看不见的菜单（语义），而 group.css 的
      // [hidden]{display:none !important} 靠 !important 压住 admin.css 那条
      // .admin-root nav{display:flex}（0,1,1 稳压 UA 的 [hidden]）。round370 剪线
      // 证实过：另写一条按类名藏形的规则永远量不到失败，是假守卫，已拆。
      nav: h("nav", {
        class: "admin-mount-nav",
        "aria-label": "主导航",
        hidden: true,
      }),
      dot: h("span", { class: "admin-dot" }),
      connText: h("span", { text: "连接中…" }),
      view: h("main", { class: "admin-mount-view" }),
    };
    adminHost = h(
      "div",
      null,
      h(
        "header",
        null,
        h("h1", { text: "OPC" }),
        adminNodes.nav,
        h("div", { class: "admin-conn" }, adminNodes.dot, adminNodes.connText),
      ),
      adminNodes.view,
    );
    adminHost.className = "admin-root admin-mount";
  }
  if (adminHost.parentNode !== view) view.append(adminHost);
  void ensureAdminMounted();
}

/**
 * 动态 import 一次、缓存到底；每次进这一格都复用同一份模块与同一个宿主。
 * mountAdmin 之后【必须】补一次 syncAdminFromHash：app.js 的当前页是模块求值时
 * 从 location.hash 认的，第二次进出时那份读数早已过期，不补这一次就是「进来还
 * 停在上次那页」。
 */
function ensureAdminMounted() {
  if (adminMounted) {
    adminApi.syncAdminFromHash(location.hash);
    return;
  }
  adminImport ??= import("/app.js");
  void adminImport.then((api) => {
    adminApi = api;
    if (state.route !== "admin") return;
    if (!adminMounted) {
      api.mountAdmin({
        view: adminNodes.view,
        nav: adminNodes.nav,
        status: { dot: adminNodes.dot, connText: adminNodes.connText },
      });
      adminMounted = true;
    }
    api.syncAdminFromHash(location.hash);
    // 中间栏此前只能是 loadingState（名单在模块里），模块落地这一刻补渲染真清单。
    renderList();
  });
}

/** 当前该高亮哪一页：hash 带来的页名认得就用它，认不得退回模块报的当前页。 */
function currentAdminPageId() {
  if (!adminApi) return adminPage;
  const known = adminApi.ADMIN_PAGES.some((r) => r.id === adminPage);
  return known ? adminPage : (adminApi.currentPage?.() ?? "today");
}

/** 中间栏 = 控制室那七页。名单【只从模块拿】：这里抄一份字面量，app.js 改页时
 *  就得跟着改两处 —— 那正是挂载 API 只暴露 ADMIN_PAGES 的原因。落地前给占位。 */
function renderAdminPageList(content) {
  if (!adminApi) {
    content.append(listSkeleton(7));
    return;
  }
  for (const page of adminApi.ADMIN_PAGES) {
    content.append(
      h(
        "button",
        {
          type: "button",
          class: "doc-list-item",
          onClick: () => setRoute("admin", page.id),
        },
        h("h3", { text: page.label }),
      ),
    );
    if (page.id === currentAdminPageId()) {
      const last = content.lastElementChild;
      last.classList.add("selected");
      last.setAttribute("aria-current", "page");
    }
  }
}
function renderMain() {
  activeDocumentSession = null;
  const token = ++renderToken;
  const view = $("#view");
  applyDocListCollapse();
  // 文档抽屉住在 #mainPane 而不是 #view 里（理由见 renderDocumentEditor），
  // 所以换路由时得自己拆 —— 否则离开文档后右滑面上还挂着一份上一个文档的权限。
  for (const stale of $$("#mainPane .doc-drawer-wrap")) stale.remove();
  $("#mainPane").classList.remove("drawer-open");
  const focusedId = view.contains(document.activeElement)
    ? document.activeElement.id
    : "";
  // 消息流的锚点在【拆之前】读：renderChat 每发都重建 .message-stream，而摘下来的节点
  // 量不到任何东西（scrollHeight/clientHeight 一律 0，实测见 0078 §4）—— 等进了
  // renderChat 再读只剩 0，量到的是「没有溢出 = 贴底」这种假读数。
  // 这一对管的是【用户动作引起的重画】（点回复、取消回复、切页签…）：它们不改内容，
  // 却会把视口送回顶部。背景重读那一头由 loadMessages 自己那对锚点管（读得更早，
  // 盖住骨架帧那一段），发送那一发在它之后无条件跳底 —— 用户自己的动作。
  const chatAnchor = chatScrollAnchor($(".message-stream"));
  view.replaceChildren();
  $("#listPane").hidden = false;
  if (state.route !== "admin" && adminMounted) {
    // 离开这一格必须真拆：SSE 是整个会话一条 fetch 流，不拆它会继续往已移出
    // 文档的节点里推，并永远占着 hub 的一路订阅。
    adminApi.unmountAdmin();
    adminMounted = false;
  }
  // 控制室不读工作台的核心数据（它自己直连 /api），所以这一格不许挡在
  // coreLoaded 之后 —— 服务不可用时恰恰要去那一格排查。
  if (state.route === "admin") {
    renderAdmin(view);
    return;
  }
  if (!coreLoaded) {
    view.append(h("div", { class: "page" }, cardSkeleton(3)));
    return;
  }
  try {
    if (state.route === "messages") {
      if (state.selectedConversation) renderChat(view, token);
      else if (state.selectedMeeting) renderMeeting(view, token);
      else view.append(welcomePage());
    }
    if (state.route === "contacts") renderContacts(view);
    if (state.route === "documents")
      state.selectedDocument
        ? renderDocumentEditor(view)
        : renderDocumentsHome(view);
    if (state.route === "backlog")
      state.selectedBacklog ? renderBacklogDetail(view) : renderBacklog(view);
    if (state.route === "talent") renderTalent(view);
    if (state.route === "settings") {
      if (state.settingsSection === "groups") {
        state.settingsGroup
          ? renderGroupSettings(view)
          : renderSettingsHome(view);
      } else if (state.settingsSection === "roles") {
        state.settingsRole
          ? renderRoleSettings(view)
          : renderSettingsHome(view);
      } else if (state.settingsSection === "plugins") {
        state.settingsPlugin
          ? renderPluginSettings(view)
          : renderSettingsHome(view);
      } else if (state.settingsMember) renderSettings(view);
      else renderSettingsHome(view);
    }
  } catch (error) {
    view.append(banner(errorMessage(error), "error", () => renderMain()));
  }
  // 只有【屏幕上是这一会话的窗口】才许把锚点压回去（同 loadMessages 的窗口归属门）：
  // 刚切会话时 renderMain 收到的 chatAnchor 读的是上一个会话的流，压到新会话上会让
  // 它停在半屏而不是最新消息。窗口属主还没换到新会话 = 这一屏不是他的，不动。
  if (state.messagesWindowId === state.selectedConversation)
    applyChatScrollAnchor($(".message-stream", view), chatAnchor);
  if (focusedId)
    document.getElementById(focusedId)?.focus({ preventScroll: true });
}
function welcomePage() {
  const pending = state.conversations.filter((c) => c.unread_count > 0).length;
  return h(
    "div",
    { class: "page" },
    pageHeader("今天从哪里开始？", "所有项目、成员与会议都在同一个工作台。", [
      button("发起会议", () => openCreateModal("meeting")),
      button("新建文档", () => openCreateModal("document")),
      button("私聊成员（老板）", () => openBossPrivateModal(), "primary"),
    ]),
    h(
      "div",
      { class: "meeting-summary" },
      ...[
        ["未读会话", pending, "red"],
        [
          "进行中会议",
          state.meetings.filter((m) => m.status === "open").length,
          "purple",
        ],
        [
          "进行中待办",
          state.backlog.filter((b) => b.state === "doing").length,
          "blue",
        ],
      ].map(([name, count, tone]) =>
        h(
          "div",
          { class: "summary-cell" },
          h("small", { text: name }),
          h("strong", { class: "num", text: count }),
          pill("实时数据", tone),
        ),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h3", { text: "快速进入" }),
      h(
        "div",
        { class: "actions" },
        ...state.groups.slice(0, 6).map((group) =>
          button(group.title, () => {
            const conversation = state.conversations.find(
              (c) => c.group_id === group.group_id,
            );
            if (conversation) openConversation(conversation.conversation_id);
            else selectGroup(group.group_id);
          }),
        ),
      ),
    ),
    !state.groups.length
      ? emptyState(
          "尚未创建项目群",
          "创建群后会自动出现群会话与项目空间。",
          button("新建群", () => openCreateModal("group"), "primary"),
          "users",
        )
      : null,
  );
}

async function openConversation(id) {
  state.selectedConversation = id;
  state.selectedMeeting = null;
  state.replyTo = null;
  // 每个会话从消息开始，避免把上一群的任务/文档视图带到私聊或另一群。
  state.chatTab = "messages";
  setRoute("messages", id);
  await loadMessages(id, true);
}
async function loadMessages(id, markRead) {
  const token = ++renderToken;
  const requestToken = ++messageRequestToken;
  // 锚点读在【任何重画之前】：再往下一行 messageLoading=true 会画骨架帧，那时量到的是
  // 「没有溢出 = 贴底」，每次重读都会把视口送回底部（见 chatScrollAnchor）。
  // 窗口按 conversation_id 认（同 0077 的 messagesWindowId）：屏幕上还是上一个会话时，
  // 它的滚动位置与新会话无关 —— 带过去会让新会话停在半屏而不是最新消息。
  const scrollAnchor =
    state.messagesWindowId === id
      ? chatScrollAnchor($(".message-stream"))
      : null;
  state.messageLoading = true;
  if (state.route === "messages" && state.selectedConversation === id)
    renderChat($("#view"), token);
  try {
    const result = await request(
      `/conversations/${encodeURIComponent(id)}/messages?limit=${MESSAGES_PAGE_LIMIT}`,
    );
    // 发送或切换会话后，旧快照不能覆盖当前消息流。
    if (requestToken !== messageRequestToken) return;
    // 首屏 = 最新的一页；窗口里比它更旧的那段由 applyHistoryWindow 保留（见那里）。
    applyHistoryWindow(id, result.messages || []);
    state.messageLoading = false;
    const conversation = state.conversations.find(
      (c) => c.conversation_id === id,
    );
    if (conversation?.unread_count) {
      conversation.unread_count = 0;
      updateUnreadBadge();
      renderList();
    }
    if (markRead)
      await request(`/conversations/${encodeURIComponent(id)}/read`, {
        method: "POST",
        body: {},
      }).catch(() => {});
    if (state.route === "messages" && state.selectedConversation === id) {
      renderChat($("#view"), token);
      const stream = $(".message-stream");
      // 只有用户本来就贴在最新消息上才跳到底；往上翻着旧史时把他留在原地。
      // 没有锚点（首次打开 / 刚切到这一会话 / 那一屏不是这一会话）= 落到最新消息。
      if (stream) {
        if (scrollAnchor === null) stream.scrollTop = stream.scrollHeight;
        else applyChatScrollAnchor(stream, scrollAnchor);
      }
    }
  } catch (error) {
    if (requestToken !== messageRequestToken) return;
    state.messageLoading = false;
    if (state.route === "messages" && state.selectedConversation === id)
      $("#view").replaceChildren(
        banner(errorMessage(error), "error", () => loadMessages(id, false)),
      );
  }
}
/**
 * 「查看更早的消息」：拿 before_seq 游标往旧翻，服务端按升序返回这一页
 * （见 conversations/service.ts 的 listMessages：「前端上拉历史是 prepend」），
 * 所以这里直接拼在现有数组头 —— 不许 reverse，也不许整体覆盖
 * （覆盖会把用户刚翻出来的那段又吞回去）。
 *
 * 竞态：翻页不抢 renderToken/messageRequestToken。它既不是新快照也不是切会话，
 * 抢 token 会让并发在飞的 loadMessages 白投一次；反过来本发只靠 conversation_id
 * 自证「结果还属于当前会话」，不属于就丢掉。
 */
async function loadOlderMessages(id) {
  // 游标取不到（页内没有一条带整数 seq_in_conv）时没法拼 before_seq，直接不作请求。
  if (state.loadingOlder || state.messagesCursor === null) return;
  const before = state.messagesCursor;
  // 锚点 = 视口顶到内容底的距离。prepend 之后内容整体下移，用这个差值把视口
  // 拉回原本看着的那条消息，否则每次点「更早」屏幕都会跳走。
  const streamBefore = $(".message-stream");
  const anchorOffset = streamBefore
    ? streamBefore.scrollHeight - streamBefore.scrollTop
    : 0;
  state.loadingOlder = true;
  renderChat($("#view"), renderToken);
  try {
    const result = await request(
      `/conversations/${encodeURIComponent(id)}/messages` +
        `?limit=${MESSAGES_PAGE_LIMIT}&before_seq=${before}`,
    );
    if (state.selectedConversation !== id) return;
    const page = result.messages || [];
    // 去重兜住翻页窗口与 SSE 推送重叠那一瞬：服务端游标是严格小于，本身不会
    // 重复，但这一页与内存里那段之间可能已经插进同一条（同一消息画两遍）。
    const known = new Set(state.messages.map((m) => m.message_id));
    const fresh = page.filter((m) => !known.has(m.message_id));
    state.messages = fresh.concat(state.messages);
    const next = historyCursor(page);
    // 游标只许往更小走：页空或算不出更小时保持原位，绝不清空（清空 = 按钮消失，
    // 而那一屏其实还有更早的历史没读）。
    if (
      next !== null &&
      (state.messagesCursor === null || next < state.messagesCursor)
    )
      state.messagesCursor = next;
    state.messagesHasMore = historyHasMore(page.length, MESSAGES_PAGE_LIMIT);
  } catch (error) {
    if (state.selectedConversation === id) toast(errorMessage(error), true);
  } finally {
    state.loadingOlder = false;
    if (state.route === "messages" && state.selectedConversation === id) {
      renderChat($("#view"), renderToken);
      const stream = $(".message-stream");
      if (stream) stream.scrollTop = stream.scrollHeight - anchorOffset;
    }
  }
}
function selectChatTab(tab, focus = false) {
  if (!groupChatTabs.some(([value]) => value === tab)) return;
  state.chatTab = tab;
  renderMain();
  if (focus) $(`#group-chat-tab-${tab}`)?.focus();
}
function groupChatTabList() {
  return h(
    "div",
    {
      class: "group-chat-tabs",
      role: "tablist",
      "aria-label": "群会话视图",
    },
    ...groupChatTabs.map(([value, label]) =>
      h("button", {
        id: `group-chat-tab-${value}`,
        type: "button",
        role: "tab",
        class: `group-chat-tab${state.chatTab === value ? " active" : ""}`,
        text: label,
        "aria-selected": String(state.chatTab === value),
        "aria-controls": "group-chat-panel",
        tabindex: state.chatTab === value ? 0 : -1,
        onclick: () => selectChatTab(value),
        onkeydown: (event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const index = groupChatTabs.findIndex(([tab]) => tab === value);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? groupChatTabs.length - 1
                : event.key === "ArrowRight"
                  ? (index + 1) % groupChatTabs.length
                  : (index - 1 + groupChatTabs.length) % groupChatTabs.length;
          selectChatTab(groupChatTabs[next][0], true);
        },
      }),
    ),
  );
}
function renderGroupTaskFlow(conversation) {
  const items = state.backlog
    .filter((item) => item.group_id === conversation.group_id)
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.created_at - b.created_at ||
        a.id.localeCompare(b.id),
    );
  if (!items.length)
    return emptyState(
      "本群还没有待办",
      "从任务面板创建待办，或等待后续流程沉淀后在这里查看。",
      null,
      "board",
    );
  const tones = {
    backlog: "",
    scheduled: "purple",
    doing: "blue",
    done: "green",
    cancelled: "",
  };
  return h(
    "section",
    { class: "group-workspace", "aria-label": "群任务流" },
    h(
      "header",
      { class: "group-workspace-heading" },
      h(
        "div",
        null,
        h("h3", { text: "群任务流" }),
        h("p", {
          text: `${items.length} 项待办，按状态分组；点击条目查看详情。`,
        }),
      ),
      pill("实时同步", "blue"),
    ),
    h(
      "div",
      { class: "group-task-groups" },
      ...["backlog", "scheduled", "doing", "done", "cancelled"].map(
        (status) => {
          const grouped = items.filter((item) => item.state === status);
          if (!grouped.length) return null;
          return h(
            "section",
            {
              class: "group-task-group",
              dataset: { status },
              "aria-label": labels[status],
            },
            h(
              "div",
              { class: "group-task-group-heading" },
              h("h4", { text: labels[status] }),
              pill(grouped.length, tones[status]),
            ),
            h(
              "div",
              { class: "group-task-list" },
              ...grouped.map((item) =>
                h(
                  "button",
                  {
                    type: "button",
                    class: "group-task-card",
                    dataset: { backlogId: item.id },
                    "aria-label": `打开待办：${item.title}`,
                    onclick: () => {
                      state.selectedBacklog = item.id;
                      setRoute("backlog", item.id);
                    },
                  },
                  h("span", {
                    class: "group-task-title tw:text-balance",
                    text: item.title,
                  }),
                  item.detail
                    ? h("span", {
                        class: "group-task-detail",
                        text: item.detail,
                      })
                    : null,
                  h(
                    "span",
                    { class: "group-task-meta" },
                    pill(`P ${item.priority}`, item.priority < 0 ? "red" : ""),
                    item.due_at
                      ? h("time", { text: `截止 ${fmtDate(item.due_at)}` })
                      : h("span", { text: "无截止时间" }),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    ),
  );
}
function renderGroupDocuments(conversation) {
  const documents = state.documents
    .filter(
      (doc) =>
        doc.group_id === conversation.group_id &&
        (doc.deleted_at === null || doc.deleted_at === undefined),
    )
    .sort(
      (a, b) =>
        b.updated_at - a.updated_at ||
        a.title.localeCompare(b.title, "zh-CN") ||
        a.doc_id.localeCompare(b.doc_id),
    );
  const create = () => documentCreateModal(null, conversation.group_id);
  return h(
    "section",
    { class: "group-workspace", "aria-label": "群文档区" },
    h(
      "header",
      { class: "group-workspace-heading" },
      h(
        "div",
        null,
        h("h3", { text: "群文档区" }),
        h("p", { text: `${documents.length} 份文档，按最近更新时间排序。` }),
      ),
      button("新建群文档", create, "primary small"),
    ),
    documents.length
      ? h(
          "div",
          { class: "group-document-list" },
          ...documents.map((doc) =>
            h(
              "button",
              {
                type: "button",
                class: "group-document-card",
                dataset: { documentId: doc.doc_id },
                "aria-label": `打开文档：${doc.title}`,
                onclick: () => openDocument(doc.doc_id),
              },
              h(
                "span",
                { class: "group-document-icon" },
                icon(
                  doc.kind === "sheet"
                    ? "board"
                    : doc.kind === "mindmap"
                      ? "tree"
                      : "doc",
                ),
              ),
              h(
                "span",
                { class: "group-document-copy" },
                h("strong", {
                  class: "group-document-title tw:text-balance",
                  text: doc.title,
                }),
                h(
                  "span",
                  { class: "group-document-meta" },
                  pill(labels[doc.kind] || doc.kind),
                  doc.origin === "auto" ? pill("自动生成", "blue") : null,
                  h("time", { text: `更新于 ${fmtDateTime(doc.updated_at)}` }),
                ),
              ),
            ),
          ),
        )
      : emptyState(
          "本群还没有文档",
          "新建一份群文档，或等待自动章程与协作成果沉淀。",
          button("新建群文档", create, "primary"),
          "doc",
        ),
  );
}
function renderChat(view, token) {
  const focusedId = view.contains(document.activeElement)
    ? document.activeElement.id
    : "";
  view.replaceChildren();
  const conversation = state.conversations.find(
    (c) => c.conversation_id === state.selectedConversation,
  );
  if (!conversation) {
    view.append(emptyState("会话不存在", "刷新会话列表后重试。", null, "chat"));
    return;
  }
  const isGroup = conversation.kind === "group";
  const peer = isGroup ? null : privatePeer(conversation);
  const bossPrivate =
    !isGroup &&
    (conversation.member_a === "boss" || conversation.member_b === "boss");
  if (!isGroup) state.chatTab = "messages";
  const tab = groupChatTabs.find(([value]) => value === state.chatTab)?.[1];
  const refreshLabel =
    !isGroup || state.chatTab === "messages"
      ? "刷新消息"
      : state.chatTab === "tasks"
        ? "刷新任务流"
        : "刷新文档区";
  const refresh = () => {
    if (!isGroup || state.chatTab === "messages")
      return loadMessages(conversation.conversation_id, false);
    return refreshAll().catch((error) => toast(errorMessage(error), true));
  };
  const draft = state.composerDrafts.get(conversation.conversation_id) || "";
  const stream = h("div", {
    class: "message-stream",
    "aria-live": "polite",
    "aria-label": "消息流",
  });
  const composer = h(
    "form",
    { class: "composer", onsubmit: sendMessage },
    h(
      "div",
      { class: "composer-box" },
      h("textarea", {
        name: "body",
        value: draft,
        maxlength: 8000,
        required: true,
        disabled: state.messageLoading,
        placeholder: isGroup
          ? "输入消息，使用 @boss 请求老板拍板…"
          : `给${peer?.name || "这位成员"}发送消息…`,
        "aria-label": "消息内容",
        onkeydown: (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form.requestSubmit();
          }
        },
        oninput: (event) => {
          state.composerDrafts.set(
            conversation.conversation_id,
            event.target.value,
          );
          $(".char-count", event.currentTarget.form).textContent =
            `${event.target.value.length} / 8000`;
        },
      }),
      h(
        "div",
        { class: "composer-bottom" },
        button("回复", () => chooseReply(stream), "ghost small"),
        h("span", { class: "spacer" }),
        h("span", { class: "char-count", text: `${draft.length} / 8000` }),
        h(
          "button",
          {
            class: "btn primary",
            type: "submit",
            disabled: state.messageLoading,
          },
          icon("send"),
          "发送",
        ),
      ),
    ),
  );
  const panel = h("div", {
    id: isGroup ? "group-chat-panel" : null,
    class: "chat-panel",
    role: isGroup ? "tabpanel" : null,
    "aria-labelledby": isGroup ? `group-chat-tab-${state.chatTab}` : null,
    tabindex: isGroup ? 0 : null,
  });
  view.append(
    h(
      "div",
      { class: "chat-view" },
      h(
        "header",
        { class: "chat-header" },
        isGroup
          ? h("span", { class: "kind-icon" }, icon("users"))
          : conversationKindIcon(conversation),
        h(
          "div",
          { class: "chat-header-copy" },
          h("h2", {
            text: isGroup
              ? conversation.title
              : privateConversationTitle(conversation),
          }),
          h("p", {
            // 群会话的 title 就是群名，副标题再写一遍等于同一行字出现两次。
            // 副标题只补标题没说的信息：成员数 + 当前页签（私聊保留原来的一句话说明）。
            text: isGroup
              ? [groupSeatSummary(conversation.group_id), tab]
                  .filter(Boolean)
                  .join(" · ")
              : bossPrivate
                ? "老板 · 私聊成员（老板）"
                : "成员间私聊",
          }),
        ),
        iconButton("refresh", refreshLabel, refresh),
        button("私聊成员（老板）", () => openBossPrivateModal(), "small"),
      ),
      isGroup ? groupChatTabList() : null,
      panel,
    ),
  );
  if (focusedId)
    document.getElementById(focusedId)?.focus({ preventScroll: true });
  if (isGroup && state.chatTab !== "messages") {
    panel.classList.add("group-chat-panel");
    panel.append(
      state.chatTab === "tasks"
        ? renderGroupTaskFlow(conversation)
        : renderGroupDocuments(conversation),
    );
    return;
  }
  panel.append(stream, composer);
  if (state.messageLoading) {
    stream.append(chatSkeleton());
    return;
  }
  if (!state.messages.length) {
    stream.append(
      emptyState("还没有消息", "发出第一条消息，开始这段协作。", null, "chat"),
    );
    return;
  }
  // 按钮挂在消息循环之前 = 流的最顶端（往上翻的东西在上方）。到底了
  // （messagesHasMore=false）这一格根本不画，不留一枚点了空手而回的按钮。
  if (state.messagesHasMore) {
    stream.append(
      h(
        "div",
        { class: "history-more" },
        button(
          state.loadingOlder ? "正在加载更早的消息…" : "查看更早的消息",
          () => loadOlderMessages(conversation.conversation_id),
          "ghost small",
          { id: "load-older", disabled: state.loadingOlder || null },
        ),
      ),
    );
  }
  let day = "";
  for (const message of state.messages) {
    const messageDay = fmtDate(message.created_at);
    if (messageDay !== day) {
      stream.append(h("div", { class: "message-day", text: messageDay }));
      day = messageDay;
    }
    stream.append(messageNode(message));
    if (token !== renderToken) return;
  }
  if (state.replyTo) {
    const original = state.messages.find((m) => m.message_id === state.replyTo);
    const bar = h(
      "div",
      { class: "reply-bar" },
      icon("reply"),
      h("span", {
        text: `回复 ${memberName(original?.sender_member_id)}：${original?.body || ""}`,
      }),
      iconButton("close", "取消回复", () => {
        state.replyTo = null;
        renderMain();
      }),
    );
    $(".composer-box", view).prepend(bar);
  }
}
function messageNode(message) {
  const isBoss = message.author_kind === "boss";
  const isSystem = message.author_kind === "system";
  const member =
    !isBoss && !isSystem ? memberById(message.sender_member_id) : undefined;
  const replied = message.reply_to
    ? state.messages.find((m) => m.message_id === message.reply_to)
    : null;
  const row = h("article", {
    class: `message-row ${message.author_kind}`,
    // data-seq 是这一发在会话内的序号（服务端事实）：翻页判据靠它钉 prepend
    // 顺序，不靠渲染时刻的几何。
    dataset: { messageId: message.message_id, seq: message.seq_in_conv },
    tabindex: 0,
  });
  if (!isSystem)
    row.append(avatarForAuthor(message.author_kind, message.sender_member_id));
  const body = h(
    "div",
    { class: "message-body" },
    h(
      "div",
      { class: "message-meta" },
      h("strong", {
        text: isBoss
          ? "老板"
          : isSystem
            ? "系统"
            : memberName(message.sender_member_id),
      }),
      member
        ? h("span", { class: "persona-tagline", text: personaTagline(member) })
        : null,
      h("time", {
        class: "mono",
        datetime: new Date(message.created_at).toISOString(),
        // 日期已由上方的 .message-day 分隔条说过，这里只留「几点几分」，
        // 一行消息头从「2026/11/24 上午10:32:00」瘦成「10:32」。
        title: fmtDateTime(message.created_at),
        text: fmtTime(message.created_at),
      }),
    ),
    replied
      ? h("div", {
          class: "reply-context",
          text: `${memberName(replied.sender_member_id)}：${replied.body}`,
        })
      : null,
    h("div", { class: "bubble", text: message.body }),
  );
  if (message.mentions.includes("@boss") && !isSystem)
    body.append(
      h(
        "div",
        { class: "decision-card" },
        h("strong", null, icon("talent"), "需要你拍板"),
        h("div", {
          class: "small-text",
          text: "这条消息已升级给老板。请评估边界、预算与战略影响。",
        }),
      ),
    );
  if (message.kind !== "text" && !isSystem)
    body.append(
      h(
        "div",
        { class: "actions" },
        pill(labels[message.kind] || titleCase(message.kind), "blue"),
      ),
    );
  row.append(body);
  if (!isSystem)
    row.append(
      h(
        "div",
        { class: "message-tools" },
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              state.replyTo = message.message_id;
              renderMain();
              $("textarea", $(".composer"))?.focus();
            },
          },
          "回复",
        ),
        message.author_kind === "member"
          ? h(
              "button",
              {
                type: "button",
                onclick: () => speak(message.body, message.sender_member_id),
              },
              "播放语音",
            )
          : null,
      ),
    );
  return row;
}
function chooseReply(stream) {
  const target = stream.querySelector(".message-row:last-of-type");
  if (!target) return toast("当前没有可回复的消息", true);
  state.replyTo = target.dataset.messageId;
  renderMain();
  $("textarea", $(".composer"))?.focus();
}
function speak(text, memberId) {
  const synthesis = browserSpeech();
  if (!synthesis) return toast("当前浏览器不支持语音播放", true);
  synthesis.cancel();
  const member = memberById(memberId);
  speakWithBrowser(
    synthesis,
    (options) => {
      const utterance = new SpeechSynthesisUtterance(options.text);
      utterance.lang = options.lang;
      utterance.rate = options.rate;
      utterance.pitch = options.pitch;
      utterance.voice = options.voice;
      return utterance;
    },
    text,
    member?.voice || null,
  ).catch((error) => toast(errorMessage(error), true));
}
async function sendMessage(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = new FormData(form).get("body").toString().trim();
  if (!body) return;
  const conversationId = state.selectedConversation;
  messageRequestToken += 1;
  state.messageLoading = false;
  state.messageSending = true;
  const submit = $("button[type=submit]", form);
  submit.disabled = true;
  try {
    const result = await request(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        body: { body, ...(state.replyTo ? { reply_to: state.replyTo } : {}) },
      },
    );
    if (result.message) state.messages.push(result.message);
    const cosMessage = result.dispatch?.message;
    if (
      cosMessage?.ok &&
      cosMessage.message &&
      !state.messages.some(
        (item) => item.message_id === cosMessage.message.message_id,
      )
    )
      state.messages.push(cosMessage.message);
    state.replyTo = null;
    state.composerDrafts.delete(conversationId);
    form.reset();
    $(".char-count", form).textContent = "0 / 8000";
    renderMain();
    const stream = $(".message-stream");
    if (stream) stream.scrollTop = stream.scrollHeight;
    await Promise.all([loadCore(), loadAuxiliary()]);
    renderList();
    if (state.selectedConversation === conversationId)
      await loadMessages(conversationId, false);
    toast("消息已发送");
  } catch (error) {
    toast(errorMessage(error), true);
  } finally {
    state.messageSending = false;
    submit.disabled = false;
  }
}

async function openMeeting(id) {
  state.selectedMeeting = id;
  state.selectedConversation = null;
  setRoute("messages", `meeting:${id}`);
  await loadMeeting(id, true);
}
async function loadMeeting(id, showLoading = false) {
  if (showLoading) $("#view").replaceChildren(loadingState("正在加载会议…"));
  try {
    const result = await request(`/meetings/${encodeURIComponent(id)}`);
    state.meetings = state.meetings.map((meeting) =>
      meeting.meeting_id === id ? result.meeting : meeting,
    );
    if (!state.meetings.some((meeting) => meeting.meeting_id === id))
      state.meetings.push(result.meeting);
    if (id) {
      const response = await request(
        `/groups/${encodeURIComponent(result.meeting.group_id)}`,
      );
      state.groupMembers.set(result.meeting.group_id, response.members || []);
    }
    renderList();
    renderMain();
  } catch (error) {
    $("#view").replaceChildren(
      banner(errorMessage(error), "error", () => loadMeeting(id)),
    );
  }
}
function renderMeeting(view) {
  const meeting = state.meetings.find(
    (m) => m.meeting_id === state.selectedMeeting,
  );
  if (!meeting) {
    view.append(
      emptyState("会议不存在", "返回会议列表选择其他记录。", null, "meeting"),
    );
    return;
  }
  const participants = (state.groupMembers.get(meeting.group_id) || []).map(
    (seat) => seat.member_id,
  );
  const speakerIds = [
    ...new Set(
      [
        meeting.moderator_member_id,
        ...meeting.speaking_order,
        ...meeting.turns.map((turn) => turn.speaker_member_id),
        ...participants,
      ].filter(Boolean),
    ),
  ];
  const concluded = meeting.status === "concluded";
  const cancelled = meeting.status === "cancelled";
  const spoken = new Set(meeting.turns.map((turn) => turn.speaker_member_id));
  const nextId = meeting.next_speaker_member_id;
  const order = h(
    "div",
    { class: "speaking-order", "aria-label": "发言顺序" },
    ...meeting.speaking_order.map((id) =>
      h(
        "span",
        {
          class: `speaker-chip ${id === nextId ? "next" : spoken.has(id) ? "done" : ""}`,
        },
        avatar(memberById(id), "small"),
        memberName(id),
        id === nextId ? "· 下一位" : "",
      ),
    ),
  );
  const turnCards = meeting.turns.length
    ? meeting.turns.map((turn) =>
        h(
          "article",
          { class: "turn-card" },
          avatar(memberById(turn.speaker_member_id)),
          h(
            "div",
            null,
            h("h3", { text: memberName(turn.speaker_member_id) }),
            h("time", {
              class: "mono",
              text: `第 ${turn.turn_seq + 1} 轮 · ${fmtDateTime(turn.created_at)}`,
            }),
            h("div", { class: "turn-content", text: turn.content }),
          ),
        ),
      )
    : emptyState(
        "尚未开始发言",
        "只有当前下一位发言者可以提交本轮发言。",
        null,
        "meeting",
      );
  const turnForm = h(
    "form",
    { class: "card", onsubmit: postMeetingTurn },
    h("h3", { text: `本轮发言 · ${memberName(nextId)}` }),
    field(
      "发言内容",
      textarea("content", "", {
        required: true,
        maxlength: 8000,
        placeholder: "提交后服务端会原子推进到下一位…",
      }),
    ),
    h(
      "div",
      { class: "toolbar" },
      field(
        "指定下一位",
        select(
          "next_speaker_member_id",
          [
            ["", "按既定顺序推进"],
            ...speakerIds
              .filter((id) => id !== nextId)
              .map((id) => [id, memberName(id)]),
          ],
          "",
        ),
      ),
      h(
        "button",
        {
          class: "btn primary",
          type: "submit",
          disabled: concluded || cancelled || !nextId,
        },
        icon("send"),
        "提交发言",
      ),
    ),
  );
  const conclusion = h(
    "section",
    { class: "card" },
    h("h3", { text: "结论三件套" }),
    concluded || cancelled
      ? h(
          "dl",
          { class: "detail-list" },
          h("dt", { text: "决定" }),
          h("dd", { text: meeting.decision || "—" }),
          h("dt", { text: "负责人" }),
          h("dd", { text: memberName(meeting.owner_member_id) }),
          h("dt", { text: "截止" }),
          h("dd", { class: "mono", text: fmtDateTime(meeting.deadline_at) }),
        )
      : h(
          "form",
          { onsubmit: concludeMeeting },
          formGrid(
            field(
              "决定",
              textarea("decision", "", { required: true, maxlength: 4000 }),
            ),
            field(
              "负责人",
              select(
                "owner_member_id",
                speakerIds.map((id) => [id, memberName(id)]),
                meeting.moderator_member_id || "",
              ),
              { required: true },
            ),
            field(
              "截止时间",
              input("deadline_at", "", "datetime-local", { required: true }),
            ),
          ),
          h(
            "div",
            { class: "actions" },
            h(
              "button",
              { class: "btn primary", type: "submit" },
              "散会并生成纪要",
            ),
          ),
        ),
  );
  const summaryLink = meeting.summary_doc_id
    ? h(
        "a",
        {
          class: "btn",
          href: "#/documents",
          onclick: (event) => {
            event.preventDefault();
            setRoute("documents", meeting.summary_doc_id);
            openDocument(meeting.summary_doc_id);
          },
        },
        icon("doc"),
        "打开自动纪要",
      )
    : null;
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader(
        meeting.topic,
        `${labels[meeting.meeting_type]}会议 · ${groupName(meeting.group_id)}`,
        [
          pill(
            labels[meeting.status],
            meeting.status === "open"
              ? "purple"
              : meeting.status === "concluded"
                ? "green"
                : "",
          ),
          button("刷新", () => loadMeeting(meeting.meeting_id), "small"),
          !concluded && !cancelled
            ? button(
                "取消会议",
                () => cancelMeetingModal(meeting),
                "danger small",
              )
            : null,
        ],
      ),
      h(
        "div",
        { class: "meeting-layout" },
        h(
          "div",
          null,
          h(
            "section",
            { class: "card" },
            h(
              "div",
              { class: "detail-hero" },
              h("span", { class: "kind-icon meeting" }, icon("meeting")),
              h(
                "div",
                null,
                h("h2", { text: meeting.topic }),
                h("p", {
                  text: `主持：${memberName(meeting.moderator_member_id)} · 开场于 ${fmtDateTime(meeting.opened_at)}`,
                }),
              ),
            ),
            h("h3", { text: "发言顺序" }),
            order,
            h("p", {
              class: "muted small-text",
              text: nextId
                ? `下一位：${memberName(nextId)}`
                : cancelled
                  ? "会议已取消"
                  : concluded
                    ? "会议已散会"
                    : "暂无下一位发言者",
            }),
          ),
          h("h3", { text: "逐轮发言" }),
          turnCards,
          meeting.status === "open" ? turnForm : null,
        ),
        h(
          "aside",
          { class: "side-stack" },
          conclusion,
          h(
            "section",
            { class: "card" },
            h("h3", { text: "会议文档" }),
            h("p", {
              class: "muted small-text",
              text: "散会成功后，服务端自动生成包含发言与结论的 Markdown 纪要。",
            }),
            summaryLink,
            cancelled
              ? h("p", {
                  class: "small-text",
                  text: "取消操作保留在审计记录中。",
                })
              : null,
          ),
        ),
      ),
    ),
  );
}
async function postMeetingTurn(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const meeting = state.meetings.find(
    (m) => m.meeting_id === state.selectedMeeting,
  );
  const submit = $("button[type=submit]", form);
  submit.disabled = true;
  try {
    await request(`/meetings/${encodeURIComponent(meeting.meeting_id)}/turns`, {
      method: "POST",
      body: {
        speaker_member_id: meeting.next_speaker_member_id,
        content: data.get("content"),
        ...(data.get("next_speaker_member_id")
          ? { next_speaker_member_id: data.get("next_speaker_member_id") }
          : {}),
      },
    });
    toast("发言已记录，下一位已更新");
    await loadMeeting(meeting.meeting_id);
  } catch (error) {
    toast(errorMessage(error), true);
    submit.disabled = false;
  }
}
async function concludeMeeting(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const deadline = new Date(data.get("deadline_at")).getTime();
  if (!Number.isFinite(deadline) || deadline <= 0)
    return toast("请选择有效的截止时间", true);
  const submit = $("button[type=submit]", event.currentTarget);
  submit.disabled = true;
  try {
    const result = await request(
      `/meetings/${encodeURIComponent(state.selectedMeeting)}/conclude`,
      {
        method: "POST",
        body: {
          decision: data.get("decision"),
          owner_member_id: data.get("owner_member_id"),
          deadline_at: deadline,
        },
      },
    );
    await loadMeeting(state.selectedMeeting);
    if (result.summary?.ok && result.summary.docId) {
      toast("会议已散会，纪要已自动生成");
      await openDocument(result.summary.docId);
    } else
      toast(
        `会议已散会，但纪要生成失败：${result.summary?.reason || "未知原因"}`,
        true,
      );
  } catch (error) {
    toast(errorMessage(error), true);
    submit.disabled = false;
  }
}

function rhythmKindMeta(value) {
  return (
    rhythmKinds.find((kind) => kind.value === value) || {
      value,
      label: titleCase(value),
      tone: "",
      empty: "暂无该类节奏记录。",
    }
  );
}
function payloadText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function safeWebUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : "";
  } catch {
    return "";
  }
}
function setTaskTab(tab) {
  if (!taskTabs.some(([value]) => value === tab)) return;
  if (tab === state.taskTab && tab !== "backlog") {
    void loadTeamPanel(tab);
    return;
  }
  state.taskTab = tab;
  state.teamWorkError = "";
  renderMain();
  if (tab !== "backlog") void loadTeamPanel(tab);
}
async function loadTeamPanel(tab) {
  if (tab !== "rhythm" && tab !== "research") return;
  const token = ++teamPanelToken;
  state.teamWorkLoading = true;
  state.teamWorkError = "";
  if (state.route === "backlog" && !state.selectedBacklog) renderMain();
  try {
    let path = "/research/today";
    if (tab === "rhythm") {
      const query = new URLSearchParams({ limit: "50" });
      if (state.rhythmGroup) query.set("group_id", state.rhythmGroup);
      if (state.rhythmKind) query.set("kind", state.rhythmKind);
      path = `/rhythm/events?${query}`;
    }
    const result = await request(path);
    if (result?.ok === false)
      throw new Error(result?.reason || result?.error || "加载失败");
    if (
      token !== teamPanelToken ||
      state.taskTab !== tab ||
      state.route !== "backlog" ||
      state.selectedBacklog
    )
      return;
    if (tab === "rhythm") state.rhythmEvents = result?.items || [];
    else state.researchCards = result?.items || [];
  } catch (error) {
    if (
      token === teamPanelToken &&
      state.taskTab === tab &&
      state.route === "backlog" &&
      !state.selectedBacklog
    )
      state.teamWorkError = errorMessage(error);
  } finally {
    if (
      token === teamPanelToken &&
      state.taskTab === tab &&
      state.route === "backlog" &&
      !state.selectedBacklog
    ) {
      state.teamWorkLoading = false;
      renderMain();
    }
  }
}
async function refreshTaskPanel() {
  await refreshAll();
  if (state.taskTab !== "backlog") await loadTeamPanel(state.taskTab);
}
function renderTaskTabs() {
  return h(
    "div",
    {
      class: "tabs task-tabs",
      role: "tablist",
      "aria-label": "任务面板视图",
    },
    ...taskTabs.map(([value, label]) =>
      h(
        "button",
        {
          type: "button",
          class: `tab${state.taskTab === value ? " active" : ""}`,
          role: "tab",
          id: `task-tab-${value}`,
          "aria-controls": "taskPanel",
          "aria-selected": String(state.taskTab === value),
          tabindex: state.taskTab === value ? 0 : -1,
          onclick: () => setTaskTab(value),
          onkeydown: (event) => {
            const current = taskTabs.findIndex(([tab]) => tab === value);
            let next = current;
            if (event.key === "ArrowRight")
              next = (current + 1) % taskTabs.length;
            else if (event.key === "ArrowLeft")
              next = (current - 1 + taskTabs.length) % taskTabs.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = taskTabs.length - 1;
            else return;
            event.preventDefault();
            const target = taskTabs[next][0];
            setTaskTab(target);
            $(`#task-tab-${target}`)?.focus();
          },
        },
        label,
      ),
    ),
  );
}
function renderRhythmCard(event) {
  const meta = rhythmKindMeta(event.kind);
  const payload =
    event.payload && typeof event.payload === "object" ? event.payload : {};
  const knownKeys = new Set(rhythmPayloadFields.map(([key]) => key));
  const fields = rhythmPayloadFields
    .map(([key, label]) => [key, label, payloadText(payload[key])])
    .filter(([, , value]) => value.trim())
    .map(([key, label, value]) =>
      h(
        "div",
        { class: `payload-item${key === "conclusion" ? " conclusion" : ""}` },
        h("dt", { text: label }),
        h("dd", {
          text: key === "owner" ? memberName(value) : value,
        }),
      ),
    );
  for (const [key, value] of Object.entries(payload)) {
    if (knownKeys.has(key)) continue;
    const text = payloadText(value);
    if (text.trim())
      fields.push(
        h(
          "div",
          { class: "payload-item" },
          h("dt", { text: titleCase(key) }),
          h("dd", { text }),
        ),
      );
  }
  return h(
    "article",
    { class: "entry-card rhythm-card" },
    h(
      "div",
      { class: "entry-heading" },
      h("h3", { text: meta.label }),
      h(
        "div",
        { class: "actions" },
        !payloadText(payload.conclusion).trim()
          ? pill("无明确结论", "amber")
          : null,
        event.digest_doc_id ? pill("摘要文档已生成", "green") : null,
      ),
    ),
    h(
      "div",
      { class: "entry-meta" },
      h("time", { class: "mono", text: fmtDateTime(event.at) }),
      pill(groupName(event.group_id)),
      h("span", { class: "mono small-text muted", text: event.event_id }),
    ),
    fields.length
      ? h("dl", { class: "payload-grid" }, ...fields)
      : h("p", { class: "muted", text: "该记录没有管理内容。" }),
    h(
      "div",
      { class: "entry-footer" },
      event.digest_doc_id
        ? button(
            "打开摘要文档",
            () => openDocument(event.digest_doc_id),
            "small",
          )
        : h("span", { class: "small-text muted", text: "暂无摘要文档" }),
    ),
  );
}
function renderRhythmView() {
  const toolbar = h(
    "div",
    { class: "toolbar team-toolbar" },
    select(
      "rhythmKind",
      [
        ["", "全部节奏"],
        ...rhythmKinds.map((kind) => [kind.value, kind.label]),
      ],
      state.rhythmKind,
      {
        "aria-label": "筛选节奏类型",
        onchange: (event) => {
          state.rhythmKind = event.target.value;
          void loadTeamPanel("rhythm");
        },
      },
    ),
    select(
      "rhythmGroup",
      [
        ["", "全部群组"],
        ...state.groups.map((group) => [group.group_id, group.title]),
      ],
      state.rhythmGroup,
      {
        "aria-label": "筛选节奏群组",
        onchange: (event) => {
          state.rhythmGroup = event.target.value;
          void loadTeamPanel("rhythm");
        },
      },
    ),
    h("span", { class: "spacer" }),
    button("刷新列表", () => loadTeamPanel("rhythm"), "small"),
  );
  const visibleKinds = state.rhythmKind
    ? rhythmKinds.filter((kind) => kind.value === state.rhythmKind)
    : rhythmKinds;
  return h(
    "section",
    { class: "team-panel" },
    h("h3", { text: "团队节奏" }),
    h("p", {
      class: "muted",
      text: "按迭代计划、站会、评审与复盘沉淀管理结论；每条记录可打开自动生成的摘要文档。",
    }),
    toolbar,
    state.teamWorkError
      ? banner(state.teamWorkError, "error", () => loadTeamPanel("rhythm"))
      : null,
    state.teamWorkLoading ? cardSkeleton(3) : null,
    !state.teamWorkLoading && !state.rhythmEvents.length
      ? emptyState(
          "还没有团队节奏",
          state.rhythmKind || state.rhythmGroup
            ? "当前筛选下没有记录，调整类型或群组后再试。"
            : "从一次迭代计划或每日站会开始。请填写摘要、成果、卡点、下一步与负责人，并给出明确结论。",
          button("新增节奏", () => rhythmCreateModal(), "primary"),
          "clock",
        )
      : null,
    ...(!state.teamWorkLoading && state.rhythmEvents.length
      ? visibleKinds.map((kind) => {
          const events = state.rhythmEvents.filter(
            (event) => event.kind === kind.value,
          );
          return h(
            "section",
            { class: "card team-section" },
            h(
              "div",
              { class: "section-heading" },
              h("h3", { text: kind.label }),
              pill(`${events.length} 条`, kind.tone),
            ),
            events.length
              ? h(
                  "div",
                  { class: "entry-list" },
                  ...events.map(renderRhythmCard),
                )
              : h("p", { class: "inline-empty muted", text: kind.empty }),
          );
        })
      : []),
  );
}
async function openResearchBacklog(id, trigger) {
  // 待办清单没这一条时要先拉 /backlog（一个来回）。按钮在飞的时候按下去：
  // 上一行 disabled 让指针变禁、再点不重复发 —— 没有这一发，点击像没生效。
  if (trigger) trigger.disabled = true;
  try {
    if (!state.backlog.some((item) => item.id === id)) {
      const result = await request("/backlog?limit=200");
      if (result?.ok === false)
        throw new Error(result?.reason || result?.error || "加载待办失败");
      state.backlog = result?.items || [];
      renderList();
    }
    state.selectedBacklog = id;
    setRoute("backlog", id);
  } catch (error) {
    toast(errorMessage(error), true);
  } finally {
    if (trigger) trigger.disabled = false;
  }
}
function renderResearchCard(item) {
  const url = safeWebUrl(item.url);
  return h(
    "article",
    { class: "entry-card research-card" },
    h(
      "div",
      { class: "entry-heading" },
      h("h3", { class: "tw:text-balance", text: item.title }),
      pill(item.source || "manual", "blue"),
    ),
    h(
      "div",
      { class: "entry-meta" },
      h("time", { class: "mono", text: fmtDateTime(item.created_at) }),
      h("span", { text: `调研日期 ${item.day}` }),
      pill(groupName(item.group_id)),
    ),
    h("p", {
      class: "research-summary",
      text: item.summary || "暂无摘要，可打开调研文档补充。",
    }),
    item.url
      ? url
        ? h(
            "a",
            {
              class: "small-text research-link",
              href: url,
              target: "_blank",
              rel: "noopener noreferrer",
            },
            item.url,
          )
        : h("p", { class: "small-text muted", text: item.url })
      : null,
    h(
      "div",
      { class: "entry-footer" },
      h(
        "div",
        { class: "actions" },
        item.doc_id
          ? button("打开调研文档", () => openDocument(item.doc_id), "small")
          : pill("未生成调研文档", "amber"),
        item.backlog_item_id ? pill("已关联待办", "green") : pill("未关联待办"),
      ),
      item.backlog_item_id
        ? button(
            "查看任务",
            (event) =>
              openResearchBacklog(item.backlog_item_id, event.currentTarget),
            "small",
          )
        : h("span", {
            class: "small-text muted",
            text: "创建后由服务端生成待办草稿",
          }),
    ),
  );
}
function renderResearchView() {
  return h(
    "section",
    { class: "team-panel" },
    h("h3", { text: "每日调研" }),
    h("p", {
      class: "muted",
      text: "汇总今日调研卡，直接打开来源、调研文档与服务端自动创建的待办草稿。",
    }),
    h(
      "div",
      { class: "toolbar team-toolbar" },
      h("span", { class: "spacer" }),
      button("刷新列表", () => loadTeamPanel("research"), "small"),
    ),
    state.teamWorkError
      ? banner(state.teamWorkError, "error", () => loadTeamPanel("research"))
      : null,
    state.teamWorkLoading ? cardSkeleton(3) : null,
    !state.teamWorkLoading && !state.researchCards.length
      ? emptyState(
          "今天还没有调研",
          "登记一条外部链接或手动调研。没有 URL 时来源请填写 manual，创建后会关联调研文档和待办草稿。",
          button("新增调研", () => researchCreateModal(), "primary"),
          "search",
        )
      : null,
    !state.teamWorkLoading && state.researchCards.length
      ? h(
          "div",
          { class: "entry-list" },
          ...state.researchCards.map(renderResearchCard),
        )
      : null,
  );
}
function rhythmCreateModal() {
  openModal({
    title: "新增团队节奏",
    eyebrow: "TEAM RHYTHM",
    build: () =>
      h(
        "div",
        null,
        banner(
          "明确结论为必填：空白结论、只写过程或只罗列卡点，都不算完整记录。",
          "warning",
        ),
        formGrid(
          field(
            "节奏类型",
            select(
              "kind",
              rhythmKinds.map((kind) => [kind.value, kind.label]),
              state.rhythmKind || "standup",
              { required: true },
            ),
          ),
          field(
            "所属群",
            select(
              "group_id",
              [
                ["", "不分组"],
                ...state.groups.map((group) => [group.group_id, group.title]),
              ],
              state.rhythmGroup,
            ),
          ),
          field(
            "发生时间",
            input("at", dateInputValue(Date.now()), "datetime-local", {
              required: true,
            }),
          ),
          field(
            "负责人",
            input("owner", "", "text", {
              maxlength: 200,
              placeholder: "成员 ID 或姓名",
            }),
          ),
          fullField(
            "摘要",
            textarea("summary", "", {
              required: true,
              maxlength: 8000,
              placeholder: "这次节奏发生了什么？",
            }),
          ),
          fullField(
            "明确结论",
            textarea("conclusion", "", {
              required: true,
              maxlength: 8000,
              placeholder: "写清决定、共识或可验证的结论",
            }),
            "必填；空结论不算完整。",
          ),
          fullField("成果", textarea("outcomes", "", { maxlength: 8000 })),
          fullField("卡点", textarea("blockers", "", { maxlength: 8000 })),
          fullField("下一步", textarea("next_steps", "", { maxlength: 8000 })),
        ),
      ),
    submit: "记录节奏",
    onSubmit: async (data) => {
      const summary = String(data.get("summary") || "").trim();
      const conclusion = String(data.get("conclusion") || "").trim();
      if (!summary || !conclusion)
        throw new Error("请填写摘要与明确结论；空结论不算完整。");
      const at = new Date(data.get("at")).getTime();
      if (!Number.isFinite(at) || at <= 0)
        throw new Error("请选择有效的发生时间。");
      const payload = { summary, conclusion };
      for (const key of ["outcomes", "blockers", "next_steps", "owner"]) {
        const value = String(data.get(key) || "").trim();
        if (value) payload[key] = value;
      }
      const result = await request("/rhythm/events", {
        method: "POST",
        body: {
          kind: data.get("kind"),
          ...(data.get("group_id") ? { group_id: data.get("group_id") } : {}),
          at,
          payload,
        },
      });
      if (result?.ok === false)
        throw new Error(result?.reason || result?.error || "新增节奏失败");
      const documentFailed = result.document?.ok === false;
      toast(
        documentFailed
          ? "节奏已记录，但摘要文档生成失败"
          : result.created === false
            ? "节奏记录已存在，已刷新列表"
            : result.document?.ok
              ? "节奏已记录，摘要文档已生成"
              : "节奏已记录",
        documentFailed,
      );
      await Promise.all([loadTeamPanel("rhythm"), loadAuxiliary()]);
    },
  });
}
function researchCreateModal() {
  openModal({
    title: "新增每日调研",
    eyebrow: "DAILY RESEARCH",
    build: () =>
      h(
        "div",
        null,
        banner(
          "没有 URL 时，来源必须填写 manual。创建后由服务端生成待办草稿与调研文档。",
          "info",
        ),
        formGrid(
          field(
            "来源",
            input("source", "manual", "text", {
              required: true,
              maxlength: 200,
              placeholder: "manual 或来源名称",
            }),
            "没有链接时只能填写 manual。",
          ),
          field(
            "所属群",
            select("group_id", [
              ["", "不分组"],
              ...state.groups.map((group) => [group.group_id, group.title]),
            ]),
          ),
          fullField(
            "标题",
            input("title", "", "text", {
              required: true,
              maxlength: 300,
            }),
          ),
          fullField(
            "摘要",
            textarea("summary", "", {
              required: true,
              maxlength: 8000,
              placeholder: "值得团队关注的信息与判断",
            }),
          ),
          fullField("链接", input("url", "", "url", { maxlength: 2000 })),
        ),
      ),
    submit: "登记调研",
    onSubmit: async (data) => {
      const source = String(data.get("source") || "").trim();
      const title = String(data.get("title") || "").trim();
      const summary = String(data.get("summary") || "").trim();
      const url = String(data.get("url") || "").trim();
      if (!source || !title || !summary)
        throw new Error("请填写来源、标题与摘要。");
      if (!url && source !== "manual")
        throw new Error("没有 URL 时，来源必须填写 manual。");
      const result = await request("/research/today", {
        method: "POST",
        body: {
          source,
          title,
          summary,
          ...(url ? { url } : {}),
          ...(data.get("group_id") ? { group_id: data.get("group_id") } : {}),
        },
      });
      if (result?.ok === false)
        throw new Error(result?.reason || result?.error || "新增调研失败");
      const documentFailed = result.document?.ok === false;
      toast(
        documentFailed
          ? "调研已登记，但调研文档生成失败"
          : result.created === false
            ? "今日调研已存在，已刷新关联状态"
            : result.item?.backlog_item_id
              ? "调研已登记，待办草稿与调研文档已关联"
              : "调研已登记",
        documentFailed,
      );
      await refreshAll();
      await loadTeamPanel("research");
    },
  });
}

function renderBacklog(view) {
  const states = ["backlog", "scheduled", "doing", "done", "cancelled"];
  const _tone = { doing: "blue", done: "green", cancelled: "" };
  const cards = (items) =>
    items
      .sort((a, b) => a.priority - b.priority || a.created_at - b.created_at)
      .map((item) =>
        h(
          "article",
          { class: "task-card", tabindex: 0 },
          h("h4", { text: item.title }),
          h("p", { text: item.detail || "暂无详情" }),
          h(
            "div",
            { class: "task-meta" },
            pill(`P ${item.priority}`, item.priority < 0 ? "red" : ""),
            pill(groupName(item.group_id)),
            item.due_at
              ? h("time", { class: "mono", text: fmtDate(item.due_at) })
              : null,
          ),
          h(
            "div",
            { class: "task-actions" },
            h(
              "button",
              { type: "button", onclick: () => selectBacklog(item.id) },
              "详情",
            ),
            h(
              "button",
              { type: "button", onclick: () => backlogPriorityModal(item) },
              "优先级",
            ),
            h(
              "button",
              { type: "button", onclick: () => backlogDeferModal(item) },
              "延期",
            ),
            h(
              "button",
              { type: "button", onclick: () => backlogMoveModal(item) },
              "移动群组",
            ),
            h(
              "button",
              { type: "button", onclick: () => backlogSplitModal(item) },
              "拆分",
            ),
            h(
              "button",
              { type: "button", onclick: () => backlogMergeModal(item) },
              "合并",
            ),
            item.state !== "cancelled"
              ? h(
                  "button",
                  { type: "button", onclick: () => cancelBacklog(item) },
                  "取消",
                )
              : null,
          ),
        ),
      );
  const createAction =
    state.taskTab === "rhythm"
      ? button("新增节奏", () => rhythmCreateModal(), "primary")
      : state.taskTab === "research"
        ? button("新增调研", () => researchCreateModal(), "primary")
        : button("新建待办", () => backlogCreateModal(), "primary");
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader(
        "任务面板",
        "待办、团队节奏与每日调研；所有变更由 Hub 审计。",
        [
          button("刷新", () => {
            void refreshTaskPanel().catch((error) =>
              toast(errorMessage(error), true),
            );
          }),
          createAction,
        ],
      ),
      renderTaskTabs(),
      h(
        "section",
        {
          id: "taskPanel",
          role: "tabpanel",
          "aria-labelledby": `task-tab-${state.taskTab}`,
        },
        state.taskTab === "backlog"
          ? h(
              "div",
              null,
              banner(
                "优先级数字越小越紧急。取消、移动、延期、拆分与合并均调用独立领域端点。",
                "info",
              ),
              h(
                "div",
                { class: "board" },
                ...states.map((status) =>
                  h(
                    "section",
                    { class: "board-column" },
                    h(
                      "h3",
                      null,
                      labels[status],
                      h("span", {
                        text: state.backlog.filter(
                          (item) => item.state === status,
                        ).length,
                      }),
                    ),
                    cards(
                      state.backlog.filter((item) => item.state === status),
                    ),
                  ),
                ),
              ),
            )
          : state.taskTab === "rhythm"
            ? renderRhythmView()
            : renderResearchView(),
      ),
    ),
  );
}
async function selectBacklog(id) {
  state.selectedBacklog = id;
  renderList();
  renderMain();
}
function renderBacklogDetail(view) {
  const item = state.backlog.find(
    (entry) => entry.id === state.selectedBacklog,
  );
  if (!item) {
    view.append(emptyState("待办不存在", "返回任务面板。", null, "board"));
    return;
  }
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader(
        item.title,
        `${labels[item.state]} · ${groupName(item.group_id)}`,
        [
          button(
            state.taskTab === "backlog" ? "返回看板" : "返回任务面板",
            () => {
              state.selectedBacklog = null;
              setRoute("backlog");
            },
          ),
          button("取消待办", () => cancelBacklog(item), "danger"),
        ],
      ),
      h(
        "article",
        { class: "card" },
        h("h3", { text: "详情" }),
        h("p", { text: item.detail || "暂无详情" }),
        h(
          "dl",
          { class: "detail-list" },
          h("dt", { text: "ID" }),
          h("dd", { class: "mono", text: item.id }),
          h("dt", { text: "优先级" }),
          h("dd", { text: item.priority }),
          h("dt", { text: "截止" }),
          h("dd", { text: fmtDateTime(item.due_at) }),
          h("dt", { text: "父项" }),
          h("dd", { class: "mono", text: item.parent_id || "—" }),
          h("dt", { text: "合并到" }),
          h("dd", { class: "mono", text: item.merged_into || "—" }),
          h("dt", { text: "更新时间" }),
          h("dd", { text: fmtDateTime(item.updated_at) }),
        ),
        h(
          "div",
          { class: "actions" },
          button("改优先级", () => backlogPriorityModal(item)),
          button("延期", () => backlogDeferModal(item)),
          button("移动群组", () => backlogMoveModal(item)),
          button("拆分", () => backlogSplitModal(item)),
          button("合并", () => backlogMergeModal(item)),
        ),
      ),
    ),
  );
}
async function backlogMutation(path, method = "PATCH", body) {
  await request(path, { method, body });
  await refreshAll();
  toast("待办已更新");
}
function backlogCreateModal() {
  openModal({
    title: "新建待办",
    eyebrow: "BACKLOG",
    build: () =>
      formGrid(
        field(
          "标题",
          input("title", "", "text", { required: true, maxlength: 200 }),
        ),
        field(
          "所属群",
          select("group_id", [
            ["", "不分组"],
            ...state.groups.map((g) => [g.group_id, g.title]),
          ]),
        ),
        field(
          "优先级（-100 至 100）",
          input("priority", 0, "number", {
            min: -100,
            max: 100,
            required: true,
          }),
        ),
        field("截止时间", input("due_at", "", "datetime-local")),
        fullField("详情", textarea("detail", "", { maxlength: 8000 })),
      ),
    submit: "创建",
    onSubmit: async (data) => {
      const due = data.get("due_at");
      await backlogMutation("/backlog", "POST", {
        title: data.get("title"),
        detail: data.get("detail"),
        priority: Number(data.get("priority")),
        ...(data.get("group_id") ? { group_id: data.get("group_id") } : {}),
        ...(due ? { due_at: new Date(due).getTime() } : {}),
      });
    },
  });
}
function backlogPriorityModal(item) {
  openModal({
    title: "调整优先级",
    eyebrow: item.title,
    build: () =>
      field(
        "优先级",
        input("priority", item.priority, "number", {
          min: -100,
          max: 100,
          required: true,
        }),
        "数字越小越紧急，-100 最紧急。",
      ),
    submit: "保存",
    onSubmit: (data) =>
      backlogMutation(`/backlog/${encodeURIComponent(item.id)}`, "PATCH", {
        priority: Number(data.get("priority")),
      }),
  });
}
function backlogDeferModal(item) {
  openModal({
    title: "延期或清除期限",
    eyebrow: item.title,
    build: () =>
      h(
        "div",
        null,
        field(
          "新的截止时间",
          input("due_at", dateInputValue(item.due_at), "datetime-local"),
          "留空将清除当前期限。",
        ),
        h(
          "label",
          { class: "check-row" },
          h("input", { type: "checkbox", name: "clear" }),
          "明确清除期限",
        ),
      ),
    submit: "保存",
    onSubmit: (data) =>
      backlogMutation(`/backlog/${encodeURIComponent(item.id)}`, "PATCH", {
        due_at: data.has("clear")
          ? null
          : data.get("due_at")
            ? new Date(data.get("due_at")).getTime()
            : null,
      }),
  });
}
function backlogMoveModal(item) {
  openModal({
    title: "移动所属群",
    eyebrow: item.title,
    build: () =>
      field(
        "目标群",
        select(
          "group_id",
          [["", "移出群组"], ...state.groups.map((g) => [g.group_id, g.title])],
          item.group_id || "",
        ),
      ),
    submit: "移动",
    onSubmit: (data) =>
      backlogMutation(`/backlog/${encodeURIComponent(item.id)}`, "PATCH", {
        group_id: data.get("group_id") || null,
      }),
  });
}
async function cancelBacklog(item) {
  openModal({
    title: "取消待办",
    eyebrow: item.title,
    build: () =>
      h("p", { text: "取消后条目保留在看板的“已取消”列，审计记录不会删除。" }),
    submit: "确认取消",
    danger: true,
    onSubmit: () =>
      backlogMutation(`/backlog/${encodeURIComponent(item.id)}`, "DELETE"),
  });
}
function backlogSplitModal(item) {
  openModal({
    title: "拆分待办",
    eyebrow: item.title,
    build: () =>
      h(
        "div",
        null,
        h("p", {
          class: "muted",
          text: "至少创建两个子项；父项保留并建立 parent_id 关联。",
        }),
        field("子项 1", input("child1", "", "text", { required: true })),
        field("子项 2", input("child2", "", "text", { required: true })),
      ),
    submit: "拆分",
    onSubmit: (data) =>
      backlogMutation(`/backlog/${encodeURIComponent(item.id)}/split`, "POST", {
        children: [data.get("child1"), data.get("child2")].map((title) => ({
          title,
          detail: "",
          priority: item.priority,
        })),
      }),
  });
}
function backlogMergeModal(item) {
  const targets = state.backlog.filter(
    (entry) => entry.id !== item.id && entry.state !== "cancelled",
  );
  if (!targets.length) return toast("没有可合并的目标条目", true);
  openModal({
    title: "合并到其他待办",
    eyebrow: item.title,
    build: () =>
      h(
        "div",
        null,
        h("p", {
          class: "muted",
          text: "本项将被取消，并记录 merged_into 指向目标；原记录保留。",
        }),
        field(
          "目标条目",
          select(
            "into_id",
            targets.map((entry) => [
              entry.id,
              `${entry.title}（${labels[entry.state]}）`,
            ]),
            targets[0].id,
          ),
          { required: true },
        ),
      ),
    submit: "确认合并",
    danger: true,
    onSubmit: (data) =>
      backlogMutation(`/backlog/${encodeURIComponent(item.id)}/merge`, "POST", {
        into_id: data.get("into_id"),
      }),
  });
}

function renderDocumentsHome(view) {
  const groups = [...new Set(state.documents.map((doc) => doc.kind))];
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader("文档中心", "模板、在线编辑、版本、权限与水印共用同一正文。", [
        button("导入", () => importDocument()),
        button("新建文档", () => openCreateModal("document"), "primary"),
      ]),
      h(
        "div",
        { class: "talent-grid" },
        ...groups.map((kind) =>
          h(
            "button",
            {
              type: "button",
              class: "talent-card",
              onclick: () => {
                state.docFilter.kind = kind;
                renderList();
              },
            },
            icon(
              kind === "sheet" ? "board" : kind === "mindmap" ? "tree" : "doc",
            ),
            h("h3", { text: labels[kind] }),
            h("p", {
              text: `${state.documents.filter((doc) => doc.kind === kind).length} 份文档`,
            }),
            pill("在线编辑", "blue"),
          ),
        ),
      ),
      h(
        "section",
        { class: "card" },
        h("h3", { text: "从模板开始" }),
        h(
          "div",
          { class: "actions" },
          ...state.templates
            .slice(0, 8)
            .map((template) =>
              button(
                template.name,
                () => createFromTemplate(template),
                "small",
              ),
            ),
          button("新建模板", () => templateCreateModal(), "small"),
        ),
      ),
      !state.templates.length
        ? emptyState(
            "暂无模板",
            "点「新建模板」建第一张，或先创建空白文档。",
            null,
            "upload",
          )
        : null,
    ),
  );
}
async function openDocument(id) {
  state.selectedDocument = id;
  setRoute("documents", id);
  $("#view").replaceChildren(docSkeleton());
  try {
    const [detail, versions, permissions] = await Promise.all([
      request(`/documents/${encodeURIComponent(id)}`),
      request(`/documents/${encodeURIComponent(id)}/versions`),
      request(`/documents/${encodeURIComponent(id)}/permissions`),
    ]);
    // upsert，不是 map：state.documents 是 boot 时那一份列表，别的标签页/会话新建的
    // 文档、以及翻页翻不到的文档都不在里面。只 map 的话，hash 深链打开这种文档会拿
    // 着已经取到的 detail 渲染「文档不存在」（实测：列表外文档换 hash ⇒ 空状态，刷新才出来）。
    state.documents = state.documents.some((doc) => doc.doc_id === id)
      ? state.documents.map((doc) =>
          doc.doc_id === id ? detail.document : doc,
        )
      : [...state.documents, detail.document];
    state.versions = versions.versions || [];
    state.permissions = permissions.permissions || [];
    state.draft = readDraft(id);
    renderList();
    renderMain();
  } catch (error) {
    $("#view").replaceChildren(
      banner(errorMessage(error), "error", () => openDocument(id)),
    );
  }
}
const richEditorFormats = [
  "header",
  "bold",
  "italic",
  "underline",
  "strike",
  "blockquote",
  "list",
  "code-block",
  "code",
  "link",
  "image",
  "table",
  "align",
  "indent",
];
const richEditorTableActions = {
  "table-row-above": ["+行", "当前表格上方插入行"],
  "table-row-below": ["+行", "当前表格下方插入行"],
  "table-row-delete": ["−行", "删除当前行"],
  "table-column-left": ["+列", "当前列左侧插入列"],
  "table-column-right": ["+列", "当前列右侧插入列"],
  "table-column-delete": ["−列", "删除当前列"],
  "table-delete": ["删表格", "删除整个表格"],
};
// Quill 2.0.3 没有 destroy()（实测 typeof quill.destroy === "undefined"），却会往 document
// 上挂 selectionchange 监听。每次打开文档新建一个实例的话，旧实例的监听永远留着、并且指向
// 已经丢弃的正文节点。所以全工作台只造一个 Quill：宿主节点、工具栏、正文节点跨渲染复用，
// 换文档 = 换 editable + 重新灌正文。
let richEditorShared = null;
function richEditorRetag(node, tag, keepAttrs) {
  const next = document.createElement(tag);
  for (const attr of node.attributes)
    if (!keepAttrs || keepAttrs.includes(attr.name))
      next.setAttribute(attr.name, attr.value);
  next.append(...node.childNodes);
  node.replaceWith(next);
  return next;
}
function richEditorDataUrlToFile(src) {
  const comma = src.indexOf(",");
  const mime = src.slice(5, src.indexOf(";")) || "image/png";
  let binary = "";
  try {
    binary = atob(src.slice(comma + 1));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], `pasted.${mime.split("/")[1] || "png"}`, {
    type: mime,
  });
}
async function richEditorAssetUrl(file) {
  const asset = await uploadAssetBase64(file, "attachment");
  const assetId = asset?.asset?.asset_id || asset?.asset_id;
  if (typeof assetId !== "string" || !assetId)
    throw new Error("图片上传响应缺少 asset_id。");
  return `/api/v1/assets/${encodeURIComponent(assetId)}`;
}
function normalizeRichEditorHtml(html) {
  const parsed = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    "text/html",
  );
  // <br>（DOCX 导入的软换行）按 Quill 的原生读法喂，不再替换成 \n：文本节点里的 \n
  // 会被 HTML 空白折叠压成空格（实测「尾段<br>换行」显示成「尾段 换行」——一行字没了，
  // 中间多了个空格），而单元格里的 <br> 会被读成「换了一个单元格」（2 列表变 3 列，吃排版）。
  // pre 里两者实测逐字节等价（都成 code-block 行），blockquote/li 里原生 <br> 保行、
  // \n 反而把两行并成一行。所以只在全局不动 <br>，表格里换成空格（内容不丢、列数不变）。
  for (const cell of [...parsed.querySelectorAll("td br, th br")])
    cell.replaceWith(" ");
  // 表头：Quill 的表格 blot 只认 tbody>tr>td，th/thead 落不了地时会被并进相邻单元格
  // （实测两列表头压成一个「列一列二」单元格 —— 这是吃内容，不是掉格式）。
  // 统一降成 tbody>tr>td，文字与列数都不动。
  for (const thead of [...parsed.querySelectorAll("thead")]) {
    const table = thead.closest("table");
    if (!table) {
      thead.replaceWith(...thead.childNodes);
      continue;
    }
    let body = table.querySelector("tbody");
    if (!body) {
      body = document.createElement("tbody");
      table.prepend(body);
    }
    for (const row of [...thead.querySelectorAll("tr")]) body.prepend(row);
    thead.remove();
  }
  for (const table of [...parsed.querySelectorAll("table")]) {
    const loose = [...table.children].filter((child) => child.tagName === "TR");
    if (!loose.length) continue;
    let body = table.querySelector("tbody");
    if (!body) {
      body = document.createElement("tbody");
      table.append(body);
    }
    for (const row of loose) body.append(row);
  }
  for (const cell of [...parsed.querySelectorAll("th")])
    richEditorRetag(cell, "td", ["colspan", "rowspan"]);
  // <hr> 在 Quill 里没有对应 blot，转换时会被静默丢掉；提前删掉让行为可预期。
  for (const node of [...parsed.querySelectorAll("hr")]) node.remove();
  // Quill 每次建表都写 inline style="border:1px solid #000"：属性级样式压过样式表，
  // 既是白底黑边的突兀配色，也等于让文档作者往工作台外壳注入样式（存的时候
  // sanitisedDocFragment 会抹掉 style，所以灌之前先摘 —— 所见即所存）。
  for (const node of [...parsed.querySelectorAll("table")])
    node.removeAttribute("style");
  return parsed.body.innerHTML;
}
function richEditorCellContext(quill) {
  const range = quill.getSelection();
  if (!range) return null;
  const [table, row, cell] = quill.getModule("table").getTable(range);
  if (!table || !row || !cell) return null;
  const node =
    cell.domNode?.nodeType === Node.ELEMENT_NODE
      ? cell.domNode
      : cell.domNode?.parentElement;
  const tableNode = node?.closest?.("table") || null;
  const rowNode = node?.closest?.("tr") || null;
  if (!tableNode || !rowNode) return null;
  return { api: quill.getModule("table"), tableNode, rowNode };
}
function richDocEditor(editable, notify) {
  if (!window.Quill) {
    return {
      toolbar: null,
      element: banner(
        "富文本引擎没能加载（/vendor/quill/quill.js）。刷新页面重试；此期间正文不会自动保存，以免把空内容写回文档。",
        "error",
      ),
      host: { ready: false, seed() {}, read: () => "" },
    };
  }
  if (!richEditorShared) richEditorShared = richEditorCreate();
  const host = richEditorShared;
  host.editable = editable;
  host.notify = notify;
  host.quill.enable(editable);
  host.root.setAttribute("aria-readonly", editable ? "false" : "true");
  for (const control of host.lockable) control.disabled = !editable;
  host.paint();
  return { toolbar: host.toolbar, element: host.element, host };
}
function richEditorCreate() {
  const element = h("div", { class: "rich-editor-host" });
  const host = {
    element,
    quill: null,
    root: null,
    toolbar: null,
    lockable: [],
    stateTools: [],
    tableButtons: [],
    ready: true,
    editable: true,
    settling: false,
    notify: () => {},
    seed(body) {
      host.settling = true;
      // silent：灌正文不算用户改动 —— 既不发 text-change，也不会把这篇的正文当成
      // 上一篇的未保存修改自动 PATCH 回上一篇的 doc_id（串文档写）。
      host.quill.setContents(
        host.quill.clipboard.convert({
          html: normalizeRichEditorHtml(body || ""),
          text: "",
        }),
        "silent",
      );
      // 撤销栈必须跟着清：seed 发的是 TEXT_CHANGE，history 默认 userOnly:false，
      // 会把「灌进这一篇」和「上一篇的改动」记进同一条撤销记录 —— 实例是跨文档复用的，
      // 不清的话在新文档里按 Ctrl+Z 会把上一篇的段落搬过来。
      host.quill.getModule("history").clear();
      host.settling = false;
      host.paint();
    },
    read() {
      // getSemanticHTML 而不是 root.innerHTML：后者会把 Quill 自绘的列表标记
      // （`<span class="ql-ui">`）连同 data-list 一起存进正文。
      const safe = document.createElement("div");
      safe.append(...sanitizedDocFragment(host.quill.getSemanticHTML()));
      return safe.innerHTML;
    },
    paint() {
      // 不能用无参的 getFormat()：它内部是 getSelection(true) —— 逼一次焦点、没焦点
      // 返回 null，再把 null 当坐标读（实测抛 Cannot read properties of null
      // (reading 'index')）。渲染期正文还没挂进文档，光标本来就不存在。
      const range = host.quill.getSelection();
      const format = range ? host.quill.getFormat(range) : {};
      for (const tool of host.stateTools) {
        const current = format[tool.format];
        let active;
        if (tool.value === undefined) active = Boolean(current);
        else if (tool.value === false) active = !current;
        else
          active = Array.isArray(current)
            ? current.includes(tool.value)
            : current === tool.value;
        tool.node.classList.toggle("active", active);
        tool.node.setAttribute("aria-pressed", String(active));
      }
      const header = String(format.header ?? "");
      host.paragraphSelect.value = [...host.paragraphSelect.options].some(
        (option) => option.value === header,
      )
        ? header
        : "";
      let inTable = false;
      try {
        inTable = Boolean(richEditorCellContext(host.quill));
      } catch {
        inTable = false;
      }
      for (const control of host.tableButtons)
        control.disabled = !host.editable || !inTable;
    },
  };
  const applyFormat = (name, value, line) => {
    const quill = host.quill;
    const range = quill.getSelection(true);
    if (!range) return;
    const current = quill.getFormat(range)[name];
    let next;
    if (name === "indent") {
      const base = Number(current) || 0;
      next = base + (value === "-1" ? -1 : 1);
      if (next < 0) return;
      next = next === 0 ? false : next;
    } else if (value === undefined) {
      next = !current;
    } else {
      // 再点一次取消：靠右 → 点靠左 = 清掉对齐，点两次居中 = 回到默认。
      const wanted = value === "" ? false : value;
      const already = wanted === false ? !current : current === wanted;
      if (already && wanted === false) return;
      next = already ? false : wanted;
    }
    if (line) quill.formatLine(range, name, next, "user");
    // 行内格式走 quill.format()，不走 formatText(range, …)：range 折叠时长度为 0，
    // 而 Delta 的 retain(0, attrs) 直接返回自身（长度 0 根本不入 ops），
    // formatText 于是静默什么都不做 —— 实测「光标停在那儿点加粗、再打字」全无效。
    // quill.format() 内部对折叠光标插一个带格式的 ql-cursor 零宽字符，打出来的字才继承格式。
    else quill.format(name, next, "user");
    // 落笔后立刻重画：quill.format() 改的是光标格式态，不保证再发一次 SELECTION_CHANGE，
    // 不主动画的话按了加粗按钮不会亮，用户只能靠再按一次猜。
    host.paint();
  };
  const openLinkModal = () => {
    if (!host.editable) return;
    const urlInput = input("url", "", "text", {
      required: true,
      maxlength: 2048,
      inputmode: "url",
      autocomplete: "off",
      placeholder: "https://example.com、mailto:name@example.com 或 #章节",
      "aria-label": "链接地址",
    });
    openModal({
      title: "插入链接",
      eyebrow: "RICH TEXT LINK",
      build: () =>
        h(
          "div",
          null,
          field("链接地址", urlInput),
          h("p", {
            class: "help",
            text: "仅支持 http/https、mailto 与页内 # 链接。",
          }),
        ),
      submit: "插入链接",
      onSubmit: async (data) => {
        const url = String(data.get("url") || "").trim();
        if (!/^(?:https?:\/\/|mailto:|#)/iu.test(url))
          throw new Error("链接必须以 http://、https://、mailto: 或 # 开头。");
        // 等弹层关掉再落笔：Quill 的选区是离开正文时存下的快照，
        // 弹层还开着就写会插到光标已经不在了的位置。
        $("#modal").addEventListener(
          "close",
          () => {
            const range = host.quill.getSelection(true);
            if (!range || !host.root.isConnected) return;
            if (range.length) host.quill.formatText(range, "link", url, "user");
            else {
              host.quill.insertText(range.index, url, { link: url }, "user");
              host.quill.setSelection(range.index + url.length, 0, "api");
            }
          },
          { once: true },
        );
      },
    });
  };
  const imagePicker = input("docImage", "", "file", {
    accept: "image/*",
    hidden: true,
    "aria-label": "选择要上传的图片",
    onchange: async (event) => {
      const picker = event.currentTarget;
      const file = picker.files?.[0];
      picker.value = "";
      if (!file) return;
      if (!/^image\//iu.test(file.type)) {
        toast("请选择有效的图片文件。", true);
        return;
      }
      await host.storeImages(file);
    },
  });
  host.lockable.push(imagePicker);
  const textTool = (text, label, tool = {}, onClick) => {
    const item = button(
      text,
      onClick ||
        (() => {
          if (!host.editable) return;
          applyFormat(tool.format, tool.value, tool.line);
        }),
      "small",
      { title: label, "aria-label": label, disabled: !host.editable },
    );
    item.classList.add("rich-editor-tool");
    if (tool.className) item.classList.add(tool.className);
    host.lockable.push(item);
    if (tool.format) {
      item.setAttribute("aria-pressed", "false");
      host.stateTools.push({
        node: item,
        format: tool.format,
        value: tool.value,
      });
    }
    return item;
  };
  const iconTool = (name, label, onClick, tool = {}) => {
    const item = iconButton(name, label, onClick, { disabled: !host.editable });
    item.classList.add("rich-editor-tool");
    host.lockable.push(item);
    // 和 textTool 一样：带 format 的按钮要进 stateTools，paint() 才点得亮它。
    // 加粗是 toggle 语义（applyFormat 里 next = !current），不亮的话按下去没有任何
    // 反馈，用户只能靠再按一次猜（实测折叠光标下点加粗，按钮永远不亮）。
    if (tool.format) {
      item.setAttribute("aria-pressed", "false");
      host.stateTools.push({
        node: item,
        format: tool.format,
        value: tool.value,
      });
    }
    return item;
  };
  const tableTool = (action) => {
    const [text, label] = richEditorTableActions[action];
    const item = button(
      text,
      () => {
        const context = richEditorCellContext(host.quill);
        if (!context) {
          toast("先把光标放到表格里，再用这几个按钮。", true);
          return;
        }
        const { api, tableNode, rowNode } = context;
        const lastOne =
          (action === "table-row-delete" && tableNode.rows.length <= 1) ||
          (action === "table-column-delete" && rowNode.cells.length <= 1);
        if (lastOne) {
          // 旧实现在这里弹「至少保留一行/一列」并让按钮一直禁着：最后一行永远删不掉，
          // 想弃掉表格只能整段手敲删除。这里把「删掉它就是空表格」说破，另外单独给一枚
          // 「删除整个表格」—— 两条路都通，不留死胡同。
          toast(
            action === "table-row-delete"
              ? "这是最后一行，删掉它整张表格就没内容了；要弃掉表格请用「删除整个表格」。"
              : "这是最后一列，删掉它整张表格就没内容了；要弃掉表格请用「删除整个表格」。",
            true,
          );
          return;
        }
        if (action === "table-row-above") api.insertRowAbove();
        else if (action === "table-row-below") api.insertRowBelow();
        else if (action === "table-row-delete") api.deleteRow();
        else if (action === "table-column-left") api.insertColumnLeft();
        else if (action === "table-column-right") api.insertColumnRight();
        else if (action === "table-column-delete") api.deleteColumn();
        else api.deleteTable();
      },
      "small",
      { title: label, "aria-label": label, disabled: true },
    );
    item.classList.add("rich-editor-tool");
    host.tableButtons.push(item);
    return item;
  };
  const insertTable = () => {
    if (!host.editable) return;
    const range = host.quill.getSelection(true);
    if (!range) {
      toast("先把光标放到要插入表格的位置。", true);
      return;
    }
    host.quill.getModule("table").insertTable(3, 3);
  };
  const paragraphSelect = select(
    "docParagraph",
    [
      ["", "正文"],
      ["1", "标题 1"],
      ["2", "标题 2"],
      ["3", "标题 3"],
    ],
    "",
    {
      class: "rich-editor-paragraph-select",
      "aria-label": "段落层级",
      disabled: !host.editable,
      onchange: (event) => {
        const value = event.currentTarget.value;
        applyFormat("header", value === "" ? false : Number(value), true);
      },
    },
  );
  host.paragraphSelect = paragraphSelect;
  host.lockable.push(paragraphSelect);
  host.toolbar = h(
    "div",
    {
      class: "editor-toolbar rich-editor-toolbar",
      role: "toolbar",
      "aria-label": "富文本格式",
      onmousedown: (event) => {
        if (event.target.closest("button")) event.preventDefault();
      },
    },
    h(
      "label",
      { class: "rich-editor-paragraph" },
      icon("heading"),
      paragraphSelect,
    ),
    h("span", { class: "divider" }),
    iconTool("bold", "加粗", () => applyFormat("bold"), { format: "bold" }),
    textTool("I", "斜体", { format: "italic", className: "italic" }),
    textTool("U", "下划线", { format: "underline", className: "underline" }),
    textTool("S", "删除线", { format: "strike", className: "strike" }),
    textTool("码", "行内代码", { format: "code", className: "mono" }),
    h("span", { class: "divider" }),
    textTool("•", "无序列表", { format: "list", value: "bullet", line: true }),
    textTool("1.", "有序列表", {
      format: "list",
      value: "ordered",
      line: true,
    }),
    textTool("引用", "引用", { format: "blockquote", line: true }),
    textTool("代码块", "代码块", { format: "code-block", line: true }),
    h("span", { class: "divider" }),
    textTool("靠左", "左对齐", { format: "align", value: false, line: true }),
    textTool("居中", "居中对齐", {
      format: "align",
      value: "center",
      line: true,
    }),
    textTool("靠右", "右对齐", { format: "align", value: "right", line: true }),
    textTool("两端", "两端对齐", {
      format: "align",
      value: "justify",
      line: true,
    }),
    textTool("←缩进", "减少缩进", {
      format: "indent",
      value: "-1",
      line: true,
    }),
    textTool("缩进→", "增加缩进", {
      format: "indent",
      value: "+1",
      line: true,
    }),
    h("span", { class: "divider" }),
    textTool("链接", "插入链接", {}, () => openLinkModal()),
    iconTool("upload", "上传图片", () => {
      if (!host.editable) return;
      imagePicker.value = "";
      imagePicker.click();
    }),
    imagePicker,
    h("span", { class: "divider" }),
    textTool("表格", "插入 3×3 表格", {}, insertTable),
    h(
      "span",
      {
        class: "rich-editor-table-tools",
        role: "group",
        "aria-label": "当前表格操作",
      },
      ...Object.keys(richEditorTableActions).map(tableTool),
    ),
  );
  // 不传 theme："core" 会当场抛 Invalid theme（full bundle 只注册了 themes/snow 与
  // themes/bubble），默认的 BaseTheme 才合用 —— 它只造正文节点，不往 DOM 里塞自带控件。
  // 也不交 toolbar：Quill 自带工具栏按「设值」语义发指令，且 value="" 的按钮会被它算成
  // false（实测靠左永远压不上居中/靠左），切换语义与点亮状态一律我们自己接。
  const quill = new window.Quill(element, {
    formats: richEditorFormats,
    modules: {
      table: true,
      clipboard: { matchVisual: false },
      history: { delay: 2000 },
      // 走我们的资产接口，不走 Quill 默认的 FileReader → data: URI：后者会被
      // sanitisedDocFragment 的 src 白名单整条抹掉，图片存进去就没了。
      // mimetypes 要写全：默认只收 png/jpeg，截图工具给的 webp 会被静默丢掉。
      uploader: {
        mimetypes: [
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
          "image/bmp",
        ],
        handler(_index, files) {
          void host.storeImages(...files);
        },
      },
    },
  });
  quill.root.classList.add("rich-editor");
  // 无障碍语义跟着 role/aria-label 走，不依赖内容可编辑性：只读时
  // getByRole("textbox", { name: "富文本正文" }) 仍然要能命中。
  quill.root.setAttribute("role", "textbox");
  quill.root.setAttribute("aria-multiline", "true");
  quill.root.setAttribute("aria-label", "富文本正文");
  // 从 Word/网页粘进来的 data: 图片：不进模型（那种 src 存不下来），先落地成资产再插。
  quill.clipboard.addMatcher("IMG", (node, delta) => {
    const src = node.getAttribute("src") || "";
    if (!/^data:image\//iu.test(src)) return delta;
    // 只转用户粘进来的。seed 也走 clipboard.convert，不加这道闸的话：打开一篇存量的
    // 老文档（正文里躺着 data: 图）就当场上传一次、把图插到光标处（内容顺序变了）、
    // 并把这篇标脏自动写一个新版本 —— 用户什么都没做。老实现的 sanitizer 本来就
    // 只放行 /api/v1/assets/ 的 src，那种图一直是丢弃的，这里维持丢弃，不擅自"救图"。
    if (host.settling) return new (window.Quill.import("delta"))();
    const file = richEditorDataUrlToFile(src);
    if (file) {
      const index = quill.getSelection()?.index ?? quill.getLength() - 1;
      void host.storeImages(file, index);
    }
    return new (window.Quill.import("delta"))();
  });
  quill.on("text-change", (_delta, _oldSource, source) => {
    // 灌正文走 silent 到不了这里；到了一定是正文变了。settling 挡的是 Quill 归一化
    // 时补发的那一次（比如 code-block 补 data-language），不是用户改的。
    if (host.settling) return;
    host.notify(source === "user");
  });
  // 表格按钮只在光标落进单元格时可用，格式按钮要跟着选区点亮；
  // SELECTION_CHANGE 时 Quill 已经把 DOM 选区换算成 delta 偏移，比自听 selectionchange 准。
  quill.on("selection-change", () => host.paint());
  host.storeImages = async (...files) => {
    let index = quill.getLength() - 1;
    if (files.length && typeof files[0] === "number") index = files.shift();
    for (const file of files) {
      if (!(file instanceof File)) continue;
      try {
        const url = await richEditorAssetUrl(file);
        if (!host.root.isConnected) return;
        const at = Math.min(index, quill.getLength() - 1);
        quill.insertEmbed(at, "image", url, "user");
        const node = quill.root.querySelector(`img[src="${url}"]`);
        // alt 只能在 insertEmbed 之后补：image 是 embed，Quill 的 value() 不读任何属性，
        // 构造时传对象反而会让 src 整个丢失（实测插出来的 img 连 src 都没有）。
        if (node) node.setAttribute("alt", file.name);
        quill.update("user");
        index = at + 1;
      } catch (error) {
        toast(errorMessage(error), true);
      }
    }
  };
  host.quill = quill;
  host.root = quill.root;
  return host;
}
function documentAssociations(doc) {
  const members = (state.groupMembers.get(doc.group_id) || [])
    .map((seat) => memberById(seat.member_id))
    .filter(Boolean);
  const task = state.backlog.find((item) => item.id === doc.task_id);
  const meetings = state.meetings.filter(
    (meeting) => meeting.summary_doc_id === doc.doc_id,
  );
  const relation = (label, value, action, emptyText) =>
    h(
      "div",
      { class: "document-relation" },
      h("span", { class: "document-relation-label", text: label }),
      value || h("span", { class: "muted small-text", text: emptyText }),
      action || null,
    );
  return h(
    "section",
    {
      class: "card document-associations",
      "aria-label": "文档关联",
    },
    h("h3", { text: "关联成员" }),
    h("p", {
      class: "help",
      text: doc.group_id
        ? "所属群成员，点击直接与老板私聊。"
        : "文档未关联群，暂无可私聊的所属群成员。",
    }),
    members.length
      ? h(
          "div",
          { class: "document-member-list" },
          ...members.map((member) =>
            h(
              "button",
              {
                type: "button",
                class: "document-member-button",
                dataset: { memberId: member.member_id },
                "aria-label": `与老板私聊：${member.name}`,
                onclick: () => startBossPrivate(member.member_id),
              },
              avatar(member, "small"),
              h(
                "span",
                { class: "member-copy" },
                h("strong", { text: member.name }),
                h("small", { text: roleName(member.role_id) }),
              ),
              icon("chat"),
            ),
          ),
        )
      : h("p", { class: "inline-empty", text: "暂无关联成员" }),
    h("h3", { text: "关联对象" }),
    relation(
      "关联群",
      doc.group_id ? groupName(doc.group_id) : null,
      doc.group_id
        ? button("打开群聊", () => selectGroup(doc.group_id), "small")
        : null,
      "暂无关联群",
    ),
    relation(
      "关联任务",
      task?.title || doc.task_id || null,
      doc.task_id
        ? button(
            task ? "打开关联任务" : "在管理视图查看任务",
            () => {
              if (task) {
                state.selectedBacklog = task.id;
                setRoute("backlog", task.id);
              } else location.href = "/";
            },
            "small",
          )
        : null,
      "暂无关联任务",
    ),
    ...meetings.map((meeting) =>
      relation(
        "关联会议",
        meeting.topic,
        button("打开关联会议", () => openMeeting(meeting.meeting_id), "small"),
        null,
      ),
    ),
    !meetings.length ? relation("关联会议", null, null, "暂无关联会议") : null,
  );
}
// 「源码 / 预览 / 分栏」这一组页签由正文形态（sourceMode）决定，不是由 kind 决定：
// markdown 与思维导图共用同一个控件，只是词不同；表格与富文本压根没有「源码」这一说。
const SOURCE_MODES = {
  markdown: { source: "源码", preview: "预览", split: "分栏" },
  mindmap: { source: "大纲", preview: "预览", split: "分栏" },
};
// 形态按文档记（会话内）：写完一段切去核对渲染效果，切回来还在原处，不必每篇重选一遍。
// 用 Map 不用 localStorage —— 这是临时偏好，为它写盘会把「上次停在预览」带进下一篇。
const docModes = new Map();
function renderDocumentEditor(view) {
  const doc = state.documents.find(
    (entry) => entry.doc_id === state.selectedDocument,
  );
  if (!doc) {
    view.append(emptyState("文档不存在", "返回文档中心。", null, "doc"));
    return;
  }
  const editable = doc.my_tier !== "reader";
  const latestSeq = state.versions.length
    ? Math.max(...state.versions.map((version) => version.seq))
    : 1;
  const title = input("docTitle", doc.title, "text", {
    maxlength: 300,
    required: true,
    disabled: !editable,
    "aria-label": "文档标题",
  });
  const status = h("span", { text: `基线版本 ${latestSeq}` });
  // kind-* 类决定正文宿主的滚动归属：富文本宿主自己滚（正文按内容长），
  // markdown/mindmap/sheet 由内部输入面滚（双层滚圈同屏是误操作源头）。见 group.css 的 .editor-surface。
  const watermark = h("div", {
    class: `editor-surface watermark ${doc.watermark_profile} kind-${doc.kind}`,
    dataset: {
      watermark: `${memberName(doc.owner)} · ${fmtDateTime(Date.now())}\n${doc.watermark_profile === "confidential" ? "机密" : "内部"}`,
    },
  });
  let readContent = () => doc.body_text || "";
  let richHost = null;
  let sheetHost = null;
  // 只有「有源码文本」的形态（markdown / 思维导图）才挂这一层：源码面与预览面同在一个
  // 弹性容器里，谁显示由 data-mode 决定（CSS 分派，见 group.css 的 .editor-panes）。
  // 表格与富文本没有「源码」可言，保持原形状。
  const paneHost = h("div", { class: "editor-panes" });
  let panes = null;
  let paneKind = null;
  // 恢复草稿 / 切形态后要重画的东西：markdown 是预览 HTML，思维导图是那棵树。
  let repaintPanes = null;
  const mountPanes = (kind, source, preview) => {
    panes = { source, preview };
    paneKind = kind;
    paneHost.append(source, preview);
    // 装进水位面而不是顶替它：.editor-surface 同时是 queueDraft() 读 data-draftBody
    // 与 restoreDraft() 找 textarea 的那枚节点，顶替等于把草稿存取整条剪断。
    watermark.append(paneHost);
  };
  if (doc.kind === "doc") {
    const editor = richDocEditor(editable, (user) => {
      if (user) dirty = true;
      scheduleAutosave();
    });
    richHost = editor.host;
    if (editor.host.ready) readContent = () => editor.host.read();
    else readContent = () => watermark.dataset.draftBody || doc.body_text || "";
    watermark.append(editor.toolbar, editor.element);
  } else if (doc.kind === "sheet") {
    sheetHost = renderSheetEditor(doc, editable, () => {
      dirty = true;
      scheduleAutosave();
    });
    readContent = sheetHost.readContent;
    watermark.append(sheetHost.element);
  } else if (doc.kind === "mindmap") {
    const outline = textarea("mindmapOutline", doc.body_text || "", {
      class: "mindmap-outline",
      "aria-label": "思维导图大纲",
      disabled: !editable,
    });
    const preview = h("div", { class: "mindmap-preview" });
    const drawTree = () => {
      preview.replaceChildren(...outlineTree(outline.value));
    };
    outline.addEventListener("input", drawTree);
    drawTree();
    readContent = () => outline.value;
    repaintPanes = drawTree;
    mountPanes("mindmap", outline, preview);
    // 旧的「每行一个节点，用两个空格缩进表示层级」提示跟着页签走（见下方 modeBar），
    // 不再单占一条 editor-toolbar —— 编辑面每一行高度都是从正文里借的。
  } else {
    const editor = textarea("markdownBody", doc.body_text || "", {
      class: "markdown-editor",
      "aria-label": "Markdown 正文",
      disabled: !editable,
    });
    const preview = h("div", {
      class: "markdown-preview",
      "aria-live": "polite",
    });
    const paintPreview = () => {
      preview.innerHTML = renderMarkdown(editor.value);
    };
    editor.addEventListener("input", paintPreview);
    paintPreview();
    readContent = () => editor.value;
    repaintPanes = paintPreview;
    mountPanes("markdown", editor, preview);
  }
  watermark.dataset.draftBody = doc.body_text || "";
  let savedBody = doc.body_text || "";
  let savedTitle = doc.title;
  let baseSeq = latestSeq;
  let dirty = false;
  let saving = false;
  let queuedSave = false;
  let conflicted = false;
  let autosaveTimer = null;
  const hasChanges = () =>
    title.value.trim() !== savedTitle || readContent() !== savedBody;
  const isDirty = () => dirty || hasChanges();
  const captureDraft = () => {
    watermark.dataset.draftBody = readContent();
    dirty = hasChanges();
    queueDraft();
    status.textContent = navigator.onLine
      ? "有未保存更改 · 即将自动保存"
      : "离线草稿已缓存 · 联网后自动同步";
    if (!conflicted && !saving && dirty) {
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => void save(true), 900);
    }
  };
  const scheduleAutosave = () => {
    dirty = hasChanges();
    clearTimeout(autosaveTimer);
    if (!conflicted && !saving && dirty && navigator.onLine)
      autosaveTimer = setTimeout(() => void save(true), 900);
  };
  watermark.addEventListener("input", captureDraft);
  watermark.addEventListener("click", () => setTimeout(captureDraft, 0));
  title.addEventListener("input", captureDraft);
  const save = async (auto = false) => {
    if (saving) {
      queuedSave = true;
      return;
    }
    if (!isDirty()) {
      if (!auto) toast("文档没有需要保存的更改");
      return;
    }
    if (auto && !navigator.onLine) {
      queueDraft();
      status.textContent = "离线草稿已缓存 · 联网后自动同步";
      return;
    }
    saving = true;
    clearTimeout(autosaveTimer);
    const submit = $("#saveDocument");
    submit.disabled = true;
    try {
      const bodyText = readContent();
      if (doc.kind === "sheet") JSON.parse(bodyText);
      const nextTitle = title.value.trim();
      const result = await request(
        `/documents/${encodeURIComponent(doc.doc_id)}`,
        {
          method: "PATCH",
          body: {
            title: nextTitle,
            body_text: bodyText,
            base_seq: baseSeq,
          },
        },
      );
      baseSeq += 1;
      savedBody = bodyText;
      savedTitle = nextTitle;
      dirty = false;
      conflicted = false;
      doc.title = nextTitle;
      doc.body_text = bodyText;
      doc.updated_at = result.document?.updated_at ?? Date.now();
      state.documents = state.documents.map((entry) =>
        entry.doc_id === doc.doc_id ? (result.document ?? doc) : entry,
      );
      state.versions = [
        {
          version_id: Date.now(),
          doc_id: doc.doc_id,
          seq: baseSeq,
          author: "boss",
          created_at: doc.updated_at,
        },
        ...state.versions,
      ];
      removeDraft(doc.doc_id);
      state.draft = null;
      watermark.dataset.draftBody = bodyText;
      status.textContent = `已自动保存 · 版本 ${baseSeq}`;
      if (!auto) {
        await openDocument(doc.doc_id);
        toast(`文档已保存为版本 ${baseSeq}`);
      }
    } catch (error) {
      queueDraft();
      if (
        error instanceof ApiError &&
        (error.status === 409 || /冲突|base_seq|版本/u.test(error.message))
      ) {
        conflicted = true;
        status.textContent = "保存冲突：本地草稿已保留，请打开服务器版本后合并";
      } else if (!navigator.onLine) {
        status.textContent = "离线草稿已缓存 · 联网后自动同步";
      } else {
        status.textContent = "自动保存失败 · 本地草稿已保留";
      }
      if (!auto || navigator.onLine) toast(errorMessage(error), true);
    } finally {
      saving = false;
      submit.disabled = false;
      if (queuedSave) {
        queuedSave = false;
        scheduleAutosave();
      }
    }
  };
  activeDocumentSession = {
    docId: doc.doc_id,
    host: richHost,
    sheetHost,
    isDirty,
    changed: scheduleAutosave,
    remoteChanged: () => {
      if (isDirty() || saving) {
        status.textContent = "服务器有新版本 · 本地更改已保留，保存时检测冲突";
        return;
      }
      void openDocument(doc.doc_id);
    },
    flush: () => save(true),
  };
  // 灌正文必须在上面这套闭包（dirty / scheduleAutosave / readContent）齐活之后：
  // 引擎在灌的过程中若发现正文和云端基线不一致，会立刻起一个 900ms 的自动保存，
  // 把「还没渲染完的中间态」当成用户改动写回服务端。
  // 只灌服务端正文：本地草稿仍旧走「恢复本地草稿」按钮，一打开就自动应用草稿会让
  // 页面在用户什么都没做的情况下变脏，进而把草稿静默 PATCH 回服务端。
  if (richHost?.ready) richHost.seed(doc.body_text || "");
  const permissionForm = h(
    "form",
    { onsubmit: setPermission },
    field(
      "授权对象（member_id 或 group:群ID）",
      input("grantee", "", "text", {
        required: true,
        list: "granteeOptions",
        placeholder: "member_id 或 group:group_id",
      }),
    ),
    h(
      "datalist",
      { id: "granteeOptions" },
      ...state.members.map((member) =>
        h("option", { value: member.member_id }),
      ),
      ...state.groups.map((group) =>
        h("option", { value: `group:${group.group_id}` }),
      ),
    ),
    field(
      "权限",
      select(
        "tier",
        [
          ["editor", "可编辑"],
          ["reader", "仅查看"],
        ],
        "reader",
      ),
      { required: true },
    ),
    h("button", { class: "btn small", type: "submit" }, "保存权限"),
  );
  const versions = h(
    "div",
    null,
    ...state.versions.map((version) =>
      h(
        "div",
        { class: "version-item" },
        h("strong", { text: `版本 ${version.seq}` }),
        h("p", {
          text: `${memberName(version.author)} · ${fmtDateTime(version.created_at)}`,
        }),
        button(
          "恢复此版本",
          () => restoreDocument(doc.doc_id, version.seq),
          "small",
        ),
      ),
    ),
    !state.versions.length
      ? h("p", { class: "muted small-text", text: "首次保存后产生版本。" })
      : null,
  );
  // 关联区块进抽屉（round370，用户拍板）：正文只留标题条 + 编辑面。
  // 与上一轮「关联刻意留正文」的翻向理由记在这里，别再被顺手挪回去：
  // 上一版的病是「正文被非正文的东西占掉一半」，而不是「关联不该在抽屉」——
  // 这一版正文铺满之后，上下文放抽屉是可展开的；判据见 group-workbench.spec.ts
  // 用 getByRole("region", {name:"文档关联"}) 取数（抽屉在 #view 之外，见下面的挂载点）。
  const drawerBody = h(
    "div",
    {
      class: "doc-drawer-body",
      id: "docDrawer",
    },
    documentAssociations(doc),
    h(
      "section",
      { class: "card" },
      h("h3", { text: "文档元数据" }),
      field(
        "水印配置",
        select(
          "watermark",
          [
            ["none", "无水印"],
            ["internal", "内部"],
            ["confidential", "机密"],
          ],
          doc.watermark_profile,
          {
            onchange: async (event) => {
              try {
                await request(`/documents/${encodeURIComponent(doc.doc_id)}`, {
                  method: "PATCH",
                  body: { watermark_profile: event.target.value },
                });
                toast("水印配置已更新");
                await openDocument(doc.doc_id);
              } catch (error) {
                toast(errorMessage(error), true);
              }
            },
          },
        ),
      ),
      field(
        "所属群",
        select(
          "docGroup",
          [
            ["", "未分组"],
            ...state.groups.map((group) => [group.group_id, group.title]),
          ],
          doc.group_id || "",
          {
            onchange: async (event) => {
              try {
                await request(`/documents/${encodeURIComponent(doc.doc_id)}`, {
                  method: "PATCH",
                  body: { group_id: event.target.value || null },
                });
                toast("所属群已更新");
                await openDocument(doc.doc_id);
              } catch (error) {
                toast(errorMessage(error), true);
              }
            },
          },
        ),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h3", { text: "版本历史（30 天）" }),
      versions,
    ),
    h(
      "section",
      { class: "card" },
      h("h3", { text: "权限" }),
      ...state.permissions.map((permission) =>
        h(
          "div",
          { class: "permission-item" },
          h("strong", { text: permission.grantee }),
          h("p", { text: labels[permission.tier] }),
          button(
            "移除",
            () => removePermission(doc.doc_id, permission.grantee),
            "small",
          ),
        ),
      ),
      permissionForm,
    ),
  );
  // 抽屉挂在 #mainPane 上而不是 .page 里：.view 是滚动容器，塞在里面就等于抽屉跟着正文
  // 一起滚走 —— 滑到文档中段想改权限，抽屉已经滚出屏幕了。代价是 renderMain 换路由时
  // 要显式拆掉它（那边 replaceChildren 只清 #view，清不到兄弟节点）。
  const drawer = h(
    "div",
    { class: "doc-drawer-wrap closed", id: "docDrawerWrap" },
    h(
      "header",
      { class: "doc-drawer-head" },
      h("h2", { text: "权限与设置" }),
      h(
        "button",
        {
          type: "button",
          class: "icon-button",
          "aria-label": "收起权限面板",
          onclick: () => setDrawer(false),
        },
        icon("close"),
      ),
    ),
    drawerBody,
  );
  const setDrawer = (open) => {
    drawer.classList.toggle("closed", !open);
    // 宽屏上开着抽屉时把正文挤窄，而不是压在上面盖住右边十几个字；窄屏没地方挤，
    // 才退回真正的浮层（CSS 里用同一条类分派）。
    $("#mainPane").classList.toggle("drawer-open", open);
    drawerToggle.setAttribute("aria-expanded", open ? "true" : "false");
  };
  const drawerToggle = button(
    "权限与设置",
    () => setDrawer(drawer.classList.contains("closed")),
    "",
    { "aria-expanded": "false", "aria-controls": "docDrawerWrap" },
  );
  // 形态页签（源码/预览/分栏）：只有 markdown 与思维导图有。放在编辑卡内部的顶部而不是
  // .doc-head —— 它是【正文的】视图开关，不是页面的操作；跟工具条同属一条外壳带。
  let modeBar = null;
  if (panes !== null) {
    const labels = SOURCE_MODES[paneKind];
    const mode = docModes.get(doc.doc_id) ?? "source";
    const setMode = (next) => {
      docModes.set(doc.doc_id, next);
      paneHost.dataset.mode = next;
      for (const [key, node] of modeButtons) {
        const on = key === next;
        node.classList.toggle("active", on);
        node.setAttribute("aria-pressed", String(on));
      }
    };
    const modeButtons = new Map(
      ["source", "preview", "split"].map((key) => [
        key,
        h(
          "button",
          {
            type: "button",
            class: "btn small doc-mode-tab",
            "aria-pressed": "false",
            onclick: () => setMode(key),
          },
          labels[key],
        ),
      ]),
    );
    paneHost.dataset.mode = mode;
    modeBar = h(
      "div",
      {
        class: "editor-toolbar doc-mode-bar",
        role: "group",
        "aria-label": "正文视图",
      },
      ...modeButtons.values(),
      h("span", { class: "spacer" }),
      h("span", {
        class: "muted small-text doc-mode-hint",
        text:
          paneKind === "mindmap"
            ? "每行一个节点，用两个空格缩进表示层级"
            : "支持标题 / 列表 / 表格 / 代码块 / 链接",
      }),
    );
    // aria-pressed 与 class 一起在这里落：modeButtons 造出来时三者都还是初始态，
    // 真正的当前形态要到下面那次 setMode 才知道，所以三态在这里统一落。
    setMode(mode);
  }
  // 本地草稿：一条横幅说完「有什么 + 怎么办」，不再横幅一行 + 按钮行两行。
  // 可关（它是提示不是流程门）。放在 .editor-card 内部顶端 ⇒ 卡片仍是唯一的外壳，
  // 高度收缩由 flex 记账，不额外吃一次 .doc-page 的 gap。
  let draftBar = null;
  if (state.draft) {
    draftBar = h(
      "div",
      {
        class: "banner warning doc-draft-bar",
        role: "status",
        id: "docDraftBar",
      },
      icon("search"),
      h("span", {
        text: "检测到这份文档的本地草稿。云端基线未改变时可恢复。",
      }),
      h(
        "div",
        { class: "actions" },
        button(
          "恢复本地草稿",
          () =>
            restoreDraft(doc, watermark, title, status, () => repaintPanes?.()),
          "",
          { id: "docDraftRestore" },
        ),
        button(
          "丢弃草稿",
          () => {
            removeDraft(doc.doc_id);
            state.draft = null;
            renderMain();
          },
          "",
          { id: "docDraftDiscard" },
        ),
        iconButton("close", "关闭草稿提示", () => draftBar.remove()),
      ),
    );
  }
  const page = h(
    "div",
    { class: "page doc-page" },
    h(
      "header",
      { class: "doc-head" },
      h(
        "div",
        { class: "doc-head-main" },
        h(
          "div",
          { class: "doc-head-line" },
          iconButton(
            "chevron",
            "返回文档中心",
            () => {
              state.selectedDocument = null;
              renderList();
              renderMain();
            },
            { class: "icon-button doc-back" },
          ),
          title,
        ),
        h("p", {
          class: "doc-sub",
          text: `${labels[doc.kind]} · ${memberName(doc.owner)} · 更新于 ${fmtDateTime(doc.updated_at)} · ${doc.watermark_profile === "none" ? "无水印" : doc.watermark_profile === "internal" ? "内部水印" : "机密水印"} · 有效权限：${labels[doc.my_tier] || "所有者"}`,
        }),
      ),
      h(
        "div",
        { class: "actions" },
        // 左栏折叠开关：编辑面要整屏宽度，但列表得留一条回来的路 —— 所以入口在页头，
        // 而不是藏在收起后的那条缝里（收起后栏里没东西可点，见 group.css 的 .list-collapsed）。
        h(
          "button",
          {
            type: "button",
            class: "icon-button doc-list-toggle",
            id: "docListToggle",
            "aria-expanded": state.docListCollapsed ? "false" : "true",
            "aria-controls": "listPane",
            onclick: () => {
              state.docListCollapsed = !state.docListCollapsed;
              writeStoredJson(
                STORAGE_KEYS.docListCollapsed,
                state.docListCollapsed,
              );
              applyDocListCollapse();
            },
          },
          icon("panel"),
        ),
        button("导出", () => exportDocumentModal(doc), ""),
        drawerToggle,
        button("软删除", () => softDeleteDocument(doc), "danger"),
        h(
          "button",
          {
            id: "saveDocument",
            class: "btn primary",
            type: "button",
            disabled: !editable,
            onclick: () => save(),
          },
          "保存新版本",
        ),
      ),
    ),
    h(
      "section",
      { class: "card editor-card" },
      modeBar,
      draftBar,
      // 水印层永远是正文宿主：markdown / 思维导图在它里面再套一层分栏容器
      // （谁是「栏」见 group.css 的 .editor-panes[data-mode]），表格 / 富文本直接装引擎。
      watermark,
      h(
        "div",
        { class: "editor-status" },
        status,
        h("span", { class: "spacer" }),
        h("span", { text: "Ctrl / Cmd + S 保存" }),
      ),
    ),
    // 关联区块已搬进右侧抽屉的 drawerBody（见本函数上文），正文只留标题条 + 编辑面。
  );
  view.append(page);
  $("#mainPane").append(drawer);
}
const SHEET_LIMITS = { sheets: 32, rows: 2000, columns: 256, cells: 100000 };
const sheetRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// 正文形状（hub 的 SheetPayload，packages/hub/src/documents/formats.ts:88）：
//   {sheets:[{name, rows:[[原始值]], styles?:[[样式对象|null]]}]}
// 库形状（vendor/xspreadsheet 1.1.9）：
//   [{name, rows:{len,[ri]:{cells:{ci:{text,style}}}}, cols:{len,[ci]:{width}},
//     styles:[样式对象], merges:[...], freeze:"A1"}]
// 下面这两支转换是两边之间唯一的桥；样式在库里是「指向 styles 数组的下标」，
// 所以去重表必须跟着每次 loadData 新建，不能跨表复用。
const XDS_BORDER_SIDES = ["top", "right", "bottom", "left"];
// 库只画得出 thin/medium/thick/dashed/dotted/double 六种线宽（xspreadsheet.js 的
// border 调色板），其余 hair / mediumDashDotDot… 落回 thin：宁可线宽不准，
// 也不要整条边框消失。
const XDS_BORDER_STYLES = new Set([
  "thin",
  "medium",
  "thick",
  "dashed",
  "dotted",
  "double",
]);
// hub 存的是 Excel numFmt 字符串（formats.ts 原样透传），库只认固定 token。
// 认得出的这几条双向映射；认不出的原样存在 numFmt 键上（库读样式只取自己认识的键，
// 多余键不影响渲染，getData 时又带回来），这样导出 xlsx 仍拿得到原始格式串。
const XDS_FORMAT_BY_NUM_FMT = new Map([
  ["0", "number"],
  ["0.00", "number"],
  ["#,##0", "number"],
  ["#,##0.00", "number"],
  ["0%", "percent"],
  ["0.00%", "percent"],
  ["yyyy/m/d", "date"],
  ["hh:mm:ss", "time"],
  ["yyyy/m/d hh:mm", "datetime"],
]);
const XDS_NUM_FMT_BY_FORMAT = new Map(
  [...XDS_FORMAT_BY_NUM_FMT].map(([numFmt, format]) => [format, numFmt]),
);
const XDS_ALIGN_BY_HORIZONTAL = new Map([
  ["left", "left"],
  ["center", "center"],
  ["right", "right"],
]);
const XDS_VALIGN_BY_VERTICAL = new Map([
  ["top", "top"],
  ["middle", "middle"],
  ["bottom", "bottom"],
]);

// hub 侧颜色是 AARRGGBB 十六进制、不带 #（formats.ts:1169 sheetColor 的尺子）；
// 库直接把字符串交给 canvas，所以要还原成 #RRGGBB。alpha 丢掉：库里没有透明填充。
function hubColorToXds(value) {
  if (typeof value !== "string") return null;
  const hex = value.replace(/^#/u, "").toUpperCase();
  if (/^[0-9A-F]{8}$/u.test(hex)) return `#${hex.slice(2).toLowerCase()}`;
  if (/^[0-9A-F]{6}$/u.test(hex)) return `#${hex.toLowerCase()}`;
  return null;
}
function xdsColorToHub(value) {
  if (typeof value !== "string") return null;
  const hex = value.replace(/^#/u, "").toUpperCase();
  if (/^[0-9A-F]{6}$/u.test(hex)) return `FF${hex}`;
  if (/^[0-9A-F]{8}$/u.test(hex)) return hex;
  return null;
}

function hubStyleToXds(style) {
  if (!sheetRecord(style)) return null;
  const out = {};
  if (style.bold === true) out.font = { bold: true };
  if (style.italic === true) out.font = { ...(out.font || {}), italic: true };
  const color = hubColorToXds(style.color);
  if (color) out.color = color;
  const bgcolor = hubColorToXds(style.fill);
  if (bgcolor) out.bgcolor = bgcolor;
  if (sheetRecord(style.align)) {
    const horizontal = XDS_ALIGN_BY_HORIZONTAL.get(style.align.horizontal);
    if (horizontal) out.align = horizontal;
    const vertical = XDS_VALIGN_BY_VERTICAL.get(style.align.vertical);
    if (vertical) out.valign = vertical;
    if (style.align.wrapText === true) out.textwrap = true;
  }
  if (typeof style.numFmt === "string") {
    const format = XDS_FORMAT_BY_NUM_FMT.get(style.numFmt);
    if (format) out.format = format;
    else out.numFmt = style.numFmt;
  }
  const border = sheetRecord(style.border) ? style.border : null;
  const single = typeof style.border === "string" ? style.border : null;
  for (const side of XDS_BORDER_SIDES) {
    const raw = single ? { style: single } : border?.[side];
    if (!sheetRecord(raw) || typeof raw.style !== "string") continue;
    const width = XDS_BORDER_STYLES.has(raw.style) ? raw.style : "thin";
    out.border = {
      ...(out.border || {}),
      [side]: [width, hubColorToXds(raw.color) || "#000000"],
    };
  }
  return Object.keys(out).length ? out : null;
}

function xdsStyleToHub(style) {
  if (!sheetRecord(style)) return null;
  const out = {};
  if (style.font && style.font.bold === true) out.bold = true;
  if (style.font && style.font.italic === true) out.italic = true;
  const color = xdsColorToHub(style.color);
  if (color) out.color = color;
  const fill = xdsColorToHub(style.bgcolor);
  if (fill) out.fill = fill;
  const align = {};
  const horizontal = XDS_ALIGN_BY_HORIZONTAL.get(style.align);
  if (horizontal) align.horizontal = horizontal;
  const vertical = XDS_VALIGN_BY_VERTICAL.get(style.valign);
  if (vertical) align.vertical = vertical;
  if (style.textwrap === true) align.wrapText = true;
  if (Object.keys(align).length) out.align = align;
  if (typeof style.numFmt === "string") out.numFmt = style.numFmt;
  else if (typeof style.format === "string") {
    const numFmt = XDS_NUM_FMT_BY_FORMAT.get(style.format);
    if (numFmt) out.numFmt = numFmt;
  }
  if (sheetRecord(style.border)) {
    const border = {};
    for (const side of XDS_BORDER_SIDES) {
      const raw = style.border[side];
      if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
      border[side] = {
        style: XDS_BORDER_STYLES.has(raw[0]) ? raw[0] : "thin",
        ...(xdsColorToHub(raw[1]) ? { color: xdsColorToHub(raw[1]) } : {}),
      };
    }
    if (Object.keys(border).length) out.border = border;
  }
  return Object.keys(out).length ? out : null;
}

// 库里格子只有 text；回正文时按字面量还原类型，否则 xlsx 导出把数字存成文本单元格。
// 只升「String(Number(x)) 和原文一模一样」的：00123 / 1.50 / 1e5 / " 5" 这类带信息量的
// 写法必须原样留成字符串，否则产品编号的前导零会被静默吃掉。
function xdsTextToPrimitive(text) {
  if (typeof text !== "string" || text === "") return text ?? "";
  const value = Number(text);
  if (Number.isFinite(value) && String(value) === text) return value;
  return text;
}

function xdsSheetsFromHub(sheets) {
  return sheets.map((sheet) => {
    const styles = [];
    const styleIndex = new Map();
    const addStyle = (style) => {
      const key = JSON.stringify(style);
      const found = styleIndex.get(key);
      if (found !== undefined) return found;
      styles.push(style);
      styleIndex.set(key, styles.length - 1);
      return styles.length - 1;
    };
    const rows = { len: Math.max(100, sheet.rows.length + 1) };
    sheet.rows.forEach((row, rowIndex) => {
      const cells = {};
      row.forEach((value, columnIndex) => {
        const text = value === null ? "" : String(value);
        const style = hubStyleToXds(sheet.styles?.[rowIndex]?.[columnIndex]);
        if (text === "" && !style) return;
        const cell = {};
        if (text !== "") cell.text = text;
        if (style) cell.style = addStyle(style);
        cells[columnIndex] = cell;
      });
      if (Object.keys(cells).length) rows[rowIndex] = { cells };
    });
    const width = sheet.rows.reduce(
      (widest, row) => Math.max(widest, row.length),
      3,
    );
    // cols.len 是「画到第几列」而不是「数据有几列」：照数据宽度给就出现「F 列右边一片
    // 空白」，而 Excel/WPS 的表头是铺满视口的。取库自己的默认 26 当下限。
    return {
      name: sheet.name,
      rows,
      cols: { len: Math.max(26, width) },
      styles,
    };
  });
}

function hubSheetsFromXds(data) {
  const list = Array.isArray(data) ? data : [];
  const sheets = [];
  let totalCells = 0;
  for (const raw of list) {
    if (!sheetRecord(raw)) continue;
    const rowsByKey = sheetRecord(raw.rows) ? raw.rows : {};
    const rowIndexes = Object.keys(rowsByKey)
      .filter((key) => key !== "len")
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= 0);
    let height = 0;
    let width = 0;
    const grid = [];
    for (const rowIndex of rowIndexes) {
      const rowValue = rowsByKey[rowIndex];
      const cells =
        sheetRecord(rowValue) && sheetRecord(rowValue.cells)
          ? rowValue.cells
          : {};
      const out = [];
      for (const key of Object.keys(cells)) {
        const columnIndex = Number(key);
        if (!Number.isInteger(columnIndex) || columnIndex < 0) continue;
        const cell = cells[key];
        if (!sheetRecord(cell)) continue;
        out[columnIndex] = xdsTextToPrimitive(cell.text);
        if (columnIndex + 1 > width) width = columnIndex + 1;
        totalCells += 1;
      }
      grid[rowIndex] = out;
      if (rowIndex + 1 > height) height = rowIndex + 1;
    }
    const styleTable = Array.isArray(raw.styles) ? raw.styles : [];
    const rows = [];
    const styleRows = [];
    let anyStyle = false;
    for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
      const source = grid[rowIndex] || [];
      const row = [];
      const rowStyles = [];
      for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
        row.push(source[columnIndex] ?? "");
        const cell = rowsByKey[rowIndex]?.cells?.[columnIndex];
        const style =
          sheetRecord(cell) && cell.style !== undefined
            ? xdsStyleToHub(styleTable[cell.style])
            : null;
        rowStyles.push(style);
        if (style) anyStyle = true;
      }
      rows.push(row);
      styleRows.push(rowStyles);
    }
    const name =
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : `Sheet${sheets.length + 1}`;
    const sheet = { name, rows };
    // hub 的尺子：styles 不得超过 rows 的行数、每行不得超过对应 rows 的列数
    // （formats.ts:1326 sheetStyles）；全空就不写这个键，省字节。
    if (anyStyle) sheet.styles = styleRows;
    if (rows.length > SHEET_LIMITS.rows)
      throw new Error(`单表最多 ${SHEET_LIMITS.rows} 行。`);
    if (width > SHEET_LIMITS.columns)
      throw new Error(`单表最多 ${SHEET_LIMITS.columns} 列。`);
    sheets.push(sheet);
  }
  if (sheets.length > SHEET_LIMITS.sheets)
    throw new Error(`工作表数量不能超过 ${SHEET_LIMITS.sheets}。`);
  if (totalCells > SHEET_LIMITS.cells)
    throw new Error(`单元格总数不能超过 ${SHEET_LIMITS.cells}。`);
  return sheets;
}

// 认 {sheets:[{name,rows}]}，也认更早的裸二维数组。旧数据里的 sort/filter/conditional
// 直接忽略 —— 换库后没有这三样（用户已确认存量全是测试数据，不做迁移）。
function parseSheet(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("表格正文必须是合法 JSON。");
  }
  const rawSheets = Array.isArray(value)
    ? [{ name: "Sheet1", rows: value }]
    : sheetRecord(value) && Array.isArray(value.sheets) && value.sheets.length
      ? value.sheets
      : null;
  if (!rawSheets) throw new Error("表格正文必须是 {sheets:[{name,rows}]}。");
  if (rawSheets.length > SHEET_LIMITS.sheets)
    throw new Error(`工作表数量不能超过 ${SHEET_LIMITS.sheets}。`);
  let total = 0;
  const names = new Set();
  const sheets = rawSheets.map((raw, index) => {
    if (!sheetRecord(raw) || !Array.isArray(raw.rows))
      throw new Error("每个工作表必须包含 name 与 rows。");
    if (raw.rows.length > SHEET_LIMITS.rows)
      throw new Error(`单表最多 ${SHEET_LIMITS.rows} 行。`);
    const rows = raw.rows.map((row) => {
      if (!Array.isArray(row) || row.length > SHEET_LIMITS.columns)
        throw new Error(
          `每行必须是数组，且不超过 ${SHEET_LIMITS.columns} 列。`,
        );
      total += row.length;
      return row.map((cell) => {
        if (
          cell !== null &&
          typeof cell !== "string" &&
          typeof cell !== "boolean" &&
          !(typeof cell === "number" && Number.isFinite(cell))
        )
          throw new Error("单元格只能是字符串、有限数值、布尔值或 null。");
        if (typeof cell === "string" && cell.includes("\0"))
          throw new Error("单元格不能含 NUL 字符。");
        return cell;
      });
    });
    const name =
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : `Sheet${index + 1}`;
    const key = name.toLowerCase();
    if (names.has(key))
      throw new Error(`工作表名称不能重复（不区分大小写）：${name}。`);
    names.add(key);
    const styleRows = Array.isArray(raw.styles) ? raw.styles : null;
    return { name, rows, ...(styleRows ? { styles: styleRows } : {}) };
  });
  if (total > SHEET_LIMITS.cells)
    throw new Error(`单元格总数不能超过 ${SHEET_LIMITS.cells}。`);
  return sheets;
}

function serializeSheet(sheets) {
  return JSON.stringify({
    sheets: sheets.map(({ name, rows, styles }) => ({
      name,
      rows,
      ...(styles ? { styles } : {}),
    })),
  });
}

function blankSheetRows(height, width) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ""),
  );
}

// 表格编辑器 = vendor/xspreadsheet 本体铺在正文区。返回 {element, notice, readContent, seed}，
// 调用方只管挂载与取正文，不碰库。
function renderSheetEditor(doc, editable, onUserChange) {
  const element = h("div", {
    class: `sheet-editor${editable ? "" : " sheet-readonly"}`,
    role: "region",
    "aria-label": "表格数据",
  });
  const mount = h("div", { class: "sheet-canvas" });
  const notice = h("p", { class: "muted small-text sheet-notice" });
  element.append(mount, notice);

  let lastError = "";
  let sheets = [];
  try {
    sheets = parseSheet(
      doc.body_text || '{"sheets":[{"name":"Sheet1","rows":[[]]}]}',
    );
  } catch (error) {
    lastError = error.message;
    sheets = [{ name: "Sheet1", rows: blankSheetRows(3, 3) }];
  }
  const drawNotice = () => {
    notice.textContent = lastError
      ? `正文不是可识别的表格形状：${lastError}`
      : "";
    notice.hidden = !lastError;
  };

  // 库的默认 view 取 documentElement 尺寸（整屏）。我们的宿主是 flex 格里的一格，
  // 照默认走会溢出屏幕并把滚动条算错，所以必须显式喂容器自己的矩形。
  const view = {
    width: () => mount.getBoundingClientRect().width,
    height: () => mount.getBoundingClientRect().height,
  };
  // 中文不是「传个 locale 键」：库按 V（默认 ["en"]）这个名字表去查消息，
  // locale 文件只是把自己挂进 $messages，不改变查的名字。所以必须显式调一次
  // x_spreadsheet.locale("zh-cn") 把名字推进表头，否则界面全英文（实测）。
  window.x_spreadsheet.locale("zh-cn");
  const spreadsheet = window.x_spreadsheet(mount, {
    // mode:'read' 只挡键盘改格（库里 4 处判定，全在 setCellText/paste/autofill/editor），
    // 工具栏与右键菜单不看它 —— 实测点加粗照样写进数据并被 autosave 存回服务端。
    // 所以只读形态是三层：关工具栏 + 藏底栏的增删入口 + readContent 直接回原文。
    mode: editable ? "edit" : "read",
    view,
    showToolbar: editable,
    showContextmenu: editable,
  });
  spreadsheet.loadData(xdsSheetsFromHub(sheets));
  drawNotice();

  // 宿主在没进 DOM / 折叠态下会被量成 0×0，此时画布按 0 尺寸建好、整块画歪。
  // 库的公开方法里只有 reRender()，而它仅重绘不重算尺寸（真正的重排是内部 Sheet.reload，
  // 库自己挂在 window resize 上）。所以尺寸一恢复就补发一次 resize 事件，走库那条重排路径。
  if (typeof ResizeObserver === "function") {
    let mounted = false;
    const observer = new ResizeObserver(() => {
      if (mounted || mount.getBoundingClientRect().width <= 0) return;
      mounted = true;
      window.dispatchEvent(new Event("resize"));
    });
    observer.observe(mount);
  }

  if (editable) {
    spreadsheet.change(() => {
      if (typeof onUserChange === "function") onUserChange();
    });
  } else {
    // 只读不接 change：库的 mode:'read' 只挡键盘改格，页签双击改名、底栏「+」、
    // 右键删除行列这三条写路径都不看它。接了 change 就等于给只读用户开了 autosave
    // —— 哪怕 readContent 回的是原文，dirty=true 仍会把一次 PATCH 打成新版本。
    // 所以这里按「事件」而不是「样式」把这三条掐掉：dblclick 改名与 contextmenu
    // 在捕获阶段拦下（库的绑定在元素自己身上，捕获先于它），「+」由 CSS 摘掉。
    // 页签单击切表保留 —— 那是只读用户唯一该做的动作。
    for (const type of ["dblclick", "contextmenu"]) {
      element.addEventListener(
        type,
        (event) => {
          event.preventDefault();
          event.stopPropagation();
        },
        true,
      );
    }
  }

  const readContent = () => {
    // 只读是权限边界，不是样式：任何情况下都不回可编辑的正文。
    if (!editable) return doc.body_text || "";
    try {
      const next = hubSheetsFromXds(spreadsheet.getData());
      lastError = "";
      return serializeSheet(next);
    } catch (error) {
      lastError = error.message;
      drawNotice();
      return doc.body_text || "";
    }
  };

  return {
    element,
    notice,
    readContent,
    // 恢复本地草稿 / 回到云端基线时用：重新喂一份正文。loadData 不触发 change，
    // 所以「打开就恢复草稿」不会被记成一次编辑。
    seed(text) {
      try {
        spreadsheet.loadData(xdsSheetsFromHub(parseSheet(text || "[]")));
        lastError = "";
      } catch (error) {
        lastError = error.message;
      }
      drawNotice();
      spreadsheet.reRender();
    },
  };
}
function outlineTree(text) {
  const root = h("ul", { class: "tree-root" });
  const stack = [{ indent: -1, list: root }];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const label = line.trim();
    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    const list = stack.at(-1).list;
    const item = h(
      "li",
      { class: "tree-node" },
      h("span", { class: "tree-label", text: label }),
    );
    list.append(item);
    const children = h("ul", { class: "tree-children" });
    item.append(children);
    stack.push({ indent, list: children });
  }
  return [root];
}
function sanitizedDocFragment(html) {
  const parsed = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    "text/html",
  );
  const allowed = new Set([
    "P",
    "BR",
    "DIV",
    "SPAN",
    "B",
    "STRONG",
    "I",
    "EM",
    "U",
    "S",
    "STRIKE",
    "DEL",
    "H1",
    "H2",
    "H3",
    "H4",
    "UL",
    "OL",
    "LI",
    "BLOCKQUOTE",
    "PRE",
    "CODE",
    "A",
    "IMG",
    "TABLE",
    "THEAD",
    "TBODY",
    "TR",
    "TH",
    "TD",
    "HR",
  ]);
  const attrs = new Set([
    "href",
    "title",
    "colspan",
    "rowspan",
    "src",
    "alt",
    // class 已在上面按值筛过，这里放行才不会把刚留下的排版类又抹掉。
    "class",
  ]);
  // class 必须按值收口，不能整属性放行：正文是 HTML 片段，放开 class 等于让文档作者
  // 往工作台里注入任意样式（覆盖 .topbar/.rail 之类外壳，或造出看不见的层）。
  // 只放行编辑器排版真正用到的那几个前缀，其余一律剥掉。
  const classPattern =
    /^ql-(?:align|indent|code-block|blockquote|list|ui)(?:-[a-z0-9-]+)?$/u;
  const clean = (node) => {
    for (const child of [...node.children]) {
      clean(child);
      if (!allowed.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      if (child.hasAttribute("class")) {
        const kept = child
          .getAttribute("class")
          .split(/\s+/u)
          .filter((name) => classPattern.test(name));
        if (kept.length) child.setAttribute("class", kept.join(" "));
        else child.removeAttribute("class");
      }
      for (const attr of [...child.attributes])
        if (
          !attrs.has(attr.name) ||
          (attr.name === "href" &&
            (child.tagName !== "A" ||
              !/^(?:https?:\/\/|mailto:|#)/iu.test(attr.value))) ||
          (attr.name === "src" &&
            (child.tagName !== "IMG" ||
              !/^\/api\/v1\/assets\/[A-Za-z0-9_-]+$/u.test(attr.value))) ||
          (attr.name === "alt" && child.tagName !== "IMG") ||
          ((attr.name === "colspan" || attr.name === "rowspan") &&
            child.tagName !== "TD" &&
            child.tagName !== "TH")
        )
          child.removeAttribute(attr.name);
      if (child.tagName === "IMG" && !child.hasAttribute("src")) child.remove();
      if (child.tagName === "A") {
        child.setAttribute("rel", "noreferrer noopener");
        child.setAttribute("target", "_blank");
      }
    }
  };
  clean(parsed.body);
  return [...parsed.body.childNodes];
}
function readDraft(id) {
  try {
    const raw = localStorage.getItem(`opc:doc-draft:${id}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function removeDraft(id) {
  try {
    localStorage.removeItem(`opc:doc-draft:${id}`);
  } catch {
    /* storage is optional */
  }
}
function restoreDraft(doc, watermark, title, status, paint) {
  const session =
    activeDocumentSession?.docId === doc.doc_id ? activeDocumentSession : null;
  const richHost = doc.kind === "doc" ? session?.host : null;
  if (doc.kind === "doc" && !richHost?.ready) {
    toast("富文本引擎未就绪，暂时无法恢复草稿。刷新页面后重试。", true);
    return;
  }
  const sheetHost = doc.kind === "sheet" ? session?.sheetHost : null;
  title.value = state.draft.title || title.value;
  const body = richHost || sheetHost ? null : $("textarea", watermark);
  if (richHost) richHost.seed(state.draft.body_text || "");
  else if (sheetHost) sheetHost.seed(state.draft.body_text || "");
  else if (body) body.value = state.draft.body_text || "";
  watermark.dataset.draftBody = state.draft.body_text || "";
  // 分栏形态下只灌 textarea 不够：右侧那一栏此刻还写着旧正文，屏幕会同时说两件矛盾的事。
  // 赋值不触发 input，所以由调用方把「重画这一形态看得见的东西」交进来，一次画全。
  // 这里曾经另有一条 if (doc.kind === "mindmap") dispatchEvent("input")：它比 paint 早一步
  // 到，做的是同一件事（outline 的 input 监听就是 drawTree），于是思维导图那一次重画
  // 跑了两遍、而 markdown 只跑一遍 —— 两条线只剩一条，剪它 doc-preview 那发思维导图用例即红。
  if (paint) paint(body);
  status.textContent = "已恢复本地草稿，保存后生成新版本";
  if (session) session.changed();
  toast("本地草稿已恢复");
}
async function restoreDocument(id, seq) {
  openModal({
    title: `恢复版本 ${seq}`,
    eyebrow: "VERSION RESTORE",
    build: () =>
      h("p", {
        text: "恢复会以该版本正文创建一个新版本，当前内容不会被历史版本直接覆盖。",
      }),
    submit: "确认恢复",
    onSubmit: async () => {
      await request(
        `/documents/${encodeURIComponent(id)}/versions/${seq}/restore`,
        { method: "POST", body: {} },
      );
      await openDocument(id);
      toast("版本已恢复");
    },
  });
}
async function setPermission(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    await request(
      `/documents/${encodeURIComponent(state.selectedDocument)}/permissions`,
      {
        method: "POST",
        body: { grantee: data.get("grantee"), tier: data.get("tier") },
      },
    );
    toast("权限已保存");
    await openDocument(state.selectedDocument);
  } catch (error) {
    toast(errorMessage(error), true);
  }
}
async function removePermission(id, grantee) {
  try {
    await request(
      `/documents/${encodeURIComponent(id)}/permissions/${encodeURIComponent(grantee)}`,
      { method: "DELETE" },
    );
    toast("权限已移除");
    await openDocument(id);
  } catch (error) {
    toast(errorMessage(error), true);
  }
}
async function softDeleteDocument(doc) {
  openModal({
    title: "软删除文档",
    eyebrow: doc.title,
    build: () =>
      h("p", {
        text: "文档将从列表与详情中隐藏，版本和审计仍保留。此操作不提供客户端撤销入口。",
      }),
    submit: "确认删除",
    danger: true,
    onSubmit: async () => {
      await request(`/documents/${encodeURIComponent(doc.doc_id)}`, {
        method: "DELETE",
      });
      state.selectedDocument = null;
      await loadAuxiliary();
      renderList();
      renderMain();
      toast("文档已软删除");
    },
  });
}
function exportDocumentModal(doc) {
  openModal({
    title: "导出文档",
    eyebrow: doc.title,
    build: () =>
      h(
        "div",
        null,
        field(
          "格式",
          select(
            "format",
            [
              ["md", "Markdown（.md）"],
              ["docx", "Word（.docx）"],
              ["xlsx", "Excel（.xlsx）"],
              ["pdf", "PDF（.pdf）"],
            ],
            "md",
          ),
        ),
        h("p", {
          class: "help",
          text: "Hub 会根据文档形态校验格式；导出文件通过同源二进制响应下载。",
        }),
      ),
    submit: "下载",
    onSubmit: async (data) => {
      await downloadDocument(doc, data.get("format"));
    },
  });
}
async function downloadDocument(doc, format) {
  const blob = await request(
    `/documents/${encodeURIComponent(doc.doc_id)}/export?format=${encodeURIComponent(format)}`,
    { binary: true },
  );
  const url = URL.createObjectURL(blob);
  const link = h("a", {
    href: url,
    download: `${doc.title.replace(/[\\/:*?"<>|]/gu, "_")}.${format}`,
  });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("导出文件已下载");
}
async function uploadAssetBase64(file, purpose) {
  if (file.size > 20 * 1024 * 1024) throw new Error("文件超过 20 MB 上限。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return request("/assets", {
    method: "POST",
    body: {
      purpose,
      mime: file.type || "application/octet-stream",
      data_base64: btoa(binary),
    },
  });
}
// 头像上传走的是真 POST /assets（purpose 固定 avatar）：选完文件 asset_id 就落到
// 同表单的隐藏域里，保存按钮仍是唯一一次绑定写入 —— 上传与绑定各自只发生一次。
function avatarImagePicker() {
  const picker = input("avatar_image", "", "file", {
    accept: "image/*",
    hidden: true,
    "aria-label": "选择头像图片",
    onchange: async (event) => {
      const node = event.currentTarget;
      const file = node.files?.[0];
      node.value = "";
      if (!file) return;
      if (!/^image\//u.test(file.type)) {
        toast("请选择图片文件。", true);
        return;
      }
      try {
        const asset = await uploadAssetBase64(file, "avatar");
        const assetId = asset?.asset?.asset_id || asset?.asset_id;
        if (typeof assetId !== "string" || !assetId)
          throw new Error("头像上传响应缺少 asset_id。");
        const form = node.closest("form");
        const slot = form?.querySelector('input[name="avatar_asset_id"]');
        if (!slot) throw new Error("头像资产落点缺失，上传结果没有登记。");
        slot.value = assetId;
        const seed = form.querySelector('input[name="avatar_seed"]');
        if (seed) seed.value = "";
        toast("头像图片已上传，点保存按钮生效。");
      } catch (error) {
        toast(errorMessage(error), true);
      }
    },
  });
  return h(
    "span",
    null,
    button("上传图片作为头像", () => picker.click()),
    picker,
  );
}
async function importDocument() {
  const picker = input("importFile", "", "file", {
    accept: ".docx,.xlsx,.md,.markdown,.txt",
    required: true,
    "aria-label": "选择导入文件",
  });
  openModal({
    title: "导入文档",
    eyebrow: "ASSET → DOCUMENT",
    build: () =>
      h(
        "div",
        null,
        picker,
        field("文档标题（可选）", input("title")),
        field(
          "所属群（可选）",
          select("group_id", [
            ["", "不分组"],
            ...state.groups.map((group) => [group.group_id, group.title]),
          ]),
        ),
        h("p", {
          class: "help",
          text: "文件先以 base64 上传到 assets，再由 Hub 解析并登记为文档。最大 20 MB。",
        }),
      ),
    submit: "上传并导入",
    onSubmit: async (data) => {
      const file = $("#modalBody input[type=file]").files[0];
      if (!file) throw new Error("请选择要导入的文件。");
      const asset = await uploadAssetBase64(file, "import-source");
      await request("/documents/import", {
        method: "POST",
        body: {
          asset_id: asset.asset?.asset_id || asset.asset_id,
          ...(data.get("title") ? { title: data.get("title") } : {}),
          ...(data.get("group_id") ? { group_id: data.get("group_id") } : {}),
        },
      });
      await loadAuxiliary();
      renderList();
      renderMain();
      toast("文档已导入");
    },
  });
}

function renderContacts(view) {
  const member = state.selectedMember ? memberById(state.selectedMember) : null;
  const group = state.selectedGroup
    ? state.groups.find((entry) => entry.group_id === state.selectedGroup)
    : null;
  const roleTree = buildRoleTree();
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader("通讯录", "从角色汇报线到项目群成员，快速找到每个人。", [
        button("私聊成员（老板）", () => openBossPrivateModal(), "primary"),
      ]),
      h(
        "div",
        { class: "people-layout" },
        h(
          "section",
          { class: "card" },
          h("h3", { text: "组织架构" }),
          roleTree.length
            ? roleTree
            : emptyState("暂无角色", "Hub 返回了空组织架构。", null, "admin"),
        ),
        member
          ? memberDetail(member)
          : group
            ? groupDetail(group)
            : emptyState(
                "选择一位成员",
                "从左侧组织树或群组选择成员，查看岗位、技能、执行器与所属项目。",
                button("查看设置", () => {
                  const first = state.members[0];
                  if (first) setRoute("settings", first.member_id);
                }),
                "talent",
              ),
      ),
    ),
  );
}
function buildRoleTree() {
  const byParent = new Map();
  for (const role of state.roles) {
    if (!role.reports_to) continue;
    if (!byParent.has(role.reports_to)) byParent.set(role.reports_to, []);
    byParent.get(role.reports_to).push(role);
  }
  const nodes = (parent) =>
    (byParent.get(parent) || []).map((role) => {
      const members = state.members.filter(
        (member) => member.role_id === role.role_id,
      );
      return h(
        "details",
        { class: "org-group", open: members.length > 0 },
        h("summary", { text: `${role.name} · ${members.length} 人` }),
        h(
          "div",
          { class: "org-members" },
          ...members.map((member) => memberRow(member)),
          ...nodes(role.role_id),
        ),
      );
    });
  const knownRoles = new Set(state.roles.map((role) => role.role_id));
  const roots = state.roles.filter(
    (role) => role.reports_to === null || !knownRoles.has(role.reports_to),
  );
  return roots.flatMap((role) => nodes(role.role_id));
}
function memberRow(member) {
  return h(
    "button",
    {
      type: "button",
      class: `member-row${state.selectedMember === member.member_id ? " selected" : ""}`,
      onclick: () => selectMember(member.member_id),
    },
    avatar(member, "small"),
    h(
      "span",
      { class: "member-copy" },
      h("strong", { text: member.name }),
      h("small", {
        text: `${roleName(member.role_id)} · ${labels[member.status]}`,
      }),
    ),
  );
}
async function selectMember(id) {
  state.selectedMember = id;
  state.selectedGroup = null;
  renderList();
  renderMain();
}
async function selectGroup(id) {
  state.selectedGroup = id;
  state.selectedMember = null;
  // 先画选中态再发请求：成员详情没缓存时这一发要一个来回，此前这一格点击后
  // 什么都不变 —— 「点了没反应」和「按钮坏了」在屏幕上长得一样。
  renderList();
  try {
    const response = await request(`/groups/${encodeURIComponent(id)}`);
    state.groupMembers.set(id, response.members || []);
    const conversation = state.conversations.find(
      (entry) => entry.group_id === id,
    );
    state.groups = state.groups.map((group) =>
      group.group_id === id ? response.group : group,
    );
    if (conversation) openConversation(conversation.conversation_id);
    else {
      renderList();
      renderMain();
    }
  } catch (error) {
    toast(errorMessage(error), true);
  }
}
function memberDetail(member) {
  const groups = state.groups.filter((group) =>
    state.groupMembers
      .get(group.group_id)
      ?.some((seat) => seat.member_id === member.member_id),
  );
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "detail-hero" },
      avatar(member, "large"),
      h(
        "div",
        null,
        h("h2", { text: member.name }),
        h("p", {
          text: `${roleName(member.role_id)} · ${labels[member.model_tier]} · ${labels[member.status]}`,
        }),
      ),
      h(
        "div",
        { class: "actions" },
        button(
          "与老板私聊",
          () => startBossPrivate(member.member_id),
          "primary",
        ),
        button("编辑档案", () => setRoute("settings", member.member_id)),
      ),
    ),
    h(
      "dl",
      { class: "detail-list" },
      h("dt", { text: "口头禅 / 风格" }),
      h("dd", { text: member.persona.style }),
      h("dt", { text: "价值观" }),
      h("dd", { text: member.persona.values.join("、") || "—" }),
      h("dt", { text: "诚实边界" }),
      h("dd", { text: member.persona.honesty }),
      h("dt", { text: "语气" }),
      h("dd", { text: labels[member.tone] }),
      h("dt", { text: "语音" }),
      h("dd", {
        text: member.voice
          ? `${member.voice.lang} · 语速 ${member.voice.rate} · 音高 ${member.voice.pitch}`
          : "未配置",
      }),
    ),
    h("h3", { text: "技能" }),
    h(
      "div",
      { class: "actions" },
      ...member.skills.map((skill) => pill(skill.name, "blue")),
    ),
    h("h3", { text: "执行器" }),
    ...member.executors.map((executor) =>
      h(
        "div",
        { class: "executor-row" },
        pill(`#${executor.seq}`),
        h("strong", { text: executor.kind }),
        h("span", {
          class: "muted small-text",
          text: JSON.stringify(executor.config),
        }),
      ),
    ),
    h("h3", { text: "所属群" }),
    h(
      "div",
      { class: "actions" },
      ...groups.map((group) =>
        button(group.title, () => selectGroup(group.group_id), "small"),
      ),
    ),
  );
}
function groupDetail(group) {
  const members = (state.groupMembers.get(group.group_id) || [])
    .map((seat) => memberById(seat.member_id))
    .filter(Boolean);
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "detail-hero" },
      h("span", { class: "kind-icon large" }, icon("users")),
      h(
        "div",
        null,
        h("h2", { text: group.title }),
        h("p", {
          text: `${group.member_count} 位成员 · ${labels[group.status] || group.status}`,
        }),
      ),
    ),
    h("h3", { text: "目标" }),
    h("p", { text: group.goal || "暂无目标" }),
    h("h3", { text: "成员" }),
    ...members.map((member) => memberRow(member)),
    button(
      "进入群聊",
      () => {
        const conversation = state.conversations.find(
          (entry) => entry.group_id === group.group_id,
        );
        if (conversation) openConversation(conversation.conversation_id);
      },
      "primary",
    ),
  );
}

function renderTalent(view) {
  if (state.talentTab === "hire") {
    view.append(hireForm());
    return;
  }
  const selected = state.talents.find(
    (item) => item.item_id === state.selectedTalent,
  );
  const cards = state.talents.map((item) =>
    h(
      "button",
      {
        type: "button",
        class: `talent-card${state.selectedTalent === item.item_id ? " selected" : ""}`,
        onclick: () => {
          state.selectedTalent = item.item_id;
          renderList();
          renderMain();
        },
      },
      avatar(item.payload, "large"),
      h("h3", { text: item.name }),
      h("p", { text: roleName(item.payload.role_id) }),
      h(
        "div",
        { class: "actions" },
        pill(item.source, item.source === "builtin" ? "blue" : "green"),
        pill(labels[item.payload.model_tier]),
      ),
      h("p", { text: item.payload.persona.style }),
    ),
  );
  let detail = null;
  if (selected) {
    const executorLines = selected.payload.executors.map((executor) =>
      h("p", {
        class: "mono small-text",
        text: `#${executor.seq} ${executor.kind} ${JSON.stringify(executor.config)}`,
      }),
    );
    detail = h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "detail-hero" },
        avatar(selected.payload, "large"),
        h(
          "div",
          null,
          h("h2", { text: selected.name }),
          h("p", {
            text: `${roleName(selected.payload.role_id)} · 发布于 ${fmtDateTime(selected.published_at)}`,
          }),
        ),
        h(
          "div",
          { class: "actions" },
          button("导出蓝图", () => exportTalent(selected), ""),
          ...(selected.source === "builtin"
            ? []
            : [button("下架蓝图", () => unlistTalent(selected), "danger")]),
          button(
            "以此蓝图招聘",
            () => {
              state.talentTab = "hire";
              state.hireSeed = selected.payload;
              renderList();
              renderMain();
            },
            "primary",
          ),
        ),
      ),
      h("p", { text: selected.payload.persona.style }),
      h("p", {
        class: "muted",
        text: `诚实边界：${selected.payload.persona.honesty}`,
      }),
      h("h3", { text: "技能" }),
      h(
        "div",
        { class: "actions" },
        ...selected.payload.skills.map((skill) => pill(skill.name, "blue")),
      ),
      h("h3", { text: "执行器" }),
      ...executorLines,
    );
  }
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader("人才市场", "人才蓝图可导出、导入与招聘；入职仍走完整校验。", [
        button("导入蓝图", () => importTalentModal()),
        button("发布在职成员", () => publishMemberModal()),
        button(
          "开始招聘",
          () => {
            state.talentTab = "hire";
            renderList();
            renderMain();
          },
          "primary",
        ),
      ]),
      banner(
        "内置模板随应用提供；成员发布与导入的蓝图来源分别标记为 published、imported。",
        "info",
      ),
      h("div", { class: "talent-grid" }, ...cards),
      detail,
    ),
  );
}
function hireForm() {
  const seed = state.hireSeed || {};
  const skills = h("div", { id: "hireSkills" });
  const addSkill = (skill = {}) => {
    const row = h(
      "div",
      { class: "skill-row" },
      input("skill_id", skill.skill_id || "", "text", {
        placeholder: "技能 ID",
        required: true,
      }),
      input("skill_name", skill.name || "", "text", {
        placeholder: "技能名称",
        required: true,
      }),
      iconButton("close", "删除技能", () => row.remove()),
    );
    skills.append(row);
  };
  (seed.skills?.length ? seed.skills : [{ skill_id: "", name: "" }]).forEach(
    addSkill,
  );
  const executorList = h("div", { id: "hireExecutors" });
  const addExecutor = (
    executor = {
      seq: executorList.children.length + 1,
      kind: "pure-model",
      config: { kind: "pure-model" },
    },
  ) => {
    const kind = select("executor_kind", executors, executor.kind);
    const config = input(
      "executor_config",
      JSON.stringify(executor.config || { kind: executor.kind }, null, 2),
      "text",
      {
        placeholder:
          executor.kind === "builtin-plugin"
            ? '{"kind":"builtin-plugin","plugin_id":"p","tool_name":"t"}'
            : '{"kind":"pure-model"}',
        required: true,
      },
    );
    kind.addEventListener("change", () => {
      config.value = JSON.stringify(
        kind.value === "builtin-plugin"
          ? { kind: kind.value, plugin_id: "", tool_name: "" }
          : { kind: kind.value },
        null,
        2,
      );
      config.placeholder =
        kind.value === "builtin-plugin"
          ? '{"kind":"builtin-plugin","plugin_id":"p","tool_name":"t"}'
          : '{"kind":"pure-model"}';
    });
    const row = h(
      "div",
      { class: "executor-row" },
      input("executor_seq", executor.seq, "number", {
        min: 1,
        max: 99,
        required: true,
      }),
      kind,
      config,
      iconButton("close", "删除执行器", () => row.remove()),
    );
    executorList.append(row);
  };
  (seed.executors?.length
    ? seed.executors
    : [{ seq: 1, kind: "pure-model", config: { kind: "pure-model" } }]
  ).forEach(addExecutor);
  const form = h(
    "form",
    { onsubmit: hireMember },
    h(
      "div",
      { class: "field-grid" },
      field(
        "姓名",
        input("name", seed.name || "", "text", {
          required: true,
          maxlength: 100,
        }),
      ),
      field(
        "岗位",
        select(
          "role_id",
          state.roles.map((role) => [role.role_id, role.name]),
          seed.role_id || state.roles[0]?.role_id || "",
          { required: true },
        ),
      ),
      field(
        "模型档位",
        select(
          "model_tier",
          [
            ["management", "管理档"],
            ["execution", "执行档"],
          ],
          seed.model_tier || "execution",
        ),
      ),
      field(
        "语气",
        select(
          "tone",
          Object.entries(labels).filter(([key]) =>
            ["neutral", "steady", "direct", "warm", "precise"].includes(key),
          ),
          seed.tone || "neutral",
        ),
      ),
      field(
        "头像生成种子",
        input("avatar_seed", seed.avatar_seed || "", "text", {
          maxlength: 200,
          placeholder: "姓名或视觉主题",
        }),
      ),
      field(
        "头像",
        h(
          "span",
          null,
          input("avatar_asset_id", "", "text", { hidden: true }),
          avatarImagePicker(),
        ),
        "选图即上传为 avatar 资产；不选图就按下面的种子生成。",
      ),
      field(
        "风格 / 口头禅",
        input("persona_style", seed.persona?.style || "", "text", {
          required: true,
          maxlength: 500,
        }),
      ),
      field(
        "诚实边界",
        input("persona_honesty", seed.persona?.honesty || "", "text", {
          required: true,
          maxlength: 500,
        }),
      ),
      field(
        "价值观（逗号分隔）",
        input(
          "persona_values",
          seed.persona?.values?.join("，") || "",
          "text",
          { maxlength: 1000 },
        ),
      ),
      field(
        "语音语言",
        input("voice_lang", seed.voice?.lang || "zh-CN", "text"),
      ),
      field(
        "语速（0.5–2）",
        input("voice_rate", seed.voice?.rate || 1, "number", {
          min: 0.5,
          max: 2,
          step: 0.1,
        }),
      ),
      field(
        "音高（0–2）",
        input("voice_pitch", seed.voice?.pitch || 1, "number", {
          min: 0,
          max: 2,
          step: 0.1,
        }),
      ),
      field(
        "期望音色（可选）",
        input("voice_hint", seed.voice?.voice_hint || "", "text"),
      ),
    ),
    h(
      "section",
      { class: "card" },
      h("h3", { text: "技能" }),
      skills,
      button("添加技能", () => addSkill(), "small"),
    ),
    h(
      "section",
      { class: "card" },
      h("h3", { text: "执行器（按 seq 优先）" }),
      executorList,
      h("p", {
        class: "help",
        text: '配置必须是带 kind 的 JSON。CLI 可填 model；webhook 填 plugin_id/tool_name；builtin-plugin 填 plugin_id，tool_name 可选但推荐（留空请删除该字段；省略时选字典序第一个已授权工具），示例 {"kind":"builtin-plugin","plugin_id":"p","tool_name":"t"}；human 可填 assignee_hint。',
      }),
      button("添加执行器", () => addExecutor(), "small"),
    ),
    h(
      "section",
      { class: "card" },
      h("h3", { text: "入职后落座" }),
      ...state.groups.map((group) =>
        h(
          "label",
          { class: "check-row" },
          h("input", {
            type: "checkbox",
            name: "seat_group_ids",
            value: group.group_id,
          }),
          group.title,
        ),
      ),
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn primary", type: "submit" }, "完成招聘并入职"),
      button("返回市场", () => {
        state.talentTab = "market";
        state.hireSeed = null;
        renderList();
        renderMain();
      }),
    ),
  );
  return h(
    "div",
    { class: "page" },
    pageHeader("招聘新成员", "人设、技能、执行器、模型与头像一次配置。", [
      button("返回市场", () => {
        state.talentTab = "market";
        renderList();
        renderMain();
      }),
    ]),
    form,
  );
}
async function hireMember(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const submit = $("button[type=submit]", event.currentTarget);
  submit.disabled = true;
  try {
    const skills = $$(".skill-row", $("#hireSkills"))
      .map((row) => ({
        skill_id: $("[name=skill_id]", row).value.trim(),
        name: $("[name=skill_name]", row).value.trim(),
      }))
      .filter((skill) => skill.skill_id && skill.name);
    const executorRows = $$(".executor-row", $("#hireExecutors"));
    const memberExecutors = executorRows.map((row) => {
      const kind = $("[name=executor_kind]", row).value;
      let config;
      try {
        config = JSON.parse($("[name=executor_config]", row).value);
      } catch {
        throw new Error("执行器配置不是合法 JSON。");
      }
      return {
        seq: Number($("[name=executor_seq]", row).value),
        kind,
        config,
        enabled: true,
      };
    });
    if (!memberExecutors.length) throw new Error("至少配置一个执行器。");
    const avatarAsset = data.get("avatar_asset_id").trim();
    const avatarSeed = data.get("avatar_seed").trim();
    if (avatarAsset && avatarSeed)
      throw new Error("头像资产与生成种子只能二选一。");
    await request("/members", {
      method: "POST",
      body: {
        name: data.get("name"),
        role_id: data.get("role_id"),
        model_tier: data.get("model_tier"),
        tone: data.get("tone"),
        persona: {
          style: data.get("persona_style"),
          honesty: data.get("persona_honesty"),
          values: data
            .get("persona_values")
            .split(/[,，]/)
            .map((value) => value.trim())
            .filter(Boolean),
        },
        skills,
        executors: memberExecutors,
        voice: {
          lang: data.get("voice_lang"),
          rate: Number(data.get("voice_rate")),
          pitch: Number(data.get("voice_pitch")),
          voice_hint: data.get("voice_hint").trim() || undefined,
        },
        ...(avatarAsset
          ? { avatar_asset_id: avatarAsset }
          : avatarSeed
            ? { avatar_seed: avatarSeed }
            : {}),
        seat_group_ids: data.getAll("seat_group_ids"),
      },
    });
    state.talentTab = "market";
    state.hireSeed = null;
    await Promise.all([loadCore(), loadAuxiliary()]);
    renderList();
    renderMain();
    toast("成员已招聘并入职");
  } catch (error) {
    toast(errorMessage(error), true);
    submit.disabled = false;
  }
}
async function exportTalent(item) {
  const result = await request(
    `/talent/${encodeURIComponent(item.item_id)}/export`,
  );
  const blob = new Blob([JSON.stringify(result.payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = h("a", {
    href: url,
    download: `talent-${item.name.replace(/[\\/:*?"<>|]/gu, "_")}.json`,
  });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function importTalentModal() {
  const picker = input("talentFile", "", "file", {
    accept: ".json,application/json",
    required: true,
  });
  openModal({
    title: "导入人才蓝图",
    eyebrow: "TALENT MARKET",
    build: () =>
      h(
        "div",
        null,
        picker,
        h("p", {
          class: "help",
          text: "导入只挂牌，不会直接创建成员；岗位 ID 必须在当前组织存在。",
        }),
      ),
    submit: "导入市场",
    onSubmit: async () => {
      const file = $("#modalBody input[type=file]").files[0];
      if (!file) throw new Error("请选择蓝图 JSON 文件。");
      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        throw new Error("文件不是合法 JSON。");
      }
      if (payload.payload) payload = payload.payload;
      await request("/talent/import", { method: "POST", body: { payload } });
      await loadAuxiliary();
      renderList();
      renderMain();
      toast("人才蓝图已导入市场");
    },
  });
}
async function publishMemberModal() {
  const active = state.members.filter((member) => member.status === "active");
  if (!active.length) return toast("没有可发布的在职成员", true);
  openModal({
    title: "发布在职成员",
    eyebrow: "MEMBER BLUEPRINT",
    build: () =>
      h(
        "div",
        null,
        field(
          "选择成员",
          select(
            "member_id",
            active.map((member) => [
              member.member_id,
              `${member.name} · ${roleName(member.role_id)}`,
            ]),
            active[0].member_id,
          ),
          { required: true },
        ),
        banner(
          "发布会从成员当前档案生成快照并刷新同名条目，不会改动成员本身；重复发布会覆盖该成员先前的挂牌快照。",
          "info",
        ),
      ),
    submit: "发布到市场",
    onSubmit: async (data) => {
      const member = memberById(data.get("member_id"));
      const result = await request(
        `/talent/${encodeURIComponent(member.member_id)}/publish`,
        { method: "POST" },
      );
      state.selectedTalent = result.item.item_id;
      state.talentTab = "market";
      await loadAuxiliary();
      renderList();
      renderMain();
      toast("成员蓝图已发布（published）");
    },
  });
}
async function unlistTalent(item) {
  openModal({
    title: "下架人才蓝图",
    eyebrow: "TALENT MARKET",
    build: () =>
      h(
        "div",
        null,
        h("p", {
          text: `确认下架「${item.name}」？已按此蓝图招聘的成员不会受影响。`,
        }),
        banner("内置模板不可下架；下架后可从成员档案重新发布。", "warning"),
      ),
    submit: "确认下架",
    danger: true,
    onSubmit: async () => {
      await request(`/talent/${encodeURIComponent(item.item_id)}/unlist`, {
        method: "POST",
      });
      state.selectedTalent = null;
      await loadAuxiliary();
      renderList();
      renderMain();
      toast("人才蓝图已下架");
    },
  });
}

const seatLabels = { cos: "特助席", member: "普通席" };
const categoryLabels = {
  executive: "管理",
  product: "产品",
  engineering: "工程",
  design: "设计",
  support: "支持",
};
const pluginKindLabels = { mcp: "MCP 服务", builtin: "内置模块" };
const groupStatusLabels = { active: "活跃", archived: "已归档" };

function sectionHome({
  title,
  subtitle,
  emptyTitle,
  emptyDescription,
  emptyAction = null,
  section,
  extra = [],
}) {
  return h(
    "div",
    { class: "page" },
    pageHeader(title, subtitle, extra),
    emptyState(emptyTitle, emptyDescription, emptyAction, "settings"),
    h(
      "div",
      { class: "actions" },
      ...SETTINGS_SECTIONS.filter((s) => s.id !== section).map((s) =>
        button(`${s.label}设置`, () => setRoute("settings", s.id)),
      ),
    ),
  );
}

function renderSettingsHome(view) {
  const section = state.settingsSection;
  if (section === "groups") {
    view.append(
      sectionHome({
        title: "群组设置",
        subtitle: "改名与目标、调整成员席位、归档或恢复群组。",
        emptyTitle: "选择要配置的群组",
        emptyDescription: "从左侧群组列表选择，或在通讯录里打开群聊。",
        section: "groups",
        extra: [button("新建群", () => openCreateModal("group"), "primary")],
      }),
    );
    return;
  }
  if (section === "roles") {
    view.append(
      sectionHome({
        title: "岗位设置",
        subtitle: "维护公司树：新建岗位、调整汇报线与模型档位、删除空缺岗位。",
        emptyTitle: "选择要配置的岗位",
        emptyDescription: "从左侧岗位列表选择一项开始编辑。",
        section: "roles",
        extra: [button("新建岗位", () => openRoleModal(null), "primary")],
      }),
    );
    return;
  }
  if (section === "plugins") {
    view.append(
      sectionHome({
        title: "插件设置",
        subtitle: "登记 MCP 服务与内置模块，探活并管理启停。",
        emptyTitle: "选择要配置的插件",
        emptyDescription: "执行器引用插件提供的工具，先在左侧列表登记能力源。",
        section: "plugins",
        extra: [button("安装插件", () => openPluginModal(null), "primary")],
      }),
    );
    return;
  }
  view.append(
    sectionHome({
      title: "设置",
      subtitle: "管理成员的人设、模型、语气、语音与头像。",
      emptyTitle: "选择要配置的成员",
      emptyDescription: "从左侧成员列表选择，或通过通讯录进入成员档案。",
      emptyAction: state.members[0]
        ? button(
            "配置第一位成员",
            () => setRoute("settings", state.members[0].member_id),
            "primary",
          )
        : null,
      section: "member",
      extra: [
        button(
          "招聘成员",
          () => {
            state.talentTab = "hire";
            setRoute("talent");
          },
          "primary",
        ),
      ],
    }),
  );
}

function settingsEntry(label, hint, active, onClick, trailing = null) {
  return h(
    "button",
    {
      type: "button",
      class: `member-row${active ? " selected" : ""}`,
      onClick,
    },
    h(
      "span",
      { class: "member-copy" },
      h("strong", { text: label }),
      hint === null ? null : h("small", { text: hint }),
    ),
    trailing,
  );
}

function renderSettingsList(content, toolbar) {
  const section = state.settingsSection;
  toolbar.append(
    h(
      "div",
      { class: "tabs" },
      ...SETTINGS_SECTIONS.map((s) =>
        h(
          "button",
          {
            type: "button",
            class: `tab${section === s.id ? " active" : ""}`,
            title: s.hint,
            onClick: () => setRoute("settings", s.id),
          },
          s.label,
        ),
      ),
    ),
  );
  if (section === "member") {
    renderMemberList(content, toolbar);
    return;
  }
  if (section === "groups") {
    for (const group of state.groups)
      content.append(
        settingsEntry(
          group.title,
          `${group.member_count} 位成员 · ${groupStatusLabels[group.status]}`,
          state.settingsGroup === group.group_id,
          () => openSettingsItem("groups", group.group_id),
          pill(
            groupStatusLabels[group.status],
            group.status === "active" ? "green" : "",
          ),
        ),
      );
    if (!state.groups.length)
      content.append(
        emptyState("暂无群组", "在顶栏点击“创建 → 新建群”。", null, "users"),
      );
    return;
  }
  if (section === "roles") {
    for (const role of state.roles)
      content.append(
        settingsEntry(
          role.name,
          `${categoryLabels[role.category]} · ${role.kind === "builtin" ? "内置" : "自定义"} · ${role.occupant_count} 人在任`,
          state.settingsRole === role.role_id,
          () => openSettingsItem("roles", role.role_id),
        ),
      );
    return;
  }
  for (const plugin of state.plugins)
    content.append(
      settingsEntry(
        plugin.name,
        `${pluginKindLabels[plugin.kind]} · ${plugin.tools.length} 个工具`,
        state.settingsPlugin === plugin.plugin_id,
        () => openSettingsItem("plugins", plugin.plugin_id),
        pill(
          plugin.enabled ? "启用" : "停用",
          plugin.enabled ? "green" : "red",
        ),
      ),
    );
  if (!state.plugins.length)
    content.append(
      emptyState(
        "暂无插件",
        "执行器引用插件提供的工具，先在这里登记能力源。",
        null,
        "settings",
      ),
    );
}

/** 每个分区把「当前条目 id」存在 state 的哪一格。 */
const SETTINGS_ITEM_KEYS = {
  member: "settingsMember",
  groups: "settingsGroup",
  roles: "settingsRole",
  plugins: "settingsPlugin",
};
/** hash 的 id 段落在哪个分区：按 id 找群/岗位/插件，都找不到才当成员 id。 */
function resolveSettingsSection(id) {
  if (state.groups.some((g) => g.group_id === id)) return "groups";
  if (state.roles.some((r) => r.role_id === id)) return "roles";
  if (state.plugins.some((p) => p.plugin_id === id)) return "plugins";
  return "member";
}

/**
 * 打开设置里的一个条目。state.route 已经是 settings（点行只在设置页内发生），
 * 所以这里只改状态 + 让 hash 跟上屏幕：setRoute 会按分区名/条目 id 重写地址。
 */
function openSettingsItem(section, id) {
  state[SETTINGS_ITEM_KEYS[section]] = id;
  setRoute("settings", id);
}

function renderSettingsSectionHome(view, section) {
  state.settingsSection = section;
  renderSettingsHome(view);
}

function renderGroupSettings(view) {
  const group = state.groups.find((g) => g.group_id === state.settingsGroup);
  if (!group) {
    renderSettingsSectionHome(view, "groups");
    return;
  }
  const groupId = group.group_id;
  const seats = state.groupMembers.get(groupId) || [];
  const seatForm = h(
    "form",
    { class: "field-grid", onsubmit: (event) => addGroupSeat(event, groupId) },
    field(
      "成员",
      select(
        "member_id",
        state.members
          .filter(
            (m) =>
              m.status === "active" &&
              !seats.some((seat) => seat.member_id === m.member_id),
          )
          .map((m) => [m.member_id, `${m.name} · ${roleName(m.role_id)}`]),
      ),
    ),
    field(
      "任职岗位（留空 = 默认岗位）",
      select(
        "role_id",
        [["", "默认岗位"], ...state.roles.map((r) => [r.role_id, r.name])],
        "",
      ),
      "显式选岗即兼任：同一成员在不同群可以坐不同岗位。",
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn", type: "submit" }, "拉人进群"),
    ),
  );
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader(group.title, `群组设置 · ${groupId}`, [
        button("回到群组总览", () => setRoute("settings", "groups")),
        button("编辑资料", () => openGroupModal(group), "primary"),
      ]),
      h(
        "div",
        { class: "settings-layout" },
        h(
          "aside",
          { class: "settings-menu" },
          button("基本信息", () => scrollToSection("group-basic")),
          button("席位", () => scrollToSection("group-seats")),
        ),
        h(
          "div",
          { class: "settings-sections" },
          h(
            "section",
            { class: "card", id: "group-basic" },
            h("h3", { text: "基本信息" }),
            h("p", {
              text: group.goal || "暂无群目标。",
            }),
            h("p", {
              class: "help",
              text: `状态：${groupStatusLabels[group.status]} · 特助 ${
                group.cos_member_id ? memberName(group.cos_member_id) : "未就位"
              }`,
            }),
          ),
          h(
            "section",
            { class: "card", id: "group-seats" },
            h("h3", { text: `席位（${seats.length}）` }),
            ...seats.map((seat) =>
              h(
                "div",
                { class: "setting-line" },
                h(
                  "span",
                  { class: "setting-copy" },
                  h("strong", { text: memberName(seat.member_id) }),
                  h("small", {
                    text: `${roleName(seat.role_id)} · ${seatLabels[seat.seat]}`,
                  }),
                ),
                button(
                  "移出群",
                  () => removeGroupMember(groupId, seat),
                  "danger",
                ),
              ),
            ),
            seatForm,
          ),
          h(
            "section",
            { class: "card", id: "group-danger" },
            h("h3", { text: "危险操作" }),
            h("p", {
              class: "help",
              text:
                group.status === "active"
                  ? "归档后群组只读：不再接收新消息，成员席位保留，可随时恢复。"
                  : "这个群已归档，恢复后重新可写。",
            }),
            h(
              "div",
              { class: "actions" },
              button(
                group.status === "active" ? "归档群组" : "恢复群组",
                () => setGroupStatus(group),
                "danger",
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderRoleSettings(view) {
  const role = state.roles.find((r) => r.role_id === state.settingsRole);
  if (!role) {
    renderSettingsSectionHome(view, "roles");
    return;
  }
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader(role.name, `岗位设置 · ${role.role_id}`, [
        button("回到岗位总览", () => setRoute("settings", "roles")),
        button("编辑岗位", () => openRoleModal(role), "primary"),
      ]),
      h(
        "div",
        { class: "settings-layout" },
        h(
          "div",
          { class: "settings-sections" },
          h(
            "section",
            { class: "card" },
            h("h3", { text: "基本信息" }),
            h("p", {
              text: `${categoryLabels[role.category]} · ${role.kind === "builtin" ? "内置岗位（不可删除）" : "自定义岗位"} · ${role.occupant_count} 人在任`,
            }),
            h("p", {
              class: "help",
              text: `汇报线：${role.reports_to ? roleName(role.reports_to) : "无（根节点）"} · 模型档位 ${role.model_tier}`,
            }),
          ),
          h(
            "section",
            { class: "card" },
            h("h3", { text: "危险操作" }),
            h("p", {
              class: "help",
              text:
                role.kind === "builtin"
                  ? "内置岗位随系统迁移而来，不可删除。"
                  : role.occupant_count > 0
                    ? `还有 ${role.occupant_count} 人在任，需先为在任成员改岗。`
                    : "这个岗位当前无人在任，可以删除。",
            }),
            role.kind === "builtin" || role.occupant_count > 0
              ? null
              : h(
                  "div",
                  { class: "actions" },
                  button("删除岗位", () => deleteRole(role), "danger"),
                ),
          ),
        ),
      ),
    ),
  );
}

function renderPluginSettings(view) {
  const plugin = state.plugins.find(
    (p) => p.plugin_id === state.settingsPlugin,
  );
  if (!plugin) {
    renderSettingsSectionHome(view, "plugins");
    return;
  }
  const probe = plugin.last_probe_json;
  const probeText =
    probe === null
      ? "从未探测"
      : probe["ok"] === true
        ? `上次探测成功（${fmtDateTime(probe["probed_at"])}）`
        : `上次探测失败（${fmtDateTime(probe["probed_at"])}）：${probe["message"] || "无回执信息"}`;
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader(plugin.name, `插件设置 · ${plugin.plugin_id}`, [
        button("回到插件总览", () => setRoute("settings", "plugins")),
        button("探活", () => probePlugin(plugin)),
        button("编辑配置", () => openPluginModal(plugin), "primary"),
      ]),
      h(
        "div",
        { class: "settings-layout" },
        h(
          "aside",
          { class: "settings-menu" },
          button("基本信息", () => scrollToSection("plugin-basic")),
          button("工具清单", () => scrollToSection("plugin-tools")),
        ),
        h(
          "div",
          { class: "settings-sections" },
          h(
            "section",
            { class: "card", id: "plugin-basic" },
            h("h3", { text: "基本信息" }),
            h("p", {
              text: `${pluginKindLabels[plugin.kind]} · ${plugin.enabled ? "已启用" : "已停用"}`,
            }),
            plugin.endpoint === null
              ? null
              : h("p", { class: "mono small-text", text: plugin.endpoint }),
            h("p", { class: "help", text: probeText }),
            h(
              "div",
              { class: "actions" },
              button(
                plugin.enabled ? "停用插件" : "启用插件",
                () => togglePlugin(plugin),
                plugin.enabled ? "danger" : "",
              ),
            ),
          ),
          h(
            "section",
            { class: "card", id: "plugin-tools" },
            h("h3", { text: `工具（${plugin.tools.length}）` }),
            plugin.tools.length
              ? h(
                  "div",
                  null,
                  ...plugin.tools.map((tool) =>
                    h(
                      "div",
                      { class: "setting-line" },
                      h(
                        "span",
                        { class: "setting-copy" },
                        h("strong", { class: "mono", text: tool.tool_name }),
                        h("small", { text: tool.description || "无描述" }),
                      ),
                    ),
                  ),
                )
              : h("p", {
                  class: "help",
                  text: "工具清单在探活成功后才会落表；先点探活拉取一次。",
                }),
          ),
          h(
            "section",
            { class: "card" },
            h("h3", { text: "危险操作" }),
            h("p", {
              class: "help",
              text: "删除只撤销登记：引用它工具的插件执行器会在下一次执行时报插件缺失。",
            }),
            h(
              "div",
              { class: "actions" },
              button("删除插件", () => deletePlugin(plugin), "danger"),
            ),
          ),
        ),
      ),
    ),
  );
}

function parseJsonObject(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label}不是合法 JSON。`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${label}必须是一个 JSON 对象。`);
  return parsed;
}

function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

function openGroupModal(group) {
  openModal({
    title: "编辑群组",
    eyebrow: "GROUP SETTINGS",
    build: () =>
      formGrid(
        field(
          "群名称",
          input("title", group.title, "text", {
            required: true,
            maxlength: 200,
          }),
        ),
        fullField("群目标", textarea("goal", group.goal, { maxlength: 4000 })),
      ),
    submit: "保存群组",
    onSubmit: async (data) => {
      await request(`/groups/${encodeURIComponent(group.group_id)}`, {
        method: "PATCH",
        body: { title: data.get("title"), goal: data.get("goal") },
      });
      await loadCore();
      renderList();
      renderMain();
      toast("群组已保存");
    },
  });
}

function setGroupStatus(group) {
  const archiving = group.status === "active";
  openModal({
    title: archiving ? "归档群组" : "恢复群组",
    eyebrow: "GROUP STATUS",
    danger: archiving,
    build: () =>
      h("p", {
        text: archiving
          ? `「${group.title}」归档后只读：不再接收新消息，成员席位保留，可随时恢复。`
          : `「${group.title}」恢复为活跃后重新可写。`,
      }),
    submit: archiving ? "确认归档" : "确认恢复",
    onSubmit: async () => {
      await request(`/groups/${encodeURIComponent(group.group_id)}`, {
        method: "PATCH",
        body: { status: archiving ? "archived" : "active" },
      });
      await loadCore();
      renderList();
      renderMain();
      toast(archiving ? "群组已归档" : "群组已恢复");
    },
  });
}

async function addGroupSeat(event, groupId) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const memberId = data.get("member_id");
  if (!memberId) {
    toast("没有可拉入的在职成员。", true);
    return;
  }
  const roleId = data.get("role_id");
  try {
    await request(`/groups/${encodeURIComponent(groupId)}/members`, {
      method: "POST",
      body: {
        member_id: memberId,
        ...(roleId === "" ? {} : { role_id: roleId }),
      },
    });
    await loadCore();
    renderList();
    renderMain();
    toast("成员已入座");
  } catch (error) {
    toast(errorMessage(error), true);
  }
}

function removeGroupMember(groupId, seat) {
  openModal({
    title: "移出群组",
    eyebrow: "REMOVE SEAT",
    danger: true,
    build: () =>
      h("p", {
        text: `把「${memberName(seat.member_id)}」（${roleName(seat.role_id)} · ${seatLabels[seat.seat]}）移出本群。成员档案不受影响。`,
      }),
    submit: "确认移出",
    onSubmit: async () => {
      await request(
        `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(seat.member_id)}`,
        { method: "DELETE" },
      );
      await loadCore();
      renderList();
      renderMain();
      toast("已移出群组");
    },
  });
}

function openRoleModal(role) {
  const editing = role !== null;
  const reports = state.roles.filter(
    (r) => !editing || r.role_id !== role.role_id,
  );
  openModal({
    title: editing ? "编辑岗位" : "新建岗位",
    eyebrow: "ROLE SETTINGS",
    build: () =>
      h(
        "div",
        null,
        formGrid(
          editing
            ? field(
                "岗位标识",
                input("role_id", role.role_id, "text", { disabled: true }),
              )
            : field(
                "岗位标识",
                input("role_id", "", "text", {
                  required: true,
                  maxlength: 200,
                  pattern: "^[a-z][a-z0-9_]*$",
                }),
                "小写字母开头的蛇形标识，创建后不可改。",
              ),
          field(
            "岗位名称",
            input("name", editing ? role.name : "", "text", {
              required: true,
              maxlength: 100,
            }),
          ),
          field(
            "类别",
            select(
              "category",
              Object.entries(categoryLabels).map(([value, text]) => [
                value,
                text,
              ]),
              editing ? role.category : "engineering",
            ),
          ),
          field(
            "汇报线",
            select(
              "reports_to",
              [
                ["boss", `${roleName("boss")}（老板直属）`],
                ...reports.map((r) => [r.role_id, r.name]),
              ],
              editing ? role.reports_to || "boss" : "boss",
            ),
            "不能挂到自己或自己的下级，服务端会拒环。",
          ),
          field(
            "模型档位",
            select(
              "model_tier",
              [
                ["management", "管理档"],
                ["execution", "执行档"],
              ],
              editing ? role.model_tier : "execution",
            ),
          ),
          field(
            "头像种子",
            input(
              "avatar_seed",
              editing ? role.avatar_seed || "" : "",
              "text",
              { maxlength: 200 },
            ),
          ),
        ),
      ),
    submit: editing ? "保存岗位" : "创建岗位",
    onSubmit: async (data) => {
      const payload = {
        name: data.get("name"),
        category: data.get("category"),
        reports_to: data.get("reports_to"),
        model_tier: data.get("model_tier"),
      };
      const seed = data.get("avatar_seed").trim();
      if (seed !== "") payload.avatar_seed = seed;
      if (editing) {
        await request(`/roles/${encodeURIComponent(role.role_id)}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        await request("/roles", {
          method: "POST",
          body: { role_id: data.get("role_id"), ...payload },
        });
      }
      await loadCore();
      renderList();
      renderMain();
      toast(editing ? "岗位已保存" : "岗位已创建");
    },
  });
}

function deleteRole(role) {
  openModal({
    title: "删除岗位",
    eyebrow: "DELETE ROLE",
    danger: true,
    build: () =>
      h("p", {
        text: `「${role.name}」当前无人在任。删除后该岗位从公司树移除。`,
      }),
    submit: "确认删除",
    onSubmit: async () => {
      await request(`/roles/${encodeURIComponent(role.role_id)}`, {
        method: "DELETE",
      });
      state.settingsRole = null;
      await loadCore();
      renderList();
      renderMain();
      toast("岗位已删除");
    },
  });
}

function openPluginModal(plugin) {
  const editing = plugin !== null;
  // 视图契约（pluginView）不回传 config 列：编辑时若摆一个空的 config 编辑器，
  // 保存就等于把原配置覆盖成 {}。所以编辑只改名称/端点/启停，配置随安装写入。
  const endpointInput = input(
    "endpoint",
    editing ? plugin.endpoint || "" : "",
    "text",
    {
      required: true,
      maxlength: 2000,
    },
  );
  const endpointField = fullField(
    "服务端点",
    endpointInput,
    "MCP 服务的 HTTP(S) 端点。",
  );
  // display:none 不豁免原生校验：藏起来的 required 控件照样在 submit 事件
  // 触发前把表单拦死（Chromium 连 invalid 气泡都不往隐形格子上画）。
  // 所以哪一格跟着类型收起，就必须连里面的控件一起 disable。
  const builtinInput = input("plugin_id", "", "text", {
    required: true,
    maxlength: 200,
  });
  const builtinField = fullField(
    "内置插件标识",
    builtinInput,
    "必须是服务端已注册过的代码模块 id；内置行只是对它的授权登记。",
  );
  builtinField.hidden = true;
  builtinInput.disabled = true;
  const kindSelect = editing
    ? null
    : select(
        "kind",
        [
          ["mcp", pluginKindLabels.mcp],
          ["builtin", pluginKindLabels.builtin],
        ],
        "mcp",
        {
          onchange: (event) => {
            const kind = event.target.value;
            endpointField.hidden = kind !== "mcp";
            endpointInput.disabled = kind !== "mcp";
            builtinField.hidden = kind !== "builtin";
            builtinInput.disabled = kind !== "builtin";
          },
        },
      );
  openModal({
    title: editing ? "编辑插件" : "安装插件",
    eyebrow: "PLUGIN SETTINGS",
    build: () =>
      h(
        "div",
        null,
        formGrid(
          kindSelect,
          field(
            "展示名",
            input("name", editing ? plugin.name : "", "text", {
              required: true,
              maxlength: 200,
            }),
          ),
          editing
            ? field(
                "启用",
                select(
                  "enabled",
                  [
                    ["1", "启用"],
                    ["0", "停用"],
                  ],
                  plugin.enabled ? "1" : "0",
                ),
              )
            : null,
          editing && plugin.kind !== "mcp" ? null : endpointField,
          editing ? null : builtinField,
        ),
        editing
          ? null
          : fullField(
              "配置（JSON）",
              textarea("config", "{}", { required: true }),
              "随插件登记保存的键值配置，安装后不可在这里改写。",
            ),
      ),
    submit: editing ? "保存插件" : "安装插件",
    onSubmit: async (data) => {
      if (editing) {
        const body = {
          name: data.get("name"),
          enabled: data.get("enabled") === "1",
        };
        if (plugin.kind === "mcp") body.endpoint = data.get("endpoint");
        await request(`/plugins/${encodeURIComponent(plugin.plugin_id)}`, {
          method: "PATCH",
          body,
        });
      } else if (data.get("kind") === "builtin") {
        await request("/plugins", {
          method: "POST",
          body: {
            kind: "builtin",
            plugin_id: data.get("plugin_id"),
            name: data.get("name"),
            config: parseJsonObject(data.get("config"), "配置"),
          },
        });
      } else {
        await request("/plugins", {
          method: "POST",
          body: {
            kind: "mcp",
            name: data.get("name"),
            endpoint: data.get("endpoint"),
            config: parseJsonObject(data.get("config"), "配置"),
          },
        });
      }
      await loadCore();
      renderList();
      renderMain();
      toast(editing ? "插件已保存" : "插件已安装");
    },
  });
}

function togglePlugin(plugin) {
  request(`/plugins/${encodeURIComponent(plugin.plugin_id)}`, {
    method: "PATCH",
    body: { enabled: !plugin.enabled },
  })
    .then(async () => {
      await loadCore();
      renderList();
      renderMain();
      toast(plugin.enabled ? "插件已停用" : "插件已启用");
    })
    .catch((error) => toast(errorMessage(error), true));
}

function deletePlugin(plugin) {
  openModal({
    title: "删除插件",
    eyebrow: "DELETE PLUGIN",
    danger: true,
    build: () =>
      h("p", {
        text: `「${plugin.name}」提供 ${plugin.tools.length} 个工具。删除后引用这些工具的插件执行器会在下一次执行时报插件缺失。`,
      }),
    submit: "确认删除",
    onSubmit: async () => {
      await request(`/plugins/${encodeURIComponent(plugin.plugin_id)}`, {
        method: "DELETE",
      });
      state.settingsPlugin = null;
      await loadCore();
      renderList();
      renderMain();
      toast("插件已删除");
    },
  });
}

async function probePlugin(plugin) {
  try {
    const result = await request(
      `/plugins/${encodeURIComponent(plugin.plugin_id)}/probe`,
      { method: "POST" },
    );
    await loadCore();
    renderList();
    renderMain();
    // 外层 result.ok 只代表「探测已记账」：连不上也落 last_probe_json 并记审计，
    // 成败本身在 result.probe 里。拿外层当判据会把失败播报成成功。
    const probe = result.probe;
    toast(
      probe?.ok
        ? `探活成功，拉到 ${probe.tools.length} 个工具`
        : `探活失败：${probe?.message ?? "未知原因"}`,
      !probe?.ok,
    );
  } catch (error) {
    toast(errorMessage(error), true);
  }
}

function renderSettings(view) {
  const member = memberById(state.settingsMember);
  if (!member) {
    renderSettingsHome(view);
    return;
  }
  const form = h(
    "form",
    { onsubmit: updateMember },
    h(
      "div",
      { class: "field-grid" },
      field(
        "姓名",
        input("name", member.name, "text", { required: true, maxlength: 100 }),
      ),
      field(
        "岗位",
        select(
          "role_id",
          state.roles.map((role) => [role.role_id, role.name]),
          member.role_id,
        ),
      ),
      field(
        "模型档位",
        select(
          "model_tier",
          [
            ["management", "管理档"],
            ["execution", "执行档"],
          ],
          member.model_tier,
        ),
      ),
      field(
        "语气",
        select(
          "tone",
          [
            ["neutral", "中性"],
            ["steady", "沉稳"],
            ["direct", "直接"],
            ["warm", "温和"],
            ["precise", "严谨"],
          ],
          member.tone,
        ),
      ),
      field(
        "风格 / 口头禅",
        input("persona_style", member.persona.style, "text", {
          required: true,
          maxlength: 500,
        }),
      ),
      field(
        "诚实边界",
        input("persona_honesty", member.persona.honesty, "text", {
          required: true,
          maxlength: 500,
        }),
      ),
      field(
        "价值观（逗号分隔）",
        input("persona_values", member.persona.values.join("，"), "text"),
      ),
      field(
        "语音语言",
        input("voice_lang", member.voice?.lang || "zh-CN", "text"),
      ),
      field(
        "语速",
        input("voice_rate", member.voice?.rate || 1, "number", {
          min: 0.5,
          max: 2,
          step: 0.1,
        }),
      ),
      field(
        "音高",
        input("voice_pitch", member.voice?.pitch || 1, "number", {
          min: 0,
          max: 2,
          step: 0.1,
        }),
      ),
      field(
        "音色提示",
        input("voice_hint", member.voice?.voice_hint || "", "text"),
      ),
      field(
        "状态",
        select(
          "status",
          [
            ["active", "在职"],
            ["archived", "归档"],
          ],
          member.status,
        ),
      ),
    ),
    h(
      "div",
      { class: "actions" },
      h("button", { class: "btn primary", type: "submit" }, "保存成员档案"),
    ),
  );
  const skillsEditor = h(
    "form",
    { onsubmit: updateSkills },
    ...member.skills.map((skill) =>
      h(
        "div",
        { class: "skill-row" },
        input("skill_id", skill.skill_id, "text", { required: true }),
        input("skill_name", skill.name, "text", { required: true }),
        input("skill_note", skill.note || "", "text", {
          placeholder: "备注（可选）",
          "aria-label": "技能备注",
          maxlength: 2000,
        }),
      ),
    ),
    h("button", { class: "btn small", type: "submit" }, "保存技能列表"),
  );
  const executorsEditor = h(
    "form",
    { onsubmit: updateExecutors },
    ...member.executors.map((executor) =>
      h(
        "div",
        { class: "executor-row" },
        input("executor_seq", executor.seq, "number", {
          min: 1,
          max: 99,
          required: true,
        }),
        h("span", { class: "pill blue", text: executor.kind }),
        h(
          "label",
          { class: "check-row" },
          h("input", {
            type: "checkbox",
            name: "executor_enabled",
            ...(executor.enabled ? { checked: true } : {}),
          }),
          "启用",
        ),
        textarea("executor_config", JSON.stringify(executor.config, null, 2), {
          required: true,
        }),
      ),
    ),
    h("button", { class: "btn small", type: "submit" }, "保存执行器列表"),
    h("p", {
      class: "help",
      text: "保留 JSON 直接编辑。builtin-plugin 的 tool_name 可选但推荐；省略时执行字典序第一个已授权工具。",
    }),
  );
  const avatarForm = h(
    "form",
    { onsubmit: updateAvatar },
    h(
      "div",
      { class: "detail-hero" },
      avatar(member, "large"),
      h(
        "div",
        { class: "grow" },
        field(
          "头像生成种子",
          input("avatar_seed", member.avatar_seed, "text", { maxlength: 200 }),
        ),
        h("p", {
          class: "help",
          text: "保存种子会替换当前头像；上传图片即传为 avatar 资产，点保存按钮生效。",
        }),
        input("avatar_asset_id", "", "text", {
          hidden: true,
          "aria-label": "头像资产 ID",
        }),
        avatarImagePicker(),
      ),
      h("button", { class: "btn", type: "submit" }, "更新头像"),
    ),
  );
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader(
        "成员设置",
        "修改将直接写入成员档案，并触发 MemberUpdated 事件。",
        [
          button("与老板私聊", () => startBossPrivate(member.member_id)),
          button("返回设置", () => setRoute("settings", "member"), ""),
        ],
      ),
      h(
        "div",
        { class: "settings-layout" },
        h(
          "aside",
          { class: "settings-menu" },
          button(
            "个人档案",
            () => $(".field-grid", form).scrollIntoView({ behavior: "smooth" }),
            "primary",
          ),
          button("技能", () =>
            skillsEditor.scrollIntoView({ behavior: "smooth" }),
          ),
          button("执行器", () =>
            executorsEditor.scrollIntoView({ behavior: "smooth" }),
          ),
          button("头像", () =>
            avatarForm.scrollIntoView({ behavior: "smooth" }),
          ),
        ),
        h(
          "div",
          null,
          h(
            "section",
            { class: "card" },
            h(
              "div",
              { class: "detail-hero" },
              avatar(member, "large"),
              h(
                "div",
                null,
                h("h2", { text: member.name }),
                h("p", { class: "mono small-text", text: member.member_id }),
              ),
            ),
            form,
          ),
          h(
            "section",
            { class: "card" },
            h("h3", { text: "技能配置" }),
            skillsEditor,
          ),
          h(
            "section",
            { class: "card" },
            h("h3", { text: "执行器配置" }),
            executorsEditor,
          ),
          h(
            "section",
            { class: "card" },
            h("h3", { text: "头像" }),
            avatarForm,
          ),
        ),
      ),
    ),
  );
}
async function updateMember(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    await request(`/members/${encodeURIComponent(state.settingsMember)}`, {
      method: "PATCH",
      body: {
        name: data.get("name"),
        role_id: data.get("role_id"),
        model_tier: data.get("model_tier"),
        tone: data.get("tone"),
        status: data.get("status"),
        persona: {
          style: data.get("persona_style"),
          honesty: data.get("persona_honesty"),
          values: data
            .get("persona_values")
            .split(/[,，]/)
            .map((v) => v.trim())
            .filter(Boolean),
        },
        voice: {
          lang: data.get("voice_lang"),
          rate: Number(data.get("voice_rate")),
          pitch: Number(data.get("voice_pitch")),
          voice_hint: data.get("voice_hint").trim() || undefined,
        },
      },
    });
    await loadCore();
    renderList();
    renderMain();
    toast("成员档案已保存");
  } catch (error) {
    toast(errorMessage(error), true);
  }
}
async function updateSkills(event) {
  event.preventDefault();
  const skills = $$(".skill-row", event.currentTarget).map((row) => {
    const note = $("[name=skill_note]", row).value.trim();
    return {
      skill_id: $("[name=skill_id]", row).value,
      name: $("[name=skill_name]", row).value,
      ...(note === "" ? {} : { note }),
    };
  });
  try {
    await request(
      `/members/${encodeURIComponent(state.settingsMember)}/skills`,
      { method: "POST", body: { skills } },
    );
    await loadCore();
    renderMain();
    toast("技能已保存");
  } catch (error) {
    toast(errorMessage(error), true);
  }
}
async function updateExecutors(event) {
  event.preventDefault();
  try {
    const executorsList = $$(".executor-row", event.currentTarget).map(
      (row) => ({
        seq: Number($("[name=executor_seq]", row).value),
        kind: $(".pill", row).textContent,
        config: JSON.parse($("textarea", row).value),
        enabled: $("[name=executor_enabled]", row).checked,
      }),
    );
    await request(
      `/members/${encodeURIComponent(state.settingsMember)}/executors`,
      { method: "POST", body: { executors: executorsList } },
    );
    await loadCore();
    renderMain();
    toast("执行器已保存");
  } catch (error) {
    toast(errorMessage(error), true);
  }
}
async function updateAvatar(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const assetId = data.get("avatar_asset_id").trim();
  const seed = data.get("avatar_seed").trim();
  if (assetId && seed) {
    toast("头像资产与生成种子只能二选一：再选一次图片，或清空种子。", true);
    return;
  }
  try {
    await request(
      `/members/${encodeURIComponent(state.settingsMember)}/avatar`,
      {
        method: "POST",
        body: assetId ? { avatar_asset_id: assetId } : { avatar_seed: seed },
      },
    );
    await loadCore();
    renderMain();
    toast("头像已更新");
  } catch (error) {
    toast(errorMessage(error), true);
  }
}

function openModal({
  title,
  eyebrow = "",
  build,
  submit = "确认",
  danger = false,
  onSubmit,
}) {
  const modal = $("#modal");
  $("#modalTitle").textContent = title;
  $("#modalEyebrow").textContent = eyebrow;
  $("#modalBody").replaceChildren();
  $("#modalError").textContent = "";
  const body = build();
  $("#modalBody").append(body);
  const submitButton = $("#modalSubmit");
  submitButton.textContent = submit;
  submitButton.className = `btn ${danger ? "danger" : "primary"}`;
  submitButton.disabled = false;
  $("#modalForm").onsubmit = async (event) => {
    event.preventDefault();
    $("#modalError").textContent = "";
    submitButton.disabled = true;
    try {
      await onSubmit(new FormData(event.currentTarget), $("#modalBody"));
      modal.close();
    } catch (error) {
      $("#modalError").textContent = errorMessage(error);
    } finally {
      submitButton.disabled = false;
    }
  };
  modal.showModal();
  setTimeout(
    () =>
      $("input:not([type=hidden]), select, textarea", $("#modalBody"))?.focus(),
    30,
  );
}
function closeModal() {
  $("#modal").close();
  $("#modalError").textContent = "";
}
function openCreateModal(kind) {
  closeMenus();
  if (kind === "group") groupCreateModal();
  if (kind === "document") documentCreateModal();
  if (kind === "meeting") meetingCreateModal();
}
function groupCreateModal() {
  openModal({
    title: "新建群",
    eyebrow: "NEW GROUP",
    build: () =>
      h(
        "div",
        null,
        formGrid(
          field(
            "群名称",
            input("title", "", "text", { required: true, maxlength: 200 }),
          ),
          field("目标", textarea("goal", "", { maxlength: 4000 })),
        ),
        h("h3", { text: "首批成员" }),
        h("p", { class: "help", text: "特助由服务端自动追加，无需选择。" }),
        ...state.members
          .filter((member) => member.status === "active")
          .map((member) =>
            h(
              "label",
              { class: "check-row" },
              h("input", {
                type: "checkbox",
                name: "member_ids",
                value: member.member_id,
              }),
              `${member.name} · ${roleName(member.role_id)}`,
            ),
          ),
      ),
    submit: "创建群",
    onSubmit: async (data) => {
      await request("/groups", {
        method: "POST",
        body: {
          title: data.get("title"),
          goal: data.get("goal"),
          member_ids: data.getAll("member_ids"),
        },
      });
      await refreshAll();
      toast("群已创建");
    },
  });
}
async function documentCreateModal(template = null, defaultGroupId = "") {
  let templates = state.templates;
  if (!templates.length)
    templates = (await request("/templates")).templates || [];
  const templateSelect = select(
    "template_id",
    [
      ["", "空白正文"],
      ...templates.map((item) => [
        item.template_id,
        `${item.name} · ${labels[item.kind]}`,
      ]),
    ],
    template?.template_id || "",
    {
      onchange: (event) => {
        const chosen = templates.find(
          (item) => item.template_id === event.target.value,
        );
        $("[name=kind]", $("#modalBody")).value = chosen?.kind || "markdown";
      },
    },
  );
  openModal({
    title: template ? `从“${template.name}”起稿` : "新建文档",
    eyebrow: "NEW DOCUMENT",
    build: () =>
      formGrid(
        field(
          "标题",
          input(
            "title",
            template ? `${template.name} ${fmtDate(Date.now())}` : "",
            "text",
            { required: true, maxlength: 300 },
          ),
        ),
        field("模板", templateSelect),
        field(
          "文档形态",
          select(
            "kind",
            docKinds.map((kind) => [kind, labels[kind]]),
            template?.kind || "markdown",
          ),
        ),
        field(
          "所属群（可选）",
          select(
            "group_id",
            [
              ["", "未分组"],
              ...state.groups.map((group) => [group.group_id, group.title]),
            ],
            defaultGroupId,
          ),
        ),
        field(
          "水印",
          select(
            "watermark_profile",
            [
              ["none", "无水印"],
              ["internal", "内部"],
              ["confidential", "机密"],
            ],
            "none",
          ),
        ),
        fullField(
          "正文（不使用模板时）",
          textarea("body_text", "", { maxlength: 2000000 }),
        ),
      ),
    submit: "创建并打开",
    onSubmit: async (data) => {
      const result = await request("/documents", {
        method: "POST",
        body: {
          title: data.get("title"),
          kind: data.get("kind"),
          body_text: data.get("body_text"),
          watermark_profile: data.get("watermark_profile"),
          ...(data.get("group_id") ? { group_id: data.get("group_id") } : {}),
          ...(data.get("template_id")
            ? { template_id: data.get("template_id") }
            : {}),
        },
      });
      await loadAuxiliary();
      await openDocument(result.document.doc_id);
      toast("文档已创建");
    },
  });
}
async function createFromTemplate(template) {
  await documentCreateModal(template);
}
function templateCreateModal() {
  openModal({
    title: "新建模板",
    eyebrow: "NEW TEMPLATE",
    build: () =>
      formGrid(
        field(
          "名称",
          input("name", "", "text", { required: true, maxlength: 200 }),
        ),
        field(
          "文档形态",
          select(
            "kind",
            docKinds.map((kind) => [kind, labels[kind]]),
            "markdown",
          ),
        ),
        fullField(
          "模板正文",
          textarea("body_text", "", { maxlength: 2000000 }),
        ),
      ),
    submit: "创建模板",
    onSubmit: async (data) => {
      await request("/templates", {
        method: "POST",
        body: {
          name: data.get("name"),
          kind: data.get("kind"),
          body_text: data.get("body_text"),
        },
      });
      await loadAuxiliary();
      renderMain();
      toast("模板已创建");
    },
  });
}
function meetingCreateModal() {
  if (!state.groups.length) return toast("请先创建一个群", true);
  const groupSelect = select(
    "group_id",
    state.groups.map((group) => [group.group_id, group.title]),
    state.groups[0].group_id,
    { required: true },
  );
  const moderator = select("moderator_member_id", [], "");
  const seats = h("div", { class: "card" });
  const updateParticipants = async (groupId) => {
    moderator.replaceChildren();
    seats.replaceChildren(loadingState("正在读取群成员…"));
    try {
      const response = await request(`/groups/${encodeURIComponent(groupId)}`);
      state.groupMembers.set(groupId, response.members || []);
      const options = response.members.map((seat) => [
        seat.member_id,
        memberName(seat.member_id),
      ]);
      moderator.append(
        ...options.map(([value, label]) =>
          h(
            "option",
            { value, selected: value === response.group.cos_member_id },
            label,
          ),
        ),
      );
      seats.replaceChildren(
        h("h3", { text: "开场发言顺序" }),
        h("p", { class: "help", text: "不选时服务端默认仅主持人先发言。" }),
        ...response.members.map((seat) =>
          h(
            "label",
            { class: "check-row" },
            h("input", {
              type: "checkbox",
              name: "speaking_order",
              value: seat.member_id,
            }),
            memberName(seat.member_id),
          ),
        ),
      );
    } catch (error) {
      seats.replaceChildren(banner(errorMessage(error)));
    }
  };
  groupSelect.addEventListener(
    "change",
    () => void updateParticipants(groupSelect.value),
  );
  void updateParticipants(groupSelect.value);
  openModal({
    title: "发起会议",
    eyebrow: "NEW MEETING",
    build: () =>
      h(
        "div",
        null,
        formGrid(
          field("所属群", groupSelect),
          field(
            "会议类型",
            select(
              "meeting_type",
              [
                ["decision", "决策会"],
                ["review", "评审会"],
                ["debate", "辩论会"],
              ],
              "decision",
            ),
          ),
          fullField(
            "议题",
            input("topic", "", "text", { required: true, maxlength: 200 }),
          ),
          field("主持人", moderator),
          field(
            "关联任务 ID（可选）",
            input("task_id", "", "text", { maxlength: 200 }),
          ),
        ),
        seats,
      ),
    submit: "发起会议",
    onSubmit: async (data) => {
      const speakingOrder = data.getAll("speaking_order");
      const result = await request("/meetings", {
        method: "POST",
        body: {
          group_id: data.get("group_id"),
          meeting_type: data.get("meeting_type"),
          topic: data.get("topic"),
          moderator_member_id: data.get("moderator_member_id"),
          ...(data.get("task_id") ? { task_id: data.get("task_id") } : {}),
          ...(speakingOrder.length ? { speaking_order: speakingOrder } : {}),
        },
      });
      await loadCore();
      await openMeeting(result.meeting.meeting_id);
      toast("会议已发起");
    },
  });
}
async function openBossPrivate(memberId) {
  const member = memberById(memberId);
  if (!member) throw new Error(`成员 [${memberId}] 不存在，无法打开私聊。`);
  const result = await request(
    `/conversations/${encodeURIComponent("private")}/open-private`,
    {
      method: "POST",
      body: { member_a: "boss", member_b: memberId },
    },
  );
  state.conversations = [
    result.conversation,
    ...state.conversations.filter(
      (conversation) =>
        conversation.conversation_id !== result.conversation.conversation_id,
    ),
  ];
  await openConversation(result.conversation.conversation_id);
  toast(result.created ? "老板私聊已创建" : "已打开既有老板私聊");
  return result;
}
async function startBossPrivate(memberId) {
  try {
    await activeDocumentSession?.flush();
    await openBossPrivate(memberId);
  } catch (error) {
    toast(errorMessage(error), true);
  }
}
function openBossPrivateModal(preselected = null) {
  const active = state.members.filter((member) => member.status === "active");
  if (!active.length) return toast("暂无在职成员可发起老板私聊", true);
  const member = memberById(preselected) || active[0];
  openModal({
    title: "私聊成员（老板）",
    eyebrow: "BOSS PRIVATE THREAD",
    build: () =>
      h(
        "div",
        null,
        banner(
          "默认与老板 1:1 私聊；选择成员后直接打开，无需选择两位成员。",
          "info",
        ),
        formGrid(
          field(
            "成员 A",
            input("member_a", "boss", "text", { readonly: true }),
          ),
          field(
            "成员 B",
            select(
              "member_b",
              active.map((entry) => [entry.member_id, entry.name]),
              member.member_id,
              { required: true },
            ),
          ),
        ),
      ),
    submit: "打开老板私聊",
    onSubmit: (data) => openBossPrivate(data.get("member_b")),
  });
}
function openMemberPrivateModal() {
  const active = state.members.filter((member) => member.status === "active");
  if (active.length < 2)
    return toast("至少需要两位在职成员才能创建成员间私聊", true);
  openModal({
    title: "私聊成员（成员间）",
    eyebrow: "MEMBER PRIVATE THREAD",
    build: () =>
      h(
        "div",
        null,
        banner(
          "这是可选的成员间私聊，不是默认入口；默认入口为“私聊成员（老板）”。",
          "info",
        ),
        formGrid(
          field(
            "成员 A",
            select(
              "member_a",
              active.map((member) => [member.member_id, member.name]),
              active[0].member_id,
              { required: true },
            ),
          ),
          field(
            "成员 B",
            select(
              "member_b",
              active.map((member) => [member.member_id, member.name]),
              active[1].member_id,
              { required: true },
            ),
          ),
        ),
      ),
    submit: "打开成员间私聊",
    onSubmit: async (data) => {
      if (data.get("member_a") === data.get("member_b"))
        throw new Error("不能与自己创建私聊。");
      const result = await request(
        `/conversations/${encodeURIComponent("private")}/open-private`,
        {
          method: "POST",
          body: {
            member_a: data.get("member_a"),
            member_b: data.get("member_b"),
          },
        },
      );
      state.conversations = [
        result.conversation,
        ...state.conversations.filter(
          (conversation) =>
            conversation.conversation_id !==
            result.conversation.conversation_id,
        ),
      ];
      await openConversation(result.conversation.conversation_id);
      toast(result.created ? "成员间私聊已创建" : "已打开既有成员间私聊");
    },
  });
}
function cancelMeetingModal(meeting) {
  openModal({
    title: "取消会议",
    eyebrow: meeting.topic,
    build: () =>
      field(
        "取消原因",
        textarea("reason", "", { required: true, maxlength: 1000 }),
      ),
    submit: "确认取消",
    danger: true,
    onSubmit: async (data) => {
      await request(
        `/meetings/${encodeURIComponent(meeting.meeting_id)}/cancel`,
        { method: "POST", body: { reason: data.get("reason") } },
      );
      await loadMeeting(meeting.meeting_id);
      toast("会议已取消");
    },
  });
}

function closeMenus() {
  $("#createMenu").hidden = true;
  $("#createButton").setAttribute("aria-expanded", "false");
  $("#searchResults").hidden = true;
  $("#globalSearch").setAttribute("aria-expanded", "false");
}
async function globalSearch(query) {
  clearTimeout(state.searchTimer);
  const resultBox = $("#searchResults");
  const q = query.trim();
  if (!q) {
    resultBox.hidden = true;
    return;
  }
  state.searchTimer = setTimeout(async () => {
    state.searchAbort?.abort();
    const controller = new AbortController();
    state.searchAbort = controller;
    resultBox.replaceChildren(loadingState("正在全平台搜索…"));
    resultBox.hidden = false;
    $("#globalSearch").setAttribute("aria-expanded", "true");
    try {
      const result = await request(
        `/search?q=${encodeURIComponent(q)}&limit=30`,
        { signal: controller.signal },
      );
      resultBox.replaceChildren();
      if (!result.hits.length)
        resultBox.append(
          h("div", { class: "state" }, h("p", { text: "没有找到匹配结果" })),
        );
      for (const hit of result.hits)
        resultBox.append(
          h(
            "button",
            {
              type: "button",
              class: "search-result",
              role: "option",
              // 同一枚标题可以同时出现在好几面（群的章程文档就叫群名），所以行上
              // 必须自带【是哪一面、哪一条】：只靠标题文本挑行会挑到别一面的那一行。
              "data-face": hit.face,
              "data-id": hit.id,
              onclick: () => {
                closeMenus();
                openSearchHit(hit);
              },
            },
            icon(
              hit.face === "document"
                ? "doc"
                : hit.face === "meeting"
                  ? "meeting"
                  : hit.face === "member"
                    ? "users"
                    : "search",
            ),
            h(
              "span",
              null,
              h("span", { class: "result-title", text: hit.title }),
              h("small", { text: hit.snippet || hit.id }),
            ),
            h("span", { class: "search-face", text: faceLabels[hit.face] }),
          ),
        );
    } catch (error) {
      if (error.name === "AbortError") return;
      resultBox.replaceChildren(
        banner(errorMessage(error), "error", () => globalSearch(query)),
      );
    }
  }, 260);
}
async function openSearchHit(hit) {
  try {
    if (hit.face === "document") await openDocument(hit.id);
    if (hit.face === "meeting") await openMeeting(hit.id);
    if (hit.face === "message" && hit.conversation_id)
      await openConversation(hit.conversation_id);
    if (hit.face === "member") {
      state.selectedMember = hit.id;
      state.settingsMember = hit.id;
      setRoute("contacts", hit.id);
    }
    if (hit.face === "backlog") {
      state.selectedBacklog = hit.id;
      setRoute("backlog", hit.id);
    }
    if (hit.face === "group") {
      // 落点沿用侧栏点群的同一个函数：它自己会找群会话并进去，没有会话才落到群详情。
      // 少这一支时点群命中是【静默什么都不发生】—— 下拉关掉了，屏幕还停在原地。
      await selectGroup(hit.id);
    }
    if (hit.face === "task") {
      location.href = "/";
    }
  } catch (error) {
    toast(errorMessage(error), true);
  }
}
function applyPersonalStatus() {
  const stored = readStoredJson(STORAGE_KEYS.personalStatus, "online");
  state.personalStatus = Object.hasOwn(personalStatusLabels, stored)
    ? stored
    : "online";
  const label = personalStatusLabels[state.personalStatus];
  $("#personalStatus").value = state.personalStatus;
  $("#profileStatusDot").className = `status-dot ${state.personalStatus}`;
  $("#profileStatusText").textContent = `${label} · 本机 · 决策人`;
  $(".profile-button").dataset.personalStatus = state.personalStatus;
}
function setPersonalStatus(value) {
  if (!Object.hasOwn(personalStatusLabels, value)) return;
  state.personalStatus = value;
  writeStoredJson(STORAGE_KEYS.personalStatus, value);
  applyPersonalStatus();
  toast(`个人状态已设为${personalStatusLabels[value]}（仅本机）`);
}
function setConnection(link, text) {
  state.link = link;
  $("#connectionDot").className = `status-dot ${link}`;
  $("#connectionText").textContent =
    text ||
    {
      connecting: "连接中…",
      live: "实时同步",
      stale: "正在补齐快照",
      down: "事件流断开",
    }[link];
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (state.attempts >= 8) {
    setConnection("down", "重连已暂停 · 点击重试");
    return;
  }
  const delay = Math.min(1000 * 2 ** state.attempts, 15000);
  state.attempts += 1;
  setConnection(
    "down",
    `${Math.round(delay / 1000)} 秒后重连（${state.attempts}/8）`,
  );
  reconnectTimer = setTimeout(connectStream, delay);
}
async function connectStream() {
  clearTimeout(reconnectTimer);
  streamController?.abort();
  const controller = new AbortController();
  streamController = controller;
  const cursorAtConnect = state.cursor;
  setConnection(
    "connecting",
    state.cursor ? `从游标 ${state.cursor} 续订` : "连接中…",
  );
  let response;
  try {
    response = await fetch(
      `/api/events${state.cursor ? `?cursor=${state.cursor}` : ""}`,
      {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
        cache: "no-store",
      },
    );
  } catch (_error) {
    if (!controller.signal.aborted) scheduleReconnect();
    return;
  }
  if (!response.ok || !response.body) {
    if (!controller.signal.aborted) scheduleReconnect();
    return;
  }
  state.attempts = 0;
  setConnection("live");
  if (cursorAtConnect > 0) void snapshotRefresh();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder
        .decode(value, { stream: true })
        .replaceAll("\r\n", "\n");
      let boundary;
      for (;;) {
        boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleSseFrame(raw);
      }
    }
  } catch {
    /* reconnect below */
  }
  if (!controller.signal.aborted) scheduleReconnect();
}
function handleSseFrame(raw) {
  let event = "message",
    id = null,
    data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("id:")) id = line.slice(3).trim();
    if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (!data) return;
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    markStale();
    return;
  }
  if (event === "snapshot") {
    state.needsResume = false;
    const seq = Number(payload.as_of_seq || 0);
    if (Number.isSafeInteger(seq) && seq > state.cursor) state.cursor = seq;
    state.attempts = 0;
    setConnection("live");
    return;
  }
  const seq = Number(id ?? payload.seq);
  if (!Number.isSafeInteger(seq)) {
    markStale();
    return;
  }
  if (seq <= state.cursor) return;
  if (seq > state.cursor + 1 || payload.degraded === true) {
    // 随后的全量快照会补齐业务状态；推进游标避免重连后反复卡在同一个空洞。
    state.cursor = seq;
    markStale();
    return;
  }
  state.cursor = seq;
  if (
    payload.kind === "DocumentChanged" &&
    payload.docId === state.selectedDocument &&
    state.route === "documents"
  )
    activeDocumentSession?.remoteChanged();
  if (snapshotEventKinds.has(payload.kind)) {
    relevantKinds.add(payload.kind);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(snapshotRefresh, 140);
  }
}
function markStale() {
  state.needsResume = true;
  setConnection("stale");
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(snapshotRefresh, 120);
}
async function snapshotRefresh() {
  clearTimeout(refreshTimer);
  try {
    await refreshAll();
    setConnection("live");
    if (state.needsResume) {
      state.needsResume = false;
      streamController?.abort();
      void connectStream();
    }
  } catch (error) {
    setConnection("stale", "快照刷新失败 · 点击重试");
    toast(errorMessage(error), true);
  } finally {
    relevantKinds.clear();
  }
}
function queueDraft() {
  const doc = state.documents.find(
    (entry) => entry.doc_id === state.selectedDocument,
  );
  if (!doc || state.route !== "documents" || doc.my_tier === "reader") return;
  const title = $("[name=docTitle]")?.value;
  const body = $(".editor-surface")?.dataset.draftBody;
  if (title === undefined || body === undefined) return;
  try {
    localStorage.setItem(
      `opc:doc-draft:${doc.doc_id}`,
      JSON.stringify({ title, body_text: body, saved_at: Date.now() }),
    );
  } catch {
    /* quota/private mode */
  }
}

initNavigation();
applyPersonalStatus();
// 主题：head 的内联脚本已把首帧的 <html data-theme> 落好（防 FOUC）；这里把右上角那
// 枚 [data-theme-toggle] 接上点击 + 系统外观跟随。幂等，重复调用无副作用。
mountThemeToggle();
$("#personalStatus").addEventListener("change", (event) =>
  setPersonalStatus(event.target.value),
);
$("#createButton").addEventListener("click", () => {
  const menu = $("#createMenu");
  menu.hidden = !menu.hidden;
  $("#createButton").setAttribute("aria-expanded", String(!menu.hidden));
});
$$("[data-create]").forEach((item) => {
  item.addEventListener("click", () => {
    closeMenus();
    if (item.dataset.create === "boss-private") openBossPrivateModal();
    else if (item.dataset.create === "member-private") openMemberPrivateModal();
    else openCreateModal(item.dataset.create);
  });
});
$$("[data-nav]").forEach((item) => {
  item.addEventListener("click", () => setRoute(item.dataset.nav));
});
$("#collapseNav").addEventListener("click", () => {
  const collapsed = $(".workspace").classList.toggle("nav-collapsed");
  $("#collapseNav").setAttribute("aria-expanded", String(!collapsed));
  $("#collapseNav").setAttribute(
    "aria-label",
    collapsed ? "展开导航" : "折叠导航",
  );
});
$("#mobileListButton").addEventListener("click", () =>
  $(".workspace").classList.toggle("list-open"),
);
$("#listAction").addEventListener("click", () => {
  if (state.route === "messages") openBossPrivateModal();
  if (state.route === "contacts") groupCreateModal();
  if (state.route === "documents") documentCreateModal();
  if (state.route === "backlog") backlogCreateModal();
  if (state.route === "talent") {
    state.talentTab = "hire";
    renderList();
    renderMain();
  }
  if (state.route === "settings") toast("从列表选择成员进行配置");
});
$("#modalClose").addEventListener("click", closeModal);
$("#modalCancel").addEventListener("click", closeModal);
$("#modal").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeModal();
});
$("#globalSearch").addEventListener("input", (event) =>
  globalSearch(event.target.value),
);
$("#globalSearch").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $(".search-result", $("#searchResults"))?.click();
  if (event.key === "Escape") closeMenus();
});
$("#searchResults").addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
  event.preventDefault();
  const results = $$(".search-result", $("#searchResults"));
  const index = results.indexOf(document.activeElement);
  const next =
    event.key === "ArrowDown"
      ? (index + 1) % results.length
      : (index - 1 + results.length) % results.length;
  results[next]?.focus();
});
$("#reconnectButton").addEventListener("click", () => {
  state.attempts = 0;
  closeMenus();
  connectStream().then(snapshotRefresh);
});
document.addEventListener("click", (event) => {
  if (
    !event.target.closest(".create-wrap") &&
    !event.target.closest(".global-search")
  )
    closeMenus();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#globalSearch").focus();
    $("#globalSearch").select();
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "s" &&
    state.route === "documents" &&
    state.selectedDocument
  ) {
    event.preventDefault();
    $("#saveDocument")?.click();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === ",") {
    event.preventDefault();
    $(".workspace").classList.toggle("nav-collapsed");
  }
  if (event.key === "Escape") closeMenus();
});
window.addEventListener("hashchange", () => {
  const [route, id] = location.hash.replace(/^#\//, "").split("/");
  if (
    route === "admin" &&
    adminMounted &&
    state.route === "admin" &&
    (id ?? "").includes("?")
  ) {
    // 这一发来自控制室【自己】：今日页的窗口 chip 写的是 #/admin/today?window=7d
    // （goPage 那条路，query 住在 id 段里）。不许走下面的 setRoute：它会把整段
    // id encodeURIComponent 一遍，地址变成 #/admin/today%3Fwindow%3D7d，控制室再
    // 解析就得到一个不存在的页名：窗口判据静默蒸发，而 URL 看着仍然像回事。
    // 宿主不懂 query（那份判据在 app.js 的 parseAdminHash 里），所以这里只把页名
    // 镜像进中间栏的选中态，然后让 app.js 自己去接这一发。
    const page = decodeURIComponent(id.split("?")[0]);
    if (page) adminPage = page;
    renderList();
    return;
  }
  if (routes[route]) {
    state.route = route;
    if (id) {
      const decoded = decodeURIComponent(id);
      if (route === "documents") openDocument(decoded);
      else if (route === "settings") setRoute(route, decoded);
      else if (route === "messages" && decoded.startsWith("meeting:"))
        openMeeting(decoded.slice(8));
      else if (route === "messages") openConversation(decoded);
      else setRoute(route, decoded);
    } else setRoute(route);
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.link !== "live") {
    state.attempts = 0;
    void connectStream();
  }
  if (document.hidden) activeDocumentSession?.flush();
});
window.addEventListener("online", () => activeDocumentSession?.flush());
setInterval(() => {
  if (
    state.route === "documents" &&
    state.selectedDocument &&
    !$("#modal").open
  )
    queueDraft();
}, 1500);

async function boot() {
  const [route, id] = location.hash.replace(/^#\//, "").split("/");
  // admin 的 id 位置就是页名：不传的话 #/admin/board 直达会被 setRoute 里的
  // replaceState 削成 #/admin，首屏停在今日页 —— 而 URL 明明写着任务看板。
  setRoute(
    routes[route] ? route : "messages",
    route === "admin" && id ? decodeURIComponent(id) : null,
  );
  try {
    await loadCore();
    await loadAuxiliary().catch((error) =>
      toast(`部分辅助数据加载失败：${errorMessage(error)}`, true),
    );
    renderList();
    renderMain();
    if (id) {
      const decoded = decodeURIComponent(id);
      if (route === "messages" && decoded.startsWith("meeting:"))
        await openMeeting(decoded.slice(8));
      else if (route === "messages") await openConversation(decoded);
      else if (route === "documents") await openDocument(decoded);
      else if (route === "settings") setRoute(route, decoded);
    }
  } catch (error) {
    coreLoaded = false;
    renderList();
    if (state.route === "admin") {
      // 控制室不读工作台的核心数据（它自己直连 /api），核心加载失败不该把
      // 已经挂载的控制室换成错误页 —— 排查服务问题恰恰要去那一格。
      toast(`工作台数据加载失败：${errorMessage(error)}`, true);
    } else
      $("#view").replaceChildren(
        h(
          "div",
          { class: "page" },
          banner(errorMessage(error), "error", () => boot()),
          emptyState(
            "工作台暂时无法加载",
            "服务返回错误时不会展示演示数据。请检查同源代理、Hub 与鉴权配置后重试。",
            null,
            "refresh",
          ),
        ),
      );
    setConnection("down", "服务不可用");
  }
  void connectStream();
}
boot();
