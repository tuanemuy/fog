import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig, type UserConfig } from "vite";
import {
  type DeployStage,
  wranglerConfigFiles,
} from "./scripts/lib/deployStage";

/**
 * `null` builds against the local wrangler configs; a stage builds against
 * the pair `pnpm cf:render:<stage>` rendered. The stage configs
 * (`vite.config.cloudflare.<stage>.ts`) are the only callers that pass one,
 * so which Worker config a build carries is decided by the `--config` file
 * and by nothing ambient.
 */
export function createConfig(stage: DeployStage | null): UserConfig {
  const wranglerConfigs = wranglerConfigFiles(stage);
  return defineConfig({
    resolve: {
      tsconfigPaths: true,
    },
    plugins: [
      tailwindcss(),
      cloudflare({
        configPath: `./${wranglerConfigs.request}`,
        // Declare `rsc` as a child of the workerd-backed `ssr` env so the
        // RSC plugin's module runner is initialised inside the worker.
        // This applies to the entry (request) Worker only.
        viteEnvironment: { name: "ssr", childEnvironments: ["rsc"] },
        // The state Worker rides in the same miniflare so the request
        // Worker's Durable Object bindings resolve in `pnpm dev` and
        // `pnpm preview`. Without it those bindings have nothing to bind
        // to. It is a separate config file rather than an `[env.*]` block
        // — see the header of `wrangler.toml` for the three reasons.
        auxiliaryWorkers: [{ configPath: `./${wranglerConfigs.state}` }],
      }),
      tanstackStart({
        srcDirectory: "app",
        // Path is resolved relative to `srcDirectory`; an `app/` prefix
        // makes the plugin silently fall back to the default CF entry.
        server: { entry: "server.cloudflare.ts" },
        rsc: { enabled: true },
      }),
      rsc(),
      viteReact(),
    ],
    server: {
      port: 3000,
      host: true,
      watch: {
        ignored: ["**/.direnv/**"],
      },
    },
  });
}

export default createConfig(null);
