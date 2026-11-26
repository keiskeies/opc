/* 日 / 夜间主题：两个入口（工作台 group.html 与控制室 index.html）共用这一份。
 *
 * 为什么是模块而不是两份 <script>：配色真值住在 CSS 的 :root 与 .admin-root，
 * 主题只翻一个开关 —— documentElement 的 data-theme 属性。JS 侧只做三件事：
 *   ① 读偏好（localStorage 键 opc:theme，与本仓 opc: 前缀一族对齐，见 group.js STORAGE_KEYS）；
 *   ② 把 data-theme 落到 <html>（CSS 靠 [data-theme="dark"] 换一组 token）；
 *   ③ 把右上角那枚按钮接上（mountThemeToggle 认 [data-theme-toggle]，两个页面各放一枚）。
 *
 * 防闪烁：group.html / index.html 的 <head> 里另有一段【内联】脚本，在浏览器首帧之前
 * 就把 data-theme 设好（内联脚本先于 <link> 样式表渲染执行）。那段脚本与这里读的是
 * 同一个键 opc:theme —— 这一处是模块里的"重放"真值，内联那段是"首帧前"的抄件，
 * 键名只许这一种写法，别改成两个。
 *
 * 无用户显式选择时跟随系统（prefers-color-scheme）；一旦用户点过按钮，就持久化到
 * localStorage，后续以用户选择为准、不再随系统变。这是"做了就要记住"的最小承诺。
 */

const THEME_KEY = "opc:theme";
const DARK = "dark";
const LIGHT = "light";

function root() {
  return document.documentElement;
}

function readStoredTheme() {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === DARK || raw === LIGHT ? raw : null;
  } catch {
    /* 隐私模式 / 禁用存储：读不到就退回系统偏好，本次交互仍可用。 */
    return null;
  }
}

function currentTheme() {
  const v = root().dataset.theme;
  return v === DARK ? DARK : LIGHT;
}

function systemTheme() {
  if (typeof matchMedia === "function") {
    return matchMedia("(prefers-color-scheme: dark)").matches ? DARK : LIGHT;
  }
  return LIGHT;
}

function applyTheme(theme) {
  if (theme === DARK) root().dataset.theme = DARK;
  else delete root().dataset.theme; // 未设 data-theme = 走 :root 的浅色真值
}

/** 初始化：读偏好，无则跟随系统；返回生效的那一档。幂等，可重复调用。 */
export function initTheme() {
  const theme = readStoredTheme() ?? systemTheme();
  applyTheme(theme);
  return theme;
}

function persistTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 持久化失败不阻塞切换，只这一台设备不记住。 */
  }
}

/** 翻转并记住。返回新档。 */
export function toggleTheme() {
  const next = currentTheme() === DARK ? LIGHT : DARK;
  applyTheme(next);
  persistTheme(next);
  syncThemeButtons();
  return next;
}

/* 未显式选择过时，让系统外观变化能带动主题（切过按钮后就不再跟随，尊重用户）。 */
function watchSystem() {
  if (typeof matchMedia !== "function") return;
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const on = (e) => {
    if (readStoredTheme() === null) {
      applyTheme(e.matches ? DARK : LIGHT);
      syncThemeButtons();
    }
  };
  mq.addEventListener?.("change", on);
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SUN_PATH =
  "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z";
const MOON_PATH = "M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5Z";

function themeIcon(theme) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", theme === DARK ? MOON_PATH : SUN_PATH);
  svg.append(path);
  return svg;
}

/** 把当前主题同步到所有 [data-theme-toggle] 按钮的图标与文案。 */
export function syncThemeButtons() {
  const theme = currentTheme();
  const next = theme === DARK ? LIGHT : DARK;
  for (const btn of document.querySelectorAll("[data-theme-toggle]")) {
    btn.replaceChildren();
    btn.append(themeIcon(theme));
    btn.setAttribute(
      "aria-label",
      theme === DARK ? "切换到日间模式" : "切换到夜间模式",
    );
    btn.title = theme === DARK ? "日间" : "夜间";
    btn.dataset.themeState = theme;
    // next 供宿主（可选）渲染文字标签；目前图标即语义，保留在 dataset 上备查。
    btn.dataset.nextTheme = next;
  }
}

/** 给页面上每一枚 [data-theme-toggle] 接上点击。应在 DOM 就绪后调用。 */
export function mountThemeToggle() {
  for (const btn of document.querySelectorAll("[data-theme-toggle]")) {
    btn.addEventListener("click", () => toggleTheme());
  }
  syncThemeButtons();
  watchSystem();
}
