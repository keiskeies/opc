/** 成员 persona 只改变表达，不改变岗位书权限、门禁或事实判据。 */
import { type Persona, personaSchema, TONES, type Tone } from "@opc/contracts";

export type MemberPersona = {
  readonly name: string;
  readonly persona: Persona;
  readonly tone: Tone;
};

const TONE_INSTRUCTIONS: Readonly<Record<Tone, string>> = {
  neutral: "自然、清楚，不刻意表演。",
  steady: "沉稳，先结论后依据。",
  direct: "直接，先说重点，不绕弯。",
  warm: "温和，尊重协作对象，但不模糊事实。",
  precise: "严谨，区分事实、推断与待验证项。",
};

export function memberPersonaPrompt(member: MemberPersona): string {
  const values = member.persona.values.join("、");
  return [
    `你是数字同事「${member.name}」。`,
    `表达语气：${TONE_INSTRUCTIONS[member.tone]}`,
    `表达风格：${member.persona.style}`,
    values === "" ? "" : `价值取向：${values}。`,
    `诚实边界：${member.persona.honesty}`,
    "以上人设只影响表达方式，不得改变岗位书权限、门禁判定、审计署名或客观事实。",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 未来自动会议驱动器复用同一份议程/历史构造，不另写一套提示词口径。 */
export function meetingTurnInstruction(o: {
  readonly topic: string;
  readonly speakerName: string;
  readonly speakingOrder: readonly string[];
  readonly priorTurns: readonly { speaker: string; content: string }[];
}): string {
  const history = o.priorTurns
    .map((turn) => `${turn.speaker}：${turn.content}`)
    .join("\n");
  return [
    `会议议题：${o.topic}`,
    `既定发言顺序：${o.speakingOrder.join(" → ")}`,
    history === "" ? "目前还没有发言。" : `已有发言：\n${history}`,
    `现在轮到你（${o.speakerName}）发言。围绕议题给出明确观点、依据与下一步建议；不要重复他人，不要伪造事实。`,
  ].join("\n");
}

export function parseMemberPersona(raw: unknown): MemberPersona {
  if (typeof raw !== "object" || raw === null)
    throw new Error("成员人设行不是对象。");
  const row = raw as Record<string, unknown>;
  if (typeof row["name"] !== "string" || typeof row["tone"] !== "string") {
    throw new Error("成员人设行缺少 name/tone。");
  }
  if (!(TONES as readonly string[]).includes(row["tone"])) {
    throw new Error("成员 tone 不在契约词表里。");
  }
  const parsed = personaSchema.safeParse(
    JSON.parse(String(row["persona_json"])),
  );
  if (!parsed.success)
    throw new Error(
      "成员 persona_json 不合法：" + parsed.error.issues[0]?.message,
    );
  return { name: row["name"], tone: row["tone"] as Tone, persona: parsed.data };
}
