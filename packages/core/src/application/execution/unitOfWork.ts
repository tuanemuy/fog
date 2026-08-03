import type { AccountStore } from "@repo/core/domain/identity/ports/accountStore";
import type { CredentialLocatorStore } from "@repo/core/domain/identity/ports/credentialLocatorStore";
import type { CredentialMappingRepository } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { CredentialMappingStore } from "@repo/core/domain/identity/ports/credentialMappingStore";
import type { PasswordResetTokenPort } from "@repo/core/domain/identity/ports/passwordResetTokenPort";
import type { RotationCheckpointStore } from "@repo/core/domain/identity/ports/rotationCheckpointStore";
import type { UserSettingsRepository } from "@repo/core/domain/identity/ports/userSettingsRepository";
import type {
  EnqueueJobArgs,
  OperationPatch,
  OperationRecord,
  RecordOperationArgs,
} from "./jobs";

/**
 * The unit of work.
 *
 * ## Two context types, one per Durable Object class
 *
 * The roster of stores differs by class, and a single interface would let code
 * running inside an Identity Directory bucket touch `credentialLocatorStore` —
 * a table that does not exist there — and only find out at runtime. Splitting
 * the type puts each class's complete set of in-transaction write paths into
 * the type system, where it can be checked against `spec/database/index.md`.
 *
 * ## What may sit on a context
 *
 * Stated as a prohibition, because the permissive form ("repositories only")
 * would wrongly exclude `enqueueJob`: **no asynchronous port may be on a
 * context** — not `MailSender`, not `PasswordHasher`, not a DO stub factory,
 * not anything carrying `fetch`. Nor may raw `sql`: every write goes through a
 * named store or registration point, which is what makes the roster countable.
 *
 * ## No nesting
 *
 * `transactionSync` has no documented nesting behaviour and `sql.exec()` cannot
 * issue `SAVEPOINT`, so there is no fallback either. **Never call `run` from
 * inside `run`.** The rule is held structurally rather than by a type: a
 * context offers no route back to its provider.
 */

/** Write paths available inside a User Data DO transaction. */
export interface UserDataUnitOfWorkContext {
  userSettingsRepository: UserSettingsRepository;
  accountStore: AccountStore;
  credentialLocatorStore: CredentialLocatorStore;

  /** The only door into `jobs`. */
  enqueueJob(args: EnqueueJobArgs): void;

  /**
   * Recomputes `purge_after` for up to `limit` trashed items and reports how
   * many rows changed, so that a retention change and the re-dating of the
   * items it governs commit together.
   *
   * It is on the context rather than behind a memo / knowledge repository
   * because no such repository exists, while the retention setting itself is
   * owned here. The predicate behind it is self-consuming, so a change whose
   * trash is larger than one transaction leaves the remainder to the
   * `purge-trash` job — which recomputes before it deletes anything, and
   * therefore cannot purge an item on a window the user has just lengthened.
   */
  recalcTrashPurgeAfter(retentionDays: number, limit: number): number;

  /**
   * Reads a saga's `operations` row. A read, so it is not one of the write
   * paths the roster counts — but it has to be on the context all the same,
   * because the phase-2 idempotency rule is a decision about the *pair* of the
   * `account` row and the `operations` row.
   */
  findOperation(operationId: string): OperationRecord | null;

  /** Opens a saga's `operations` row. */
  recordOperation(args: RecordOperationArgs): void;

  /** Advances a saga's phase, stashes locators, or records its terminus. */
  updateOperation(operationId: string, patch: OperationPatch): void;

  /**
   * Advances a chunked migration's cursor. The only writers are `migrate-bulk`
   * and `reindex`, and they are the only jobs that carry a persistent cursor at
   * all — every other kind's work predicate is self-consuming.
   */
  setMigrationCursor(targetVersion: number, step: string, cursor: string): void;
}

/**
 * Write paths available inside an Identity Directory DO transaction.
 *
 * `operations` / `migration_progress` live in the User Data DO, so the three
 * corresponding registration points are absent here rather than being present
 * and throwing.
 */
export interface IdentityDirectoryUnitOfWorkContext {
  /** Reads. The DO-side shape — see the port's JSDoc for why it differs. */
  credentialMappingRepository: CredentialMappingRepository;
  /** Writes, as CAS operations. */
  credentialMappingStore: CredentialMappingStore;
  resetTokenStore: PasswordResetTokenPort;
  rotationCheckpointStore: RotationCheckpointStore;

  enqueueJob(args: EnqueueJobArgs): void;
}

/**
 * Runs `fn` inside one `ctx.storage.transactionSync`.
 *
 * **The callback is fully synchronous, and the type enforces it.** An `async`
 * function always returns a `Promise`, so `T extends Promise<unknown> ? never
 * : T` collapses its return type to `never` and the call stops compiling. That
 * turns "do not `await` inside a transaction" from a convention into a rule of
 * the language: without `async` there is no `await`, and combined with the
 * prohibition on asynchronous ports there is nothing to await either.
 *
 * It matters beyond tidiness. Cloudflare defines atomicity by the *absence* of
 * `await` — an `await` inside a transaction opens the input gate, letting an
 * interleaved handler's writes join the same transaction, and a SQL cursor held
 * across one loses its snapshot.
 *
 * `run` takes no scope argument: the Durable Object *is* the scope, and
 * `userId` was already consumed when its stub was selected.
 */
export interface UnitOfWorkProvider<TContext> {
  run<T>(fn: (ctx: TContext) => T extends Promise<unknown> ? never : T): T;
}
