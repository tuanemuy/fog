import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  type DeployStage,
  isDeployStage,
  wranglerConfigFiles,
} from "./deployStage";

/** The config the Vite build writes for the request Worker, relative to `apps/web`. */
export const BUILD_OUTPUT_CONFIG = "dist/server/wrangler.json";

/**
 * Why the build output must not be deployed to `stage`, or `null` when it
 * was built from that stage's rendered request config. `dist/` holds
 * whatever was built last — a local build, another stage's — and the output
 * config records which request config it came from as `userConfigPath`.
 */
export function stageMismatch(
  stage: DeployStage,
  outputConfig: unknown,
): string | null {
  const expected = wranglerConfigFiles(stage).request;
  const source =
    typeof outputConfig === "object" &&
    outputConfig !== null &&
    "userConfigPath" in outputConfig &&
    typeof outputConfig.userConfigPath === "string"
      ? basename(outputConfig.userConfigPath)
      : null;
  if (source === expected) return null;
  return (
    `${BUILD_OUTPUT_CONFIG} was built from ${source ?? "an unknown config"}, ` +
    `not from ${expected}. Run \`pnpm build:${stage}\` first.`
  );
}

/**
 * `stageMismatch` for the output config at `outputConfigPath`, with a
 * missing or unparseable file as one more reason not to deploy.
 */
export function buildOutputProblem(
  stage: DeployStage,
  outputConfigPath: string,
): string | null {
  let outputConfig: unknown;
  try {
    outputConfig = JSON.parse(readFileSync(outputConfigPath, "utf8"));
  } catch {
    return (
      `${BUILD_OUTPUT_CONFIG} is missing or unreadable. ` +
      `Run \`pnpm build:${stage}\` first.`
    );
  }
  return stageMismatch(stage, outputConfig);
}

export type DeployBuiltArgs = Readonly<{ stage: DeployStage; dryRun: boolean }>;

/**
 * `<stage> [--dry-run]`, and nothing else. Anything unrecognised is `null`
 * rather than ignored: a misspelt `--dry-run` that fell through would turn
 * a rehearsal into an upload.
 */
export function parseDeployBuiltArgs(
  args: readonly string[],
): DeployBuiltArgs | null {
  const [stage, ...flags] = args;
  if (stage === undefined || !isDeployStage(stage)) return null;
  if (flags.length === 0) return { stage, dryRun: false };
  return flags.length === 1 && flags[0] === "--dry-run"
    ? { stage, dryRun: true }
    : null;
}
