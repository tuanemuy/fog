import type { CredentialId } from "../valueObject";
import type { CredentialLocatorRef } from "./credentialLocatorStore";
import type { CredentialMappingKind } from "./credentialMappingRepository";

/**
 * The address original, sealed for storage.
 *
 * One value rather than three independently-optional fields: the ciphertext,
 * the nonce and the generation that sealed them are only ever meaningful
 * together, and a row carrying two of the three cannot be opened again.
 */
export type SealedCanonical = Readonly<{
  ciphertext: string;
  /** The keyring generation that sealed it. A row is opened with its own. */
  generation: number;
  nonce: string;
}>;

export type ReserveCredentialArgs = Readonly<{
  kind: CredentialMappingKind;
  hmac: string;
  generation: number;
  credentialId: CredentialId;
  candidateUserId: string;
  /**
   * The CAS key. There is no `payload_digest` column on `credential_mappings`
   * (`spec/database/index.md` lists the columns and has none), so a replay is
   * recognised by `operationId` alone.
   */
  operationId: string;
  callerToken: string;
  reservedUntil: number;
  /**
   * Present only for a password signup's email reservation. Absent for the
   * email row an SSO signup writes purely to reserve the address — that row's
   * `usableForLogin` must come out false, and holding no verifier is the
   * condition that makes it so.
   */
  passwordVerifier?: string;
  /** Every locator of the operation. Written on the coordinator row only. */
  locators?: readonly CredentialLocatorRef[];
  /** Written on non-coordinator rows, pointing back at the coordinator. */
  coordinatorLocator?: string;
  /**
   * Required, on every reservation. The bucket's row is the single place the
   * raw address survives, so a row written without it silently loses the
   * account's only recoverable recipient — the failure would first surface at
   * that user's first password reset, long after the signup that caused it.
   * Sealing is asynchronous, so it happens in the RPC entry *before* the
   * transaction opens and arrives here as a value.
   */
  sealedCanonical: SealedCanonical;
}>;

/**
 * Writes against `credential_mappings`.
 *
 * Deliberately **not** methods on `CredentialMappingRepository`:
 * `spec/domains/identity.md` says so outright — these are operations a
 * multi-step procedure issues, not domain-typed reads.
 *
 * Every method is a CAS conditioned on some combination of `operationId`,
 * `payloadDigest`, `status` and `changeState`. **None takes an
 * `ExpectedVersion`**: `credential_mappings` has no `version` column, because
 * those CAS predicates already serialise every write to a row and layering a
 * generic OCC on top would make two things authoritative at once.
 *
 * The port exists so this store can sit on
 * `IdentityDirectoryUnitOfWorkContext`. Without it the Directory would have no
 * write path through a unit of work at all, and "the reservation row and its
 * `sweep-reservations` job are written in one `transactionSync`" could only be
 * expressed by putting raw `sql` on the context, which the unit-of-work
 * contract forbids.
 */
export interface CredentialMappingStore {
  /**
   * Takes the reservation that decides uniqueness. A live `active` row for the
   * same locator key loses: the adapter translates the constraint violation
   * into `ConflictError("EMAIL_ALREADY_REGISTERED")` /
   * `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")`. Re-sending the same
   * `operationId` with the same digest converges on the same row.
   */
  reserve(args: ReserveCredentialArgs): void;

  /**
   * Promotes a reservation to the live mapping.
   *
   * Bound by `operationId`, a constant-time `callerToken` comparison **and**
   * the reservation's own `candidateUserId` — the same three-way binding
   * `cancel` uses, and for the same reason: `operationId` may appear in
   * unauthenticated logs, so a write conditioned on knowing it alone would let
   * a logged value promote somebody's reservation onto an attacker's `userId`.
   *
   * Not "absent is success": a reservation that is gone or that names a
   * different operation is a saga that cannot complete, and it raises
   * `ConflictError`. Re-running the phase against a row this same operation has
   * already activated *is* success, so retries stay idempotent.
   */
  activate(
    kind: CredentialMappingKind,
    hmac: string,
    operationId: string,
    userId: string,
    callerToken: string,
  ): void;

  /**
   * Removes a losing reservation. **Ignores `status`** — a row already
   * promoted to `active` can still be the target of recovery — so it is bound
   * by `operationId` *and* a constant-time `callerToken` comparison. Binding a
   * destructive, status-independent delete to knowledge of `operationId` alone
   * would turn a value the design permits in unauthenticated logs into a
   * capability. "Absent is success".
   */
  cancel(
    kind: CredentialMappingKind,
    hmac: string,
    operationId: string,
    callerToken: string,
  ): void;

  /**
   * Starts a verifier replacement: stores the new material as pending, sets
   * `changeState` to `'pending'` and records the origin. From this moment the
   * old material no longer verifies (fail closed).
   *
   * Passes **only** while `changeState` is `null`; a predicate that matches
   * nothing raises `ConflictError` rather than reporting a change that never
   * started. Not "absent is success" — this is the transition that closes the
   * old material, and a caller told it happened when it did not would advance a
   * saga against a credential that still verifies the old password.
   */
  beginChange(
    credentialId: CredentialId,
    pendingVerifier: string,
    origin: "password-change" | "reset",
    operationId: string,
  ): void;

  /**
   * Promotes the pending verifier, aligns `credentialVersion`, clears
   * `changeState` / `changeOrigin`, and in the same transaction resets
   * `failedAttempts` to 0 and moves `nextAttemptAllowedAt` into the past — the
   * escape hatch out of throttling. Passes **only** while `changeState` is
   * `'advanced'`; a predicate that matches nothing raises `ConflictError`
   * rather than reporting a promotion that did not happen.
   */
  promote(credentialId: CredentialId, operationId: string): void;

  /** Removes the mapping for a credential. "Absent is success". */
  delete(credentialId: CredentialId, callerToken: string): void;

  /**
   * Records a verification outcome against the throttling counters. Success
   * clears them; failure advances `failedAttempts` and pushes
   * `nextAttemptAllowedAt` out. A locator naming no row in this bucket updates
   * nothing and still reports success, so that an unregistered canonical is
   * indistinguishable from a registered one.
   */
  reportResult(kind: CredentialMappingKind, hmac: string, ok: boolean): void;

  /**
   * Stamps `last_reset_requested_at`, the throttle window for reset requests.
   *
   * Beyond the methods `spec/domains/identity.md` names: the column is listed
   * there with no writer anywhere, and the reset-request entry cannot throttle
   * on a value nothing ever sets. Like the rest it must run inside the same
   * transaction as the job row, so it belongs on this port rather than beside
   * it.
   *
   * Called on **every** request, whether or not it was allowed to issue and
   * whether or not the locator names a row: the stamp is what
   * `isResetRequestAllowed` compares the current window against, and a locator
   * naming no row writes nothing while still costing one statement.
   */
  recordResetRequested(
    kind: CredentialMappingKind,
    hmac: string,
    at: number,
  ): void;
}
