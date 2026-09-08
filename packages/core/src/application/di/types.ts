import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import type { SsoProvider } from "@repo/core/domain/identity/valueObject";
import type { ExportGateway } from "../export/gateway";
import type { IdentityGateway } from "../identity/gateway";
import type { IdentityTuning } from "../identity/tuning";
import type { KnowledgeGateway } from "../knowledge/gateway";
import type { MemoGateway } from "../memo/gateway";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/idGenerator";
import type { Logger } from "../ports/logger";
import type { SessionCodec } from "../ports/sessionCodec";
import type { TokenGenerator } from "../ports/tokenGenerator";
import type { SearchGateway } from "../search/gateway";
import type { TrashGateway } from "../trash/gateway";

export type AppConfig = Readonly<{
  appUrl: string;
  siteName: string;
  defaultTitle: string;
  defaultDescription: string;
  twitterHandle?: string;
  themeColor: string;
  /** The SSO providers with an adapter configured: the only ones a screen may offer (P-01 / P-02 / P-13). */
  ssoProviders: readonly SsoProvider[];
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
    knowledgeGateway: KnowledgeGateway;
    searchGateway: SearchGateway;
    trashGateway: TrashGateway;
    exportGateway: ExportGateway;
    passwordHasher: PasswordHasher;
    sessionCodec: SessionCodec;
    /** Opaque secrets minted on the request side: caller bindings, reset tokens, code `jti`s. */
    tokenGenerator: TokenGenerator;
  }>;
