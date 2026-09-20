import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DELIVERY_TUNING_DEFAULTS } from "@repo/core/application/delivery/tuning";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEPLOY_STAGES,
  type DeployStage,
  templateFileOf,
  wranglerConfigFiles,
} from "../lib/deployStage";
import { renderWranglerTemplate } from "../lib/wranglerTemplate";

// What a deploy uploads is the Vite build's output config, not the template
// `wranglerConfig.test.ts` reads. This suite renders each stage's templates
// from fixed values, runs the stage's real dry-run deploy, and reads that
// output back. It writes the rendered configs, so it refuses to run over
// ones that already exist, and it rewrites `dist/`.

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const inWeb = (file: string) => resolve(webRoot, file);

const fixtureOf = (stage: DeployStage) => {
  const prefix = `fog-verify-${stage}`;
  return {
    RESOURCE_PREFIX: prefix,
    APP_URL: `https://${stage}.verify.example`,
    MAIL_FROM_ADDRESS: `fog <verify@${stage}.verify.example>`,
    EVENTS_QUEUE_NAME: `${prefix}-events`,
    DLQ_QUEUE_NAME: `${prefix}-events-dlq`,
  };
};

const renderedFiles = DEPLOY_STAGES.flatMap((stage) => {
  const { request, state } = wranglerConfigFiles(stage);
  return [
    { stage, file: request },
    { stage, file: state },
  ];
});

type OutputConfig = Readonly<{
  name: string;
  main: string;
  no_bundle: boolean;
  vars: Record<string, string>;
  durable_objects: { bindings: ReadonlyArray<{ script_name: string }> };
  queues: { consumers: ReadonlyArray<Record<string, unknown>> };
}>;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
}

/** Values of `.dev.vars` long enough to be a secret rather than a flag. */
function localSecrets(): string[] {
  return [
    ...readFileSync(inWeb(".dev.vars"), "utf8").matchAll(/^\w+="(.{16,})"$/gm),
  ].map((m) => m[1] ?? "");
}

// Only what this run wrote is removed afterwards: a refused run must leave
// the rendered configs it found exactly where they were.
const written = new Set<string>();

function render(stage: DeployStage, file: string): void {
  const template = templateFileOf(file);
  writeFileSync(
    inWeb(file),
    renderWranglerTemplate(
      readFileSync(inWeb(template), "utf8"),
      fixtureOf(stage),
      template,
    ),
  );
  written.add(file);
}

function removeWritten(): void {
  for (const file of written) rmSync(inWeb(file), { force: true });
  written.clear();
}

function run(script: string): void {
  execFileSync("pnpm", [script], { cwd: webRoot, stdio: "pipe" });
}

/** stdout + stderr of a script that is expected to exit non-zero. */
function failureOutputOf(script: string): string {
  try {
    run(script);
  } catch (error) {
    const { stdout, stderr } = error as { stdout: Buffer; stderr: Buffer };
    return `${stdout.toString()}${stderr.toString()}`;
  }
  throw new Error(`${script} exited 0`);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function untilListening(origin: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      await fetch(origin, { redirect: "manual" });
      return;
    } catch {
      await new Promise((tick) => setTimeout(tick, 500));
    }
  }
  throw new Error(`${origin} never started listening`);
}

beforeAll(() => {
  const existing = renderedFiles.filter(({ file }) => existsSync(inWeb(file)));
  if (existing.length > 0) {
    throw new Error(
      `refusing to overwrite rendered configs: ${existing.map(({ file }) => file).join(", ")}`,
    );
  }
});

afterAll(removeWritten);

// Falling back to the local pair here would deploy local names and local
// vars to a stage, so a stage build has nothing to fall back to.
describe.each(DEPLOY_STAGES)(
  "a %s build missing a rendered config",
  (stage) => {
    const { request, state } = wranglerConfigFiles(stage);

    afterEach(removeWritten);

    it("stops when neither is rendered", () => {
      expect(failureOutputOf(`build:${stage}`)).toContain(
        "doesn't point to an existing file",
      );
    });

    it("stops on the state config when only the request one is rendered", () => {
      render(stage, request);
      const output = failureOutputOf(`build:${stage}`);
      expect(output).toContain(inWeb(state));
      expect(output).toContain("doesn't point to an existing file");
    });

    it("stops on the request config when only the state one is rendered", () => {
      render(stage, state);
      const output = failureOutputOf(`build:${stage}`);
      expect(output).toContain(inWeb(request));
      expect(output).toContain("doesn't point to an existing file");
    });
  },
);

