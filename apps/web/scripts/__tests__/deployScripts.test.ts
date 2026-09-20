import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEPLOY_STAGES, wranglerConfigFiles } from "../lib/deployStage";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { scripts } = JSON.parse(
  readFileSync(resolve(webRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

/** The commands a script ends up running, `pnpm <script>` steps expanded. */
function commands(name: string): string[] {
  const script = scripts[name];
  if (script === undefined) throw new Error(`no script named ${name}`);
  return script
    .split("&&")
    .map((step) => step.trim())
    .flatMap((step) => {
      const nested = /^pnpm (\S+)$/.exec(step)?.[1];
      return nested === undefined ? [step] : commands(nested);
    });
}

const configsOf = (command: string) =>
  [...command.matchAll(/(?:--config|-c)[ =](\S+)/g)].map((m) => m[1] ?? "");
const isViteBuild = (command: string) => command.startsWith("vite build ");

type Deploy = Readonly<{ target: string; dryRun: boolean }>;

/**
 * What a deploy step deploys: the state Worker's config, or — for the
 * request Worker, which goes through `scripts/deploy-built.ts` because
 * wrangler cannot bundle its source — the stage whose build output it is.
 */
function deployOf(command: string): Deploy | null {
  const built = /^tsx scripts\/deploy-built\.ts (\S+)( --dry-run)?$/.exec(
    command,
  );
  if (built !== null) {
    return { target: `built:${built[1]}`, dryRun: built[2] !== undefined };
  }
  if (!command.startsWith("wrangler deploy ")) return null;
  return {
    target: configsOf(command).join(","),
    dryRun: command.includes("--dry-run"),
  };
}

const BUILD_OUTPUT_CONFIG = "dist/server/wrangler.json";

describe.each(DEPLOY_STAGES)("the %s deploy scripts", (stage) => {
  const viteConfig = `vite.config.cloudflare.${stage}.ts`;
  const stateConfig = wranglerConfigFiles(stage).state;

  // The build comes first so that a build failure cannot leave the state
  // Worker deployed alone, and so that the two deploys sit back to back.
  // The state Worker goes before the request Worker because the request
  // Worker's DO bindings name a script that has to exist already.
  it.each([
    [`deploy:${stage}`, false, [`built:${stage}`]],
    [`deploy:${stage}:dry`, true, [`built:${stage}`]],
    [`deploy:${stage}:all`, false, [stateConfig, `built:${stage}`]],
    [`deploy:${stage}:all:dry`, true, [stateConfig, `built:${stage}`]],
  ] as const)(
    "%s builds its own stage, then deploys (dry run: %s) %j",
    (name, dryRun, targets) => {
      const [build, ...rest] = commands(name);
      expect(build !== undefined && isViteBuild(build)).toBe(true);
      expect(configsOf(build ?? "")).toEqual([viteConfig]);
      expect(rest.map(deployOf)).toEqual(
        targets.map((target) => ({ target, dryRun })),
      );
    },
  );
});

describe("pnpm start", () => {
  // The local build is part of the script: a `dist/` left by a stage build
  // names that stage's state Worker, which the local one does not answer to.
  it("builds locally, then serves the build output beside the local state Worker", () => {
    const [build, serve, ...rest] = commands("start:cf");
    expect(rest).toEqual([]);
    expect(build !== undefined && isViteBuild(build)).toBe(true);
    expect(configsOf(build ?? "")).toEqual(["vite.config.cloudflare.ts"]);
    expect(serve?.startsWith("wrangler dev ")).toBe(true);
    expect(configsOf(serve ?? "")).toEqual([
      BUILD_OUTPUT_CONFIG,
      wranglerConfigFiles(null).state,
    ]);
  });
});

describe("no script lets wrangler bundle the request Worker's source", () => {
  const requestSourceConfigs = [
    wranglerConfigFiles(null).request,
    ...DEPLOY_STAGES.map((stage) => wranglerConfigFiles(stage).request),
  ];
  const bundling = Object.keys(scripts).flatMap((name) =>
    commands(name)
      .filter((command) => /^wrangler (deploy|dev)\b/.test(command))
      .map((command) => [name, command] as const),
  );

  it("finds the scripts it is meant to check", () => {
    const names = new Set(bundling.map(([name]) => name));
    expect(names.has("start")).toBe(true);
    for (const stage of DEPLOY_STAGES) {
      expect(names.has(`deploy:${stage}:all`)).toBe(true);
      expect(names.has(`deploy:${stage}:state`)).toBe(true);
    }
  });

  it.each(bundling)("%s: %s", (_name, command) => {
    const configs = configsOf(command);
    // With no `--config`, wrangler picks a config on its own — the last
    // build's output if there is one, `wrangler.toml` otherwise.
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(requestSourceConfigs).not.toContain(config);
    }
  });
});
