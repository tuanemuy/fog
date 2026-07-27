import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { CloudflareIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import { validateDirectoryKeyring } from "@repo/core/adapters/cloudflare/identityRouting";
import { createHmacSessionCodec } from "@repo/core/adapters/webcrypto/hmacSessionCodec";
import { createPbkdf2PasswordHasher } from "@repo/core/adapters/webcrypto/pbkdf2PasswordHasher";
import { content } from "@repo/core/config";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import { type ContainerStore, installContainerStore } from "./containerStore";
import { requireSessionSecret } from "./secrets";
import type { AppConfig, RequestContainer } from "./types";

export type { AppConfig, RequestContainer } from "./types";
export { type ContainerStore, installContainerStore };

export type ServerEnv = Readonly<{
  APP_URL: string;
  USER_DATA: DurableObjectNamespace;
  IDENTITY_DIRECTORY: DurableObjectNamespace;
  ACCOUNT_HOME: DurableObjectNamespace;
  SESSION_SECRET?: string;
  DIRECTORY_ROUTING_SECRET_ACTIVE?: string;
  DIRECTORY_ROUTING_SECRET_PREVIOUS?: string;
  DIRECTORY_ROUTING_GENERATION_ACTIVE?: string;
  DIRECTORY_ROUTING_GENERATION_PREVIOUS?: string;
}>;

export type RequestServerConfig = AppConfig &
  Readonly<{
    userData: DurableObjectNamespace;
    identityDirectory: DurableObjectNamespace;
    accountHome: DurableObjectNamespace;
    sessionSecret: string;
    directoryRouting: Readonly<{
      active: Readonly<{ generation: string; secret: string }>;
      previous?: Readonly<{ generation: string; secret: string }>;
    }>;
  }>;

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function readRequestServerConfig(env: ServerEnv): RequestServerConfig {
  const hasPreviousSecret = env.DIRECTORY_ROUTING_SECRET_PREVIOUS !== undefined;
  const hasPreviousGeneration =
    env.DIRECTORY_ROUTING_GENERATION_PREVIOUS !== undefined;
  if (hasPreviousSecret !== hasPreviousGeneration) {
    throw new Error(
      "Previous directory routing secret and generation must be configured together",
    );
  }
  const previous =
    env.DIRECTORY_ROUTING_SECRET_PREVIOUS &&
    env.DIRECTORY_ROUTING_GENERATION_PREVIOUS
      ? {
          generation: env.DIRECTORY_ROUTING_GENERATION_PREVIOUS,
          secret: env.DIRECTORY_ROUTING_SECRET_PREVIOUS,
        }
      : undefined;
  const directoryRouting = validateDirectoryKeyring({
    active: {
      generation: env.DIRECTORY_ROUTING_GENERATION_ACTIVE ?? "generation-1",
      secret: required(
        env.DIRECTORY_ROUTING_SECRET_ACTIVE,
        "DIRECTORY_ROUTING_SECRET_ACTIVE",
      ),
    },
    ...(previous ? { previous } : {}),
  });
  return {
    ...content,
    appUrl: env.APP_URL,
    userData: env.USER_DATA,
    identityDirectory: env.IDENTITY_DIRECTORY,
    accountHome: env.ACCOUNT_HOME,
    sessionSecret: requireSessionSecret(env.SESSION_SECRET),
    directoryRouting,
  };
}

export function createRequestContainer(
  config: RequestServerConfig,
): RequestContainer {
  const {
    userData,
    identityDirectory,
    accountHome,
    sessionSecret,
    directoryRouting,
    ...appConfig
  } = config;
  return {
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
    config: appConfig,
    identity: new CloudflareIdentityGateway(
      identityDirectory,
      accountHome,
      userData,
      directoryRouting,
      sessionSecret,
    ),
    passwordHasher: createPbkdf2PasswordHasher(),
    sessionCodec: createHmacSessionCodec({ secret: sessionSecret }),
  };
}

export function routeAuthenticatedUserData<T>(
  namespace: Readonly<{ getByName(name: string): T }>,
  authenticatedUserId: string,
): T {
  if (authenticatedUserId.trim().length === 0) {
    throw new Error("AUTHENTICATED_USER_ID_REQUIRED");
  }
  return namespace.getByName(authenticatedUserId);
}
