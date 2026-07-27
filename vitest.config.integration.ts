import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    cloudflareTest({
      main: "apps/web/app/testing/request.integration.worker.ts",
      miniflare: {
        compatibilityDate: "2026-07-02",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          APP_URL: "https://fog.test",
          DIRECTORY_ROUTING_GENERATION_ACTIVE: "integration-v1",
          SESSION_SECRET: "integration-session-secret-with-32-bytes",
          DIRECTORY_ROUTING_SECRET_ACTIVE:
            "integration-routing-secret-with-32-bytes",
        },
        durableObjects: {
          USER_DATA: {
            className: "UserDataDurableObject",
            scriptName: "fog-state",
            useSQLite: true,
          },
          IDENTITY_DIRECTORY: {
            className: "IdentityDirectoryDurableObject",
            scriptName: "fog-state",
            useSQLite: true,
          },
          ACCOUNT_HOME: {
            className: "AccountHomeDurableObject",
            scriptName: "fog-state",
            useSQLite: true,
          },
        },
        workers: [
          {
            name: "fog-state",
            modules: true,
            scriptPath: "apps/web/dist/test/state/server.state.js",
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
        ],
      },
    }),
  ],
  test: {
    include: [
      "apps/web/app/testing/**/requestStateBoundary.integration.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
  },
});
