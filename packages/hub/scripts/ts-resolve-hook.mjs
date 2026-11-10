/**
 * 只做一件事：把 src 里 `import "./pragmas.js"` 这种【说明符写 .js 而文件是 .ts】的
 * 引用解析到 .ts 上。
 *
 *   node --experimental-transform-types --import ./scripts/ts-resolve-hook.mjs <脚本>
 *
 * 为什么要这么一层：src/**\/*.ts 用的是 NodeNext 的写法（说明符带 .js，编译产物才对得上），
 * 而 `--experimental-transform-types` 只负责【转译】，不会替我把 .js 说明符改指到 .ts。
 * 不注册这个钩子的症状是一条 ERR_MODULE_NOT_FOUND，指向 src/db/pragmas.js ——
 * 看着像【文件被删了】，真实原因是解析规则。第一次撞上会浪费很久，所以它得有名字。
 *
 * 与 /tmp/opc-harness/hooks.mjs 的关系：那一份还负责把 `vitest` 指到离线夹具、
 * 把 yaml 指到 pnpm cache 里的替代版本。这里【一样都不带】——
 * scripts/*.mjs 不 import vitest，也就不需要那两层。少一层是一层的价值：
 * 测试夹具的解析钩子是【本机临时物】，而提交进仓库的脚本不该依赖它，
 * 依赖了就等于「只有我这台机器能复算」（0019 §7 要的是任何人都能重出那些数）。
 *
 * 三条同时成立才改写：相对说明符、以 .js 结尾、同目录真的存在那个 .ts。
 * 其余一律交回 next()，所以真装了的 .js（node_modules 里的）不受影响。
 */
import { existsSync } from "node:fs";
import { dirname, resolve as presolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { dirname, resolve as presolve } from "node:path";
      import { fileURLToPath, pathToFileURL } from "node:url";
      export async function resolve(specifier, context, next) {
        if (
          /^\\.\\.?\\//.test(specifier) &&
          specifier.endsWith(".js") &&
          context.parentURL?.startsWith("file:")
        ) {
          const parent = fileURLToPath(context.parentURL);
          const asTs = presolve(dirname(parent), specifier.slice(0, -3) + ".ts");
          if (existsSync(asTs)) {
            return { url: pathToFileURL(asTs).href, shortCircuit: true, format: "module-typescript" };
          }
        }
        return next(specifier, context);
      }
    `),
  import.meta.url,
);
