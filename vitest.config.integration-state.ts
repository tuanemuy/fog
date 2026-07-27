import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    cloudflareTest({
      main: "apps/web/app/server.state.integration.ts",
      miniflare: {
        compatibilityDate: "2026-07-02",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          USER_DATA: {
            className: "UserDataDurableObject",
            useSQLite: true,
          },
          IDENTITY_DIRECTORY: {
            className: "IdentityDirectoryDurableObject",
            useSQLite: true,
          },
          ACCOUNT_HOME: {
            className: "AccountHomeDurableObject",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: [
      "apps/web/app/durable-objects/**/*.integration.test.ts",
      "apps/web/app/testing/**/migrations.integration.test.ts",
      ".thread/19/spike/**/*.integration.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
  },
});
