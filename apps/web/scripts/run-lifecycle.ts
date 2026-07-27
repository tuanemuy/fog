#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = 8799;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "wrangler.lifecycle.toml",
    "--config",
    "wrangler.state.toml",
    "--port",
    String(port),
    "--persist-to",
    ".wrangler/lifecycle",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let diagnostics = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-8_000);
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Wrangler exited before ready\n${diagnostics}`);
    }
    try {
      const response = await fetch(`${baseUrl}/__local/lifecycle`);
      if (response.status === 404) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Wrangler did not become ready\n${diagnostics}`);
}

try {
  await waitUntilReady();
  const response = await fetch(`${baseUrl}/__local/lifecycle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: crypto.randomUUID() }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      `Lifecycle Worker failed (${response.status}): ${JSON.stringify(result)}`,
    );
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}
