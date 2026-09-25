/**
 * Render the deploy configs of both Workers for one stage from their
 * `.tpl` templates, substituting placeholders with outputs from the
 * Cloudflare resources Pulumi stack and with `MAIL_FROM_ADDRESS` from the
 * environment.
 *
 * Two files come out per stage — `wrangler.<stage>.toml` (request Worker)
 * and `wrangler.state.<stage>.toml` (state Worker). **Rendering both from
 * the same Pulumi outputs is what keeps the request config's
 * `script_name` and the state config's `name` in agreement**; the Vite
 * plugin and the deploy both go quiet rather than failing when they
 * disagree.
 *
 * Usage:
 *   pnpm cf:render:<stage>
 *
 * Every `${NAME}` in a template is substituted, and where each name's value
 * comes from is `WRANGLER_PLACEHOLDER_SOURCES`. A name with no value aborts
 * the run, so we never ship a half-rendered config.
 *
 * Pulumi outputs are read via
 * `pulumi -C <dir> -s <stage> stack output --json --show-secrets` (without
 * `--show-secrets` a secret output comes back masked) — the CLI must already
 * be authenticated and the resources stack already `pulumi up`-ed for the
 * target stage.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEPLOY_STAGES,
  type DeployStage,
  isDeployStage,
  templateFileOf,
  wranglerConfigFiles,
} from "./lib/deployStage";
import {
  renderWranglerTemplate,
  stageSubstitutions,
} from "./lib/wranglerTemplate";

const stageArg = process.argv[2];
if (stageArg === undefined || !isDeployStage(stageArg)) {
  console.error(`usage: pnpm cf:render:<${DEPLOY_STAGES.join("|")}>`);
  process.exit(1);
}
const stage: DeployStage = stageArg;

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const resourcesDir = resolve(repoRoot, "infra/cloudflare/pulumi/resources");
const rendered = wranglerConfigFiles(stage);
const targets = [rendered.request, rendered.state].map((file) => ({
  templatePath: resolve(webRoot, templateFileOf(file)),
  outPath: resolve(webRoot, file),
}));

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
const substitutions = stageSubstitutions(
  JSON.parse(raw) as Record<string, unknown>,
  process.env,
);

for (const { templatePath, outPath } of targets) {
  writeFileSync(
    outPath,
    renderWranglerTemplate(
      readFileSync(templatePath, "utf8"),
      substitutions,
      templatePath,
    ),
  );
  console.log(`wrote ${outPath}`);
}
