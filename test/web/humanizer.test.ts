import { describe, expect, it } from "vitest";
import {
  avatarUrl,
  type BrowserVoice,
  generatedAvatarDataUrl,
  personaTagline,
  type SpeechSynthesisLike,
  type SpeechSynthesisUtteranceLike,
  selectVoice,
  speakWithBrowser,
  spokenText,
} from "../../packages/web/src/humanizer.js";

describe("generated avatars and persona presentation", () => {
  it("generates deterministic escaped SVG avatars without external requests", () => {
    const first = generatedAvatarDataUrl("<script>", "seed", 128);
    expect(first).toBe(generatedAvatarDataUrl("<script>", "seed", 128));
    expect(first).not.toBe(generatedAvatarDataUrl("<script>", "other", 128));
    expect(decodeURIComponent(first)).toContain("&lt;");
    expect(decodeURIComponent(first)).not.toContain("<script>");
    expect(decodeURIComponent(first)).toContain('width="128"');
  });

  it("prefers uploaded assets and otherwise derives from the member seed", () => {
    expect(
      avatarUrl({
        name: "Alice",
        avatar_seed: "alice",
        avatar_asset_id: "asset-1",
      }),
    ).toBe("/api/v1/assets/asset-1");
    expect(
      avatarUrl({ name: "Alice", avatar_seed: "alice", avatar_asset_id: null }),
    ).toContain("data:image/svg+xml");
    expect(avatarUrl({ name: "Talent", avatar_seed: "talent" })).toContain(
      "data:image/svg+xml",
    );
    expect(avatarUrl({ name: "Talent" })).toContain("data:image/svg+xml");
  });

  it("shows tone and the first persona sentence without rewriting the message", () => {
    expect(
      personaTagline({
        tone: "direct",
        persona: { style: "先读代码。再下结论。", values: [], honesty: "实测" },
      }),
    ).toBe("直接 · 先读代码");
    expect(spokenText("# 标题\n**重点** @老板 `code`")).toBe("标题 重点 code");
  });
});

describe("browser speech mapping", () => {
  const voices: BrowserVoice[] = [
    { name: "Chinese Female", lang: "zh-CN", localService: false },
    { name: "Chinese Male", lang: "zh-CN", localService: true },
    { name: "English", lang: "en-US", localService: true },
  ];

  it("uses voice hints, then language/local matches, then any available voice", () => {
    expect(
      selectVoice(voices, {
        lang: "zh-CN",
        rate: 1,
        pitch: 1,
        voice_hint: "Female",
      })?.name,
    ).toBe("Chinese Female");
    expect(
      selectVoice(voices, { lang: "zh-CN", rate: 1, pitch: 1 })?.name,
    ).toBe("Chinese Male");
    expect(
      selectVoice(voices, { lang: "fr-FR", rate: 1, pitch: 1 })?.name,
    ).toBe("Chinese Male");
    expect(selectVoice([], null)).toBeNull();
  });

  it("resolves on speech end and rejects on browser speech failure", async () => {
    const makeSynthesis = (fail: boolean): SpeechSynthesisLike => ({
      getVoices: () => voices,
      cancel: () => {},
      speak: (utterance) => {
        if (fail) utterance.onerror?.();
        else utterance.onend?.();
      },
    });
    const makeUtterance = (options: {
      text: string;
      lang: string;
      rate: number;
      pitch: number;
      voice: BrowserVoice | null;
    }): SpeechSynthesisUtteranceLike => ({
      ...options,
      onend: null,
      onerror: null,
    });
    await expect(
      speakWithBrowser(makeSynthesis(false), makeUtterance, "你好", {
        lang: "zh-CN",
        rate: 1.2,
        pitch: 0.9,
      }),
    ).resolves.toBeUndefined();
    await expect(
      speakWithBrowser(makeSynthesis(true), makeUtterance, "你好", null),
    ).rejects.toThrow(/语音合成失败/u);
    await expect(
      speakWithBrowser(makeSynthesis(false), makeUtterance, " @老板 ", null),
    ).rejects.toThrow(/没有可朗读/);
  });
});
