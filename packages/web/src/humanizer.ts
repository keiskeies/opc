/** 真人感呈现：确定性头像、persona 标签与浏览器 Web Speech 音色映射。 */
import type { MemberView, Tone, Voice } from "@opc/contracts";

export type ToneMeta = {
  readonly label: string;
  readonly color: string;
  readonly opening: string;
};

export const TONE_META: Readonly<Record<Tone, ToneMeta>> = {
  neutral: { label: "自然", color: "#64748b", opening: "" },
  steady: { label: "沉稳", color: "#0f766e", opening: "我先把结论说清楚。" },
  direct: { label: "直接", color: "#b45309", opening: "直说重点。" },
  warm: { label: "温和", color: "#be185d", opening: "我们一起看这件事。" },
  precise: { label: "严谨", color: "#4338ca", opening: "按判据逐条核对。" },
};

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** 同一成员/种子永远生成同一头像；不调用外部图片服务，也不把姓名送出去。 */
export function generatedAvatarDataUrl(
  name: string,
  seed: string,
  size = 96,
): string {
  const safeSize = Math.max(32, Math.min(512, Math.round(size)));
  const hash = hashSeed(seed === "" ? name : seed);
  const hue = hash % 360;
  const hue2 = (hue + 38 + (hash % 40)) % 360;
  const initial = Array.from(name.trim())[0] ?? "?";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${safeSize}" height="${safeSize}" viewBox="0 0 96 96">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop stop-color="hsl(${hue} 72% 62%)"/><stop offset="1" stop-color="hsl(${hue2} 68% 42%)"/>` +
    "</linearGradient></defs>" +
    `<rect width="96" height="96" rx="28" fill="url(#g)"/>` +
    `<circle cx="74" cy="20" r="12" fill="white" opacity=".16"/>` +
    `<text x="48" y="59" text-anchor="middle" font-family="system-ui,sans-serif" ` +
    `font-size="42" font-weight="700" fill="white">${escapeXml(initial)}</text></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

export function avatarUrl(
  member: Pick<MemberView, "name"> &
    Partial<Pick<MemberView, "avatar_seed" | "avatar_asset_id">>,
): string {
  const assetId = member.avatar_asset_id;
  return typeof assetId === "string" && assetId !== ""
    ? "/api/v1/assets/" + encodeURIComponent(assetId)
    : generatedAvatarDataUrl(member.name, member.avatar_seed ?? "");
}

export function personaTagline(
  member: Pick<MemberView, "persona" | "tone">,
): string {
  const meta = TONE_META[member.tone];
  const firstSentence =
    member.persona.style.split(/[。！？!?]/u)[0]?.trim() ?? "";
  return firstSentence === "" ? meta.label : `${meta.label} · ${firstSentence}`;
}

/** 朗读前去掉 Markdown 与 @ 标记，避免把语法念出来。 */
export function spokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^[#>*\-\s]+/gmu, "")
    .replace(/@[A-Za-z0-9_\-\p{L}]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export type BrowserVoice = {
  readonly name: string;
  readonly lang: string;
  readonly localService: boolean;
};

export type SpeechSynthesisLike = {
  getVoices(): BrowserVoice[];
  speak(utterance: SpeechSynthesisUtteranceLike): void;
  cancel(): void;
};

export type SpeechSynthesisUtteranceLike = {
  text: string;
  lang: string;
  rate: number;
  pitch: number;
  voice: BrowserVoice | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

function isSynthesis(value: unknown): value is SpeechSynthesisLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "getVoices" in value &&
    typeof value.getVoices === "function" &&
    "speak" in value &&
    typeof value.speak === "function"
  );
}

export function browserSpeech(): SpeechSynthesisLike | undefined {
  const candidate = (globalThis as { speechSynthesis?: unknown })
    .speechSynthesis;
  return isSynthesis(candidate) ? candidate : undefined;
}

export function selectVoice(
  voices: readonly BrowserVoice[],
  voice: Voice | null,
): BrowserVoice | null {
  if (voices.length === 0) return null;
  const lang = voice?.lang ?? "zh-CN";
  const sameLang = voices.filter((item) =>
    item.lang.toLowerCase().startsWith(lang.toLowerCase()),
  );
  const pool = sameLang.length > 0 ? sameLang : voices;
  const hint = voice?.voice_hint?.toLowerCase();
  if (hint !== undefined && hint !== "") {
    const exact = pool.find((item) => item.name.toLowerCase() === hint);
    if (exact !== undefined) return exact;
    const partial = pool.find((item) => item.name.toLowerCase().includes(hint));
    if (partial !== undefined) return partial;
  }
  return pool.find((item) => item.localService) ?? pool[0] ?? null;
}

/** 浏览器不支持/没有音色时明确 reject；UI 可降级为文字，而不是假称已朗读。 */
export function speakWithBrowser(
  synthesis: SpeechSynthesisLike,
  makeUtterance: (options: {
    text: string;
    lang: string;
    rate: number;
    pitch: number;
    voice: BrowserVoice | null;
  }) => SpeechSynthesisUtteranceLike,
  text: string,
  voice: Voice | null,
): Promise<void> {
  const clean = spokenText(text);
  if (clean === "") return Promise.reject(new Error("没有可朗读的文字。"));
  const selected = selectVoice(synthesis.getVoices(), voice);
  return new Promise((resolve, reject) => {
    const utterance = makeUtterance({
      text: clean,
      lang: voice?.lang ?? "zh-CN",
      rate: voice?.rate ?? 1,
      pitch: voice?.pitch ?? 1,
      voice: selected,
    });
    utterance.onend = () => resolve();
    utterance.onerror = () => reject(new Error("浏览器语音合成失败。"));
    synthesis.speak(utterance);
  });
}
