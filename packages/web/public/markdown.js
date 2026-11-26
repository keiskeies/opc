/* 手写 Markdown 渲染器 · 仓库里唯一的 markdown → HTML 出口（group.js 渲染 markdown 正文的预览面）。
 *
 * 为什么不用现成库：本仓零构建 + 依赖全部 vendored 离线（vendor/ 只有 quill 与
 * xspreadsheet），为一个「左编辑右预览」引一个运行时编译器不划算。要换成
 * vendored marked 只改本文件的 renderMarkdown 一处 —— 调用方只认这个出口。
 *
 * ⚠ 安全契约（调用方把用户正文直接灌进来，这里就是唯一的防线）：
 *   整篇先 esc() 再解析 ⇒ 正文里的原始 <script> 永远只是文字；
 *   链接与图片的 URL 只认白名单协议 ⇒ [点我](javascript:…) 得到的是安全链接，不是可执行 href。
 *
 * 支持：#–###### 标题 / ``` 围栏代码 / - * + 与 1. 列表（一层） / > 引用 /
 *       --- ___ *** 分隔线 / 表格 / **粗** __粗__ *斜* _斜_ `行内码` [文字](url) ![alt](url)。
 * 不支持：嵌套列表、HTML 内联、脚注、任务列表、标题锚点。
 */
