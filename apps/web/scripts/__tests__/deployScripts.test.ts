import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEPLOY_STAGES, wranglerConfigFiles } from "../lib/deployStage";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { scripts } = JSON.parse(
  readFileSync(resolve(webRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

const steps = (name: string) =>
  (scripts[name] ?? "").split("&&").map((step) => step.trim());

// The request Worker's source entry imports TanStack Start virtual modules
// that only the Vite plugin supplies, so wrangler must be handed the build
// output and never bundle that entry itself.
const DEPLOY_BUILD_OUTPUT =
  "wrangler deploy --config dist/server/wrangler.json";
const DRY_RUN = "--dry-run --outdir=dist/worker";

describe.each(DEPLOY_STAGES)("the %s deploy scripts", (stage) => {
  it("build against the stage's own Vite config", () => {
    expect(steps(`build:${stage}`)).toEqual([
      `vite build --config vite.config.cloudflare.${stage}.ts`,
    ]);
  });

  it("deploy the request Worker from the stage build's output", () => {
    expect(steps(`deploy:${stage}`)).toEqual([
      `pnpm build:${stage}`,
      DEPLOY_BUILD_OUTPUT,
    ]);
    expect(steps(`deploy:${stage}:dry`)).toEqual([
      `pnpm build:${stage}`,
      `${DEPLOY_BUILD_OUTPUT} ${DRY_RUN}`,
    ]);
  });

  // The build comes first so that a build failure cannot leave the state
  // Worker deployed alone, and so that the two deploys sit back to back.
  it("build, then deploy the state Worker, then the request Worker", () => {
    expect(steps(`deploy:${stage}:all`)).toEqual([
      `pnpm build:${stage}`,
      `pnpm deploy:${stage}:state`,
      DEPLOY_BUILD_OUTPUT,
    ]);
    expect(steps(`deploy:${stage}:all:dry`)).toEqual([
      `pnpm build:${stage}`,
      `pnpm deploy:${stage}:state:dry`,
      `${DEPLOY_BUILD_OUTPUT} ${DRY_RUN}`,
    ]);
  });

  it("deploy the state Worker from the stage's rendered config", () => {
    const { state } = wranglerConfigFiles(stage);
    expect(steps(`deploy:${stage}:state`)).toEqual([
      `wrangler deploy --config ${state}`,
    ]);
  });
});

describe("pnpm start", () => {
  // The local build is part of the script: a `dist/` left by a stage build
  // names that stage's state Worker, which the local one does not answer to.
  it("serves a fresh local build, with the state Worker from source", () => {
    expect(steps("start:cf")).toEqual([
      "pnpm build:cf",
      `wrangler dev -c dist/server/wrangler.json -c ${wranglerConfigFiles(null).state}`,
    ]);
  });
});

describe("no script lets wrangler bundle the request Worker's source", () => {
  const requestSourceConfigs = [
    wranglerConfigFiles(null).request,
    ...DEPLOY_STAGES.map((stage) => wranglerConfigFiles(stage).request),
  ];
  const bundlingSteps = Object.keys(scripts).flatMap((name) =>
    steps(name)
      .filter((step) => /^wrangler (deploy|dev)\b/.test(step))
      .map((step) => [name, step] as const),
  );

  it("finds the bundling steps it is meant to check", () => {
    expect(bundlingSteps.length).toBeGreaterThanOrEqual(13);
  });

  it.each(bundlingSteps)("%s: %s", (_name, step) => {
    const configs = [...step.matchAll(/(?:--config|-c)[ =](\S+)/g)].map(
      (m) => m[1],
    );
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(requestSourceConfigs).not.toContain(config);
    }
  });
});
