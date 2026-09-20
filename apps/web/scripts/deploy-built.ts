/**
 * Deploy the request Worker from the Vite build output, after checking that
 * the output was built for the stage being deployed.
 *
 * Usage:
 *   tsx scripts/deploy-built.ts <stage> [--dry-run]
 *
 * `wrangler` is handed `dist/server/wrangler.json` because it cannot bundle
 * the request Worker's source entry (TanStack Start virtual modules only the
 * Vite plugin supplies). That file is whatever was built last, so the stage
 * check is what keeps a local build, or another stage's, from being
 * uploaded under this stage's command.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_OUTPUT_CONFIG, stageMismatch } from "./lib/buildOutput";
import { DEPLOY_STAGES, isDeployStage } from "./lib/deployStage";

const [stageArg, ...flags] = process.argv.slice(2);
const dryRun = flags.length === 1 && flags[0] === "--dry-run";
if (
  stageArg === undefined ||
  !isDeployStage(stageArg) ||
  (flags.length > 0 && !dryRun)
) {
  console.error(
    `usage: tsx scripts/deploy-built.ts <${DEPLOY_STAGES.join("|")}> [--dry-run]`,
  );
  process.exit(1);
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputConfigPath = resolve(webRoot, BUILD_OUTPUT_CONFIG);

let outputConfig: unknown;
try {
  outputConfig = JSON.parse(readFileSync(outputConfigPath, "utf8"));
} catch {
  console.error(
    `${BUILD_OUTPUT_CONFIG} is missing or unreadable. Run \`pnpm build:${stageArg}\` first.`,
  );
  process.exit(1);
}

const mismatch = stageMismatch(stageArg, outputConfig);
if (mismatch !== null) {
  console.error(mismatch);
  process.exit(1);
}

try {
  execFileSync(
    resolve(webRoot, "node_modules/.bin/wrangler"),
    [
      "deploy",
      "--config",
      BUILD_OUTPUT_CONFIG,
      ...(dryRun ? ["--dry-run", "--outdir=dist/worker"] : []),
    ],
    { cwd: webRoot, stdio: "inherit" },
  );
} catch {
  process.exit(1);
}
