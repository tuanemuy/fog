import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  atomicWriteSafeFile,
  generatedRoot,
  readSafeFile,
  webRoot,
} from "./cloudflareFilesystem.node";
import {
  type DeploymentStage,
  deploymentStage,
  renderStageConfig,
  type StageConfig,
  validateStageConfig,
  validateStagePair,
} from "./cloudflareStage";

const templatePath = path.join(webRoot, "cloudflare", "wrangler.template.json");

export function stageConfigPath(stage: DeploymentStage): string {
  return path.join(generatedRoot, stage, "wrangler.json");
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readSafeFile(file));
}

export async function readStageConfig(
  file: string,
  stage: DeploymentStage,
): Promise<StageConfig> {
  return validateStageConfig(await readJson(file), stage);
}

export async function renderConfig(input: {
  stage: DeploymentStage;
  domain: string;
  databaseIdentity: string;
  databaseUrl: string;
  deploymentSha: string;
}): Promise<string> {
  const template = await readJson(templatePath);
  const config = renderStageConfig({
    template,
    stage: input.stage,
    domain: input.domain,
    databaseIdentity: input.databaseIdentity,
    databaseUrl: input.databaseUrl,
    deploymentSha: input.deploymentSha,
  });
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  for (const value of [input.databaseUrl, process.env.DATABASE_AUTH_TOKEN])
    if (value && serialized.includes(value))
      throw new Error("Generated config contains a secret value");
  const output = stageConfigPath(input.stage);
  await atomicWriteSafeFile(output, serialized);
  return output;
}

function option(name: string): string | undefined {
  const position = process.argv.indexOf(name);
  return position < 0 ? undefined : process.argv[position + 1];
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "render") {
    const stage = deploymentStage(option("--stage"));
    const domain = process.env.DOMAIN;
    const databaseIdentity = process.env.DATABASE_IDENTITY;
    const databaseUrl = process.env.DATABASE_URL;
    const deploymentSha = process.env.DEPLOYMENT_SHA;
    if (!domain) throw new Error("DOMAIN is required");
    if (!databaseIdentity) throw new Error("DATABASE_IDENTITY is required");
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    if (!deploymentSha) throw new Error("DEPLOYMENT_SHA is required");
    const output = await renderConfig({
      stage,
      domain,
      databaseIdentity,
      databaseUrl,
      deploymentSha,
    });
    console.log(`[fog.cloudflare.config] rendered ${stage}: ${output}`);
    return;
  }
  if (command === "validate") {
    const stage = deploymentStage(option("--stage"));
    const file = path.resolve(option("--config") ?? stageConfigPath(stage));
    if (file !== stageConfigPath(stage))
      throw new Error(`--config must be the generated ${stage} config`);
    await readStageConfig(file, stage);
    console.log(`[fog.cloudflare.config] valid ${stage}: ${file}`);
    return;
  }
  if (command === "validate-pair") {
    const staging = await readJson(stageConfigPath("staging"));
    const production = await readJson(stageConfigPath("production"));
    validateStagePair(staging, production);
    console.log("[fog.cloudflare.config] staging/production isolation valid");
    return;
  }
  throw new Error(
    "Usage: cloudflareConfig.node.ts render|validate --stage staging|production, or validate-pair",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `[fog.cloudflare.config] failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
