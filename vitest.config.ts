import { defineConfig } from "vitest/config";

// Unit and local provider contract tests. Real database tests use the Node integration config.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    globals: true,
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.direnv/**",
      "**/*.integration.test.ts",
      "spec/**",
      ".goal-implement/**",
    ],
  },
});
