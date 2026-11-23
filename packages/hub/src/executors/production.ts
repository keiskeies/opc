/** 七种执行器的生产装配表：一家 CLI 实现、七个路由 kind。 */
import type { Writer } from "../db/write-queue.js";
import { BuiltinPluginExecutor } from "./builtin-plugin.js";
import { CLI_EXECUTOR_KINDS_LOCAL, CliExecutor } from "./cli.js";
import { HumanExecutor } from "./human.js";
import { PluginWebhookExecutor } from "./plugin-webhook.js";
import { type ModelCaller, PureModelExecutor } from "./pure-model.js";
import { ExecutorRegistry } from "./registry.js";
import type { Executor } from "./types.js";

export interface CreateExecutorRegistryOptions {
  readonly writer: Writer;
  readonly callModel?: ModelCaller;
  readonly now?: () => number;
}

/**
 * 未注入 callModel 时保持 PureModelExecutor 的 model_unavailable 语义；
 * workspace 也不由本装配猜测，CLI 缺 workspace 时明确拒绝回退到 Hub cwd。
 */
export function createExecutorRegistry(
  o: CreateExecutorRegistryOptions,
): ExecutorRegistry {
  const cli = new CliExecutor({
    writer: o.writer,
    gateway: {
      audit: () => 0,
      charterHarnessDefaults: {},
      grantedSandbox: "read-only",
      grantedForbidden: [],
      ...(o.now === undefined ? {} : { now: o.now }),
    },
    ...(o.now === undefined ? {} : { now: o.now }),
  });
  const cliExecutors: Executor[] = CLI_EXECUTOR_KINDS_LOCAL.map((kind) => ({
    kind,
    run: (req) => cli.run(req),
  }));
  return new ExecutorRegistry([
    ...cliExecutors,
    new PluginWebhookExecutor({ writer: o.writer }),
    new BuiltinPluginExecutor({ writer: o.writer }),
    new PureModelExecutor({
      writer: o.writer,
      ...(o.callModel === undefined ? {} : { callModel: o.callModel }),
    }),
    new HumanExecutor({ writer: o.writer }),
  ]);
}
