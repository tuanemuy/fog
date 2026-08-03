import type {
  IdentityDirectoryFacade,
  UserDataFacade,
} from "@repo/core/application/di/facades";
import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import type { DirectoryLocator } from "@repo/core/lib/directoryLocator";
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
 * Cross-cutting deterministic deps shared between the request and state
 * composition roots. Held as ports so domain / application code stays free of
 * ambient time, id generation, and IO sinks.
 */
export type SharedDeps = Readonly<{
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
}>;

/**
 * Request-path container. Handed to the presentation layer for SSR head/meta
 * via `config`, and to usecases for everything else.
 *
 * **No `unitOfWorkProvider`.** Units of work run inside a Durable Object; the
 * request Worker reaches one through a stub factory instead.
 *
 * Repositories stay out: `UnitOfWorkContext` is their single point of issue,
 * which is what keeps every aggregate access inside a unit of work. **A DO
 * facade is transport, not a repository** — it takes primitives, returns
 * primitives, and exposes no repository type and no context type on this side.
 *
 * `passwordHasher` is a deliberate exception: a domain port that touches no
 * storage, and hashing must happen *before* a unit of work opens so a
 * CPU-bound derivation never sits inside a transaction.
 *
 * `sessionCodec` is for the presentation layer only — usecases are handed
 * `UsecaseContainer`, which omits it.
 */
export type RequestContainer = SharedDeps &
  Readonly<{
    config: AppConfig;
    passwordHasher: PasswordHasher;
    sessionCodec: SessionCodec;
    /**
     * The **only** place a `userId` becomes a Durable Object. Selection lives
     * in the composition root so no other module can name a DO, which is what
     * makes "no code path can obtain another user's stub" checkable.
     */
    userDataStubFactory: (userId: string) => UserDataFacade;
    directoryStubFactory: (
      locator: DirectoryLocator,
    ) => IdentityDirectoryFacade;
    /**
     * canonical → bucket locators. Request-side only, by design.
     *
     * Non-empty: the active generation is `[0]`, and every write goes there.
     */
    directoryLocator: {
      forCanonical(
        canonical: string,
      ): Promise<readonly [DirectoryLocator, ...DirectoryLocator[]]>;
    };
  }>;
