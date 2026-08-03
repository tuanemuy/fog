import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Does the built bundle start under workerd?
 *
 * That question has one honest answer and it is not obtainable from any other
 * suite. Type checking, linting and the Workers-pool integration tests all
 * passed while #40 was live, because none of them ever asked workerd to
 * evaluate the top-level module of the shipped bundle — which is where the
 * platform enforces its global-scope restrictions.
 *
 * **The assertions are deliberately weak.** Two claims only: the fetch returns
 * *a* response, whatever its status, and starting up does not throw
 * `Disallowed operation called within global scope`. Pinning the status to 200
 * would fail for reasons that have nothing to do with booting — there is no
 * `ASSETS` binding here, so an SSR route may well answer 500, and the module
 * evaluating successfully is the entire point.
 */

const here = dirname(fileURLToPath(import.meta.url));
const requestWorker = resolve(here, "../dist/server/index.js");
const stateWorker = resolve(here, "../dist/state/index.js");

// Mirrors `vitest.config.integration.ts`. `nodejs_compat` is not optional:
// `server.cloudflare.ts` imports `node:async_hooks`, and without the flag the
// boot fails during module resolution — a red that says nothing about the
// global-scope rule this suite exists to police.
const COMPATIBILITY_DATE = "2026-05-01";
const COMPATIBILITY_FLAGS = ["nodejs_compat"];

const DISALLOWED = "Disallowed operation called within global scope";

/**
 * The sources that end up inside the two bundles.
 *
 * `__tests__` is excluded because nothing under it is shipped — editing this
 * very file would otherwise report the build as stale — and `*.gen.ts` because
 * the router's generated tree is rewritten *during* the build, after the first
 * of the two bundles has already been emitted.
 */
const SOURCE_ROOTS = [
  resolve(here, "../app"),
  resolve(here, "../../../packages/core/src"),
];

function newestSourceMtime(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      newest = Math.max(newest, newestSourceMtime(path));
      continue;
    }
    if (entry.name.endsWith(".gen.ts")) continue;
    if (!/\.(ts|tsx|css)$/.test(entry.name)) continue;
    newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

function createMiniflare(): Miniflare {
  return new Miniflare({
    // Two workers, because the request Worker's Durable Object bindings name
    // classes the *state* Worker exports; a single-worker configuration cannot
    // resolve them. Both are listed inside `workers` rather than one of them
    // being hoisted to the top level: with a `workers` array present, miniflare
    // treats **its first entry** as the default target of `dispatchFetch` and
    // of `getDurableObjectNamespace`, so a hoisted request Worker leaves the
    // namespace lookup pointed at `state`, which declares no such binding.
    workers: [
      {
        name: "request",
        modules: true,
        scriptPath: requestWorker,
        // The request bundle is code-split into `assets/*.js`, and miniflare's
        // default rules read a bare `.js` as CommonJS — which rejects the very
        // first `import` it meets. Vite emits ES modules throughout.
        modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: COMPATIBILITY_FLAGS,
        durableObjects: {
          USER_DATA: {
            className: "UserDataDurableObject",
            scriptName: "state",
            useSQLite: true,
          },
          IDENTITY_DIRECTORY: {
            className: "IdentityDirectoryDurableObject",
            scriptName: "state",
            useSQLite: true,
          },
        },
        bindings: {
          APP_URL: "http://localhost:8787",
          SESSION_SECRET: "smoke-session-secret-0123456789abcdef",
          AI_CLIENT_TOKEN_SECRET: "smoke-ai-client-secret-0123456789abcdef",
          DIRECTORY_ROUTING_SECRET: JSON.stringify([
            {
              generation: 1,
              key: "smoke-directory-routing-secret-0123456789",
              bucketCount: 256,
            },
          ]),
        },
      },
      {
        name: "state",
        modules: true,
        scriptPath: stateWorker,
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: COMPATIBILITY_FLAGS,
        bindings: { APP_URL: "http://localhost:8787" },
      },
    ],
  });
}

describe("the built Workers boot under workerd", () => {
  let miniflare: Miniflare | null = null;

  beforeAll(() => {
    // A missing artefact means `pnpm build:cf` did not run, and a suite that
    // quietly passed in that case would be worse than useless.
    expect(
      existsSync(requestWorker),
      `${requestWorker} is missing; run \`pnpm build:cf\` first`,
    ).toBe(true);
    expect(
      existsSync(stateWorker),
      `${stateWorker} is missing; run \`pnpm build:cf\` first`,
    ).toBe(true);
    // Existence alone catches "the build never ran"; it does not catch "the
    // build ran before the change under test". This suite exists to detect a
    // regression that only the *shipped* module graph shows, so a green against
    // a stale bundle is the dangerous kind — the developer who just edited the
    // top-level Worker would be told #40 has not come back when nothing asked.
    const newestSource = Math.max(...SOURCE_ROOTS.map(newestSourceMtime));
    for (const artefact of [requestWorker, stateWorker]) {
      expect(
        statSync(artefact).mtimeMs,
        `${artefact} is older than the sources it was built from; re-run \`pnpm build:cf\``,
      ).toBeGreaterThan(newestSource);
    }
    miniflare = createMiniflare();
  });

  afterAll(async () => {
    await miniflare?.dispose();
  });

  it("answers a request without a global-scope violation", async () => {
    const instance = miniflare;
    if (instance === null) throw new Error("Miniflare was not created");
    let caught: unknown;
    let status: number | null = null;
    try {
      const response = await instance.dispatchFetch("http://localhost/");
      status = response.status;
      // Drain it: an undrained body keeps the isolate alive past `dispose`.
      await response.text();
    } catch (error) {
      caught = error;
    }
    expect(String(caught ?? "")).not.toContain(DISALLOWED);
    expect(caught).toBeUndefined();
    expect(status).not.toBeNull();
  });

  it("starts the state Worker, whose Durable Objects it hosts", async () => {
    const instance = miniflare;
    if (instance === null) throw new Error("Miniflare was not created");
    // The binding lives on the request Worker and points at a class the state
    // Worker exports, so reaching through it forces the state bundle's module
    // to be evaluated — the half the request path never touches on its own.
    const namespace = await instance.getDurableObjectNamespace("USER_DATA");
    const stub = namespace.get(namespace.idFromName("smoke-user"));
    const envelope = (await (
      stub as unknown as { readSchemaVersion(): Promise<unknown> }
    ).readSchemaVersion()) as { ok: boolean };
    expect(envelope.ok).toBe(true);
  });
});
