import { readFileSync, readdirSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

function serverFunctionId(name: string): string {
  const root = "apps/web/dist/server/rsc/assets";
  for (const file of readdirSync(root)) {
    if (!file.startsWith("action-") || !file.endsWith(".js")) continue;
    const source = readFileSync(`${root}/${file}`, "utf8");
    const match = new RegExp(
      `id:\\s*"([^"]+)",\\s*\\n\\s*name:\\s*"${name}"`,
      "u",
    ).exec(source);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`Built server function ${name} was not found`);
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "apps/web/dist/server/index.js",
      miniflare: {
        compatibilityDate: "2026-07-02",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          APP_URL: "https://fog.test",
          DIRECTORY_ROUTING_GENERATION_ACTIVE: "integration-v1",
          SESSION_SECRET: "integration-session-secret-with-32-bytes",
          DIRECTORY_ROUTING_SECRET_ACTIVE:
            "integration-routing-secret-with-32-bytes",
          PITR_OPERATOR_TOKEN:
            "integration-operator-token-with-at-least-32-bytes",
          PRODUCTION_SIGNUP_FN_ID: serverFunctionId("signupFn"),
          PRODUCTION_LOGIN_FN_ID: serverFunctionId("loginFn"),
          PRODUCTION_LOGOUT_FN_ID: serverFunctionId("logoutFn"),
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
    include: ["apps/web/app/testing/**/productionEntry.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.direnv/**"],
  },
});
