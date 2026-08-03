import type { DurableObjectState } from "@cloudflare/workers-types";
import type { StateSecrets } from "@repo/core/application/di/secrets";
import type { IdGenerator } from "@repo/core/application/ports/idGenerator";
import type { Logger } from "@repo/core/application/ports/logger";
import type { MailSender } from "@repo/core/domain/identity/ports/mailSender";
import type { DoClass, JOB_OWNER, JobKind } from "@repo/core/lib/jobKind";
import type { Sql } from "../sql/exec";
import { migrateBulk } from "./handlers/migrateBulk";
import { purgeTrash } from "./handlers/purgeTrash";
import { reindex } from "./handlers/reindex";
import { resumeSignup } from "./handlers/resumeSignup";
import { sendMail } from "./handlers/sendMail";
import { sweepReservations } from "./handlers/sweepReservations";
import { sweepResetTokens } from "./handlers/sweepResetTokens";
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
  Readonly<{
    mailSender: MailSender;
    appUrl: string;
    /**
     * The state Worker's keyrings, or `null` when the deployment binds neither.
     *
     * Nullable rather than absent because a Durable Object's constructor runs
     * before every entry point: throwing there over an unset optional binding
     * would take `alarm()` and the operator diagnostics down with it. A handler
     * that actually needs a key fails loudly instead, which keeps the failure
     * on the one job it affects.
     *
     * They are handed to the job context and **not** to the container: the
     * container's own shape is asserted to carry no secret, so that a
     * rest-spread can never carry one out of the module.
     */
    secrets: StateSecrets | null;
  }>;

export type JobOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "rearm"; readonly nextRunAt: number }
  /** Chunk budget exhausted; hand the row back for the next wake-up. */
  | { readonly kind: "yield" }
  /**
   * The handler has established that this job can never make progress —
   * distinct from throwing, which asks for a retry. It reaches the *same*
   * terminus as an exhausted retry budget (`poison` + `terminal_reason`,
   * written in one statement), because "the terminal state is uniform" has to
   * hold however the job got there: the recovery that reads those rows cannot
   * afford a second shape.
   *
   * `reason` obeys the same rule as any `terminal_reason` — the failure's
   * identity only, never PII and never a reusable secret.
   */
  | { readonly kind: "terminal"; readonly reason: string };

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
> = {
  "purge-trash": purgeTrash,
  reindex,
  "migrate-bulk": migrateBulk,
};

export const IDENTITY_DIRECTORY_JOB_HANDLERS: Partial<
  Record<
    JobKindOf<"identityDirectory">,
    JobHandler<IdentityDirectoryJobContext>
  >
> = {
  "send-mail": sendMail,
  "resume-signup": resumeSignup,
  "sweep-reservations": sweepReservations,
  "sweep-reset-tokens": sweepResetTokens,
};

/**
 * Reason recorded for a `kind` that reaches the runner with no handler. This
 * is fail-closed for a future implementation gap: nothing creates rows of the
 * five unimplemented kinds, so it is unreachable in normal operation.
 */
export const UNIMPLEMENTED_JOB_KIND = "UNIMPLEMENTED_JOB_KIND";
