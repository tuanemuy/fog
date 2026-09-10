import type {
  IdentityDirectoryJobKind,
  UserDataJobKind,
} from "@repo/core/application/delivery/types";
import type { DomainEvent, EventDraft } from "@repo/core/domain/common/event";
import type { PasswordResetRequestedEvent } from "@repo/core/domain/identity/passwordResetRequested";
import type { AccountStore } from "@repo/core/domain/identity/ports/accountStore";
import type { AiClientConnectionRepository } from "@repo/core/domain/identity/ports/aiClientConnectionRepository";
import type { CredentialLocatorStore } from "@repo/core/domain/identity/ports/credentialLocatorStore";
import type {
  CredentialAttemptRecorder,
  CredentialMappingReader,
  CredentialMappingWriter,
} from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { PasswordResetThrottlePort } from "@repo/core/domain/identity/ports/passwordResetThrottlePort";
import type { PasswordResetTokenPort } from "@repo/core/domain/identity/ports/passwordResetTokenPort";
import type { UserSettingsRepository } from "@repo/core/domain/identity/ports/userSettingsRepository";
import type { DocumentRepository } from "@repo/core/domain/knowledge/ports/documentRepository";
import type { TopicRepository } from "@repo/core/domain/knowledge/ports/topicRepository";
import type { MemoRepository } from "@repo/core/domain/memo/ports/memoRepository";
import type { SearchIndexPort } from "@repo/core/domain/search/ports/searchIndexPort";
import type { TrashQueryPort } from "@repo/core/domain/trash/ports/trashQueryPort";

/**
 * The canonical unit-of-work contract.
 *
 * `run` is **fully synchronous**: the conditional return type rejects an
 * `async` callback at compile time, which turns "no `await` inside a
 * transaction" from a convention into a language rule. The Durable Object
 * is the transaction scope, so `run` takes no scope argument — the
 * `userId` was already consumed when the DO stub was selected.
 *
 * Because the callback is one transaction, operations inside a DO are
 * **fully serialized**. An OCC `version` check therefore only bites a
 * writer that holds its token across a transaction boundary — a direct
 * repository call — and two concurrent usecases never conflict with each
 * other.
 *
 * The provider is generic over its context because the roster of stores
 * and side-effect registration points **differs by DO class**
 * (`spec/database/index.md` is the authority). Only `enqueueJob` and
 * `enqueueEvent` exist on every class.
 *
 * Never put an asynchronous port on a context (`MailSender`,
 * `PasswordHasher`, a DO stub factory, anything carrying `fetch`), and
 * never call `run` from inside `run`.
 */
export interface UnitOfWorkProvider<TCtx> {
  run<T>(fn: (ctx: TCtx) => T extends Promise<unknown> ? never : T): T;
  /**
   * Take (and clear) the flag saying the last `run` added runnable rows.
   *
   * The flag is deliberately **not** carried on `run`'s return value: the
   * canonical signature is `run<T>(fn): T`, and folding a flag into it
   * would bend that contract on its face. The provider raises the flag
   * from `enqueueJob` / `enqueueEvent`, clears it on entry to `run`, and
   * clears it again when `transactionSync` throws (the rows rolled back).
   *
   * **Call it outside `run` only.** `setAlarm()` is asynchronous and
   * cannot be issued from inside a synchronous transaction, so the
   * re-arm happens after `run` returns.
   */
  takeRearmRequest(): boolean;
}

/**
 * The shape a Durable Object's `runUnitOfWork` has when handed to an
 * adapter module as a dependency: the same synchronous-callback contract
 * as {@link UnitOfWorkProvider.run}, behind the gate and the re-arm.
 */
export type UnitOfWorkRunner<TCtx> = <T>(
  fn: (ctx: TCtx) => T extends Promise<unknown> ? never : T,
) => Promise<T>;

/**
 * Input to `enqueueJob`.
 *
 * `operationKey` is derived deterministically by the caller — it is the
 * job's identity and re-submissions converge onto the existing row — so
 * it is never minted from `IdGenerator`. `payload` carries neither PII
 * nor a reusable secret, and `nextRunAt` is excluded from the payload
 * digest comparison (bringing a job forward is not a conflict).
 */
