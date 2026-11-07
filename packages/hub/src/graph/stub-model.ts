/**
 * Phase 0 专用【桩模型】：不联网、不计费、确定性返回。
 *
 * 为什么住在 src/ 而不是 test/：CLI（hub run）在 Phase 0 也必须能跑完图，而真实
 * 模型接入是 Phase 1 的事。留在 test/ 就会诱导出"CLI 里另写一个桩"，于是"节点级
 * 档位由 model_tier 驱动"这条断言（§5.9、§24 风险 1）可能测的是 A 桩、跑的是 B 桩。
 *
 * ⚠ 这个文件【只】放桩。真实 provider 到 Phase 1 进独立的 registry，不往这里加
 * 一个 if —— "生产代码里藏着假东西"是后期最难查的一类故障。
 * 装配时 CLI 会显式打印「模型：桩（Phase 0，不计费不联网）」，不给人误以为真跑了模型。
 */
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
// ChatResult / ChatGeneration 都在 @langchain/core/outputs —— 【不在 messages】。
// 这里原先写的是从 messages 引 ChatResult，一路没被编译抓到，只因为 tsc -b 的
// solution 不覆盖 test/ 目录：本文件在 Task 0.10 之前住在 test/graph/fixtures/，
// 这个 TS2305 潜伏了整整一个任务，是"把它搬进 src/"才把它照出来的。
import type { ChatGeneration, ChatResult } from "@langchain/core/outputs";
// 档位类型的唯一权威来源是 @opc/contracts（§668：zod schema 是唯一来源）。
// 曾在这里重复声明过一份，于是 contracts 改了档位、桩这边还旧着，类型层面看不出来。
import type { ModelTier } from "@opc/contracts";

export type { ModelTier };

export interface StubCall {
  readonly tier: ModelTier;
  readonly text: string;
}

/**
 * 把 message.content 拍平成纯文本。
 *
 * content 可能是 string，也可能是 content-block 数组 —— 直接 String(content) 会得到
 * "[object Object]"，桩里基于文本做的断言就永远"通过"（因为断言的是子串匹配失败与否）。
 * 实测过：不拍平时数组分支返回的是 [object Object]。
 */
export function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "string"
          ? b
          : (((b as { text?: string })?.text as string) ??
            JSON.stringify(b) ??
            ""),
      )
      .join("");
  }
  return String(content);
}

export class StubChatModel extends BaseChatModel {
  readonly calls: StubCall[] = [];
  readonly tier: ModelTier;

  constructor(tier: ModelTier) {
    super({});
    this.tier = tier;
  }

  _llmType(): string {
    return "stub-" + this.tier;
  }

  async _generate(
    messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const text = stringifyContent(messages[messages.length - 1]?.content);
    this.calls.push({ tier: this.tier, text });
    const out = "stub:" + this.tier;
    const gen: ChatGeneration = { text: out, message: new AIMessage(out) };
    // ChatResult 的真实形状是 { generations: ChatGeneration[]; llmOutput?: object }
    // （@langchain/core/dist/outputs.d.ts:58）。这里原先多带了一个 `result: {}` 键 ——
    // 它不属于任何契约，纯属噪声。为什么没人发现：本文件此前住在 test/，而 tsc -b 的
    // solution 不覆盖 test/，多余键的 excess-property 检查根本没跑过。
    // ⚠ 别把它跟运行时那句 result.generations is not iterable 混为一谈：那句里的
    //   result 是 LangChain 内部的局部变量名，与返回对象里的这个键毫无关系。
    return { generations: [gen] };
  }
}

/**
 * 档位 → 模型。这是 §5.9 的注入口：节点只允许通过它拿模型，
 * 于是"节点级模型由 model_tier 驱动"这件事有一个可断言的收口。
 */
export class StubRegistry {
  /** 被请求过的档位，按调用顺序 —— ④ 号验收就读这个。 */
  readonly seen: ModelTier[] = [];
  readonly byTier = new Map<ModelTier, StubChatModel>();

  get(tier: ModelTier): StubChatModel {
    this.seen.push(tier);
    let m = this.byTier.get(tier);
    if (m === undefined) {
      m = new StubChatModel(tier);
      this.byTier.set(tier, m);
    }
    return m;
  }

  callsFor(tier: ModelTier): StubCall[] {
    return this.byTier.get(tier)?.calls ?? [];
  }

  get totalCalls(): number {
    let n = 0;
    for (const m of this.byTier.values()) n += m.calls.length;
    return n;
  }
}