const escMd = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** 只放行能安全出现在 href/src 里的形态：http(s)、mailto、站内相对路径与 # 锚点。 */
const safeHref = (raw) => {
  const url = String(raw ?? "").trim();
  // 控制字符与空白能用来拆开 javascript: 的字面量（java\tscript:），先剥掉再判协议。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 剥控制符的正则本身必须字面写出码位段，规则警告的性质正是这条防线的用途
  const flat = url.replace(/[\u0000-\u0020\u007f]/gu, "");
  if (/^(?:https?:|mailto:|#|\/|\.\/|\.\.\/)/iu.test(flat)) return url;
  return "#";
};

/** 行内语法：入参是【已转义】的一行，出参允许含标签。 */
function inlineMd(escaped) {
  let s = escaped;
  // 反引号优先：`<b>` 与 *text* 在行内码里保持字面。
  const codes = [];
  s = s.replace(/`([^`]+)`/gu, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 图片先于链接：两者共享 ](...) 外形，反过来会把 ! 甩在方括号外。
  s = s.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/gu,
    (_m, alt, href, title) =>
      `<img src="${safeHref(href)}" alt="${alt}"${
        title ? ` title="${title}"` : ""
      } loading="lazy">`,
  );
  s = s.replace(
    /\[((?:[^\]\\]|\\.)*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/gu,
    (_m, text, href, title) =>
      `<a href="${safeHref(href)}" rel="noopener noreferrer"${
        title ? ` title="${title}"` : ""
      }>${text}</a>`,
  );
  s = s.replace(/ {2,}$/u, "<br>");
  s = s.replace(
    /\*\*([^*]+)\*\*|__([^_]+)__/gu,
    (_m, a, b) => `<strong>${a ?? b}</strong>`,
  );
  s = s.replace(
    /(?:\*|_)(?=\S)((?:[^*_]|\*(?!\s)|_(?!\S))*?)(?<=\S)(?:\*|_)/gu,
    (_m, body) => `<em>${body}</em>`,
  );
  s = s.replace(/~~([^~]+)~~/gu, "<del>$1</del>");
  return s.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 行内码占位哨兵的 U+0000 定界必须字面写出，与写入端成对，换别的字符会与正文撞车
    /\u0000(\d+)\u0000/gu,
    (_m, i) => `<code>${codes[Number(i)]}</code>`,
  );
}

const isTableDivider = (line) =>
  /^[\s|:-]+$/.test(line) && line.includes("-") && line.includes("|");

const cellsOf = (line) =>
  line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim().replace(/\\\|/gu, "|"));

function tableHtml(header, divider, rows) {
  const aligns = cellsOf(divider).map((cell) =>
    cell.startsWith(":") && cell.endsWith(":")
      ? "center"
      : cell.endsWith(":")
        ? "right"
        : cell.startsWith(":")
          ? "left"
          : "",
  );
  const th = cellsOf(header)
    .map(
      (cell, i) =>
        `<th${aligns[i] ? ` align="${aligns[i]}"` : ""}>${inlineMd(cell)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${cellsOf(row)
          .map(
            (cell, i) =>
              `<td${aligns[i] ? ` align="${aligns[i]}"` : ""}>${inlineMd(cell)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function listHtml(items, ordered) {
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${items
    .map((item) => `<li>${inlineMd(item)}</li>`)
    .join("")}</${tag}>`;
}

/**
 * Markdown 文本 → HTML 字符串。
 * @param {string} text 原始正文（未转义）
 * @returns {string} 可直接交给 innerHTML 的片段
 */
export function renderMarkdown(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  const out = [];
  let i = 0;
  let paragraph = [];
  const flush = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.map(inlineMd).join("<br>")}</p>`);
      paragraph = [];
    }
  };
  while (i < lines.length) {
    const raw = escMd(lines[i]);
    // 围栏代码：整段原样，内部不做任何行内解析。
    const fence = /^```+\s*([\w+-]*)\s*$/u.exec(raw);
    if (fence !== null) {
      flush();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```+\s*$/u.test(escMd(lines[i]))) {
        buf.push(escMd(lines[i]));
        i += 1;
      }
      i += 1;
      const cls = fence[1] ? ` class="language-${fence[1]}"` : "";
      out.push(`<pre><code${cls}>${buf.join("\n")}</code></pre>`);
      continue;
    }
    if (raw.trim() === "") {
      flush();
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(raw);
    if (heading !== null) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMd(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^ {0,3}([-*_])\s*(?:\1\s*){2,}$/u.test(raw)) {
      flush();
      out.push("<hr>");
      i += 1;
      continue;
    }
    // 表格：表头行 + 分隔行 + 至少一行数据，三行一起认，避免把普通含 | 的段落当表。
    if (
      raw.includes("|") &&
      i + 2 < lines.length &&
      isTableDivider(escMd(lines[i + 1])) &&
      escMd(lines[i + 2]).includes("|")
    ) {
      flush();
      const header = raw;
      const divider = escMd(lines[i + 1]);
      i += 2;
      const rows = [];
      while (
        i < lines.length &&
        lines[i].includes("|") &&
        lines[i].trim() !== ""
      ) {
        rows.push(escMd(lines[i]));
        i += 1;
      }
      out.push(tableHtml(header, divider, rows));
      continue;
    }
    // 引用标记要在【未转义】的那一行上认：escMd 把 `>` 变成 `&gt;`，拿转义后的 raw 去
    // 匹配 ^ {0,3}> 恒不命中 ⇒ 整段引用会当普通段落渲染（本轮实测撞出来的）。
    // 仍然是「先剥标记、再逐行 esc、最后才进 inlineMd」，转义没有晚一步。
    if (/^ {0,3}>/u.test(lines[i])) {
      flush();
      const buf = [];
      while (i < lines.length && /^ {0,3}>/u.test(lines[i])) {
        buf.push(inlineMd(escMd(lines[i].replace(/^ {0,3}>\s?/u, ""))));
        i += 1;
      }
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
      continue;
    }
    const bullet = /^ {0,3}[-*+]\s+(.+)$/u.exec(raw);
    const numbered = /^ {0,3}\d+[.)]\s+(.+)$/u.exec(raw);
    if (bullet !== null || numbered !== null) {
      flush();
      const ordered = numbered !== null;
      const re = ordered ? /^ {0,3}\d+[.)]\s+(.+)$/u : /^ {0,3}[-*+]\s+(.+)$/u;
      const items = [];
      while (i < lines.length) {
        const escLine = escMd(lines[i]);
        const m = re.exec(escLine);
        if (m === null) break;
        items.push(m[1]);
        i += 1;
      }
      out.push(listHtml(items, ordered));
      continue;
    }
    paragraph.push(raw);
    i += 1;
  }
  flush();
  return out.join("");
}
