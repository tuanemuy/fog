import type { DurableObjectState } from "@cloudflare/workers-types";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Logger } from "@repo/core/application/ports/logger";
import type { MailSender } from "@repo/core/domain/identity/ports/mailSender";
import type { DoClass, JOB_OWNER, JobKind } from "@repo/core/lib/jobKind";
import type { Sql } from "../sql/exec";
import type { JobRow } from "./table";

/**
 * Job handlers, split by owning DO class.
 *
 * **The rules for what may sit on a `JobContext` are not the rules for a
 * `UnitOfWorkContext`.** A job handler runs *outside* the transaction and opens
 * its own, so it may hold asynchronous ports such as `MailSender`. Conflating
 * the two would quietly weaken the unit-of-work rule that no asynchronous port
 * is ever reachable from inside `transactionSync`.
 */

export type JobContextBase = Readonly<{
  /**
   * The one way into `transactionSync`. Handlers need it because several of
   * them have to commit multiple statements atomically (hard delete's four
   * steps; a chunk's progress plus its `releaseJob`), which `sql` alone cannot
   * express.
   */
  ctx: DurableObjectState;
  sql: Sql;
  now: number;
  ownerToken: string;
  logger: Logger;
  idGenerator: IdGenerator;
}>;

export type UserDataJobContext = JobContextBase;

export type IdentityDirectoryJobContext = JobContextBase &
  Readonly<{ mailSender: MailSender; appUrl: string }>;

export type JobOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "rearm"; readonly nextRunAt: number }
  /** Chunk budget exhausted; hand the row back for the next wake-up. */
  | { readonly kind: "yield" };

export type JobHandler<TCtx> = (ctx: TCtx, row: JobRow) => Promise<JobOutcome>;

/**
 * Derives each DO class's admissible `kind` set from `JOB_OWNER`, so the table
 * is not maintained twice. This only works because `JOB_OWNER` is declared
 * `as const satisfies …` — a plain type annotation widens every value to
 * `DoClass` and this conditional then admits all twelve kinds on both sides.
 */
export type JobKindOf<D extends DoClass> = {
  [K in JobKind]: (typeof JOB_OWNER)[K] extends D ? K : never;
}[JobKind];

/**
 * Note the asymmetry: because `UserDataJobContext` is a structural supertype
 * of `IdentityDirectoryJobContext`, parameter contravariance *does* let a
 * User Data handler be assigned where an Identity Directory handler is
 * expected. Only the key constraint stops the mistake — the registries admit
 * disjoint `kind` sets, so there is no key to register it under.
 */
export const USER_DATA_JOB_HANDLERS: Partial<
  Record<JobKindOf<"userData">, JobHandler<UserDataJobContext>>
> = {};

export const IDENTITY_DIRECTORY_JOB_HANDLERS: Partial<
  Record<
    JobKindOf<"identityDirectory">,
    JobHandler<IdentityDirectoryJobContext>
  >
> = {};

/**
 * Reason recorded for a `kind` that reaches the runner with no handler. This
 * is fail-closed for a future implementation gap: #37 creates no rows of the
 * five unimplemented kinds, so it is unreachable in normal operation.
 */
export const UNIMPLEMENTED_JOB_KIND = "UNIMPLEMENTED_JOB_KIND";
