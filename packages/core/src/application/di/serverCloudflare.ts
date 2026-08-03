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
 * Recognises a pending result **structurally**, by `then` alone.
 *
 * Neither shortcut works on what workerd's JS RPC actually returns, and both
 * fail silently — the call still runs, its failure just stops being translated.
 *
 * - `instanceof Promise` is **false**. `Rpc.Result<R>` is `Promise<…> &
 *   Provider<R>`, and the object behind it is a custom thenable
 *   (`[object JsRpcPromise]`) that workerd's own declarations describe as
 *   quacking like a `Promise` without being one.
 * - `typeof value === "object"` is **false too**: it is `"function"`, because
 *   the same handle doubles as the pipelining provider.
 *
 * Both are measured against a real stub in `__tests__/stubGuard.integration.test.ts`.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Wraps a stub so that platform failures become the same `SerializedError`
 * shape as the ones inside the envelope.
 *
 * Two distinct paths converge here. A failure *inside* the Durable Object comes
 * back as `{ ok: false, error }` and returns normally; a failure to reach the
 * DO at all — overloaded, evicted, `ctx.abort()` — makes the stub call itself
 * fail, and there is no catch point inside the DO for it. The second is what
 * this translates, and it arrives both ways: synchronously from the call
 * itself, and asynchronously as a rejection of the thenable it returned.
 */
function guardStub<T extends object>(stub: T): T {
  return new Proxy(stub, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          // **Never `Reflect.apply` / `.call` / `.bind`.** A JS RPC stub's
          // method is not an ordinary function but a pipelining handle, and
          // supplying the receiver explicitly makes workerd treat it as a value
          // to serialise — failing with `ServiceStub serialization requires the
          // 'experimental' compat flag` before the call ever leaves. Reading
          // the property and calling the result is fine, and is what the two
          // lines below do; it is re-binding the receiver that breaks.
          const method = (
            target as Record<PropertyKey, (...a: unknown[]) => unknown>
          )[property];
          const result = method(...args);
          // Adopting the thenable settles it into an ordinary `Promise` and so
          // drops the pipelining handle. The facades are primitives in,
          // `RpcEnvelope` out — nothing pipelines through them — and a guard
          // that only translates when the caller happens to have kept a real
          // `Promise` would be the same hole in a different shape.
          return isThenable(result)
            ? Promise.resolve(result).catch(translateStubError)
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
