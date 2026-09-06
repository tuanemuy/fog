import { pathToFileURL } from "node:url";
import { z } from "zod";
import { withProcessSignals } from "./cloudflareChild.node";
import { loadCloudflarePreflight } from "./cloudflarePreflight.node";
import {
  cloudflareAuth,
  type DeploymentStage,
  deploymentStage,
  type StageConfig,
  validateStageConfig,
} from "./cloudflareStage";

const apiOrigin = "https://api.cloudflare.com";
const apiRoot = `${apiOrigin}/client/v4/`;
const successSchema = z
  .object({
    success: z.literal(true),
    result: z.object({}).passthrough(),
  })
  .passthrough();
const tokenSchema = z
  .object({
    success: z.literal(true),
    result: z.object({ status: z.literal("active") }).passthrough(),
  })
  .passthrough();
const zonesSchema = z
  .object({
    success: z.literal(true),
    result: z
      .array(
        z
          .object({
            name: z.string(),
            status: z.literal("active"),
            account: z.object({ id: z.string() }).passthrough(),
          })
          .passthrough(),
      )
      .length(1),
  })
  .passthrough();

type CloudflareAuth = Record<
  "CLOUDFLARE_API_TOKEN" | "CLOUDFLARE_ACCOUNT_ID",
  string
>;

function parseResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(`Cloudflare authority check failed: ${label}`);
  return parsed.data;
}

function apiUrl(pathname: string, search?: URLSearchParams): URL {
  const url = new URL(pathname, apiRoot);
  if (search) url.search = search.toString();
  if (url.origin !== apiOrigin || !url.pathname.startsWith("/client/v4/"))
    throw new Error("Cloudflare authority request origin is invalid");
  return url;
}

async function requestJson(input: {
  label: string;
  url: URL;
  token: string;
  signal: AbortSignal;
  fetcher: typeof fetch;
  allowNotFound?: boolean;
}): Promise<unknown | undefined> {
  let response: Response;
  try {
    response = await input.fetcher(input.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
      },
      redirect: "error",
      signal: input.signal,
    });
  } catch {
    throw new Error(`Cloudflare authority check failed: ${input.label}`);
  }
  if (response.url) {
    let responseOrigin: string;
    try {
      responseOrigin = new URL(response.url).origin;
    } catch {
      throw new Error(`Cloudflare authority check failed: ${input.label}`);
    }
    if (responseOrigin !== apiOrigin)
      throw new Error(`Cloudflare authority check failed: ${input.label}`);
  }
  if (input.allowNotFound && response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(
      `Cloudflare authority check failed: ${input.label} returned HTTP ${response.status}`,
    );
  try {
    return await response.json();
  } catch {
    throw new Error(`Cloudflare authority check failed: ${input.label}`);
  }
}

export async function verifyCloudflareAuthority(input: {
  stage: DeploymentStage;
  config: StageConfig;
  auth: CloudflareAuth;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}): Promise<void> {
  const requestTimeoutMs = input.requestTimeoutMs ?? 10_000;
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 30_000
  )
    throw new Error(
      "Cloudflare authority timeout must be between 1 and 30000 ms",
    );
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  const fetcher = input.fetcher ?? fetch;
  const config = validateStageConfig(input.config, input.stage);
  const tokenResult = await requestJson({
    label: "token verification",
    url: apiUrl("user/tokens/verify"),
    token: input.auth.CLOUDFLARE_API_TOKEN,
    signal,
    fetcher,
  });
  parseResponse(tokenSchema, tokenResult, "token verification");

  const routeHost = config.routes[0].pattern;
  const prefix = input.stage === "staging" ? "staging-fog." : "fog.";
  const domain = routeHost.slice(prefix.length);
  const accountId = input.auth.CLOUDFLARE_ACCOUNT_ID;
  const zones = parseResponse(
    zonesSchema,
    await requestJson({
      label: "zone verification",
      url: apiUrl(
        "zones",
        new URLSearchParams({
          "account.id": accountId,
          name: domain,
          status: "active",
          match: "all",
          per_page: "5",
        }),
      ),
      token: input.auth.CLOUDFLARE_API_TOKEN,
      signal,
      fetcher,
    }),
    "zone verification",
  );
  const zone = zones.result[0];
  if (zone.name !== domain || zone.account.id !== accountId)
    throw new Error(
      "Cloudflare authority check failed: zone identity mismatch",
    );

  const workerResult = await requestJson({
    label: "Worker verification",
    url: apiUrl(
      `accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(config.name)}/settings`,
    ),
    token: input.auth.CLOUDFLARE_API_TOKEN,
    signal,
    fetcher,
    allowNotFound: true,
  });
  if (workerResult !== undefined)
    parseResponse(successSchema, workerResult, "Worker verification");
}

function stageOption(): string | undefined {
  const position = process.argv.indexOf("--stage");
  return position < 0 ? undefined : process.argv[position + 1];
}

async function main(): Promise<void> {
  const stage = deploymentStage(stageOption());
  await withProcessSignals(async (signal) => {
    const preflight = await loadCloudflarePreflight({
      stage,
      source: process.env,
      sideEffect: false,
    });
    await verifyCloudflareAuthority({
      stage,
      config: preflight.config,
      auth: cloudflareAuth(process.env),
      signal,
    });
  });
  console.log(`[fog.cloudflare.authority] verified ${stage}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(
      `[fog.cloudflare.authority] failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
