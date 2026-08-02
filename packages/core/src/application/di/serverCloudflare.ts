import type { D1Database } from "@cloudflare/workers-types";
import { getDatabase } from "@repo/core/adapters/d1/client";
import { D1UnitOfWorkProvider } from "@repo/core/adapters/d1/unitOfWork";
import { createHmacSessionCodec } from "@repo/core/adapters/webcrypto/hmacSessionCodec";
import { createPbkdf2PasswordHasher } from "@repo/core/adapters/webcrypto/pbkdf2PasswordHasher";
import { content } from "@repo/core/config";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import { type RequestSecrets, requireSessionSecret } from "./secrets";
import type { AppConfig, RequestContainer, SharedDeps } from "./types";

export {
  type ContainerStore,
  installContainerStore,
} from "./containerStore";
export type { AppConfig, RequestContainer, SharedDeps } from "./types";

/**
 * Request-path config: extends `AppConfig` (SSR head/meta) with the
 * runtime bindings the request container needs to construct its UoW.
 */
export type RequestServerConfig = AppConfig &
  Readonly<{
    binding: D1Database;
    secrets: RequestSecrets;
  }>;

/** Cloudflare bindings shape for the request Worker. */
export type ServerEnv = Readonly<{
  DB: D1Database;
  APP_URL: string;
  // Delivered as a wrangler secret (`wrangler secret put` / `.dev.vars`),
  // never as a `[vars]` entry.
  SESSION_SECRET?: string;
}>;

export function readRequestServerConfig(env: ServerEnv): RequestServerConfig {
  return {
    ...content,
    appUrl: env.APP_URL,
    binding: env.DB,
    secrets: { sessionSecret: requireSessionSecret(env.SESSION_SECRET) },
  };
}

function buildSharedDeps(): SharedDeps {
  return {
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}

/**
 * Build the request-scoped container. Wires the unit-of-work provider and
 * exposes `config` for SSR head/meta.
 */
export function createRequestContainer(
  config: RequestServerConfig,
): RequestContainer {
  const db = getDatabase(config.binding);
  const { binding: _binding, secrets, ...appConfig } = config;
  return {
    ...buildSharedDeps(),
    config: appConfig satisfies AppConfig,
    unitOfWorkProvider: new D1UnitOfWorkProvider(
      db,
      SystemClock,
      UuidV7Generator,
    ),
    passwordHasher: createPbkdf2PasswordHasher(),
    sessionCodec: createHmacSessionCodec({
      secret: secrets.sessionSecret,
    }),
  };
}
