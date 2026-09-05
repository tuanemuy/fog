import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { nodeSecretCrypto } from "@repo/core/adapters/fog/crypto";
import { createGoogleIdentity } from "@repo/core/adapters/fog/googleIdentity";
import { migrateFog } from "@repo/core/adapters/fog/schema";
import { createSmtpResetMailer } from "@repo/core/adapters/fog/smtpMailer";
import { LibsqlFogUnitOfWork } from "@repo/core/adapters/fog/unitOfWork";
import {
  applyPragmas,
  createLibsqlClient,
} from "@repo/core/adapters/libsql/client";
import { installContainerStore } from "@repo/core/application/di/containerStore";
import {
  createNodeRequestContainer,
  readNodeRequestServerConfig,
  readNodeServerEnv,
} from "@repo/core/application/di/serverNode";
import type { RequestContainer } from "@repo/core/application/di/types";
import { dispatchResetEmails } from "@repo/core/application/fog/resetEmailDispatcher";
import {
  getFogServices,
  installFogServices,
} from "@repo/core/application/fog/runtime";
import { createFogServices } from "@repo/core/application/fog/services";
import { purgeExpiredTrash } from "@repo/core/application/fog/trashServices";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { readFogAccountConfig } from "@/presentation/fogAccountConfig";
import { installFogAccountRuntime } from "@/presentation/fogAccountRuntime";
import { readFogAiClients } from "@/presentation/fogAiConfig";
import { handleFogAiHttp, isFogAiHttp } from "@/presentation/fogAiHttp";
import { handleFogGoogleCallback } from "@/presentation/fogGoogleHttp";
import { createFogResetMailRunner } from "@/worker/node/fogResetMailRunner";
import { createFogRetentionRunner } from "@/worker/node/fogRetentionRunner";

// SSR and RSC are separate module graphs in the same process; pin the
// ALS on `globalThis` (and on `import.meta.hot.data` for HMR) so both
// resolve the same store.
const ALS_SYMBOL: unique symbol = Symbol.for("@fog/request-als") as never;
type AlsHotData = { als?: AsyncLocalStorage<RequestContainer> };
type AlsGlobalSlot = { [ALS_SYMBOL]?: AsyncLocalStorage<RequestContainer> };
const alsHotData: AlsHotData = (import.meta.hot?.data ?? {}) as AlsHotData;
const alsGlobal = globalThis as unknown as AlsGlobalSlot;
const storage =
  alsGlobal[ALS_SYMBOL] ??
  alsHotData.als ??
  new AsyncLocalStorage<RequestContainer>();
alsGlobal[ALS_SYMBOL] = storage;
if (import.meta.hot) {
  (import.meta.hot.data as AlsHotData).als = storage;
}
installContainerStore({ getStore: () => storage.getStore() });

/**
 * Boots node-runtime resources (env → libSQL → worker runner → request
 * factory) and returns a fetch handler plus a shutdown hook.
 */
export type NodeServerBoot = Readonly<{
  fetch: (request: Request) => Promise<Response>;
  port: number;
  hostname: string;
  shutdown: () => Promise<void>;
}>;

