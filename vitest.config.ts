import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/test/**/*.test.ts", "**/src/**/*.test.ts", "deploy/production/production-manifest.test.ts", "scripts/*.test.ts"],
    globals: false
  }
});