export type EnqueueJobInput<TKind extends string> = Readonly<{
  operationKey: string;
  kind: TKind;
  payload: Record<string, unknown>;
  nextRunAt: Date;
}>;

/**
 * Value domain of `operations.kind` — five tokens, and that is the whole
 * of it (`spec/database/index.md`). Two of them (`credential-change` /
 * `withdrawal`) are reservations for sagas whose stages live outside this
 * spec: the schema carries them, and no writer exists for them today.
 */
export type OperationKind =
  | "signup"
  | "link"
  | "unlink"
  | "credential-change"
  | "withdrawal";

export type RecordOperationInput = Readonly<{
  operationId: string;
  kind: OperationKind;
  payload: Record<string, unknown>;
  phase: string;
  targetLocators?: readonly Record<string, unknown>[];
}>;

export type UpdateOperationInput = Readonly<{
  operationId: string;
  phase: string;
  /**
   * Omitted leaves the stored reason as it is; `null` clears it. The two
   * are distinct because a call that only advances the phase must not
   * erase a termination already recorded, and only the type says which of
   * the two a caller meant — `terminalReason?: string` alone cannot.
   */
  terminalReason?: string | null;
  /**
   * Replaces the stored array when present, on the same terms. Never
   * emptied on completion: the locators stay as recovery material
   * (`spec/recovery/index.md`), so there is no clearing form for them.
   */
  targetLocators?: readonly Record<string, unknown>[];
}>;

/** `rotation_checkpoints.rotation_kind`: which of the two rotations a row records (`spec/database/index.md`). */
export type RotationKind = "remap" | "encryption";

/**
 * One `rotation_checkpoints` row. `generation` means the retiring
 * generation of whichever kind the row is — the mapping-key one for
 * `remap`, the encryption one for `encryption`; the two are independent
 * numberings. The three conflict columns are used by `remap` alone and
 * hold the count re-detected in the chunk that wrote the row, not a total.
 */
export type RotationCheckpoint = Readonly<{
  rotationKind: RotationKind;
  bucketIndex: number;
  generation: number;
  previousCount: number;
  scannedAt: number;
  conflictCount: number;
  lastConflictAt: number | null;
  lastConflictCredentialId: string | null;
}>;

/**
 * The one write path into `rotation_checkpoints` (`spec/database/index.md`).
 * Two writers replace a snapshot — the mapping-key transfer and
 * `rotate-encryption` — and every write that adds a mapping row to this
 * bucket deletes, in its own transaction, the checkpoint of the generation
 * that row belongs to: that is the "invalidation of the retirement
 * proof" of `spec/rotation/index.md`, and it is what lets the retirement
 * condition ask for neither freshness nor a round id.
 */
export interface RotationCheckpointStore {
  /** Snapshot replacement on the key `(rotationKind, bucketIndex, generation)`. */
  replace(checkpoint: RotationCheckpoint): void;
  /** Point deletion; absent is success. */
  delete(
    rotationKind: RotationKind,
    bucketIndex: number,
    generation: number,
  ): void;
  read(
    rotationKind: RotationKind,
    bucketIndex: number,
    generation: number,
  ): RotationCheckpoint | null;
}

/** Input to `setMigrationCursor` — the resume point of one `(target_version, step)`. */
export type SetMigrationCursorInput = Readonly<{
  targetVersion: number;
  step: string;
  cursor: string;
}>;

/**
 * Registration points shared by every DO class. Both write into the DO's
 * own tables inside the same `transactionSync` as the business write, so
 * a rollback unwinds them together with it.
 *
 * Both are bound to the roster their DO class is allowed to write:
 * `TKind` to that class's `jobs.kind` union, `TEvent` to the union of the
 * **event types themselves** rather than of their `type` strings — so the
 * domain's payload type is what a draft is measured against, and
 * DOM-identity-046 ("no PII and no reusable secret in a payload") holds
 * structurally instead of by review. `TEvent` defaults to `never`, which
 * makes a draft unconstructable and leaves the empty array as the only
 * accepted argument — that is how a class whose enumerated event roster
 * is empty says so in the type rather than by convention
 * (`spec/async/index.md`).
 */
