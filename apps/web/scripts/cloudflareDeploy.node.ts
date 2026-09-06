import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ChildCommand,
  cloudflareChildEnvironment,
  runChildCommand,
  withProcessSignals,
} from "./cloudflareChild.node";
import { assertSafeWorkspacePath, webRoot } from "./cloudflareFilesystem.node";
import {
  type CloudflarePreflight,
  loadCloudflarePreflight,
} from "./cloudflarePreflight.node";
import { deploymentStage } from "./cloudflareStage";

export type DeployRunner = (input: ChildCommand) => Promise<void>;

export async function runCloudflareDeploy(input: {
  preflight: CloudflarePreflight;
  dryRun: boolean;
  runner?: DeployRunner;
  signal?: AbortSignal;
}): Promise<void> {
  const dryRunOutput = path.join(
    webRoot,
    ".cloudflare",
    "dry-run",
    input.preflight.stage,
  );
  await assertSafeWorkspacePath(dryRunOutput);
  if (input.dryRun) await rm(dryRunOutput, { recursive: true, force: true });
  const args = [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    input.preflight.builtConfigPath,
    "--strict",
  ];
  if (input.dryRun) args.push("--dry-run", "--outdir", dryRunOutput);
  let complete = false;
  try {
    await (input.runner ?? runChildCommand)({
      command: "pnpm",
      args,
      cwd: webRoot,
      env: cloudflareChildEnvironment({
        ...input.preflight.cloudflareAuth,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        CI: process.env.CI,
        NO_COLOR: process.env.NO_COLOR,
        FORCE_COLOR: process.env.FORCE_COLOR,
      }),
      output: input.dryRun
        ? { mode: "diagnostic" }
        : {
            mode: "discard",
            failureLabel: "Cloudflare deployment",
          },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    complete = true;
  } finally {
    if (input.dryRun && !complete) {
      await assertSafeWorkspacePath(dryRunOutput);
      await rm(dryRunOutput, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const stagePosition = process.argv.indexOf("--stage");
  const stage = deploymentStage(
    stagePosition < 0 ? undefined : process.argv[stagePosition + 1],
  );
  const dryRun = process.argv.includes("--dry-run");
  const deploy = process.argv.includes("--deploy");
  if (dryRun === deploy)
    throw new Error("Exactly one of --dry-run or --deploy is required");
  await withProcessSignals(async (signal) => {
    const preflight = await loadCloudflarePreflight({
      stage,
      source: process.env,
      sideEffect: deploy,
    });
    await runCloudflareDeploy({ preflight, dryRun, signal });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `[fog.cloudflare.deploy] failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
