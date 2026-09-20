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
const isWranglerDeploy = (command: string) =>
  command.startsWith("wrangler deploy ");
const isDryRun = (command: string) => command.includes("--dry-run");

// The request Worker's source entry imports TanStack Start virtual modules
// that only the Vite plugin supplies, so wrangler is handed the build's
// output config and never a config whose `main` is that entry.
const BUILD_OUTPUT_CONFIG = "dist/server/wrangler.json";

describe.each(DEPLOY_STAGES)("the %s deploy scripts", (stage) => {
  const viteConfig = `vite.config.cloudflare.${stage}.ts`;
  const stateConfig = wranglerConfigFiles(stage).state;

  it.each([`deploy:${stage}`, `deploy:${stage}:dry`])(
    "%s builds its own stage, then deploys the build output",
    (name) => {
      const [build, ...deploys] = commands(name);
      expect(build !== undefined && isViteBuild(build)).toBe(true);
      expect(configsOf(build ?? "")).toEqual([viteConfig]);
      expect(deploys.map(configsOf)).toEqual([[BUILD_OUTPUT_CONFIG]]);
      expect(deploys.every(isWranglerDeploy)).toBe(true);
    },
  );

  // The build comes first so that a build failure cannot leave the state
  // Worker deployed alone, and so that the two deploys sit back to back.
  // The state Worker goes before the request Worker because the request
  // Worker's DO bindings name a script that has to exist already.
  it.each([`deploy:${stage}:all`, `deploy:${stage}:all:dry`])(
    "%s builds, then deploys the state Worker, then the request Worker",
    (name) => {
      const [build, ...deploys] = commands(name);
      expect(build !== undefined && isViteBuild(build)).toBe(true);
      expect(configsOf(build ?? "")).toEqual([viteConfig]);
      expect(deploys.map(configsOf)).toEqual([
        [stateConfig],
        [BUILD_OUTPUT_CONFIG],
      ]);
      expect(deploys.every(isWranglerDeploy)).toBe(true);
    },
  );

  it("uploads from the plain scripts and from none of their :dry twins", () => {
    for (const name of [`deploy:${stage}`, `deploy:${stage}:all`]) {
      const plain = commands(name).filter(isWranglerDeploy);
      const dry = commands(`${name}:dry`).filter(isWranglerDeploy);
      expect(dry).toHaveLength(plain.length);
      expect(plain.filter(isDryRun)).toEqual([]);
      expect(dry.filter((command) => !isDryRun(command))).toEqual([]);
    }
  });
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
      expect(names.has(`deploy:${stage}`)).toBe(true);
      expect(names.has(`deploy:${stage}:state`)).toBe(true);
    }
  });

  it.each(bundling)("%s: %s", (_name, command) => {
    const configs = configsOf(command);
    // With no `--config`, wrangler discovers `wrangler.toml` on its own.
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      expect(requestSourceConfigs).not.toContain(config);
    }
  });
});
