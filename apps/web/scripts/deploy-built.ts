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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILD_OUTPUT_CONFIG,
  buildOutputProblem,
  parseDeployBuiltArgs,
} from "./lib/buildOutput";
import { DEPLOY_STAGES } from "./lib/deployStage";

const args = parseDeployBuiltArgs(process.argv.slice(2));
if (args === null) {
  console.error(
    `usage: tsx scripts/deploy-built.ts <${DEPLOY_STAGES.join("|")}> [--dry-run]`,
  );
  process.exit(1);
}

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const problem = buildOutputProblem(
  args.stage,
  resolve(webRoot, BUILD_OUTPUT_CONFIG),
);
if (problem !== null) {
  console.error(problem);
  process.exit(1);
}

try {
  execFileSync(
    resolve(webRoot, "node_modules/.bin/wrangler"),
    [
      "deploy",
      "--config",
      BUILD_OUTPUT_CONFIG,
      ...(args.dryRun ? ["--dry-run", "--outdir=dist/worker"] : []),
    ],
    { cwd: webRoot, stdio: "inherit" },
  );
} catch {
  process.exit(1);
}
