import { remoteLibsqlIdentity } from "@repo/core/lib/remoteLibsql";
import { getDomain } from "tldts";
import { z } from "zod";
import { readFogAiClients } from "../app/presentation/fogAiConfig";

export const deploymentStages = ["staging", "production"] as const;
export type DeploymentStage = (typeof deploymentStages)[number];

export const requiredRuntimeSecretKeys = [
  "DATABASE_URL",
  "DATABASE_AUTH_TOKEN",
  "FOG_GOOGLE_CLIENT_ID",
  "FOG_GOOGLE_CLIENT_SECRET",
] as const;

export const optionalRuntimeSecretKeys = ["FOG_AI_CLIENTS"] as const;
export type RuntimeSecretPayload = Record<
  (typeof requiredRuntimeSecretKeys)[number],
  string
> &
  Record<(typeof optionalRuntimeSecretKeys)[number], string | null>;
export const cloudflareAuthKeys = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
] as const;
const placeholder = /(?:__[^_]+(?:_[^_]+)*__|\$\{[^}]+\})/;
const hostname = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(`https://${value}`);
      return (
        url.hostname === value &&
        url.port === "" &&
        url.pathname === "/" &&
        !value.includes("_")
      );
    } catch {
      return false;
    }
  }, "Invalid hostname");
const stageSchema = z.enum(deploymentStages);
export const deploymentShaSchema = z
  .string()
  .regex(
    /^[0-9a-f]{40}$/,
    "DEPLOYMENT_SHA must be a full lowercase commit SHA",
  );
const configSchema = z
  .object({
    $schema: z.string(),
    name: z.string().min(1),
    main: z.literal("../../../app/server.cloudflare.ts"),
    compatibility_date: z.literal("2026-08-04"),
    compatibility_flags: z.tuple([z.literal("nodejs_compat")]),
    workers_dev: z.literal(false),
    routes: z
      .array(
        z
          .object({ pattern: hostname, custom_domain: z.literal(true) })
          .strict(),
      )
      .length(1),
    triggers: z
      .object({
        crons: z.tuple([z.literal("* * * * *"), z.literal("0 3 * * *")]),
      })
      .strict(),
    send_email: z
      .array(
        z
          .object({
            name: z.literal("EMAIL"),
            allowed_sender_addresses: z.array(z.email()).length(1),
          })
          .strict(),
      )
      .length(1),
    secrets: z.object({ required: z.array(z.string()).min(1) }).strict(),
    vars: z
      .object({
        APP_URL: z.url(),
        DEPLOYMENT_SHA: deploymentShaSchema,
        DEPLOYMENT_ENV: stageSchema,
        EXPECTED_DATABASE_IDENTITY: z.string().trim().min(1),
        FOG_EMAIL_FROM: z.email(),
        FOG_GOOGLE_CALLBACK_URL: z.url(),
      })
      .strict(),
  })
  .strict();
const builtConfigSchema = z
  .object({
    name: z.string(),
    main: z.literal("index.js"),
    compatibility_date: configSchema.shape.compatibility_date,
    compatibility_flags: configSchema.shape.compatibility_flags,
    workers_dev: configSchema.shape.workers_dev,
    routes: configSchema.shape.routes,
    triggers: configSchema.shape.triggers,
    send_email: configSchema.shape.send_email,
    secrets: configSchema.shape.secrets,
    vars: configSchema.shape.vars,
    assets: z.object({ directory: z.literal("../client") }).strict(),
  })
  .passthrough();

