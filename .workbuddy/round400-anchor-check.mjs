// round400：格式化之后重钉变异锚点 —— 只报命中次数，命中数 != 1 就是锚点过期
import { readFileSync } from "node:fs";
const GROUP = "packages/web/public/group.js";
const src = readFileSync(GROUP, "utf8");

const CANDIDATES = {
  "M1-旧版单行写法": '    button("添加技能", () => {',
  "M1b-整块(v2)":
    '    button(\n      "添加技能",\n      () => {\n        skillsEditor.insertBefore(\n          skillSettingsRow(\n            {},\n            { label: "删除这一件技能", onClick: (row) => row.remove() },\n          ),\n          skillsEditor.querySelector("button[type=submit]"),\n        );\n      },\n      "small",\n    ),',
  "M2-技能 append 句":
    '      maxlength: 2000,\n    }),\n  );\n  if (remove)\n    row.append(iconButton("close", remove.label, () => remove.onClick(row)));\n  return row;',
  "M5-执行器 append 句":
    '    config,\n  );\n  if (remove)\n    row.append(iconButton("close", remove.label, () => remove.onClick(row)));\n  return row;',
  "M3-页面技能行撤 DOM":
    '            { label: "删除这一件技能", onClick: (row) => row.remove() },',
  "M6-页面执行器行撤 DOM":
    '            { label: "删除这一档执行器", onClick: (row) => row.remove() },',
  "M4-note 那格": '      ...(note === "" ? {} : { note }),',
  "M7-nextSeq":
    "        const nextSeq = Math.max(0, ...rows.map((el) => Number(el.value))) + 1;",
  "M8-change 监听": '  kind.addEventListener("change", () => {',
  "M9-kind 来源": '        kind: $("[name=executor_kind]", row).value,',
  "M10-enabled 来源":
    '        enabled: $("[name=executor_enabled]", row).checked,',
  "M11-只剩一档": "        member.executors.length > 1",
  "M12-技能 DELETE":
    '      `/members/${encodeURIComponent(memberId)}/skills/${encodeURIComponent(skillId)}`,\n      { method: "DELETE" },',
  "M13-执行器 DELETE":
    '      `/members/${encodeURIComponent(memberId)}/executors/${encodeURIComponent(seq)}`,\n      { method: "DELETE" },',
  "C1-help 文案": "保留 JSON 直接编辑。换「类型」会连带重写下面那份 config 骨架",
  "C2-注释":
    "  // 不给删除钮 —— 与其让用户撞那条 422，不如让界面先长成那个形状。",
};
for (const [k, v] of Object.entries(CANDIDATES)) {
  const n = src.split(v).length - 1;
  console.log(`${n === 1 ? "OK  " : "BAD "} ${n} 次  ${k}`);
}
