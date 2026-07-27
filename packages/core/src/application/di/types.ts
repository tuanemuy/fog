import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import type { IdentityApplicationPort } from "../identity/contracts";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/idGenerator";
import type { Logger } from "../ports/logger";
import type { SessionCodec } from "../ports/sessionCodec";

export type AppConfig = Readonly<{
  appUrl: string;
  siteName: string;
  defaultTitle: string;
  defaultDescription: string;
  twitterHandle?: string;
  themeColor: string;
}>;

/**
 * Cross-cutting deterministic deps shared between request and worker
 * containers. Held as ports so domain / application code stays free of
 * ambient time, id generation, and IO sinks.
 */
export type SharedDeps = Readonly<{
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
}>;

/**
 * Request-path container. The identity port is implemented by the narrow
 * Durable Object RPC gateway. Tests that do not invoke identity may omit it.
 *
 * `sessionCodec` is for the presentation layer only — usecases are handed
 * `UsecaseContainer`, which omits it. The session secret itself is not on
 * the container at all: it is consumed while constructing the codec.
 */
export type RequestContainer = SharedDeps &
  Readonly<{
    config: AppConfig;
    identity?: IdentityApplicationPort;
    passwordHasher: PasswordHasher;
    sessionCodec: SessionCodec;
  }>;