export async function boot(): Promise<NodeServerBoot> {
  const env = readNodeServerEnv();
  const logger = ConsoleLogger;

  // libSQL's embedded driver fails to open a `file:` URL whose parent
  // directory does not exist; pre-create it so a fresh clone boots.
  if (env.DATABASE_URL.startsWith("file:")) {
    const filePath = env.DATABASE_URL.slice("file:".length);
    const parent = path.dirname(path.resolve(process.cwd(), filePath));
    fs.mkdirSync(parent, { recursive: true });
  }

  const client = createLibsqlClient({
    url: env.DATABASE_URL,
    ...(env.DATABASE_AUTH_TOKEN !== undefined
      ? { authToken: env.DATABASE_AUTH_TOKEN }
      : {}),
    ...(env.DATABASE_ENCRYPTION_KEY !== undefined
      ? { encryptionKey: env.DATABASE_ENCRYPTION_KEY }
      : {}),
  });
  const isMemory = env.DATABASE_URL === ":memory:";
  await applyPragmas(client, isMemory ? { wal: false } : {});
  await migrateFog(client);
  const fogUnitOfWork = new LibsqlFogUnitOfWork(client);
  const retention = createFogRetentionRunner({
    purge: () =>
      purgeExpiredTrash({ unitOfWork: fogUnitOfWork, clock: SystemClock }),
    logger,
  });
  const accountConfig = readFogAccountConfig(process.env, env.APP_URL);
  const googleIdentity =
    accountConfig.FOG_GOOGLE_CLIENT_ID && accountConfig.FOG_GOOGLE_CLIENT_SECRET
      ? createGoogleIdentity({
          clientId: accountConfig.FOG_GOOGLE_CLIENT_ID,
          clientSecret: accountConfig.FOG_GOOGLE_CLIENT_SECRET,
          appUrl: env.APP_URL,
          clock: SystemClock,
          ...(accountConfig.FOG_OIDC_FIXTURE_ORIGIN
            ? { fixtureOrigin: accountConfig.FOG_OIDC_FIXTURE_ORIGIN }
            : {}),
        })
      : undefined;
  const mailer =
    accountConfig.FOG_SMTP_HOST && accountConfig.FOG_SMTP_FROM
      ? createSmtpResetMailer({
          host: accountConfig.FOG_SMTP_HOST,
          port: accountConfig.FOG_SMTP_PORT,
          from: accountConfig.FOG_SMTP_FROM,
          appUrl: env.APP_URL,
          local: accountConfig.FOG_SMTP_LOCAL === "true",
          ...(accountConfig.FOG_SMTP_USER
            ? { user: accountConfig.FOG_SMTP_USER }
            : {}),
          ...(accountConfig.FOG_SMTP_PASSWORD
            ? { password: accountConfig.FOG_SMTP_PASSWORD }
            : {}),
        })
      : undefined;
  const resetMail = createFogResetMailRunner({
    dispatch: () =>
      dispatchResetEmails({
        unitOfWork: fogUnitOfWork,
        clock: SystemClock,
        ids: UuidV7Generator,
        ...(mailer ? { mailer } : {}),
      }),
    logger,
  });
  installFogAccountRuntime({
    googleEnabled: !!googleIdentity,
    createBrowserToken: () => nodeSecretCrypto.newToken(),
  });
  installFogServices(
    await createFogServices({
      unitOfWork: fogUnitOfWork,
      crypto: nodeSecretCrypto,
      clock: SystemClock,
      ids: UuidV7Generator,
      aiClients: readFogAiClients(process.env.FOG_AI_CLIENTS),
      appUrl: env.APP_URL,
      ...(googleIdentity ? { googleIdentity } : {}),
    }),
  );

  retention.start();
  resetMail.start();

  const config = readNodeRequestServerConfig(env);

  // `@tanstack/react-start/server-entry` only resolves once the framework
  // bundle is ready; defer the import to the first request.
  const entryPromise = import("@tanstack/react-start/server-entry").then(
    (m) => m.default,
  );

  const fetch = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname === "/auth/google/callback")
      return handleFogGoogleCallback(request, {
        services: getFogServices(),
        appUrl: env.APP_URL,
      });
    if (new URL(request.url).pathname === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD")
        return new Response(null, { status: 405 });
      try {
        await client.execute("SELECT 1");
        return new Response(request.method === "HEAD" ? null : "ok", {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/plain",
          },
        });
      } catch {
        return new Response("unavailable", {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        });
      }
    }
    if (isFogAiHttp(new URL(request.url).pathname))
      return handleFogAiHttp(request, {
        services: getFogServices(),
        appUrl: env.APP_URL,
        logger,
      });
    if (/^\/todo(?:\/|$)/.test(new URL(request.url).pathname))
      return new Response("Not found", { status: 404 });
    const container = createNodeRequestContainer(config);
    const entry = await entryPromise;
    return storage.run(container, async () => entry.fetch(request));
  };

  const port = env.PORT;
  const hostname = env.HOSTNAME;

  let shuttingDown: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown !== null) return shuttingDown;
    shuttingDown = (async () => {
      try {
        await Promise.all([retention.stop(), resetMail.stop()]);
      } catch (cause) {
        logger.error("[server.node] retention runner stop threw", { cause });
      } finally {
        client.close();
      }
    })();
    return shuttingDown;
  };

  return { fetch, port, hostname, shutdown };
}

const defaultExport = {
  async fetch(request: Request): Promise<Response> {
    const booted = await getOrStartBoot();
    return booted.fetch(request);
  },
};

// Boot lazily so importing this module for type resolution (e.g. inside
// the vite plugin's server-entry probe) does not trigger DB I/O.
let bootPromise: Promise<NodeServerBoot> | null = null;
function getOrStartBoot(): Promise<NodeServerBoot> {
  if (bootPromise === null) {
    bootPromise = boot();
    const onSignal = (signal: NodeJS.Signals) => {
      ConsoleLogger.info(`[server.node] received ${signal}, shutting down`);
      void bootPromise?.then((b) => b.shutdown());
    };
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("SIGINT", () => onSignal("SIGINT"));
  }
  return bootPromise;
}

export default defaultExport;
