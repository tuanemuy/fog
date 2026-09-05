import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createStaticAssets } from "./staticAssets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
  path.resolve(here, "../dist/server/server.node.js"),
  path.resolve(here, "../server/server.node.js"),
  path.resolve(process.cwd(), "dist/server/server.node.js"),
];

// The candidate is picked by existence, not by whether it imports —
// a bundle that exists but fails to load must surface its real error
// instead of a misleading "could not locate".
async function loadBundled() {
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `[listen.node] could not locate the bundled server entry. Tried:\n  - ${candidates.join("\n  - ")}\nDid you run \`pnpm build:node\`?`,
    );
  }
  const mod = await import(pathToFileURL(found).toString());
  const resolved = typeof mod.boot === "function" ? mod : mod.default;
  if (!resolved || typeof resolved.boot !== "function") {
    throw new Error(`[listen.node] ${found} does not export boot()`);
  }
  return resolved;
}

async function main() {
  const { boot } = await loadBundled();
  const booted = await boot();

  const assets = createStaticAssets(path.resolve(here, "../dist/client"));
  const server = serve(
    {
      fetch: async (request) =>
        (await assets(request)) ?? booted.fetch(request),
      port: booted.port,
      hostname: booted.hostname,
    },
    (info) => {
      console.log(
        `[listen.node] listening on http://${info.address}:${info.port}`,
      );
    },
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[listen.node] received ${signal}, draining`);
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await booted.shutdown();
    process.exit(0);
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

main().catch(() => {
  console.error(
    "[listen.node] failed to start; check build, environment, database, and listener configuration",
  );
  process.exit(1);
});
