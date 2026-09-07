import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import type { IdentityGateway } from "../identity/gateway";
import type { IdentityTuning } from "../identity/tuning";
import type { MemoGateway } from "../memo/gateway";
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

export type SharedDeps = Readonly<{
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
}>;

/**
 * The request-path container. One gateway per domain; the trash / search /
 * export gateways join at the same level as their slices land. Repositories
 * stay off it: they are issued only by a unit-of-work context inside a Durable
 * Object. `passwordHasher` is the one domain port here, because hashing runs
 * before any unit of work opens. Nothing on this type names a platform type.
 */
export type RequestContainer = SharedDeps &
  Readonly<{
    config: AppConfig;
    identityGateway: IdentityGateway;
    identityTuning: IdentityTuning;
    memoGateway: MemoGateway;
    passwordHasher: PasswordHasher;
    sessionCodec: SessionCodec;
  }>;
