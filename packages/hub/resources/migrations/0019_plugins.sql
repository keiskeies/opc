-- 0019_plugins.sql —— 插件与 MCP 平台入口（D14 / 上游 §2.9）
--
-- ── 这张表喂的是谁 ─────────────────────────────────────────────────
-- 两个消费方：① member_executors 里 kind='builtin-plugin' 的执行器（config_json 指向
-- plugin_id），② platform-webhook 执行器的 MCP 客户端（kind='mcp'，endpoint 即 server 地址）。
-- 0001 的 harness_calls 记的是【CLI harness 调用】（claude/codex/qoder 三家适配器），
-- 语义是「一次执行」；plugins 记的是【可插拔能力源】，语义是「一个可探测的端点」。
-- 两张表不可互相替代：一次 harness_call 不指向任何 plugin，一个 plugin 也可以从没被调过。
--
-- ── plugin_tools 为什么要落表而不是每次现探 ────────────────────────
-- 招聘页要展示「这个插件能给成员加什么工具」，而 MCP 的 tools/list 是一次网络往返。
-- 每次渲染都探测 = 招聘页随外部服务健康度抖动。落表 + last_probe_json 记最近一次探测
-- 结果，列表页读表，显式 POST /plugins/:id/probe 才真探。
-- input_schema_json 原样存 MCP 的 JSON Schema，执行器侧 zod 校验用它 —— 契约与 DDL 同源。
--
-- ── 为什么 endpoint 不建唯一索引 ───────────────────────────────────
-- 同一个 MCP server 可能以不同配置装两次（不同 token / 不同工具白名单）。
-- 去重键若取 endpoint，第二次合法安装会炸；config_json 参与唯一性又要求
-- JSON 规范化字节一致，那是个静默失效的假约束（等价配置不同字节 ⇒ 判定为不同）。

CREATE TABLE plugins (
  plugin_id      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('mcp', 'builtin')),
  endpoint       TEXT,                            -- mcp：server URL；builtin：NULL（进程内）
  config_json    TEXT NOT NULL DEFAULT '{}',
  enabled        INTEGER NOT NULL DEFAULT 1,
  installed_at   INTEGER NOT NULL,
  last_probe_json TEXT                            -- 最近一次探测（可空=从未探测）
);

CREATE TABLE plugin_tools (
  plugin_id         TEXT NOT NULL REFERENCES plugins(plugin_id),
  tool_name         TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  input_schema_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (plugin_id, tool_name)
);
