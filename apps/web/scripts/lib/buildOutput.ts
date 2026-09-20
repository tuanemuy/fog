import { basename } from "node:path";
import { type DeployStage, wranglerConfigFiles } from "./deployStage";

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