const builtTopLevelKeys = [
  "configPath",
  "userConfigPath",
  "topLevelName",
  "definedEnvironments",
  "compatibility_date",
  "compatibility_flags",
  "jsx_factory",
  "jsx_fragment",
  "rules",
  "name",
  "main",
  "routes",
  "triggers",
  "assets",
  "workers_dev",
  "vars",
  "secrets",
  "durable_objects",
  "workflows",
  "migrations",
  "exports",
  "kv_namespaces",
  "cloudchamber",
  "send_email",
  "queues",
  "connect",
  "r2_buckets",
  "d1_databases",
  "vectorize",
  "ai_search_namespaces",
  "ai_search",
  "agent_memory",
  "hyperdrive",
  "services",
  "analytics_engine_datasets",
  "dispatch_namespaces",
  "mtls_certificates",
  "pipelines",
  "secrets_store_secrets",
  "artifacts",
  "unsafe_hello_world",
  "flagship",
  "worker_loaders",
  "ratelimits",
  "vpc_services",
  "vpc_networks",
  "logfwdr",
  "python_modules",
  "dev",
  "no_bundle",
] as const;

export type StageConfig = z.infer<typeof configSchema>;

export function deploymentStage(value: unknown): DeploymentStage {
  return stageSchema.parse(value);
}

export function deploymentDomain(value: unknown): string {
  const domain = z.string().trim().toLowerCase().parse(value);
  if (
    placeholder.test(domain) ||
    domain === "localhost" ||
    hostname.safeParse(domain).success === false ||
    getDomain(domain, { allowPrivateDomains: false }) !== domain
  )
    throw new Error("DOMAIN must be a registrable ICANN apex domain");
  return domain;
}

export function stageIdentity(stage: DeploymentStage, domainInput: unknown) {
  const domain = deploymentDomain(domainInput);
  const workerName = stage === "staging" ? "fog-staging" : "fog-production";
  const host = stage === "staging" ? `staging-fog.${domain}` : `fog.${domain}`;
  const appUrl = `https://${host}`;
  return {
    stage,
    domain,
    workerName,
    host,
    appUrl,
    googleCallbackUrl: `${appUrl}/auth/google/callback`,
    emailFrom: `${stage === "staging" ? "fog-staging" : "fog"}@${domain}`,
  } as const;
}

export function renderStageConfig(input: {
  template: unknown;
  stage: DeploymentStage;
  domain: unknown;
  databaseIdentity: string;
  databaseUrl: string;
  deploymentSha: string;
}): StageConfig {
  const identity = stageIdentity(input.stage, input.domain);
  const databaseIdentity = validateDatabaseAuthority(
    input.stage,
    input.databaseIdentity,
  );
  if (remoteLibsqlIdentity(input.databaseUrl) !== databaseIdentity)
    throw new Error("DATABASE_URL does not match DATABASE_IDENTITY authority");
  const substitutions = new Map([
    ["__WORKER_NAME__", identity.workerName],
    ["__HOSTNAME__", identity.host],
    ["__APP_URL__", identity.appUrl],
    ["__DEPLOYMENT_SHA__", deploymentShaSchema.parse(input.deploymentSha)],
    ["__STAGE__", identity.stage],
    ["__DATABASE_IDENTITY__", databaseIdentity],
    ["__EMAIL_FROM__", identity.emailFrom],
    ["__GOOGLE_CALLBACK_URL__", identity.googleCallbackUrl],
  ]);
  const serialized = JSON.stringify(input.template, (_key, value) =>
    typeof value === "string" && substitutions.has(value)
      ? substitutions.get(value)
      : value,
  );
  if (placeholder.test(serialized))
    throw new Error("Generated config contains an unexpanded placeholder");
  return validateStageConfig(JSON.parse(serialized), input.stage);
}

