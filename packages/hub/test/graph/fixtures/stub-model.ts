/**
 * 桩模型（Task 0.8 验收要求：测试用桩模型，不联网、不计费）。
 *
 * 单独成文件而不是留在测试里，是因为崩溃续跑测试要在**另一个进程**里用同一个桩：
 * 桩若有两份实现，子进程跑的就不是被测路径，"已完成节点不重复执行"会退化成自我确认。
 *
 * 为什么真继承 BaseChatModel 而不是随手写个 { invoke } 对象：规格 §5.9 第 2 条要求
 * 模型 Provider 统一走 @langchain/core 的 message API。桩不继承它，节点里就能塞进
 * 任意对象而测试照样绿 —— 那条约束就没有任何测试守着。
 *
 * 为什么必须返回标准 ChatResult：实测把 SimpleChatModel 的 _generate 写成直接返回
 * content 时，LangChain 在 result.generations is not iterable 处炸掉。也就是说
 * "看着像模型"不够，桩要按真实契约返回。
 */
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  type ChatResult,
} from "@langchain/core/messages";
import type { ChatGeneration } from "@langchain/core/outputs";

// 类型来自 @opc/contracts（唯一权威来源）；曾在这里重复声明过一份，
// 于是 contracts 改了档位、桩这边还旧着 —— 类型层面看不出来，只有行为会偏。
export type { ModelTier } from "@opc/contracts";

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
    return { generations: [gen], result: {} };
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
