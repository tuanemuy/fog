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
      viteEnvironment: { name: "ssr", childEnvironments: ["rsc"] },
      // The Durable Object classes live in a second Worker, so `pnpm dev` has
      // to boot both: the DO bindings in `wrangler.toml` name `fog-state`, and
      // a binding whose script is absent resolves to nothing at call time.
      auxiliaryWorkers: [
        {
          configPath: "./wrangler.state.toml",
          // Dev only. The deployable state Worker is built by
          // `vite.config.state.ts` (the second stage of `build:cf`), which is
          // what `wrangler.state.toml`'s `main` points at; letting this plugin
          // build it too would emit a second, unused copy.
          devOnly: true,
          // Overrides that `main`, because the vite plugin resolves it as a
          // source entry and a clean clone has no `dist/` yet.
          config: { main: "app/worker/cloudflare/state.ts" },
          viteEnvironment: { name: "state" },
        },
      ],
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
    // `APP_URL` in `wrangler.toml` / `wrangler.state.toml` hard-codes this
    // port, and absolute links (canonical / `og:url`, password-reset mail)
    // are built from it. Vite's default is to move to the next free port
    // silently, which would leave those links pointing at a port nothing is
    // listening on — failing to boot is the honest outcome.
    strictPort: true,
    host: true,
    watch: {
      ignored: ["**/.direnv/**"],
    },
  },
});