export function validateStageConfig(
  value: unknown,
  expectedStage?: DeploymentStage,
): StageConfig {
  if (placeholder.test(JSON.stringify(value)))
    throw new Error("Config contains an unexpanded placeholder");
  const config = configSchema.parse(value);
  const stage = expectedStage ?? config.vars.DEPLOYMENT_ENV;
  if (config.vars.DEPLOYMENT_ENV !== stage)
    throw new Error(
      "Config deployment stage does not match the requested stage",
    );
  validateDatabaseAuthority(stage, config.vars.EXPECTED_DATABASE_IDENTITY);
  const routeHost = config.routes[0].pattern;
  const prefix = stage === "staging" ? "staging-fog." : "fog.";
  if (!routeHost.startsWith(prefix))
    throw new Error("Config hostname is invalid");
  const identity = stageIdentity(stage, routeHost.slice(prefix.length));
  if (
    config.name !== identity.workerName ||
    config.vars.APP_URL !== identity.appUrl ||
    config.vars.FOG_GOOGLE_CALLBACK_URL !== identity.googleCallbackUrl ||
    config.vars.FOG_EMAIL_FROM !== identity.emailFrom ||
    config.send_email[0].allowed_sender_addresses[0] !== identity.emailFrom
  )
    throw new Error("Config stage identity is inconsistent");
  if (
    config.secrets.required.length !== requiredRuntimeSecretKeys.length ||
    requiredRuntimeSecretKeys.some(
      (key) => !config.secrets.required.includes(key),
    ) ||
    new Set(config.secrets.required).size !== config.secrets.required.length
  )
    throw new Error("Config must declare exactly the required runtime secrets");
  const forbiddenVars = [
    "DATABASE_URL",
    "DATABASE_AUTH_TOKEN",
    "FOG_GOOGLE_CLIENT_ID",
    "FOG_GOOGLE_CLIENT_SECRET",
    "FOG_AI_CLIENTS",
  ];
  if (forbiddenVars.some((key) => key in config.vars))
    throw new Error("Secret values must not be stored in config vars");
  return config;
}

export function validateStagePair(staging: unknown, production: unknown): void {
  const left = validateStageConfig(staging, "staging");
  const right = validateStageConfig(production, "production");
  if (
    left.name === right.name ||
    left.routes[0].pattern === right.routes[0].pattern ||
    left.vars.APP_URL === right.vars.APP_URL ||
    left.vars.EXPECTED_DATABASE_IDENTITY ===
      right.vars.EXPECTED_DATABASE_IDENTITY
  )
    throw new Error("Staging and production identities must be isolated");
}

export function validateBuiltStageConfig(
  value: unknown,
  source: StageConfig,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Built config must be an object");
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...builtTopLevelKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys))
    throw new Error(
      "Built config contains missing or unknown top-level fields",
    );
  const built = builtConfigSchema.parse(value);
  for (const key of [
    "name",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "routes",
    "triggers",
    "send_email",
    "secrets",
    "vars",
  ] as const)
    if (JSON.stringify(built[key]) !== JSON.stringify(source[key]))
      throw new Error(`Built config does not match source config: ${key}`);
  const record = value as Record<string, unknown>;
  const emptyDefaults: Record<string, unknown> = {
    definedEnvironments: [],
    durable_objects: { bindings: [] },
    workflows: [],
    migrations: [],
    exports: {},
    kv_namespaces: [],
    cloudchamber: {},
    queues: { producers: [], consumers: [] },
    connect: [],
    r2_buckets: [],
    d1_databases: [],
    vectorize: [],
    ai_search_namespaces: [],
    ai_search: [],
    agent_memory: [],
    hyperdrive: [],
    services: [],
    analytics_engine_datasets: [],
    dispatch_namespaces: [],
    mtls_certificates: [],
    pipelines: [],
    secrets_store_secrets: [],
    artifacts: [],
    unsafe_hello_world: [],
    flagship: [],
    worker_loaders: [],
    ratelimits: [],
    vpc_services: [],
    vpc_networks: [],
    logfwdr: { bindings: [] },
    python_modules: { exclude: ["**/*.pyc"] },
  };
  for (const [key, expected] of Object.entries(emptyDefaults))
    if (JSON.stringify(record[key]) !== JSON.stringify(expected))
      throw new Error(`Built config contains unexpected binding: ${key}`);
  if (
    record.topLevelName !== source.name ||
    record.jsx_factory !== "React.createElement" ||
    record.jsx_fragment !== "React.Fragment" ||
    record.no_bundle !== true ||
    JSON.stringify(record.rules) !==
      JSON.stringify([{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }]) ||
    JSON.stringify(record.dev) !==
      JSON.stringify({
        ip: "localhost",
        local_protocol: "http",
        upstream_protocol: "http",
        enable_containers: true,
        generate_types: false,
      }) ||
    typeof record.configPath !== "string" ||
    record.userConfigPath !== record.configPath ||
    !record.configPath.endsWith(
      `/.cloudflare/generated/${source.vars.DEPLOYMENT_ENV}/wrangler.json`,
    )
  )
    throw new Error("Built config contains unexpected build settings");
}

