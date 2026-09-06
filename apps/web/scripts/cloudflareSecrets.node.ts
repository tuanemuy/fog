import { pathToFileURL } from "node:url";
import {
  type ChildCommand,
  cloudflareChildEnvironment,
  runChildCommand,
  withProcessSignals,
} from "./cloudflareChild.node";
import { webRoot } from "./cloudflareFilesystem.node";
import {
  type CloudflarePreflight,
  loadCloudflarePreflight,
} from "./cloudflarePreflight.node";
import { deploymentStage } from "./cloudflareStage";

export type SecretBulkRunner = (input: ChildCommand) => Promise<void>;

export async function syncRuntimeSecrets(input: {
  preflight: CloudflarePreflight;
  runner?: SecretBulkRunner;
  signal?: AbortSignal;
}): Promise<void> {
  await (input.runner ?? runChildCommand)({
    command: "pnpm",
    args: [
      "exec",
      "wrangler",
      "secret",
      "bulk",
      "--config",
      input.preflight.sourceConfigPath,
      "--name",
      input.preflight.config.name,
    ],
    cwd: webRoot,
    stdin: JSON.stringify(input.preflight.runtimeSecrets),
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
    output: {
      mode: "discard",
      failureLabel: "Cloudflare secret synchronization",
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

async function main(): Promise<void> {
  const position = process.argv.indexOf("--stage");
  const stage = deploymentStage(
    position < 0 ? undefined : process.argv[position + 1],
  );
  await withProcessSignals(async (signal) => {
    const preflight = await loadCloudflarePreflight({
      stage,
      source: process.env,
      sideEffect: true,
    });
    if (signal.aborted) throw signal.reason;
    await syncRuntimeSecrets({ preflight, signal });
  });
  console.log(`[fog.cloudflare.secrets] synchronized ${stage}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `[fog.cloudflare.secrets] failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
