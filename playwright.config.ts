import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 240_000,
  workers: 1,
  reporter: [["list"]],
});
