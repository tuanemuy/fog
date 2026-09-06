import { AsyncLocalStorage } from "node:async_hooks";
import { createBoundedSecretCrypto } from "@repo/core/adapters/fog/boundedCrypto";
import {
  type CloudflareEmailBinding,
  createCloudflareResetMailer,
} from "@repo/core/adapters/fog/cloudflareEmailMailer";
import { nodeSecretCrypto } from "@repo/core/adapters/fog/crypto";
import { createGoogleIdentity } from "@repo/core/adapters/fog/googleIdentity";
import { LibsqlFogUnitOfWork } from "@repo/core/adapters/fog/unitOfWork";
import { createRemoteLibsqlClient } from "@repo/core/adapters/libsql/client.web";
import { installContainerStore } from "@repo/core/application/di/containerStore";
import {
  createCloudflareRequestContainer,
  readCloudflareRequestServerConfig,
  readCloudflareServerEnv,
} from "@repo/core/application/di/serverCloudflare";
import type { RequestContainer } from "@repo/core/application/di/types";
import { installFogServices } from "@repo/core/application/fog/runtime";
import { createFogServices } from "@repo/core/application/fog/services";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import defaultEntry from "@tanstack/react-start/server-entry";
import { installFogAccountRuntime } from "@/presentation/fogAccountRuntime";
import { readFogAiClients } from "@/presentation/fogAiConfig";
import { createFogHttpHandler } from "@/serverHttp";
import { runFogScheduled } from "@/worker/cloudflare/fogScheduled";

type ExecutionContext = Readonly<{
  waitUntil(promise: Promise<unknown>): void;
}>;
type ScheduledController = Readonly<{ cron: string }>;
export type AppEnv = Readonly<Record<string, unknown>> & {
  EMAIL?: CloudflareEmailBinding;
};

const ALS_SYMBOL: unique symbol = Symbol.for("@fog/request-als") as never;
type AlsGlobalSlot = {
  [ALS_SYMBOL]?: AsyncLocalStorage<RequestContainer>;
};
const alsGlobal = globalThis as unknown as AlsGlobalSlot;
const storage =
  alsGlobal[ALS_SYMBOL] ?? new AsyncLocalStorage<RequestContainer>();
alsGlobal[ALS_SYMBOL] = storage;
installContainerStore({ getStore: () => storage.getStore() });

type Runtime = Awaited<ReturnType<typeof boot>>;
let runtimePromise: Promise<Runtime> | undefined;

async function boot(source: AppEnv) {
  const env = readCloudflareServerEnv(source);
  if (!!source.EMAIL !== !!env.FOG_EMAIL_FROM)
    throw new Error("EMAIL binding and FOG_EMAIL_FROM must be set together");
  const client = createRemoteLibsqlClient({
    url: env.DATABASE_URL,
    authToken: env.DATABASE_AUTH_TOKEN,
  });
  const unitOfWork = new LibsqlFogUnitOfWork(client);
  const crypto = createBoundedSecretCrypto(nodeSecretCrypto, { maxQueued: 2 });
  const googleIdentity =
    env.FOG_GOOGLE_CLIENT_ID && env.FOG_GOOGLE_CLIENT_SECRET
      ? createGoogleIdentity({
          clientId: env.FOG_GOOGLE_CLIENT_ID,
          clientSecret: env.FOG_GOOGLE_CLIENT_SECRET,
          appUrl: env.APP_URL,
          clock: SystemClock,
        })
      : undefined;
  const mailer =
    source.EMAIL && env.FOG_EMAIL_FROM
      ? createCloudflareResetMailer({
          binding: source.EMAIL,
          from: env.FOG_EMAIL_FROM,
        })
      : undefined;
  const services = await createFogServices({
    unitOfWork,
    crypto,
    clock: SystemClock,
    ids: UuidV7Generator,
    aiClients: readFogAiClients(env.FOG_AI_CLIENTS),
    appUrl: env.APP_URL,
    ...(googleIdentity ? { googleIdentity } : {}),
  });
  installFogServices(services);
  installFogAccountRuntime({
    googleEnabled: !!googleIdentity,
    createBrowserToken: () => crypto.newToken(),
  });
  const config = readCloudflareRequestServerConfig(env);
  const fetch = createFogHttpHandler({
    appUrl: env.APP_URL,
    services,
    logger: ConsoleLogger,
    healthCheck: async () => {
      await client.execute("SELECT 1");
    },
    healthDetails: {
      deploymentSha: env.DEPLOYMENT_SHA,
      deploymentEnv: env.DEPLOYMENT_ENV,
      databaseIdentity: env.EXPECTED_DATABASE_IDENTITY,
    },
    render: async (request) =>
      storage.run(createCloudflareRequestContainer(config), () =>
        defaultEntry.fetch(request),
      ),
  });
  return { unitOfWork, mailer, fetch };
}

function runtime(env: AppEnv): Promise<Runtime> {
  runtimePromise ??= boot(env);
  return runtimePromise;
}

export default {
  async fetch(
    request: Request,
    env: AppEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    return (await runtime(env)).fetch(request);
  },
  async scheduled(
    event: ScheduledController,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const current = await runtime(env);
    ctx.waitUntil(
      runFogScheduled(event.cron, {
        unitOfWork: current.unitOfWork,
        clock: SystemClock,
        ids: UuidV7Generator,
        logger: ConsoleLogger,
        ...(current.mailer ? { mailer: current.mailer } : {}),
      }),
    );
  },
};
