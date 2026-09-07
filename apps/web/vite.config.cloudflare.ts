import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    cloudflare({
      // Declare `rsc` as a child of the workerd-backed `ssr` env so the
      // RSC plugin's module runner is initialised inside the worker.
      // This applies to the entry (request) Worker only.
      viteEnvironment: { name: "ssr", childEnvironments: ["rsc"] },
      // The state Worker rides in the same miniflare so the request
      // Worker's Durable Object bindings resolve in `pnpm dev` and
      // `pnpm preview`. Without it those bindings have nothing to bind
      // to. It is a separate config file rather than an `[env.*]` block
      // — see the header of `wrangler.toml` for the three reasons.
      auxiliaryWorkers: [{ configPath: "./wrangler.state.toml" }],
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