export interface CommonUnitOfWorkContext<
  TKind extends string,
  TEvent extends DomainEvent = never,
> {
  enqueueJob(input: EnqueueJobInput<TKind>): void;
  enqueueEvent(drafts: readonly EventDraft<TEvent>[]): void;
}

/**
 * User Data DO context — the roster grows slice by slice toward
 * `spec/database/index.md`'s declaration: today the two identity
 * repositories/stores, the memo, topic and document repositories, the
 * trash read port, the `operations` registration points and the two
 * common ones.
 *
 * **The search projection is not on it, and will not be.** The index is
 * maintained inside the writing repository's own statement, in the same
 * `transactionSync`; putting it here would make it injectable, and
 * therefore callable from outside the transaction whose atomicity is the
 * only thing keeping the index true.
 *
 * `accountStore` is on the context but is **not** one of the nine
 * non-aggregate stores: `account` carries an OCC `version` and sits on the
 * aggregate-root side of that split.
 *
 * Its event roster is empty and stays empty: `TEvent` is left at `never`,
 * so `enqueueEvent` here accepts nothing but `[]`.
 */
export interface UserDataUnitOfWorkContext
  extends CommonUnitOfWorkContext<UserDataJobKind> {
  userSettingsRepository: UserSettingsRepository;
  memoRepository: MemoRepository;
  topicRepository: TopicRepository;
  documentRepository: DocumentRepository;
  /** Read-only; the index whose entries the repositories above write (`spec/domains/search.md`). */
  searchIndex: SearchIndexPort;
  /** Read-only; the wake-up material for `purge-trash` (`spec/domains/trash.md`). */
  trashQueryPort: TrashQueryPort;
  accountStore: AccountStore;
  credentialLocatorStore: CredentialLocatorStore;
  aiClientConnectionRepository: AiClientConnectionRepository;
  recordOperation(input: RecordOperationInput): void;
  updateOperation(input: UpdateOperationInput): void;
  /** `migration_progress`: the one write, the cursor of `reindex` / `migrate-bulk` (`spec/database/index.md`). */
  setMigrationCursor(input: SetMigrationCursorInput): void;
}

/**
 * Identity Directory DO context. `credential_mappings` and the two reset
 * tables are the business side; `rotation_checkpoints` the rotation's.
 *
 * **The three members below are the complete set of ways that table is
 * read and written.** `credentialMappingWriter` holds the six procedure
 * stages the domain fixed, `credentialAttemptRecorder` the seventh write
 * (how a verification went), and `credentialMappingReader` the locator-keyed
 * reads. A path that writes a mapping row without going through one of the
 * two writers does not exist.
 */
export interface IdentityDirectoryUnitOfWorkContext
  extends CommonUnitOfWorkContext<
    IdentityDirectoryJobKind,
    PasswordResetRequestedEvent
  > {
  credentialMappingReader: CredentialMappingReader;
  credentialMappingWriter: CredentialMappingWriter;
  credentialAttemptRecorder: CredentialAttemptRecorder;
  /** `password_reset_tokens`: issue / consume / decoy (`PasswordResetTokenPort`). */
  resetTokenStore: PasswordResetTokenPort;
  /** `reset_request_windows`: the one write, `claimWindow` (`PasswordResetThrottlePort`). */
  resetThrottleStore: PasswordResetThrottlePort;
  /** `rotation_checkpoints`: snapshot replacement and the proof-invalidating deletion. */
  rotationCheckpointStore: RotationCheckpointStore;
}

export type UserDataUnitOfWorkProvider =
  UnitOfWorkProvider<UserDataUnitOfWorkContext>;

export type IdentityDirectoryUnitOfWorkProvider =
  UnitOfWorkProvider<IdentityDirectoryUnitOfWorkContext>;
