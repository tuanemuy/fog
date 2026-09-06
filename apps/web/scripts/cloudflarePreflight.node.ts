import path from "node:path";
import { readStageConfig, stageConfigPath } from "./cloudflareConfig.node";
import {
  assertSafeWorkspacePath,
  readSafeFile,
} from "./cloudflareFilesystem.node";
import {
  type ArtifactProvenance,
  builtConfigPath as expectedBuiltConfigPath,
  validateArtifactProvenance,
} from "./cloudflareProvenance.node";
import {
  cloudflareAuth,
  type DeploymentStage,
  type RuntimeSecretPayload,
  runtimeSecrets,
  type StageConfig,
  validateDatabaseAuthority,
  validateBuiltStageConfig,
  validateStageConfig,
} from "./cloudflareStage";

declare const preflightBrand: unique symbol;

export type CloudflarePreflight = {
  readonly [preflightBrand]: true;
  readonly stage: DeploymentStage;
  readonly config: StageConfig;
  readonly sourceConfigPath: string;
  readonly builtConfigPath: string;
  readonly runtimeSecrets: RuntimeSecretPayload;
  readonly cloudflareAuth: Record<
    "CLOUDFLARE_API_TOKEN" | "CLOUDFLARE_ACCOUNT_ID",
    string
  >;
  readonly provenance: ArtifactProvenance;
  readonly bootstrapDatabaseIdentity: boolean;
  readonly databaseIdentityRebindFrom?: string;
};

export type ProvenanceVerifier = (input: {
  stage: DeploymentStage;
  sourceConfigPath: string;
  requireClean: boolean;
}) => Promise<ArtifactProvenance>;

export async function createCloudflarePreflight(input: {
  stage: DeploymentStage;
  sourceConfig: StageConfig;
  sourceConfigPath: string;
  builtConfig: unknown;
  builtConfigPath: string;
  source: Readonly<Record<string, string | undefined>>;
  sideEffect: boolean;
  provenanceVerifier?: ProvenanceVerifier;
}): Promise<CloudflarePreflight> {
  const expectedSourceConfigPath = stageConfigPath(input.stage);
  if (path.resolve(input.sourceConfigPath) !== expectedSourceConfigPath)
    throw new Error(
      `Preflight source config must be the generated ${input.stage} config`,
    );
  if (path.resolve(input.builtConfigPath) !== expectedBuiltConfigPath)
    throw new Error(
      "Preflight built config must be the current build artifact",
    );
  const config = validateStageConfig(input.sourceConfig, input.stage);
  validateBuiltStageConfig(input.builtConfig, config);
  const built = input.builtConfig as Record<string, unknown>;
  if (
    built.configPath !== path.resolve(input.sourceConfigPath) ||
    built.userConfigPath !== path.resolve(input.sourceConfigPath)
  )
    throw new Error(
      "Built config does not originate from the selected source config",
    );
  const bootstrapValue = input.source.DATABASE_IDENTITY_BOOTSTRAP?.trim();
  if (bootstrapValue && bootstrapValue !== "true")
    throw new Error(
      "DATABASE_IDENTITY_BOOTSTRAP must be exactly true when used",
    );
  const rebindValue = input.source.DATABASE_IDENTITY_REBIND_FROM?.trim();
  const databaseIdentityRebindFrom = rebindValue
    ? validateDatabaseAuthority(input.stage, rebindValue)
    : undefined;
  if (databaseIdentityRebindFrom === config.vars.EXPECTED_DATABASE_IDENTITY)
    throw new Error(
      "DATABASE_IDENTITY_REBIND_FROM must differ from DATABASE_IDENTITY",
    );
  if (databaseIdentityRebindFrom && bootstrapValue)
    throw new Error(
      "DATABASE_IDENTITY_REBIND_FROM and DATABASE_IDENTITY_BOOTSTRAP cannot be used together",
    );
  const secrets = input.sideEffect
    ? runtimeSecrets(config, input.source)
    : ({} as RuntimeSecretPayload);
  const auth = input.sideEffect
    ? cloudflareAuth(input.source)
    : ({} as Record<"CLOUDFLARE_API_TOKEN" | "CLOUDFLARE_ACCOUNT_ID", string>);
  const provenance = await (
    input.provenanceVerifier ?? validateArtifactProvenance
  )({
    stage: input.stage,
    sourceConfigPath: input.sourceConfigPath,
    requireClean: input.sideEffect,
  });
  return {
    stage: input.stage,
    config,
    sourceConfigPath: input.sourceConfigPath,
    builtConfigPath: input.builtConfigPath,
    runtimeSecrets: secrets,
    cloudflareAuth: auth,
    provenance,
    bootstrapDatabaseIdentity: bootstrapValue === "true",
    ...(databaseIdentityRebindFrom ? { databaseIdentityRebindFrom } : {}),
  } as CloudflarePreflight;
}

export async function loadCloudflarePreflight(input: {
  stage: DeploymentStage;
  source: Readonly<Record<string, string | undefined>>;
  sideEffect: boolean;
}): Promise<CloudflarePreflight> {
  const sourcePath = stageConfigPath(input.stage);
  await Promise.all([
    assertSafeWorkspacePath(sourcePath, { requireFile: true }),
    assertSafeWorkspacePath(expectedBuiltConfigPath, { requireFile: true }),
  ]);
  const [sourceConfig, builtContents] = await Promise.all([
    readStageConfig(sourcePath, input.stage),
    readSafeFile(expectedBuiltConfigPath),
  ]);
  return createCloudflarePreflight({
    stage: input.stage,
    sourceConfig,
    sourceConfigPath: sourcePath,
    builtConfig: JSON.parse(builtContents) as unknown,
    builtConfigPath: expectedBuiltConfigPath,
    source: input.source,
    sideEffect: input.sideEffect,
  });
}