export function runtimeSecrets(
  config: StageConfig,
  source: Readonly<Record<string, string | undefined>>,
): RuntimeSecretPayload {
  const secrets = {} as RuntimeSecretPayload;
  for (const key of requiredRuntimeSecretKeys) {
    const value = source[key]?.trim();
    if (!value) throw new Error(`Missing required secret: ${key}`);
    secrets[key] = value;
  }
  for (const key of optionalRuntimeSecretKeys) {
    const value = source[key]?.trim();
    if (value) {
      readFogAiClients(value);
      secrets[key] = value;
    } else secrets[key] = null;
  }
  assertDatabaseIdentity(config, source, secrets.DATABASE_URL);
  return secrets;
}

export function databaseCredentials(
  config: StageConfig,
  source: Readonly<Record<string, string | undefined>>,
): { databaseUrl: string; databaseAuthToken: string } {
  const databaseUrl = source.DATABASE_URL?.trim();
  const databaseAuthToken = source.DATABASE_AUTH_TOKEN?.trim();
  if (!databaseUrl) throw new Error("Missing required secret: DATABASE_URL");
  if (!databaseAuthToken)
    throw new Error("Missing required secret: DATABASE_AUTH_TOKEN");
  assertDatabaseIdentity(config, source, databaseUrl);
  return { databaseUrl, databaseAuthToken };
}

function assertDatabaseIdentity(
  config: StageConfig,
  source: Readonly<Record<string, string | undefined>>,
  databaseUrl: string,
): void {
  const authority = validateDatabaseAuthority(
    config.vars.DEPLOYMENT_ENV,
    source.DATABASE_IDENTITY,
  );
  if (authority !== config.vars.EXPECTED_DATABASE_IDENTITY)
    throw new Error(
      "DATABASE_IDENTITY does not match the selected stage config",
    );
  const identity = remoteLibsqlIdentity(databaseUrl);
  if (identity !== authority)
    throw new Error("DATABASE_URL does not match the selected stage database");
}

export function validateDatabaseAuthority(
  stage: DeploymentStage,
  value: unknown,
): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("DATABASE_IDENTITY is required");
  const authority = value.trim();
  let normalized: string;
  try {
    normalized = remoteLibsqlIdentity(`libsql://${authority}`);
  } catch {
    throw new Error("DATABASE_IDENTITY must be a normalized remote identity");
  }
  if (normalized !== authority)
    throw new Error("DATABASE_IDENTITY must be a normalized remote identity");
  const firstLabel = new URL(`libsql://${authority}`).hostname.split(".")[0];
  const expected = stage === "staging" ? "fog-staging" : "fog-production";
  if (firstLabel !== expected && !firstLabel.startsWith(`${expected}-`))
    throw new Error(`DATABASE_IDENTITY must use the ${expected} naming prefix`);
  return authority;
}

export function cloudflareAuth(
  source: Readonly<Record<string, string | undefined>>,
): Record<(typeof cloudflareAuthKeys)[number], string> {
  const result = {} as Record<(typeof cloudflareAuthKeys)[number], string>;
  for (const key of cloudflareAuthKeys) {
    const value = source[key]?.trim();
    if (!value) throw new Error(`Missing required secret: ${key}`);
    result[key] = value;
  }
  return result;
}
