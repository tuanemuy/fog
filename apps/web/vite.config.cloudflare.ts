import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    cloudflare({
      configPath: "./wrangler.request.toml",
      // Wrangler deploys the generated artifact, while Vite must build from
      // the source entry. Without this override, repeated builds ingest the
      // previous dist/server output and recursively bundle stale code.
      config: { main: "app/server.cloudflare.ts" },
      // Declare `rsc` as a child of the workerd-backed `ssr` env so the
      // RSC plugin's module runner is initialised inside the worker.
      viteEnvironment: { name: "ssr", childEnvironments: ["rsc"] },
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
