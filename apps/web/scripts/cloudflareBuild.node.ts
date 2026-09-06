import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ChildCommand,
  cloudflareChildEnvironment,
  runChildCommand,
  withProcessSignals,
} from "./cloudflareChild.node";
import { readStageConfig, stageConfigPath } from "./cloudflareConfig.node";
import {
  assertSafeWorkspacePath,
  buildRoot,
  webRoot,
} from "./cloudflareFilesystem.node";
import {
  provenancePath,
  writeArtifactProvenance,
} from "./cloudflareProvenance.node";
import { type DeploymentStage, deploymentStage } from "./cloudflareStage";

export type BuildRunner = (input: ChildCommand) => Promise<void>;

const devVarsPath = path.join(buildRoot, "server", ".dev.vars");
const viteTemporaryPath = path.join(webRoot, ".vite-rsc-temp");
const nodeModulesViteTemporaryPath = path.join(
  webRoot,
  "node_modules",
  ".vite-rsc-temp",
);

async function cleanupBuildSecrets(removeProvenance: boolean): Promise<void> {
  await Promise.all([
    assertSafeWorkspacePath(devVarsPath),
    assertSafeWorkspacePath(viteTemporaryPath),
    assertSafeWorkspacePath(nodeModulesViteTemporaryPath),
    assertSafeWorkspacePath(provenancePath),
  ]);
  await Promise.all([
    rm(devVarsPath, { force: true }),
    rm(viteTemporaryPath, { recursive: true, force: true }),
    rm(nodeModulesViteTemporaryPath, { recursive: true, force: true }),
    ...(removeProvenance ? [rm(provenancePath, { force: true })] : []),
  ]);
}

export async function runCloudflareBuild(input: {
  stage: DeploymentStage;
  configPath: string;
  source: Readonly<Record<string, string | undefined>>;
  runner?: BuildRunner;
  signal?: AbortSignal;
}): Promise<void> {
  const expectedConfigPath = stageConfigPath(input.stage);
  if (path.resolve(input.configPath) !== expectedConfigPath)
    throw new Error(`Build config must be the generated ${input.stage} config`);
  await readStageConfig(expectedConfigPath, input.stage);
  await assertSafeWorkspacePath(expectedConfigPath, { requireFile: true });
  await assertSafeWorkspacePath(buildRoot);
  await cleanupBuildSecrets(true);
  let complete = false;
  try {
    const env = cloudflareChildEnvironment(input.source);
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_ACCOUNT_ID;
    env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH = expectedConfigPath;
    if (input.signal?.aborted)
      throw input.signal.reason ?? new Error("Build aborted");
    await (input.runner ?? runChildCommand)({
      command: "pnpm",
      args: ["exec", "vite", "build", "--config", "vite.config.cloudflare.ts"],
      cwd: webRoot,
      env,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await cleanupBuildSecrets(false);
    await writeArtifactProvenance(input.stage, expectedConfigPath);
    complete = true;
  } finally {
    await cleanupBuildSecrets(!complete);
  }
}

async function main(): Promise<void> {
  const position = process.argv.indexOf("--stage");
  const stage = deploymentStage(
    position < 0 ? undefined : process.argv[position + 1],
  );
  await withProcessSignals((signal) =>
    runCloudflareBuild({
      stage,
      configPath: stageConfigPath(stage),
      source: process.env,
      signal,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `[fog.cloudflare.build] failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
