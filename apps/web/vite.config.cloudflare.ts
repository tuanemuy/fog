import { rmSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import rsc from "@vitejs/plugin-rsc";
import { defineConfig } from "vite";

rmSync(new URL("./dist-cloudflare", import.meta.url), {
  recursive: true,
  force: true,
});

export default defineConfig({
  resolve: { tsconfigPaths: true },
  build: { outDir: "dist-cloudflare" },
  plugins: [
    tailwindcss(),
    cloudflare({
      viteEnvironment: { name: "ssr", childEnvironments: ["rsc"] },
    }),
    tanstackStart({
      srcDirectory: "app",
      server: { entry: "server.cloudflare.ts" },
      rsc: { enabled: true },
    }),
    rsc(),
    viteReact(),
  ],
  server: {
    port: 3000,
    host: true,
    watch: { ignored: ["**/.direnv/**"] },
  },
});