describe.each(DEPLOY_STAGES)("the %s deploy", (stage) => {
  const fixture = fixtureOf(stage);
  let output: OutputConfig;

  beforeAll(() => {
    const { request, state } = wranglerConfigFiles(stage);
    render(stage, request);
    render(stage, state);
    run(`deploy:${stage}:all:dry`);
    output = JSON.parse(
      readFileSync(inWeb("dist/server/wrangler.json"), "utf8"),
    ) as OutputConfig;
  });

  it("hands wrangler a prebuilt entry it does not bundle again", () => {
    expect(output.main).toBe("index.js");
    expect(output.no_bundle).toBe(true);
    expect(existsSync(inWeb("dist/server/index.js"))).toBe(true);
  });

  it("names the stage's Worker and binds the stage's state Worker", () => {
    expect(output.name).toBe(fixture.RESOURCE_PREFIX);
    expect(
      output.durable_objects.bindings.map((binding) => binding.script_name),
    ).toEqual([
      `${fixture.RESOURCE_PREFIX}-state`,
      `${fixture.RESOURCE_PREFIX}-state`,
    ]);
  });

  // Exact equality is the point: a local-only variable
  // (`DIAGNOSTICS_ENABLED`, `MAIL_DEV_SINK`, `SSO_DEV_STUB`) reaching the
  // output is one key too many.
  it("carries the stage's vars and no others", () => {
    expect(output.vars).toEqual({
      APP_URL: fixture.APP_URL,
      MAIL_FROM_ADDRESS: fixture.MAIL_FROM_ADDRESS,
    });
  });

  it("consumes the stage's queues under the declared delivery tuning", () => {
    expect(output.queues.consumers).toEqual([
      {
        queue: fixture.EVENTS_QUEUE_NAME,
        max_batch_size: 25,
        max_batch_timeout:
          DELIVERY_TUNING_DEFAULTS.eventsMaxBatchTimeoutMs / 1000,
        max_retries: DELIVERY_TUNING_DEFAULTS.eventsMaxRetries,
        dead_letter_queue: fixture.DLQ_QUEUE_NAME,
      },
      {
        queue: fixture.DLQ_QUEUE_NAME,
        max_batch_size: 25,
        max_batch_timeout:
          DELIVERY_TUNING_DEFAULTS.eventsMaxBatchTimeoutMs / 1000,
        max_retries: DELIVERY_TUNING_DEFAULTS.dlqMaxRetries,
      },
    ]);
  });

  // The Vite plugin copies `.dev.vars` next to the output config for
  // `wrangler dev`. A deploy must not pick it up from there.
  it.skipIf(!existsSync(inWeb(".dev.vars")))(
    "keeps the local .dev.vars out of what the dry run would upload",
    () => {
      const secrets = localSecrets();
      expect(secrets.length).toBeGreaterThan(0);
      const uploaded = filesUnder(inWeb("dist/worker"));
      expect(uploaded.length).toBeGreaterThan(0);
      for (const file of uploaded) {
        const body = readFileSync(file, "utf8");
        for (const secret of secrets) {
          expect(body.includes(secret), `${file} carries a secret`).toBe(false);
        }
      }
    },
  );
});

// Runs last on purpose: `dist/` now holds a stage build, whose DO bindings
// name a state Worker the local one does not answer to. `pnpm start` has to
// come up on a local build regardless, and the round trip into a Durable
// Object is what shows the binding is wired.
describe.skipIf(!existsSync(inWeb(".dev.vars")))(
  "pnpm start after a stage build",
  () => {
    let server: ChildProcess;
    let origin: string;
    const persistTo = mkdtempSync(join(tmpdir(), "fog-start-"));

    beforeAll(async () => {
      const port = await freePort();
      origin = `http://localhost:${port}`;
      server = spawn(
        "pnpm",
        ["start:cf", "--port", String(port), "--persist-to", persistTo],
        { cwd: webRoot, stdio: "ignore", detached: true },
      );
      await untilListening(origin);
    });

    afterAll(() => {
      if (server.pid !== undefined) process.kill(-server.pid, "SIGTERM");
      rmSync(persistTo, { recursive: true, force: true });
    });

    it("serves the top page", async () => {
      const response = await fetch(origin, { redirect: "manual" });
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("/login");
    });

    it("reaches a Durable Object through the request Worker", async () => {
      const response = await fetch(
        `${origin}/__diagnostics/schema-version?locator=dir:g1:b0`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ schemaVersion: null });
    });
  },
);
