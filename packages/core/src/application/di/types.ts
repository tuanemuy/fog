import type { PasswordHasher } from "@repo/core/domain/identity/ports/passwordHasher";
import type { UnitOfWorkProvider } from "../execution/unitOfWork";
import type { Clock } from "../ports/clock";
import type { IdempotencyStore } from "../ports/idempotencyStore";
import type { IdGenerator } from "../ports/idGenerator";
import type { Logger } from "../ports/logger";
import type { OutboxRepository } from "../ports/outboxRepository";
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
 * Request-path container. Provided to usecases that mutate aggregates
 * (which must run inside `unitOfWorkProvider.run`) and to the
 * presentation layer for SSR head/meta via `config`.
 *
 * Intentionally does NOT carry `outboxRepository` or
 * `idempotencyStore`: those are worker concerns. A request that needs
 * to enqueue a domain event uses the UoW's `collectEvents`, which
 * funnels through the transactional outbox write inside the unit of
 * work — never touching the repository directly.
 *
 * Repositories likewise stay out: `UnitOfWorkContext` is their single
 * point of issue, which is what keeps every aggregate access inside a
 * unit of work. `passwordHasher` is a deliberate exception to that rule
 * — it is a domain port but not a repository, it touches no storage, and
 * spec/usecases/identity.md requires hashing to happen *before* the unit
 * of work opens so a CPU-bound derivation never sits inside a
 * transaction (ADR-009).
 *
 * `sessionCodec` is here for the presentation layer only; no usecase may
 * read it (see the port's own JSDoc). The session secret itself is not
 * on the container at all — it is consumed while constructing the codec
 * and goes no further (ADR-002).
 */
export type RequestContainer = SharedDeps &
  Readonly<{
    config: AppConfig;
    unitOfWorkProvider: UnitOfWorkProvider;
    passwordHasher: PasswordHasher;
    sessionCodec: SessionCodec;
  }>;

/**
 * Worker-path container. Used by the relay (`processOutboxEvents`),
 * pruner (`pruneOutbox`), queue consumer, and DLQ handler.
 *
 * Intentionally does NOT carry `config` or `unitOfWorkProvider`:
 * `config` is SSR-only metadata, and worker code that reads/writes
 * the outbox does so through `outboxRepository` directly without a
 * unit of work (no aggregate is mutated).
 */
export type WorkerContainer = SharedDeps &
  Readonly<{
    outboxRepository: OutboxRepository;
    idempotencyStore: IdempotencyStore;
  }>;
