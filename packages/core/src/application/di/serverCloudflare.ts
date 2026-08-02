import type {
  DurableObjectNamespace,
  Fetcher,
} from "@cloudflare/workers-types";
import type { DirectoryLocator } from "@repo/core/adapters/cloudflare/directoryLocator";
import { createDirectoryLocator } from "@repo/core/adapters/cloudflare/directoryLocator";
import { translateStubError } from "@repo/core/adapters/cloudflare/platform/stubErrors";
import { createHmacSessionCodec } from "@repo/core/adapters/webcrypto/hmacSessionCodec";
import { createPbkdf2PasswordHasher } from "@repo/core/adapters/webcrypto/pbkdf2PasswordHasher";
import { content } from "@repo/core/config";
import { SystemClock } from "../ports/clock";
import { UuidV7Generator } from "../ports/idGenerator";
import { ConsoleLogger } from "../ports/logger";
import type { IdentityDirectoryFacade, UserDataFacade } from "./facades";
import {
  type RequestSecrets,
  requireAiClientTokenSecret,
  requireDirectoryRoutingKeyring,
  requireSessionSecret,
} from "./secrets";
import type { AppConfig, RequestContainer, SharedDeps } from "./types";

export {
  type ContainerStore,
  installContainerStore,
} from "./containerStore";
export type { AppConfig, RequestContainer, SharedDeps } from "./types";

/**
 * Request-path config: `AppConfig` (SSR head/meta) plus the runtime bindings
 * and secrets the request container needs.
 *
 * Secrets stay nested — see `secrets.ts` for why that nesting is what keeps
 * them out of the SSR payload.
 */
export type RequestServerConfig = AppConfig &
  Readonly<{
    bindings: Readonly<{
      userData: DurableObjectNamespace;
      identityDirectory: DurableObjectNamespace;
    }>;
    secrets: RequestSecrets;
  }>;

/** Cloudflare bindings shape for the request Worker. */
export type ServerEnv = Readonly<{
  USER_DATA: DurableObjectNamespace;
  IDENTITY_DIRECTORY: DurableObjectNamespace;
  ASSETS?: Fetcher;
  APP_URL: string;
  // Delivered as wrangler secrets (`wrangler secret put` / `.dev.vars`), never
  // as `[vars]` entries. `DIRECTORY_ROUTING_SECRET` is on this side and **not**
  // on the state Worker's: a bucket that could derive its own name from an
  // address would defeat the point of the HMAC (ADR-016).
  SESSION_SECRET?: string;
  AI_CLIENT_TOKEN_SECRET?: string;
  DIRECTORY_ROUTING_SECRET?: string;
}>;

export function readRequestServerConfig(env: ServerEnv): RequestServerConfig {
  return {
    ...content,
    appUrl: env.APP_URL,
    bindings: {
      userData: env.USER_DATA,
      identityDirectory: env.IDENTITY_DIRECTORY,
    },
    secrets: {
      sessionSecret: requireSessionSecret(env.SESSION_SECRET),
      aiClientTokenSecret: requireAiClientTokenSecret(
        env.AI_CLIENT_TOKEN_SECRET,
      ),
      directoryRoutingKeyring: requireDirectoryRoutingKeyring(
        env.DIRECTORY_ROUTING_SECRET,
      ),
    },
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
 * Wraps a stub so that platform failures become the same `SerializedError`
 * shape as the ones inside the envelope.
 *
 * Two distinct paths converge here. A failure *inside* the Durable Object comes
 * back as `{ ok: false, error }` and returns normally; a failure to reach the
 * DO at all — overloaded, evicted, `ctx.abort()` — makes the stub call itself
 * throw, and there is no catch point inside the DO for it. The second is what
 * this translates.
 */
function guardStub<T extends object>(stub: T): T {
  return new Proxy(stub, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const result = (value as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
          return result instanceof Promise
            ? result.catch(translateStubError)
            : result;
        } catch (error) {
          return translateStubError(error);
        }
      };
    },
  });
}

/**
 * Builds the request-scoped container.
 *
 * **`idFromName` / `getByName` appear here and nowhere else in the codebase.**
 * That is the structural guarantee behind "an authenticated request cannot
 * select a Durable Object from anything but its own `userId`": there is no
 * other module where an external input could reach one.
 */
export function createRequestContainer(
  config: RequestServerConfig,
): RequestContainer {
  const { bindings, secrets, ...appConfig } = config;
  return {
    ...buildSharedDeps(),
    config: appConfig satisfies AppConfig,
    passwordHasher: createPbkdf2PasswordHasher(),
    sessionCodec: createHmacSessionCodec({ secret: secrets.sessionSecret }),
    directoryLocator: createDirectoryLocator(secrets.directoryRoutingKeyring),
    userDataStubFactory: (userId: string): UserDataFacade => {
      const namespace = bindings.userData;
      return guardStub(
        namespace.get(
          namespace.idFromName(userId),
        ) as unknown as UserDataFacade,
      );
    },
    directoryStubFactory: (
      locator: DirectoryLocator,
    ): IdentityDirectoryFacade => {
      const namespace = bindings.identityDirectory;
      return guardStub(
        namespace.get(
          namespace.idFromName(locator.doName),
        ) as unknown as IdentityDirectoryFacade,
      );
    },
  };
}
