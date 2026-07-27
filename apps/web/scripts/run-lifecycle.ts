#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = 8799;
const baseUrl = `http://127.0.0.1:${port}`;

type LifecycleResult = Readonly<{
  localOnly: boolean;
  observations: readonly Readonly<{
    step: string;
    page: Readonly<{
      items: readonly Readonly<{ type: string; id: string }>[];
    }>;
  }>[];
}>;

const expectedHits: Readonly<Record<string, readonly string[]>> = {
  "create-memo": ["memo:memo-1"],
  "create-topic": ["memo:memo-1"],
  "create-document": ["document:document-1", "memo:memo-1"],
  "update-memo": ["document:document-1", "memo:memo-1"],
  "update-document": ["document:document-1", "memo:memo-1"],
  "trash-document": ["memo:memo-1"],
  "restore-document": ["document:document-1", "memo:memo-1"],
  "trash-memo": ["document:document-1"],
  "restore-memo": ["document:document-1", "memo:memo-1"],
  "trash-document-before-remove": ["memo:memo-1"],
  "remove-document": ["memo:memo-1"],
  "trash-memo-before-remove": [],
  "remove-memo": [],
};

function assertLifecycle(result: unknown): asserts result is LifecycleResult {
  if (
    typeof result !== "object" ||
    result === null ||
    !("localOnly" in result) ||
    result.localOnly !== true ||
    !("observations" in result) ||
    !Array.isArray(result.observations)
  ) {
    throw new Error("Lifecycle result has an invalid contract");
  }
  for (const observation of result.observations as LifecycleResult["observations"]) {
    const expected = expectedHits[observation.step];
    if (expected === undefined) {
      throw new Error(`Unexpected lifecycle step ${observation.step}`);
    }
    const actual = observation.page.items
      .map((item) => `${item.type}:${item.id}`)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      throw new Error(
        `Lifecycle search mismatch at ${observation.step}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  if (result.observations.length !== Object.keys(expectedHits).length) {
    throw new Error("Lifecycle result omitted one or more required steps");
  }
}
const child = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "wrangler.lifecycle.toml",
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
  assertLifecycle(result);
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
