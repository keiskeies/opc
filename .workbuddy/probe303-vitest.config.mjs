// probe303: throwaway vitest config so the real safety.ts runs (repo include only covers test/** and packages/*/test/**).
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "D:/item/opc",
  test: {
    environment: "node",
    include: [".workbuddy/probe303-*.probe.ts"],
  },
});
