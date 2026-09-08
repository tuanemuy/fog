import type { DurableObjectBindings } from "@repo/core/adapters/cloudflare/doStubs";
import { createIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import { createKnowledgeGateway } from "@repo/core/adapters/cloudflare/knowledgeGateway";
import { createMemoGateway } from "@repo/core/adapters/cloudflare/memoGateway";
import { createSearchGateway } from "@repo/core/adapters/cloudflare/searchGateway";
import { createHmacSessionCodec } from "@repo/core/adapters/webcrypto/hmacSessionCodec";
import { createPbkdf2PasswordHasher } from "@repo/core/adapters/webcrypto/pbkdf2PasswordHasher";
import { WebCryptoTokenGenerator } from "@repo/core/adapters/webcrypto/webCryptoTokenGenerator";
import { content } from "@repo/core/config";
import { createIdentityTuning } from "../identity/tuning";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import {
  type RequestSecrets,
  requireDirectoryRoutingKeyring,
  requireSessionSecret,
} from "./secrets";
import type { AppConfig, RequestContainer } from "./types";

/**
 * What the request Worker's `fetch` receives. Secrets stay optional: nothing
 * validates this type at boot, and `readRequestServerConfig` is where a
 * missing one fails, per request, before any container exists.
 */
export type ServerEnv = Readonly<{
  USER_DATA: DurableObjectNamespace;
  IDENTITY_DIRECTORY: DurableObjectNamespace;
  APP_URL?: string;
  DIAGNOSTICS_ENABLED?: string;
  SESSION_SECRET?: string;
  DIRECTORY_ROUTING_SECRET?: string;
}>;

/**
 * Secrets nest under `secrets` so that the rest-spread building `AppConfig`
 * cannot carry them to the client (`secrets.ts`); the bindings nest for the
 * same reason.
 */
export type RequestServerConfig = Readonly<{
  appUrl: string;
  secrets: RequestSecrets;
  bindings: DurableObjectBindings;
}>;

export function readRequestServerConfig(env: ServerEnv): RequestServerConfig {
  const appUrl = env.APP_URL;
  if (appUrl === undefined || appUrl.length === 0) {
    throw new Error("APP_URL is required on the request path");
  }
  return {
    appUrl: new URL(appUrl).origin,
    secrets: {
      sessionSecret: requireSessionSecret(env.SESSION_SECRET),
      directoryRoutingKeyring: requireDirectoryRoutingKeyring(
        env.DIRECTORY_ROUTING_SECRET,
      ),
    },
    bindings: {
      USER_DATA: env.USER_DATA,
      IDENTITY_DIRECTORY: env.IDENTITY_DIRECTORY,
    },
  };
}

export function createRequestContainer(
  config: RequestServerConfig,
): RequestContainer {
  const { secrets, bindings, ...rest } = config;
  const appConfig = { ...content, ...rest } satisfies AppConfig;
  const identityTuning = createIdentityTuning();
  return {
    config: appConfig,
    identityGateway: createIdentityGateway({
      bindings,
      keyring: secrets.directoryRoutingKeyring,
      clock: SystemClock,
      tuning: identityTuning,
    }),
    identityTuning,
    memoGateway: createMemoGateway(bindings),
    knowledgeGateway: createKnowledgeGateway(bindings),
    searchGateway: createSearchGateway(bindings),
    passwordHasher: createPbkdf2PasswordHasher(),
    sessionCodec: createHmacSessionCodec({ secret: secrets.sessionSecret }),
    tokenGenerator: WebCryptoTokenGenerator,
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}
