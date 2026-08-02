/**
 * Render `wrangler.<role>.<stage>.toml` from the matching `.tpl` template by
 * substituting placeholders with outputs from the Cloudflare resources Pulumi
 * stack.
 *
 * Usage:
 *   pnpm cf:render:<stage>
 *
 * Two roles are rendered per stage, because the app deploys as two Workers: the
 * `request` Worker that serves HTTP and the `state` Worker that owns the
 * Durable Object classes. The stage stays the script's only argument — a role
 * is never rendered on its own, since the request config names the state
 * Worker's script and the two must agree on the prefix.
 *
 * Placeholders recognised in the templates (any `${NAME}` occurrence is
 * substituted; unknown names abort the run so we never ship a half-rendered
 * config):
 *   ${APP_URL}            — public URL of the deployment
 *   ${RESOURCE_PREFIX}    — worker / resource name prefix (e.g. `fog-staging`)
 *
 * Pulumi outputs are read via `pulumi -C <dir> -s <stage> stack output --json`
 * — the CLI must already be authenticated and the resources stack already
 * `pulumi up`-ed for the target stage.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_STAGES = ["staging", "production"] as const;
type Stage = (typeof SUPPORTED_STAGES)[number];

const ROLES = ["request", "state"] as const;

function isStage(value: string): value is Stage {
  return (SUPPORTED_STAGES as readonly string[]).includes(value);
}

const stageArg = process.argv[2];
if (stageArg === undefined || !isStage(stageArg)) {
  console.error(`usage: pnpm cf:render:<${SUPPORTED_STAGES.join("|")}>`);
  process.exit(1);
}
const stage: Stage = stageArg;

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const resourcesDir = resolve(repoRoot, "infra/cloudflare/pulumi/resources");

const raw = execFileSync(
  "pulumi",
  [
    "-C",
    resourcesDir,
    "-s",
    stage,
    "stack",
    "output",
    "--json",
    "--show-secrets",
  ],
  { encoding: "utf8" },
);
const outputs = JSON.parse(raw) as Record<string, string>;

const substitutions: Record<string, string | undefined> = {
  APP_URL: outputs.exportedAppUrl,
  RESOURCE_PREFIX: outputs.exportedPrefix,
};

for (const role of ROLES) {
  const templatePath = resolve(webRoot, `wrangler.${role}.${stage}.toml.tpl`);
  const outPath = resolve(webRoot, `wrangler.${role}.${stage}.toml`);

  const template = readFileSync(templatePath, "utf8");
  const rendered = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) => {
    const value = substitutions[name];
    if (value === undefined) {
      throw new Error(
        `Unknown placeholder \${${name}} in ${templatePath}. ` +
          `Known: ${Object.keys(substitutions).join(", ")}`,
      );
    }
    return value;
  });

  writeFileSync(outPath, rendered);
  console.log(`wrote ${outPath}`);
}
