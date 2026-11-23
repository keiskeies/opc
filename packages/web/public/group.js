/* T11: same-origin desktop client. User content is always inserted as text/DOM nodes. */
import {
  avatarUrl,
  browserSpeech,
  generatedAvatarDataUrl,
  personaTagline,
  speakWithBrowser,
} from "/src/humanizer.ts";

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
const faceLabels = {
  task: "任务",
  member: "成员",
  message: "消息",
  document: "文档",
  meeting: "会议",
  backlog: "待办",
};
const docKinds = ["doc", "sheet", "markdown", "mindmap"];
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
function emptyState(title, description, action) {
  return h(
    "div",
    { class: "state" },
    icon("doc"),
    h("h3", { text: title }),
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
      h("p", { text: subtitle }),
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
  const value = Date.parse(
    conversation.last_message_at || conversation.created_at || "",
  );
  return Number.isFinite(value) ? value : 0;
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
  messages: [],
  meetings: [],
  groups: [],
  members: [],
  roles: [],
  documents: [],
  templates: [],
  backlog: [],
  talents: [],
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
  backlogFilter: "",
  chatTab: "messages",
  taskTab: "backlog",
  rhythmKind: "",
  rhythmGroup: "",
  rhythmEvents: [],
  researchCards: [],
  teamWorkLoading: false,
  teamWorkError: "",
  talentTab: "market",
  settingsMember: null,
  draft: null,
};
let renderToken = 0;
let messageRequestToken = 0;
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

const routes = {
  messages: ["消息", "群聊、私聊与会议"],
  contacts: ["通讯录", "组织架构与成员"],
  documents: ["文档中心", "知识、模板与版本"],
  backlog: ["任务面板", "待办流转与拆分"],
  talent: ["人才市场", "招聘与人才蓝图"],
  settings: ["设置", "成员档案与偏好"],
};

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
  if (route === "settings" && id) state.settingsMember = id;
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
  history.replaceState(
    null,
    "",
    `#/${route}${id ? `/${encodeURIComponent(id)}` : ""}`,
  );
  renderList();
  renderMain();
}
async function loadCore() {
  const [conversations, meetings, groups, members, roles, backlog] =
    await Promise.all([
      request("/conversations"),
      request("/meetings"),
      request("/groups"),
      request("/members"),
      request("/roles"),
      request("/backlog?limit=200"),
    ]);
  Object.assign(state, {
    conversations: conversations.conversations || [],
    meetings: meetings.meetings || [],
    groups: groups.groups || [],
    members: members.members || [],
    roles: roles.roles || [],
    backlog: backlog.items || [],
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
              `/conversations/${encodeURIComponent(state.selectedConversation)}/messages?limit=200`,
            );
            state.messages = result.messages || [];
          } else await loadMessages(state.selectedConversation, false);
        }
      } else if (state.selectedMeeting)
        await loadMeeting(state.selectedMeeting, false);
    } else if (state.route !== "documents" || !state.selectedDocument)
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
  if (!coreLoaded) {
    content.append(loadingState());
    return;
  }
  if (state.route === "messages") renderConversationList(content);
  if (state.route === "contacts") renderGroupList(content, toolbar);
  if (state.route === "documents") renderDocumentList(content, toolbar);
  if (state.route === "backlog") renderBacklogList(content, toolbar);
  if (state.route === "talent") renderTalentList(content, toolbar);
  if (state.route === "settings") renderMemberList(content, toolbar);
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
    content.append(emptyState("暂无群组", "在顶栏点击“创建 → 新建群”。"));
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
function renderDocumentList(content, toolbar) {
  toolbar.append(
    h(
      "div",
      { class: "toolbar" },
      input("docSearch", state.docFilter.q, "search", {
        placeholder: "筛选标题或作者",
        "aria-label": "筛选文档",
        oninput: (event) => {
          state.docFilter.q = event.target.value;
          renderDocumentList(content, toolbar);
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
        renderDocumentList(content, toolbar);
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
        renderDocumentList(content, toolbar);
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
  toolbar.append(h("div", { class: "toolbar" }, kinds, groups));
  const filtered = state.documents.filter(
    (doc) =>
      (!state.docFilter.kind || doc.kind === state.docFilter.kind) &&
      (!state.docFilter.group || doc.group_id === state.docFilter.group) &&
      (!state.docFilter.q ||
        `${doc.title} ${doc.owner}`
          .toLowerCase()
          .includes(state.docFilter.q.toLowerCase())),
  );
  if (!filtered.length) {
    content.append(
      emptyState(
        state.documents.length ? "没有匹配的文档" : "文档中心还是空的",
        state.documents.length
          ? "调整类型、群组或关键词筛选。"
          : "从模板创建文档，或导入本地 Word、Excel、Markdown 文件。",
      ),
    );
    return;
  }
  for (const doc of filtered)
    content.append(
      h(
        "button",
        {
          type: "button",
          class: `doc-list-item${state.selectedDocument === doc.doc_id ? " selected" : ""}`,
          onClick: () => openDocument(doc.doc_id),
        },
        h("h3", { text: doc.title }),
        h("p", {
          text: `${labels[doc.kind]} · ${memberName(doc.owner)} · ${fmtDate(doc.updated_at)}`,
        }),
        h(
          "div",
          { class: "actions" },
          pill(labels[doc.kind], "blue"),
          doc.watermark_profile !== "none" ? pill("已水印", "amber") : null,
        ),
      ),
    );
}
function renderBacklogList(content, toolbar) {
  toolbar.append(
    input("backlogSearch", state.backlogFilter, "search", {
      placeholder: "筛选待办",
      "aria-label": "筛选待办",
      oninput: (event) => {
        state.backlogFilter = event.target.value;
        renderBacklogList(content, toolbar);
      },
    }),
  );
  const items = state.backlog.filter(
    (item) =>
      !state.backlogFilter ||
      item.title.toLowerCase().includes(state.backlogFilter.toLowerCase()),
  );
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
      emptyState("没有匹配的待办", "创建条目后，可在这里按群组和优先级处理。"),
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
          h("small", {
            text: `${roleName(member.role_id)} · ${labels[member.status]}`,
          }),
        ),
        pill(labels[member.status], member.status === "active" ? "green" : ""),
      ),
    );
  if (!state.members.length)
    content.append(emptyState("暂无成员", "前往人才市场完成招聘。"));
}

function renderMain() {
  activeDocumentSession = null;
  const token = ++renderToken;
  const view = $("#view");
  const focusedId = view.contains(document.activeElement)
    ? document.activeElement.id
    : "";
  view.replaceChildren();
  $("#listPane").hidden = false;
  if (!coreLoaded) {
    view.append(loadingState("正在连接工作台…"));
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
    if (state.route === "settings")
      state.settingsMember ? renderSettings(view) : renderSettingsHome(view);
  } catch (error) {
    view.append(banner(errorMessage(error), "error", () => renderMain()));
  }
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
  state.messageLoading = true;
  if (state.route === "messages" && state.selectedConversation === id)
    renderChat($("#view"), token);
  try {
    const result = await request(
      `/conversations/${encodeURIComponent(id)}/messages?limit=200`,
    );
    // 发送或切换会话后，旧快照不能覆盖当前消息流。
    if (requestToken !== messageRequestToken) return;
    state.messages = result.messages || [];
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
      if (stream) stream.scrollTop = stream.scrollHeight;
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
                  h("span", { class: "group-task-title", text: item.title }),
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
                h("strong", { class: "group-document-title", text: doc.title }),
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
    view.append(emptyState("会话不存在", "刷新会话列表后重试。"));
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
            text: isGroup
              ? `${groupName(conversation.group_id)} · ${tab}`
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
    stream.append(loadingState());
    return;
  }
  if (!state.messages.length) {
    stream.append(emptyState("还没有消息", "发出第一条消息，开始这段协作。"));
    return;
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
    dataset: { messageId: message.message_id },
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
        text: fmtDateTime(message.created_at),
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
    view.append(emptyState("会议不存在", "返回会议列表选择其他记录。"));
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
    : emptyState("尚未开始发言", "只有当前下一位发言者可以提交本轮发言。");
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
    state.teamWorkLoading ? loadingState("正在加载团队节奏…") : null,
    !state.teamWorkLoading && !state.rhythmEvents.length
      ? emptyState(
          "还没有团队节奏",
          state.rhythmKind || state.rhythmGroup
            ? "当前筛选下没有记录，调整类型或群组后再试。"
            : "从一次迭代计划或每日站会开始。请填写摘要、成果、卡点、下一步与负责人，并给出明确结论。",
          button("新增节奏", () => rhythmCreateModal(), "primary"),
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
async function openResearchBacklog(id) {
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
      h("h3", { text: item.title }),
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
            () => openResearchBacklog(item.backlog_item_id),
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
    state.teamWorkLoading ? loadingState("正在加载今日调研…") : null,
    !state.teamWorkLoading && !state.researchCards.length
      ? emptyState(
          "今天还没有调研",
          "登记一条外部链接或手动调研。没有 URL 时来源请填写 manual，创建后会关联调研文档和待办草稿。",
          button("新增调研", () => researchCreateModal(), "primary"),
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
          button(
            "刷新",
            () => {
              void refreshTaskPanel().catch((error) =>
                toast(errorMessage(error), true),
              );
            },
            "small",
          ),
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
    view.append(emptyState("待办不存在", "返回任务面板。"));
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
        button("导入", () => importDocument(), "small"),
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
        ),
      ),
      !state.templates.length
        ? emptyState("暂无模板", "可创建空白文档，或稍后从 Hub 模板库选择。")
        : null,
    ),
  );
}
async function openDocument(id) {
  state.selectedDocument = id;
  setRoute("documents", id);
  $("#view").replaceChildren(loadingState("正在打开文档…"));
  try {
    const [detail, versions, permissions] = await Promise.all([
      request(`/documents/${encodeURIComponent(id)}`),
      request(`/documents/${encodeURIComponent(id)}/versions`),
      request(`/documents/${encodeURIComponent(id)}/permissions`),
    ]);
    state.documents = state.documents.map((doc) =>
      doc.doc_id === id ? detail.document : doc,
    );
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
function editorSelectionRange(editor) {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer) ? range : null;
}
function focusEditorRange(editor, range) {
  if (!range || !editor.contains(range.commonAncestorContainer)) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  editor.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}
function richDocToolbar(editor, editable) {
  let savedRange = null;
  let activeCell = null;
  let uploading = false;
  const commandButtons = new Map();
  const tableButtons = [];
  const paragraphSelect = select(
    "docParagraph",
    [
      ["p", "正文"],
      ["h1", "标题 1"],
      ["h2", "标题 2"],
      ["h3", "标题 3"],
    ],
    "p",
    {
      class: "rich-editor-paragraph-select",
      "aria-label": "段落层级",
      disabled: !editable,
      onchange: (event) => runCommand("formatBlock", event.target.value),
    },
  );
  const textTool = (text, label, onClick, tone = "") => {
    const control = button(text, onClick, "small", {
      title: label,
      "aria-label": label,
      disabled: !editable,
    });
    control.classList.add("rich-editor-tool");
    if (tone) control.classList.add(tone);
    return control;
  };
  const iconTool = (name, label, onClick, extra = {}) =>
    iconButton(name, label, onClick, { disabled: !editable, ...extra });
  const commandTool = (command, control) => {
    commandButtons.set(command, control);
    return control;
  };
  const tableTool = (label, title, action) => {
    const control = textTool(label, title, () => runTableAction(action));
    tableButtons.push(control);
    return control;
  };
  const updateToolbar = () => {
    const range = editorSelectionRange(editor) || savedRange;
    const anchor =
      range && editor.contains(range.commonAncestorContainer)
        ? range.startContainer.nodeType === Node.ELEMENT_NODE
          ? range.startContainer
          : range.startContainer.parentElement
        : null;
    const block = anchor?.closest("h1, h2, h3, blockquote, p, li");
    paragraphSelect.value = /^H[123]$/u.test(block?.tagName || "")
      ? block.tagName.toLowerCase()
      : "p";
    for (const [command, control] of commandButtons) {
      let active = false;
      try {
        active = document.queryCommandState(command);
      } catch {
        /* command state is optional */
      }
      control.classList.toggle("active", active);
      control.setAttribute("aria-pressed", String(active));
    }
    const quoteButton = commandButtons.get("blockquote");
    if (quoteButton) {
      const active = block?.tagName === "BLOCKQUOTE";
      quoteButton.classList.toggle("active", active);
      quoteButton.setAttribute("aria-pressed", String(active));
    }
    const tableAvailable =
      editable && activeCell?.isConnected && editor.contains(activeCell);
    for (const control of tableButtons) control.disabled = !tableAvailable;
    uploadButton.disabled = !editable || uploading;
  };
  const captureSelection = () => {
    const range = editorSelectionRange(editor);
    if (!range) return;
    savedRange = range.cloneRange();
    const anchor =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
    const cell = anchor?.closest("td, th");
    activeCell = cell && editor.contains(cell) ? cell : null;
    updateToolbar();
  };
  const runCommand = (command, value = null) => {
    if (!editable) return;
    focusEditorRange(editor, savedRange);
    document.execCommand(command, false, value);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    captureSelection();
  };
  const selectCell = (cell) => {
    if (!cell || !editor.contains(cell)) return;
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.collapse(false);
    focusEditorRange(editor, range);
    captureSelection();
  };
  const runTableAction = (action) => {
    if (!editable || !activeCell || !editor.contains(activeCell)) return;
    const table = activeCell.closest("table");
    const row = activeCell.closest("tr");
    if (!table || !row) return;
    const rows = [...table.rows];
    const rowIndex = rows.indexOf(row);
    const columnIndex = activeCell.cellIndex;
    let targetCell = null;
    if (action === "row-above" || action === "row-below") {
      const insertAt = rowIndex + (action === "row-below" ? 1 : 0);
      const newRow = table.insertRow(insertAt);
      for (let index = 0; index < row.cells.length; index += 1)
        newRow.append(h("td", null, h("br")));
      targetCell = newRow.cells[columnIndex] || newRow.cells[0];
    } else if (action === "row-delete") {
      if (rows.length === 1) {
        toast("表格至少需要保留一行。", true);
        return;
      }
      row.remove();
      targetCell =
        table.rows[Math.min(rowIndex, table.rows.length - 1)]?.cells[
          columnIndex
        ] || table.rows[0]?.cells[0];
    } else if (action === "column-left" || action === "column-right") {
      const insertAt = columnIndex + (action === "column-right" ? 1 : 0);
      for (const currentRow of table.rows) {
        const cell = h(
          currentRow.cells[columnIndex]?.tagName || "TD",
          null,
          h("br"),
        );
        if (insertAt > currentRow.cells.length) currentRow.append(cell);
        else currentRow.insertCell(insertAt).replaceWith(cell);
      }
      targetCell = row.cells[insertAt];
    } else if (action === "column-delete") {
      if (table.rows[0]?.cells.length <= 1) {
        toast("表格至少需要保留一列。", true);
        return;
      }
      for (const currentRow of table.rows)
        currentRow.cells[columnIndex]?.remove();
      targetCell =
        row.cells[columnIndex] || row.cells[columnIndex - 1] || row.cells[0];
    }
    if (!targetCell) return;
    selectCell(targetCell);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const insertTable = () => {
    const body = h("tbody");
    for (let rowIndex = 0; rowIndex < 3; rowIndex += 1)
      body.append(
        h(
          "tr",
          null,
          ...Array.from({ length: 3 }, () => h("td", null, h("br"))),
        ),
      );
    const table = h("table", null, body);
    const paragraph = h("p", null, h("br"));
    const range = focusEditorRange(editor, savedRange);
    range.deleteContents();
    range.insertNode(table);
    table.after(paragraph);
    range.setStart(paragraph, 0);
    range.collapse(true);
    focusEditorRange(editor, range);
    activeCell = table.rows[0]?.cells[0] || null;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    updateToolbar();
  };
  const openLinkModal = () => {
    if (!editable) return;
    if (editorSelectionRange(editor)) captureSelection();
    focusEditorRange(editor, savedRange);
    savedRange = editorSelectionRange(editor)?.cloneRange() || savedRange;
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
        $("#modal").addEventListener(
          "close",
          () => {
            if (!editable || !editor.isConnected) return;
            const range = focusEditorRange(editor, savedRange);
            if (!range.collapsed) {
              document.execCommand("createLink", false, url);
            } else {
              const link = h(
                "a",
                { href: url, rel: "noreferrer noopener", target: "_blank" },
                url,
              );
              const trailing = document.createTextNode("\u00a0");
              range.insertNode(link);
              link.after(trailing);
              range.setStartAfter(trailing);
              range.collapse(true);
              focusEditorRange(editor, range);
            }
            editor.dispatchEvent(new Event("input", { bubbles: true }));
            captureSelection();
          },
          { once: true },
        );
      },
    });
  };
  const imagePicker = input("docImage", "", "file", {
    accept: "image/*",
    hidden: true,
    disabled: !editable,
    "aria-label": "选择要上传的图片",
    onchange: async (event) => {
      const picker = event.currentTarget;
      const file = picker.files?.[0];
      if (!file) return;
      if (!/^image\//iu.test(file.type)) {
        toast("请选择有效的图片文件。", true);
        picker.value = "";
        return;
      }
      const uploadRange =
        editorSelectionRange(editor)?.cloneRange() || savedRange?.cloneRange();
      uploading = true;
      updateToolbar();
      try {
        const asset = await uploadAssetBase64(file, "attachment");
        const assetId = asset?.asset?.asset_id || asset?.asset_id;
        if (typeof assetId !== "string" || !assetId)
          throw new Error("图片上传响应缺少 asset_id。");
        if (!editor.isConnected) return;
        const range = focusEditorRange(editor, uploadRange);
        const image = h("img", {
          src: `/api/v1/assets/${encodeURIComponent(assetId)}`,
          alt: file.name,
          loading: "lazy",
        });
        range.deleteContents();
        range.insertNode(image);
        range.setStartAfter(image);
        range.collapse(true);
        focusEditorRange(editor, range);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
        captureSelection();
        toast("图片已上传并插入");
      } catch (error) {
        toast(errorMessage(error), true);
      } finally {
        uploading = false;
        picker.value = "";
        updateToolbar();
      }
    },
  });
  const uploadButton = iconTool("upload", "上传图片", () => {
    if (!editable) return;
    if (editorSelectionRange(editor)) captureSelection();
    imagePicker.value = "";
    imagePicker.click();
  });
  const toolbar = h(
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
    commandTool(
      "bold",
      iconTool("bold", "加粗", () => runCommand("bold")),
    ),
    commandTool(
      "italic",
      textTool("I", "斜体", () => runCommand("italic"), "italic"),
    ),
    commandTool(
      "underline",
      textTool("U", "下划线", () => runCommand("underline"), "underline"),
    ),
    commandTool(
      "strikeThrough",
      textTool("S", "删除线", () => runCommand("strikeThrough"), "strike"),
    ),
    h("span", { class: "divider" }),
    commandTool(
      "insertUnorderedList",
      iconTool("list", "无序列表", () => runCommand("insertUnorderedList")),
    ),
    commandTool(
      "insertOrderedList",
      textTool("1.", "有序列表", () => runCommand("insertOrderedList")),
    ),
    commandTool(
      "blockquote",
      textTool("引用", "引用", () => runCommand("formatBlock", "blockquote")),
    ),
    textTool("链接", "插入链接", openLinkModal),
    h("span", { class: "divider" }),
    iconTool("board", "插入 3×3 表格", insertTable),
    uploadButton,
    imagePicker,
    h("span", { class: "divider" }),
    h(
      "span",
      {
        class: "rich-editor-table-tools",
        role: "group",
        "aria-label": "当前表格操作",
      },
      tableTool("+行", "当前表格上方插入行", "row-above"),
      tableTool("+行", "当前表格下方插入行", "row-below"),
      tableTool("−行", "删除当前行", "row-delete"),
      tableTool("+列", "当前列左侧插入列", "column-left"),
      tableTool("+列", "当前列右侧插入列", "column-right"),
      tableTool("−列", "删除当前列", "column-delete"),
    ),
  );
  const onSelectionChange = () => {
    if (!editor.isConnected) {
      document.removeEventListener("selectionchange", onSelectionChange);
      return;
    }
    captureSelection();
  };
  document.addEventListener("selectionchange", onSelectionChange);
  for (const eventName of ["focus", "keyup", "mouseup", "input"])
    editor.addEventListener(eventName, captureSelection);
  updateToolbar();
  return toolbar;
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
function renderDocumentEditor(view) {
  const doc = state.documents.find(
    (entry) => entry.doc_id === state.selectedDocument,
  );
  if (!doc) {
    view.append(emptyState("文档不存在", "返回文档中心。"));
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
  const watermark = h("div", {
    class: `editor-surface watermark ${doc.watermark_profile}`,
    dataset: {
      watermark: `${memberName(doc.owner)} · ${fmtDateTime(Date.now())}\n${doc.watermark_profile === "confidential" ? "机密" : "内部"}`,
    },
  });
  let readContent = () => doc.body_text || "";
  if (doc.kind === "doc") {
    const editor = h("div", {
      class: "rich-editor",
      contenteditable: editable ? "true" : "false",
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": "富文本正文",
      onpaste: (event) => {
        event.preventDefault();
        document.execCommand(
          "insertText",
          false,
          event.clipboardData.getData("text/plain"),
        );
      },
      ondrop: (event) => event.preventDefault(),
    });
    editor.replaceChildren(...sanitizedDocFragment(doc.body_text || ""));
    readContent = () => {
      const safe = document.createElement("div");
      safe.append(...sanitizedDocFragment(editor.innerHTML));
      return safe.innerHTML;
    };
    watermark.append(richDocToolbar(editor, editable), editor);
  } else if (doc.kind === "sheet") {
    const sheetEditor = renderSheetEditor(doc, editable, latestSeq, status);
    readContent = sheetEditor.readContent;
    watermark.append(sheetEditor.element);
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
    watermark.append(
      h(
        "div",
        { class: "editor-toolbar" },
        h("span", {
          class: "muted small-text",
          text: "每行一个节点，用两个空格缩进表示层级",
        }),
      ),
      preview,
      outline,
    );
  } else {
    const editor = textarea("markdownBody", doc.body_text || "", {
      class: "markdown-editor",
      "aria-label": "Markdown 正文",
      disabled: !editable,
    });
    readContent = () => editor.value;
    watermark.append(editor);
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
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader(
        doc.title,
        `${labels[doc.kind]} · ${memberName(doc.owner)} · 更新于 ${fmtDateTime(doc.updated_at)}`,
        [
          button(
            "返回文档中心",
            () => {
              state.selectedDocument = null;
              renderList();
              renderMain();
            },
            "small",
          ),
          button("导出", () => exportDocumentModal(doc), "small"),
          button("软删除", () => softDeleteDocument(doc), "danger small"),
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
        ],
      ),
      state.draft
        ? banner(
            "检测到这份文档的本地草稿。云端基线未改变时可恢复。",
            "warning",
            null,
          )
        : null,
      state.draft
        ? h(
            "div",
            { class: "actions" },
            button("恢复本地草稿", () =>
              restoreDraft(doc, watermark, title, status),
            ),
            button("丢弃草稿", () => {
              removeDraft(doc.doc_id);
              state.draft = null;
              renderMain();
            }),
          )
        : null,
      h(
        "div",
        { class: "doc-layout" },
        h(
          "section",
          { class: "card editor-card" },
          h(
            "div",
            { class: "editor-header" },
            title,
            h("p", {
              class: "muted small-text",
              text: `水印：${doc.watermark_profile === "none" ? "无" : doc.watermark_profile === "internal" ? "内部" : "机密"} · 有效权限：${labels[doc.my_tier] || "所有者"}`,
            }),
          ),
          watermark,
          h(
            "div",
            { class: "editor-status" },
            status,
            h("span", { class: "spacer" }),
            h("span", { text: "Ctrl / Cmd + S 保存" }),
          ),
          h(
            "aside",
            { class: "side-stack" },
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
                        await request(
                          `/documents/${encodeURIComponent(doc.doc_id)}`,
                          {
                            method: "PATCH",
                            body: { watermark_profile: event.target.value },
                          },
                        );
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
                    ...state.groups.map((group) => [
                      group.group_id,
                      group.title,
                    ]),
                  ],
                  doc.group_id || "",
                  {
                    onchange: async (event) => {
                      try {
                        await request(
                          `/documents/${encodeURIComponent(doc.doc_id)}`,
                          {
                            method: "PATCH",
                            body: { group_id: event.target.value || null },
                          },
                        );
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
          ),
        ),
      ),
    ),
  );
}
const SHEET_LIMITS = { sheets: 32, rows: 2000, columns: 256, cells: 100000 };
const SHEET_COLUMN_NAME = (index) => {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
};
const sheetRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function validateSheetName(name, sheets, current = -1) {
  if (typeof name !== "string" || !name.trim() || name.length > 31)
    throw new Error("工作表名称必须为非空字符串，且不超过 31 个字符。");
  if ([...name].some((character) => character.charCodeAt(0) < 32))
    throw new Error("工作表名称不能含控制字符。");
  if (
    sheets.some(
      (sheet, index) =>
        index !== current && sheet.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw new Error("工作表名称不能重复（不区分大小写）。");
}
function parseSheetRows(value) {
  if (!Array.isArray(value) || value.length > SHEET_LIMITS.rows)
    throw new Error(`rows 必须是数组，且每表不超过 ${SHEET_LIMITS.rows} 行。`);
  let count = 0;
  const rows = value.map((row) => {
    if (!Array.isArray(row) || row.length > SHEET_LIMITS.columns)
      throw new Error(`每行必须是数组，且不超过 ${SHEET_LIMITS.columns} 列。`);
    count += row.length;
    if (count > SHEET_LIMITS.cells)
      throw new Error(`单表单元格总数不能超过 ${SHEET_LIMITS.cells}。`);
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
      return cell === null ? "" : String(cell);
    });
  });
  const width = Math.max(3, ...rows.map((row) => row.length));
  return rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
}
function parseSheetMetadata(raw, columns) {
  const metadata = {};
  if (raw.sort !== undefined) {
    if (
      !sheetRecord(raw.sort) ||
      !Number.isInteger(raw.sort.column) ||
      raw.sort.column < 0 ||
      raw.sort.column >= SHEET_LIMITS.columns ||
      !["asc", "desc"].includes(raw.sort.direction)
    )
      throw new Error("sort 必须是 {column,direction:asc|desc}。");
    metadata.sort = { column: raw.sort.column, direction: raw.sort.direction };
  }
  if (raw.filter !== undefined) {
    if (
      !sheetRecord(raw.filter) ||
      !Number.isInteger(raw.filter.column) ||
      raw.filter.column < 0 ||
      raw.filter.column >= SHEET_LIMITS.columns ||
      !["text", "number"].includes(raw.filter.mode) ||
      typeof raw.filter.query !== "string" ||
      raw.filter.query.length > 256
    )
      throw new Error("filter 必须是 {column,mode:text|number,query}。");
    if (
      raw.filter.mode === "number" &&
      raw.filter.operator !== undefined &&
      !["eq", "gt", "lt", "gte", "lte"].includes(raw.filter.operator)
    )
      throw new Error("数字筛选 operator 无效。");
    metadata.filter = {
      column: raw.filter.column,
      mode: raw.filter.mode,
      query: raw.filter.query,
      ...(raw.filter.mode === "number"
        ? { operator: raw.filter.operator || "eq" }
        : {}),
    };
  }
  if (raw.conditional !== undefined) {
    if (!Array.isArray(raw.conditional) || raw.conditional.length > 64)
      throw new Error("conditional 必须是规则数组，且不超过 64 条。");
    metadata.conditional = raw.conditional.map((rule) => {
      if (
        !sheetRecord(rule) ||
        !Number.isInteger(rule.column) ||
        rule.column < 0 ||
        rule.column >= columns ||
        !["gt", "lt", "eq", "contains"].includes(rule.operator) ||
        typeof rule.value !== "string" ||
        rule.value.length > 256 ||
        !/^#[0-9a-f]{6}$/iu.test(rule.color)
      )
        throw new Error("条件格式规则无效（column/operator/value/color）。");
      return {
        column: rule.column,
        operator: rule.operator,
        value: rule.value,
        color: rule.color,
      };
    });
  }
  return metadata;
}
function parseSheetStyles(raw, rows) {
  if (!Array.isArray(raw) || raw.length > rows.length)
    throw new Error("styles 必须是与 rows 对齐的二维数组。");
  return raw.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length > rows[rowIndex].length)
      throw new Error("styles 每行不能超过对应 rows 的列数。");
    return row.map((value) => {
      if (value === null) return null;
      if (!sheetRecord(value))
        throw new Error("styles 每格必须是对象或 null。");
      const style = {};
      for (const key of ["bold", "italic"])
        if (value[key] !== undefined) {
          if (typeof value[key] !== "boolean")
            throw new Error(`styles.${key} 必须是布尔值。`);
          style[key] = value[key];
        }
      for (const key of ["fill", "color"])
        if (value[key] !== undefined) {
          if (
            typeof value[key] !== "string" ||
            !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value[key])
          )
            throw new Error(`styles.${key} 必须是十六进制颜色。`);
          style[key] = value[key];
        }
      if (value.numFmt !== undefined) {
        if (typeof value.numFmt !== "string" || value.numFmt.length > 100)
          throw new Error("styles.numFmt 无效。");
        style.numFmt = value.numFmt;
      }
      if (value.align !== undefined) {
        if (!sheetRecord(value.align))
          throw new Error("styles.align 必须是对象。");
        const align = {};
        for (const key of ["horizontal", "vertical"])
          if (value.align[key] !== undefined) {
            if (
              ![
                "left",
                "center",
                "right",
                "justify",
                "top",
                "middle",
                "bottom",
                "distributed",
                "fill",
              ].includes(value.align[key])
            )
              throw new Error(`styles.align.${key} 无效。`);
            align[key] = value.align[key];
          }
        for (const key of [
          "wrapText",
          "shrinkToFit",
          "indent",
          "textRotation",
          "readingOrder",
        ])
          if (value.align[key] !== undefined) align[key] = value.align[key];
        style.align = align;
      }
      if (value.border !== undefined) {
        if (typeof value.border === "string") {
          if (!SHEET_BORDER_STYLES.has(value.border))
            throw new Error("styles.border 样式无效。");
          style.border = value.border;
        } else if (sheetRecord(value.border)) {
          const border = {};
          for (const side of ["top", "left", "bottom", "right"]) {
            const rawSide = value.border[side];
            if (rawSide === undefined) continue;
            if (
              !sheetRecord(rawSide) ||
              !SHEET_BORDER_STYLES.has(rawSide.style)
            )
              throw new Error("styles.border 边框样式无效。");
            border[side] = { style: rawSide.style };
            if (rawSide.color !== undefined) {
              if (
                typeof rawSide.color !== "string" ||
                !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(rawSide.color)
              )
                throw new Error("styles.border.color 无效。");
              border[side].color = rawSide.color;
            }
          }
          style.border = border;
        } else throw new Error("styles.border 必须是边框对象或样式名。");
      }
      return style;
    });
  });
}
const SHEET_BORDER_STYLES = new Set([
  "thin",
  "dashed",
  "dotted",
  "medium",
  "thick",
  "double",
  "hair",
  "mediumDashed",
  "mediumDashDot",
  "mediumDashDotDot",
  "slantDashDot",
  "dashDot",
  "dashDotDot",
]);
function sheetCellCss(style, highlight) {
  if (!style && !highlight) return "";
  const declarations = [];
  if (style?.bold) declarations.push("font-weight:700");
  if (style?.italic) declarations.push("font-style:italic");
  if (style?.color) declarations.push(`color:${style.color}`);
  if (highlight || style?.fill)
    declarations.push(`background:${highlight || style.fill}`);
  if (style?.align?.horizontal)
    declarations.push(`text-align:${style.align.horizontal}`);
  if (style?.align?.vertical)
    declarations.push(`vertical-align:${style.align.vertical}`);
  if (style?.align?.wrapText) declarations.push("white-space:normal");
  else declarations.push("white-space:nowrap");
  const widths = {
    hair: 1,
    thin: 1,
    dotted: 1,
    dashed: 1,
    medium: 2,
    thick: 3,
    double: 3,
  };
  const border =
    typeof style?.border === "string"
      ? {
          top: { style: style.border },
          left: { style: style.border },
          bottom: { style: style.border },
          right: { style: style.border },
        }
      : style?.border;
  for (const side of ["top", "left", "bottom", "right"]) {
    const value = border?.[side];
    if (!value) continue;
    const line =
      value.style.includes("Dashed") || value.style.includes("dash")
        ? "dashed"
        : value.style === "dotted"
          ? "dotted"
          : "solid";
    declarations.push(
      `border-${side}:${widths[value.style] || 1}px ${line} ${value.color || "#94a3b8"}`,
    );
  }
  return declarations.join(";");
}
function parseSheet(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("表格正文必须是合法 JSON。");
  }
  if (Array.isArray(value))
    return [{ name: "Sheet1", rows: parseSheetRows(value) }];
  if (
    !sheetRecord(value) ||
    !Array.isArray(value.sheets) ||
    !value.sheets.length
  )
    throw new Error("表格正文必须是二维数组或 {sheets:[{name,rows}]}。");
  if (value.sheets.length > SHEET_LIMITS.sheets)
    throw new Error(`工作表数量不能超过 ${SHEET_LIMITS.sheets}。`);
  const sheets = value.sheets.map((raw) => {
    if (!sheetRecord(raw) || !("rows" in raw))
      throw new Error("每个工作表必须包含 name 与 rows。");
    return { name: raw.name, rows: parseSheetRows(raw.rows) };
  });
  sheets.forEach((sheet, index) => {
    validateSheetName(sheet.name, sheets, index);
  });
  return value.sheets.map((raw, index) => ({
    ...sheets[index],
    ...parseSheetMetadata(raw, sheets[index].rows[0]?.length || 3),
    ...(raw.styles === undefined
      ? {}
      : { styles: parseSheetStyles(raw.styles, sheets[index].rows) }),
  }));
}
function serializeSheet(sheets) {
  return JSON.stringify({
    sheets: sheets.map(({ name, rows, sort, filter, conditional, styles }) => ({
      name,
      rows,
      ...(sort ? { sort } : {}),
      ...(filter ? { filter } : {}),
      ...(conditional?.length ? { conditional } : {}),
      ...(styles ? { styles } : {}),
    })),
  });
}
function sheetNumericValue(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value.trim())
    ? Number(value)
    : null;
}
function sheetFormulaNumber(value) {
  const number = sheetNumericValue(value);
  if (number === null || !Number.isFinite(number)) throw new Error("number");
  return number;
}
const SHEET_CYCLE = Symbol("sheet-cycle");
const SHEET_FORMULA_FUNCTIONS = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
  "ROUND",
]);
function tokenizeSheetFormula(source) {
  const tokens = [];
  let offset = 0;
  const cellPattern = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)/u;
  const cell = () => {
    const match = cellPattern.exec(source.slice(offset));
    if (!match) throw new Error("reference");
    const column = match[1]
      .toUpperCase()
      .split("")
      .reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
    offset += match[0].length;
    return { column: column - 1, row: Number(match[2]) - 1 };
  };
  while (offset < source.length) {
    const rest = source.slice(offset);
    if (/^\s/u.test(rest)) {
      offset += 1;
      continue;
    }
    let match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/iu.exec(rest);
    if (match) {
      tokens.push({ type: "number", value: Number(match[0]) });
      offset += match[0].length;
      continue;
    }
    if (rest.startsWith("'")) {
      match = /^'((?:[^']|'')+)'/u.exec(rest);
      if (!match) throw new Error("sheet reference");
      const sheet = match[1].replaceAll("''", "'");
      offset += match[0].length;
      if (source[offset] !== "!") throw new Error("sheet reference");
      offset += 1;
      tokens.push({ type: "reference", sheet, ...cell() });
      continue;
    }
    match = /^([A-Za-z_\u0080-\uffff][A-Za-z0-9_.\u0080-\uffff ]*)!/u.exec(
      rest,
    );
    if (match) {
      offset += match[0].length;
      tokens.push({ type: "reference", sheet: match[1].trim(), ...cell() });
      continue;
    }
    match = cellPattern.exec(rest);
    if (match) {
      tokens.push({ type: "reference", sheet: null, ...cell() });
      continue;
    }
    match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest);
    if (match) {
      tokens.push({ type: "name", value: match[0].toUpperCase() });
      offset += match[0].length;
      continue;
    }
    if (/^[+\-*/():,]/u.test(rest)) {
      tokens.push({ type: rest[0] });
      offset += 1;
      continue;
    }
    throw new Error("token");
  }
  if (!tokens.length || tokens.length > 512) throw new Error("formula size");
  return tokens;
}
class SheetFormulaParser {
  constructor(source) {
    this.tokens = tokenizeSheetFormula(source);
    this.offset = 0;
    this.depth = 0;
  }
  peek(type) {
    return this.tokens[this.offset]?.type === type;
  }
  take(type) {
    if (!this.peek(type)) throw new Error(type);
    return this.tokens[this.offset++];
  }
  parse() {
    const expression = this.additive();
    if (this.offset !== this.tokens.length) throw new Error("trailing");
    return expression;
  }
  additive() {
    let node = this.multiplicative();
    while (this.peek("+") || this.peek("-")) {
      const operator = this.tokens[this.offset++].type;
      node = {
        type: "binary",
        operator,
        left: node,
        right: this.multiplicative(),
      };
    }
    return node;
  }
  multiplicative() {
    let node = this.unary();
    while (this.peek("*") || this.peek("/")) {
      const operator = this.tokens[this.offset++].type;
      node = { type: "binary", operator, left: node, right: this.unary() };
    }
    return node;
  }
  unary() {
    if (this.peek("+") || this.peek("-")) {
      const operator = this.tokens[this.offset++].type;
      if (++this.depth > 64) throw new Error("depth");
      const node = { type: "unary", operator, value: this.unary() };
      this.depth -= 1;
      return node;
    }
    return this.primary();
  }
  primary() {
    if (this.peek("(")) {
      this.take("(");
      if (++this.depth > 64) throw new Error("depth");
      const node = this.additive();
      this.depth -= 1;
      this.take(")");
      return node;
    }
    const token = this.tokens[this.offset++];
    if (token?.type === "number") return { type: "number", value: token.value };
    if (token?.type === "reference") {
      if (this.peek(":")) {
        this.take(":");
        const end = this.take("reference");
        if (end.sheet && end.sheet !== token.sheet)
          throw new Error("range sheet");
        return {
          type: "range",
          sheet: token.sheet,
          start: token,
          end,
        };
      }
      return { type: "reference", sheet: token.sheet, ...token };
    }
    if (token?.type === "name") {
      if (!SHEET_FORMULA_FUNCTIONS.has(token.value))
        throw new Error("function");
      this.take("(");
      const args = [];
      if (!this.peek(")")) {
        args.push(this.additive());
        while (this.peek(",")) {
          this.take(",");
          args.push(this.additive());
        }
      }
      this.take(")");
      if (
        !args.length ||
        args.length > 64 ||
        (token.value === "ROUND" && (args.length < 1 || args.length > 2)) ||
        (token.value !== "ROUND" && token.value !== "SUM" && args.length !== 1)
      )
        throw new Error("arguments");
      return { type: "function", name: token.value, args };
    }
    throw new Error("expression");
  }
}
function createSheetEvaluator(sheets) {
  const cache = new Map();
  const visiting = new Set();
  let work = 0;
  const cellValue = (sheetIndex, row, column) => {
    const sheet = sheets[sheetIndex];
    if (!sheet || row < 0 || column < 0) return { value: 0 };
    const key = `${sheetIndex}:${row}:${column}`;
    if (visiting.has(key)) throw SHEET_CYCLE;
    if (cache.has(key)) return cache.get(key);
    if (++work > 100000) throw new Error("formula work");
    visiting.add(key);
    try {
      const raw = sheet.rows[row]?.[column] ?? "";
      let result;
      if (!raw.startsWith("="))
        result = { value: sheetNumericValue(raw) ?? raw };
      else {
        try {
          if (raw.length > 4096) throw new Error("formula size");
          const ast = new SheetFormulaParser(raw.slice(1).trim()).parse();
          const evaluate = (node) => {
            if (node.type === "number") return node.value;
            if (node.type === "unary") {
              const value = sheetFormulaNumber(evaluate(node.value));
              return node.operator === "-" ? -value : value;
            }
            if (node.type === "binary") {
              const left = sheetFormulaNumber(evaluate(node.left));
              const right = sheetFormulaNumber(evaluate(node.right));
              if (node.operator === "+") return left + right;
              if (node.operator === "-") return left - right;
              if (node.operator === "*") return left * right;
              if (right === 0) throw new Error("division");
              return left / right;
            }
            if (node.type === "reference") {
              const target = node.sheet
                ? sheets.findIndex(
                    (entry) =>
                      entry.name.toLowerCase() === node.sheet.toLowerCase(),
                  )
                : sheetIndex;
              if (target < 0) throw new Error("sheet");
              const value = cellValue(target, node.row, node.column);
              if (value.error) throw value.error;
              return value.value;
            }
            if (node.type === "range") {
              const target = node.sheet
                ? sheets.findIndex(
                    (entry) =>
                      entry.name.toLowerCase() === node.sheet.toLowerCase(),
                  )
                : sheetIndex;
              if (target < 0) throw new Error("sheet");
              if (
                node.start.row > node.end.row ||
                node.start.column > node.end.column ||
                (node.end.row - node.start.row + 1) *
                  (node.end.column - node.start.column + 1) >
                  10000
              )
                throw new Error("range");
              const values = [];
              for (let row = node.start.row; row <= node.end.row; row += 1)
                for (
                  let column = node.start.column;
                  column <= node.end.column;
                  column += 1
                ) {
                  const value = cellValue(target, row, column);
                  if (value.error) throw value.error;
                  values.push(value.value);
                }
              return values;
            }
            const evaluatedArgs = node.args.map(evaluate);
            const args = evaluatedArgs.flat();
            if (node.name === "ROUND") {
              const number = sheetFormulaNumber(evaluatedArgs[0]);
              const digits =
                evaluatedArgs.length === 2
                  ? sheetFormulaNumber(evaluatedArgs[1])
                  : 0;
              if (!Number.isInteger(digits) || digits < -15 || digits > 15)
                throw new Error("round");
              const factor = 10 ** digits;
              return Math.round((number + Number.EPSILON) * factor) / factor;
            }
            const numbers = args
              .map(sheetNumericValue)
              .filter((value) => value !== null && Number.isFinite(value));
            if (node.name === "SUM")
              return numbers.reduce((sum, value) => sum + value, 0);
            if (node.name === "COUNT") return numbers.length;
            if (!numbers.length) throw new Error("aggregate");
            if (node.name === "AVERAGE")
              return (
                numbers.reduce((sum, value) => sum + value, 0) / numbers.length
              );
            return node.name === "MIN"
              ? Math.min(...numbers)
              : Math.max(...numbers);
          };
          const value = evaluate(ast);
          result = { value: Number.isFinite(value) ? value : String(value) };
        } catch (error) {
          result = { error: error === SHEET_CYCLE ? SHEET_CYCLE : "#ERROR!" };
        }
      }
      cache.set(key, result);
      return result;
    } finally {
      visiting.delete(key);
    }
  };
  return (sheetIndex, row, column) => {
    const result = cellValue(sheetIndex, row, column);
    return result.error === SHEET_CYCLE
      ? "#CYCLE!"
      : result.error || String(result.value ?? "");
  };
}
function renderSheetEditor(doc, editable, latestSeq, status) {
  let sheets = parseSheet(doc.body_text || "[]");
  let active = 0;
  let selection = sheets.map(() => ({ row: 0, column: 0 }));
  let evaluator = createSheetEvaluator(sheets);
  const current = () => sheets[active];
  const width = () => Math.max(3, ...current().rows.map((row) => row.length));
  const cellCount = () =>
    current().rows.reduce((sum, row) => sum + row.length, 0);
  const element = h("div", { class: "sheet-editor" });
  const tabs = h("div", {
    class: "sheet-tabs",
    role: "tablist",
    "aria-label": "工作表",
  });
  const grid = h("div", {
    class: "sheet-grid",
    role: "region",
    "aria-label": "表格数据",
  });
  const json = textarea("sheetJson", "", {
    class: "sheet-json",
    "aria-label": "表格 JSON",
    disabled: !editable,
    spellcheck: false,
  });
  const columnOptions = () =>
    Array.from({ length: width() }, (_, index) =>
      h("option", { value: index, text: `${SHEET_COLUMN_NAME(index)} 列` }),
    );
  const sort = h(
    "select",
    { class: "sheet-control", "aria-label": "排序列", disabled: !editable },
    h("option", { value: "", text: "不排序" }),
    ...columnOptions(),
  );
  const direction = h(
    "select",
    { class: "sheet-control", "aria-label": "排序方向", disabled: !editable },
    h("option", { value: "asc", text: "升序" }),
    h("option", { value: "desc", text: "降序" }),
  );
  const filterColumn = h("select", {
    class: "sheet-control",
    "aria-label": "筛选列",
    disabled: !editable,
  });
  const filterMode = h(
    "select",
    { class: "sheet-control", "aria-label": "筛选类型", disabled: !editable },
    h("option", { value: "text", text: "文本包含" }),
    h("option", { value: "number", text: "数字筛选" }),
  );
  const filterQuery = h("input", {
    class: "sheet-control sheet-filter-query",
    type: "text",
    placeholder: "筛选值",
    "aria-label": "筛选值",
    disabled: !editable,
  });
  const filterNumber = h(
    "select",
    {
      class: "sheet-control",
      "aria-label": "数字筛选条件",
      disabled: !editable,
    },
    h("option", { value: "eq", text: "等于" }),
    h("option", { value: "gt", text: "大于" }),
    h("option", { value: "lt", text: "小于" }),
    h("option", { value: "gte", text: "大于等于" }),
    h("option", { value: "lte", text: "小于等于" }),
  );
  const ruleColumn = h("select", {
    class: "sheet-control",
    "aria-label": "条件格式列",
    disabled: !editable,
  });
  const ruleOperator = h(
    "select",
    {
      class: "sheet-control",
      "aria-label": "条件格式运算符",
      disabled: !editable,
    },
    h("option", { value: "gt", text: "大于" }),
    h("option", { value: "lt", text: "小于" }),
    h("option", { value: "eq", text: "等于" }),
    h("option", { value: "contains", text: "包含" }),
  );
  const ruleValue = h("input", {
    class: "sheet-control",
    type: "text",
    placeholder: "阈值",
    "aria-label": "条件格式阈值",
    disabled: !editable,
  });
  const ruleColor = h("input", {
    class: "sheet-control sheet-color",
    type: "color",
    value: "#fff2a8",
    "aria-label": "条件格式高亮色",
    disabled: !editable,
  });
  const rules = h("div", {
    class: "sheet-rules",
    "aria-label": "条件格式规则",
  });
  const syncJson = () => {
    json.value = JSON.stringify(JSON.parse(serializeSheet(sheets)), null, 2);
  };
  const changed = (message) => {
    evaluator = createSheetEvaluator(sheets);
    status.textContent = `${message} · 基线版本 ${latestSeq}`;
    syncJson();
  };
  const drawTabs = () => {
    tabs.replaceChildren(
      ...sheets.map((sheet, index) =>
        h("button", {
          type: "button",
          class: `sheet-tab${index === active ? " active" : ""}`,
          role: "tab",
          "aria-selected": index === active,
          text: sheet.name,
          onclick: () => {
            active = index;
            drawAll();
          },
        }),
      ),
      button(
        "＋ 新建",
        () => {
          let index = sheets.length + 1;
          let name = `Sheet${index}`;
          while (
            sheets.some(
              (sheet) => sheet.name.toLowerCase() === name.toLowerCase(),
            )
          )
            name = `Sheet${++index}`;
          sheets.push({ name, rows: [["", "", ""]] });
          selection.push({ row: 0, column: 0 });
          active = sheets.length - 1;
          drawAll();
          changed("已新建工作表");
        },
        "small",
        { disabled: !editable || sheets.length >= SHEET_LIMITS.sheets },
      ),
      button(
        "重命名",
        () => {
          const name = window.prompt("工作表名称（1–31 字符）", current().name);
          if (name === null) return;
          try {
            const trimmed = name.trim();
            validateSheetName(trimmed, sheets, active);
            current().name = trimmed;
            evaluator = createSheetEvaluator(sheets);
            drawAll();
            changed("工作表已重命名");
          } catch (error) {
            toast(errorMessage(error), true);
          }
        },
        "small",
        { disabled: !editable },
      ),
      button(
        "删除",
        () => {
          if (sheets.length <= 1) {
            toast("至少需要保留一张工作表。", true);
            return;
          }
          sheets.splice(active, 1);
          selection.splice(active, 1);
          active = Math.max(0, active - 1);
          drawAll();
          changed("工作表已删除");
        },
        "small",
        { disabled: !editable || sheets.length <= 1 },
      ),
    );
  };
  const visibleRows = () => {
    const sheet = current();
    const result = sheet.rows.map((row, index) => ({ row, index }));
    if (sheet.filter?.query) {
      const filter = sheet.filter;
      result.splice(
        0,
        result.length,
        ...result.filter(({ index }) => {
          const value = evaluator(active, index, filter.column);
          if (filter.mode === "number") {
            const query = sheetNumericValue(filter.query);
            const number = sheetNumericValue(value);
            if (query === null || number === null) return false;
            if (filter.operator === "gt") return number > query;
            if (filter.operator === "lt") return number < query;
            if (filter.operator === "gte") return number >= query;
            if (filter.operator === "lte") return number <= query;
            return number === query;
          }
          return value.toLowerCase().includes(filter.query.toLowerCase());
        }),
      );
    }
    if (sheet.sort) {
      const { column, direction: order } = sheet.sort;
      result.sort((left, right) => {
        const a = evaluator(active, left.index, column);
        const b = evaluator(active, right.index, column);
        const numericA = sheetNumericValue(a);
        const numericB = sheetNumericValue(b);
        const compared =
          numericA !== null && numericB !== null
            ? numericA - numericB
            : a.localeCompare(b, "zh-CN", { numeric: true });
        return order === "asc" ? compared : -compared;
      });
    }
    return result;
  };
  const ruleColorFor = (column, value) => {
    const matching = current().conditional?.filter((rule) => {
      if (rule.column !== column) return false;
      if (rule.operator === "contains")
        return value.toLowerCase().includes(rule.value.toLowerCase());
      if (rule.operator === "eq") return value === rule.value;
      const threshold = sheetNumericValue(rule.value);
      const number = sheetNumericValue(value);
      if (threshold === null || number === null) return false;
      if (rule.operator === "gt") return number > threshold;
      return number < threshold;
    });
    return matching?.at(-1)?.color || "";
  };
  const refreshCells = () => {
    for (const cell of $$("td[data-row]", grid)) {
      const row = Number(cell.dataset.row);
      const column = Number(cell.dataset.column);
      const value = evaluator(active, row, column);
      const output = $(".sheet-formula-value", cell);
      if (output) {
        output.textContent = value;
        output.classList.toggle(
          "sheet-error",
          value === "#CYCLE!" || value === "#ERROR!",
        );
      }
      cell.style.backgroundColor = ruleColorFor(column, value);
    }
  };
  const drawControls = () => {
    const sheet = current();
    const pendingColumn = filterColumn.value || "0";
    const pendingMode = filterMode.value;
    const pendingOperator = filterNumber.value;
    sort.replaceChildren(
      h("option", { value: "", text: "不排序" }),
      ...columnOptions(),
    );
    ruleColumn.replaceChildren(...columnOptions());
    filterColumn.replaceChildren(...columnOptions());
    sort.value = sheet.sort ? String(sheet.sort.column) : "";
    direction.value = sheet.sort?.direction || "asc";
    filterColumn.value = String(sheet.filter?.column ?? Number(pendingColumn));
    filterMode.value = sheet.filter?.mode || pendingMode;
    filterNumber.value = sheet.filter?.operator || pendingOperator;
    filterQuery.value = sheet.filter?.query || "";
    rules.replaceChildren(
      ...(sheet.conditional || []).map((rule, index) =>
        h(
          "div",
          { class: "sheet-rule" },
          h("span", {
            class: "sheet-rule-swatch",
            style: `background:${rule.color}`,
          }),
          h("span", {
            text: `${SHEET_COLUMN_NAME(rule.column)} 列 ${{ gt: "大于", lt: "小于", eq: "等于", contains: "包含" }[rule.operator]} ${rule.value}`,
          }),
          button(
            "删除规则",
            () => {
              sheet.conditional.splice(index, 1);
              drawAll();
              changed("条件格式已删除");
            },
            "small",
            { disabled: !editable },
          ),
        ),
      ),
      ...(sheet.conditional?.length
        ? []
        : [h("span", { class: "muted small-text", text: "无条件格式规则" })]),
    );
  };
  const drawGrid = () => {
    const columns = width();
    const selected = selection[active];
    selected.column = Math.min(selected.column, columns - 1);
    const table = h(
      "table",
      { class: "sheet-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { text: "#", scope: "col" }),
          ...Array.from({ length: columns }, (_, column) =>
            h("th", {
              scope: "col",
              class: selection[active].column === column ? "selected" : "",
              text: SHEET_COLUMN_NAME(column),
              "aria-selected": selection[active].column === column,
              onclick: () => {
                selection[active].column = column;
                drawGrid();
              },
            }),
          ),
        ),
      ),
      h(
        "tbody",
        null,
        ...visibleRows().map(({ row, index }) =>
          h(
            "tr",
            { class: selection[active].row === index ? "selected" : "" },
            h("th", {
              scope: "row",
              text: index + 1,
              onclick: () => {
                selection[active].row = index;
                drawGrid();
              },
            }),
            ...Array.from({ length: columns }, (_, column) => {
              const raw = row[column] ?? "";
              const value = evaluator(active, index, column);
              return h(
                "td",
                {
                  dataset: { row: index, column },
                  style: sheetCellCss(
                    current().styles?.[index]?.[column],
                    ruleColorFor(column, value),
                  ),
                  onclick: () => {
                    selection[active] = { row: index, column };
                    for (const entry of $$("tr", grid))
                      entry.classList.toggle(
                        "selected",
                        Number(entry.querySelector("th")?.textContent) ===
                          index + 1,
                      );
                  },
                },
                raw.startsWith("=")
                  ? h("span", {
                      class: `sheet-formula-value${value === "#ERROR!" || value === "#CYCLE!" ? " sheet-error" : ""}`,
                      text: value,
                      title: raw,
                    })
                  : null,
                h("input", {
                  type: "text",
                  class: "sheet-cell-input",
                  value: raw,
                  disabled: !editable,
                  "aria-label": `${current().name} 第 ${index + 1} 行第 ${column + 1} 列`,
                  onfocus: () => {
                    selection[active] = { row: index, column };
                  },
                  oninput: (event) => {
                    row[column] = event.target.value;
                    evaluator = createSheetEvaluator(sheets);
                    refreshCells();
                    changed("已编辑");
                  },
                }),
              );
            }),
          ),
        ),
        ...(current().rows.length && !visibleRows().length
          ? [
              h(
                "tr",
                null,
                h("td", {
                  class: "sheet-empty",
                  colspan: columns + 1,
                  text: "没有符合筛选条件的行",
                }),
              ),
            ]
          : []),
      ),
    );
    grid.replaceChildren(table);
  };
  const drawAll = () => {
    evaluator = createSheetEvaluator(sheets);
    drawTabs();
    drawControls();
    drawGrid();
    syncJson();
    for (const item of $$("button", toolbar)) {
      if (item.textContent === "添加行")
        item.disabled =
          !editable ||
          current().rows.length >= SHEET_LIMITS.rows ||
          cellCount() + width() > SHEET_LIMITS.cells;
      else if (item.textContent === "添加列")
        item.disabled =
          !editable ||
          width() >= SHEET_LIMITS.columns ||
          cellCount() + current().rows.length > SHEET_LIMITS.cells;
    }
    const clear = $(".sheet-view-controls button", element);
    if (clear)
      clear.disabled = !editable || (!current().sort && !current().filter);
  };
  sort.addEventListener("change", () => {
    if (!sort.value) delete current().sort;
    else
      current().sort = {
        column: Number(sort.value),
        direction: direction.value,
      };
    drawAll();
    changed("排序已更新（不改变原始数据）");
  });
  direction.addEventListener("change", () => {
    if (sort.value)
      current().sort = {
        column: Number(sort.value),
        direction: direction.value,
      };
    drawAll();
    changed("排序已更新（不改变原始数据）");
  });
  const applyFilter = () => {
    if (!filterQuery.value) delete current().filter;
    else
      current().filter = {
        column: Number(filterColumn.value || 0),
        mode: filterMode.value,
        query: filterQuery.value,
        ...(filterMode.value === "number"
          ? { operator: filterNumber.value }
          : {}),
      };
    drawAll();
    changed("筛选已更新（不改变原始数据）");
  };
  filterColumn.addEventListener("change", applyFilter);
  filterMode.addEventListener("change", applyFilter);
  filterNumber.addEventListener("change", applyFilter);
  filterQuery.addEventListener("input", applyFilter);
  const applyJson = () => {
    try {
      const parsed = parseSheet(json.value);
      sheets = parsed;
      active = 0;
      selection = sheets.map(() => ({ row: 0, column: 0 }));
      drawAll();
      status.textContent = `JSON 已同步 · 基线版本 ${latestSeq}`;
    } catch (error) {
      toast(errorMessage(error), true);
    }
  };
  const selectedCellStyle = () => {
    const selected = selection[active];
    current().styles ??= [];
    current().styles[selected.row] ??= [];
    current().styles[selected.row][selected.column] ??= {};
    return current().styles[selected.row][selected.column];
  };
  const updateSelectedStyle = (patch, message) => {
    Object.assign(selectedCellStyle(), patch);
    drawAll();
    changed(message);
  };
  const toolbar = h(
    "div",
    { class: "editor-toolbar sheet-toolbar" },
    button(
      "添加行",
      () => {
        if (
          current().rows.length >= SHEET_LIMITS.rows ||
          cellCount() + width() > SHEET_LIMITS.cells
        ) {
          toast(
            `单表最多 ${SHEET_LIMITS.rows} 行、${SHEET_LIMITS.cells} 个单元格。`,
            true,
          );
          return;
        }
        current().rows.push(Array(width()).fill(""));
        current().styles ??= [];
        current().styles.push(Array(width()).fill(null));
        drawAll();
        changed("已添加行");
      },
      "small",
      {
        disabled:
          !editable ||
          current().rows.length >= SHEET_LIMITS.rows ||
          cellCount() + width() > SHEET_LIMITS.cells,
      },
    ),
    button(
      "添加列",
      () => {
        if (
          width() >= SHEET_LIMITS.columns ||
          cellCount() + current().rows.length > SHEET_LIMITS.cells
        ) {
          toast(
            `单表最多 ${SHEET_LIMITS.columns} 列、${SHEET_LIMITS.cells} 个单元格。`,
            true,
          );
          return;
        }
        current().rows.forEach((row, index) => {
          row.push("");
          current().styles ??= [];
          current().styles[index] ??= [];
          current().styles[index].push(null);
        });
        drawAll();
        changed("已添加列");
      },
      "small",
      {
        disabled:
          !editable ||
          width() >= SHEET_LIMITS.columns ||
          cellCount() + current().rows.length > SHEET_LIMITS.cells,
      },
    ),
    button(
      "删除选中行",
      () => {
        const row = selection[active].row;
        if (!current().rows[row]) return;
        current().rows.splice(row, 1);
        current().styles?.splice(row, 1);
        selection[active].row = Math.max(0, row - 1);
        drawAll();
        changed("已删除选中行");
      },
      "small",
      { disabled: !editable },
    ),
    button(
      "删除选中列",
      () => {
        const column = selection[active].column;
        current().rows.forEach((row, index) => {
          row.splice(column, 1);
          current().styles?.[index]?.splice(column, 1);
        });
        if (current().conditional) {
          current().conditional = current().conditional.filter(
            (rule) => rule.column !== column,
          );
          current().conditional.forEach((rule) => {
            if (rule.column > column) rule.column -= 1;
          });
        }
        for (const key of ["sort", "filter"]) {
          const metadata = current()[key];
          if (!metadata) continue;
          if (metadata.column === column) delete current()[key];
          else if (metadata.column > column) metadata.column -= 1;
        }
        selection[active].column = Math.max(0, column - 1);
        drawAll();
        changed("已删除选中列");
      },
      "small",
      { disabled: !editable },
    ),
    button(
      "加粗",
      () =>
        updateSelectedStyle({ bold: !selectedCellStyle().bold }, "已切换加粗"),
      "small",
      { disabled: !editable },
    ),
    button(
      "斜体",
      () =>
        updateSelectedStyle(
          { italic: !selectedCellStyle().italic },
          "已切换斜体",
        ),
      "small",
      { disabled: !editable },
    ),
    h(
      "label",
      { class: "sheet-fill-control" },
      "填充",
      h("input", {
        type: "color",
        value: "#fff2a8",
        "aria-label": "选中单元格填充色",
        disabled: !editable,
        onchange: (event) =>
          updateSelectedStyle({ fill: event.target.value }, "已更新填充色"),
      }),
    ),
    button(
      "清除样式",
      () => {
        const selected = selection[active];
        if (current().styles?.[selected.row])
          current().styles[selected.row][selected.column] = null;
        drawAll();
        changed("已清除选中单元格样式");
      },
      "small",
      { disabled: !editable },
    ),
    button("从 JSON 应用", applyJson, "small", { disabled: !editable }),
  );
  element.append(
    tabs,
    toolbar,
    h(
      "div",
      { class: "sheet-view-controls" },
      h("label", null, "排序", sort, direction),
      h(
        "label",
        null,
        "筛选",
        filterColumn,
        filterMode,
        filterNumber,
        filterQuery,
      ),
      button(
        "清除排序/筛选",
        () => {
          delete current().sort;
          delete current().filter;
          drawAll();
          changed("已清除排序与筛选");
        },
        "small",
        { disabled: !editable || (!current().sort && !current().filter) },
      ),
    ),
    h(
      "details",
      { class: "sheet-conditional-details" },
      h("summary", { text: "条件格式" }),
      h(
        "div",
        { class: "sheet-conditional-controls" },
        ruleColumn,
        ruleOperator,
        ruleValue,
        ruleColor,
        button(
          "添加规则",
          () => {
            const column = Number(ruleColumn.value || 0);
            if (!ruleValue.value) {
              toast("请输入条件格式阈值。", true);
              return;
            }
            if (!/^#[0-9a-f]{6}$/iu.test(ruleColor.value)) {
              toast("高亮色必须是六位十六进制颜色。", true);
              return;
            }
            current().conditional ||= [];
            if (current().conditional.length >= 64) return;
            current().conditional.push({
              column,
              operator: ruleOperator.value,
              value: ruleValue.value,
              color: ruleColor.value,
            });
            ruleValue.value = "";
            drawAll();
            changed("条件格式已添加");
          },
          "small",
          { disabled: !editable },
        ),
      ),
      rules,
    ),
    grid,
    h(
      "details",
      { class: "sheet-json-details" },
      h("summary", { text: "JSON 同步（规范 sheets / 兼容旧二维数组）" }),
      h("p", {
        class: "muted small-text sheet-json-hint",
        text: "sort、filter、conditional 随工作表保存；排序与筛选只影响显示。",
      }),
      json,
    ),
  );
  drawAll();
  return { element, readContent: () => serializeSheet(sheets) };
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
  const attrs = new Set(["href", "title", "colspan", "rowspan", "src", "alt"]);
  const clean = (node) => {
    for (const child of [...node.children]) {
      clean(child);
      if (!allowed.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        continue;
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
function restoreDraft(doc, watermark, title, status) {
  title.value = state.draft.title || title.value;
  const body =
    doc.kind === "markdown"
      ? $("textarea", watermark)
      : doc.kind === "mindmap"
        ? $("textarea", watermark)
        : doc.kind === "sheet"
          ? $("#sheetJson", watermark)
          : $(".rich-editor", watermark);
  if (doc.kind === "doc")
    body.replaceChildren(...sanitizedDocFragment(state.draft.body_text || ""));
  else body.value = state.draft.body_text || "";
  watermark.dataset.draftBody = state.draft.body_text || "";
  if (doc.kind === "sheet") {
    const apply = $$("button", watermark).find((item) =>
      item.textContent.includes("从 JSON 应用"),
    );
    apply?.click();
    watermark.dataset.draftBody = state.draft.body_text || "";
  }
  if (doc.kind === "mindmap")
    body.dispatchEvent(new Event("input", { bubbles: true }));
  status.textContent = "已恢复本地草稿，保存后生成新版本";
  if (activeDocumentSession?.docId === doc.doc_id)
    activeDocumentSession.changed();
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
            : emptyState("暂无角色", "Hub 返回了空组织架构。"),
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
          button("导出蓝图", () => exportTalent(selected), "small"),
          ...(selected.source === "builtin"
            ? []
            : [
                button(
                  "下架蓝图",
                  () => unlistTalent(selected),
                  "danger small",
                ),
              ]),
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
        "头像资产 ID（可选）",
        input("avatar_asset_id", "", "text", {
          placeholder: "先通过 assets 上传，勿与种子同时填写",
        }),
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

function renderSettingsHome(view) {
  view.append(
    h(
      "div",
      { class: "page" },
      pageHeader("设置", "管理成员的人设、模型、语气、语音与头像。", [
        button(
          "招聘成员",
          () => {
            state.talentTab = "hire";
            setRoute("talent");
          },
          "primary",
        ),
      ]),
      emptyState(
        "选择要配置的成员",
        "从左侧成员列表选择，或通过通讯录进入成员档案。",
        state.members[0]
          ? button(
              "配置第一位成员",
              () => setRoute("settings", state.members[0].member_id),
              "primary",
            )
          : null,
      ),
    ),
  );
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
          text: "保存种子会替换当前头像；上传图片需先得到 avatar 用途的 asset_id。",
        }),
        h("input", {
          name: "avatar_asset_id",
          type: "text",
          placeholder: "或填写 avatar asset_id",
          "aria-label": "头像资产 ID",
        }),
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
          button(
            "返回设置",
            () => {
              state.settingsMember = null;
              renderList();
              renderMain();
            },
            "small",
          ),
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
  const skills = $$(".skill-row", event.currentTarget).map((row) => ({
    skill_id: $("[name=skill_id]", row).value,
    name: $("[name=skill_name]", row).value,
  }));
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
        enabled: true,
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
  try {
    await request(
      `/members/${encodeURIComponent(state.settingsMember)}/avatar`,
      {
        method: "POST",
        body: assetId
          ? { avatar_asset_id: assetId }
          : { avatar_seed: data.get("avatar_seed").trim() },
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
  setRoute(routes[route] ? route : "messages");
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
    $("#view").replaceChildren(
      h(
        "div",
        { class: "page" },
        banner(errorMessage(error), "error", () => boot()),
        emptyState(
          "工作台暂时无法加载",
          "服务返回错误时不会展示演示数据。请检查同源代理、Hub 与鉴权配置后重试。",
        ),
      ),
    );
    setConnection("down", "服务不可用");
  }
  void connectStream();
}
boot();
