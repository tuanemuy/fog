import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  deploymentDomain,
  deploymentShaSchema,
  deploymentStage,
  stageIdentity,
  validateDatabaseAuthority,
} from "./cloudflareStage";

const healthSchema = z
  .object({
    status: z.literal("ok"),
    deploymentSha: deploymentShaSchema,
    deploymentEnv: z.enum(["staging", "production"]),
    databaseIdentity: z.string().trim().min(1),
  })
  .strict();

export type HealthExpectation = z.infer<typeof healthSchema>;

function healthUrl(
  value: string,
  stage: HealthExpectation["deploymentEnv"],
  selectedDomain: string,
): URL {
  if (!/^[\x21-\x7e]+$/.test(value))
    throw new Error("Smoke target must use an ASCII stage origin");
  const url = new URL(value);
  const prefix = stage === "staging" ? "staging-fog." : "fog.";
  const domain = deploymentDomain(selectedDomain);
  const expected = stageIdentity(stage, domain).appUrl;
  if (
    value !== expected ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !url.hostname.startsWith(prefix) ||
    url.hostname.split(".").some((label) => label.startsWith("xn--"))
  )
    throw new Error("Smoke target must be the selected stage HTTPS origin");
  return new URL("/healthz", url);
}

export async function waitForCloudflareHealth(input: {
  appUrl: string;
  domain: string;
  expected: HealthExpectation;
  attempts?: number;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  fetcher?: typeof fetch;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const expected = healthSchema.parse(input.expected);
  validateDatabaseAuthority(expected.deploymentEnv, expected.databaseIdentity);
  const url = healthUrl(input.appUrl, expected.deploymentEnv, input.domain);
  const attempts = input.attempts ?? 18;
  const requestTimeoutMs = input.requestTimeoutMs ?? 10_000;
  const retryDelayMs = input.retryDelayMs ?? 5_000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 60)
    throw new Error("Smoke attempts must be between 1 and 60");
  const fetcher = input.fetcher ?? fetch;
  const delay =
    input.delay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.status === 200) {
        const actual = healthSchema.parse(await response.json());
        if (
          actual.deploymentSha === expected.deploymentSha &&
          actual.deploymentEnv === expected.deploymentEnv &&
          actual.databaseIdentity === expected.databaseIdentity
        )
          return;
      }
    } catch {
      // A newly deployed route can be temporarily unavailable while propagating.
    }
    if (attempt < attempts) await delay(retryDelayMs);
  }
  throw new Error("Cloudflare health smoke did not reach the expected release");
}

async function main(): Promise<void> {
  const deploymentEnv = deploymentStage(process.env.DEPLOYMENT_ENV);
  const deploymentSha = deploymentShaSchema.parse(process.env.DEPLOYMENT_SHA);
  const appUrl = process.env.APP_URL;
  const domain = process.env.DOMAIN;
  const databaseIdentity = process.env.DATABASE_IDENTITY;
  if (!appUrl) throw new Error("APP_URL is required");
  if (!domain) throw new Error("DOMAIN is required");
  if (!databaseIdentity) throw new Error("DATABASE_IDENTITY is required");
  await waitForCloudflareHealth({
    appUrl,
    domain,
    expected: {
      status: "ok",
      deploymentSha,
      deploymentEnv,
      databaseIdentity,
    },
  });
  console.log(
    `[fog.cloudflare.smoke] verified ${deploymentEnv} ${deploymentSha}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `[fog.cloudflare.smoke] failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
