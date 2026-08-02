import { defineConfig } from "vite";

// Build config for the **state Worker** (the Durable Object host). Kept apart
// from `vite.config.cloudflare.ts` because the TanStack Start / RSC / React
// plugin chain exists for the request Worker: the state Worker has no public
// routes, only two DO class exports and a 404 default handler.
//
// `outDir` differs from the request build's, so the two stages of `build:cf`
// do not empty each other's output.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  // The state Worker serves nothing, so `public/` must not be copied in.
  publicDir: false,
  build: {
    outDir: "dist/state",
    emptyOutDir: true,
    target: "esnext",
    minify: false,
    rollupOptions: {
      external: [/^cloudflare:/, /^node:/],
    },
    lib: {
      entry: "app/worker/cloudflare/state.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
});
