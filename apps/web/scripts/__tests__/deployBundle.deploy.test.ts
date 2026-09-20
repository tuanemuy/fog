import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DELIVERY_TUNING_DEFAULTS } from "@repo/core/application/delivery/tuning";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
// ones that already exist, and it leaves `dist/` holding a stage build.

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
const written: string[] = [];

beforeAll(() => {
  const existing = renderedFiles.filter(({ file }) => existsSync(inWeb(file)));
  if (existing.length > 0) {
    throw new Error(
      `refusing to overwrite rendered configs: ${existing.map(({ file }) => file).join(", ")}`,
    );
  }
  for (const { stage, file } of renderedFiles) {
    const template = templateFileOf(file);
    writeFileSync(
      inWeb(file),
      renderWranglerTemplate(
        readFileSync(inWeb(template), "utf8"),
        fixtureOf(stage),
        template,
      ),
    );
    written.push(file);
  }
});

afterAll(() => {
  for (const file of written) rmSync(inWeb(file), { force: true });
});

describe.each(DEPLOY_STAGES)("the %s deploy", (stage) => {
  const fixture = fixtureOf(stage);
  let output: OutputConfig;

  beforeAll(() => {
    execFileSync("pnpm", [`deploy:${stage}:all:dry`], {
      cwd: webRoot,
      stdio: "pipe",
    });
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
