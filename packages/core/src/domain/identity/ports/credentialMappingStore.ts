import type { CredentialId } from "../valueObject";
import type { CredentialMappingKind } from "./credentialMappingRepository";

export type ReserveCredentialArgs = Readonly<{
  kind: CredentialMappingKind;
  hmac: string;
  generation: number;
  credentialId: CredentialId;
  candidateUserId: string;
  /**
   * The CAS key. There is no `payload_digest` column on `credential_mappings`
   * (`spec/database/index.md` lists the columns and has none), so a replay is
   * recognised by `operationId` alone — see ADR-024.
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
  locators?: readonly unknown[];
  /** Written on non-coordinator rows, pointing back at the coordinator. */
  coordinatorLocator?: string;
  encryptedCanonical?: string;
  encryptionGeneration?: number;
  encryptionNonce?: string;
}>;

/**
 * Writes against `credential_mappings`.
 *
 * Deliberately **not** methods on `CredentialMappingRepository`:
 * `spec/domains/identity.md` says so outright — these are operations a
 * multi-step procedure issues, not domain-typed reads — and leaves the
 * implementation shape to #37 (ADR-012).
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
 * expressed by putting raw `sql` on the context — which §8.2 forbids.
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

  /** Promotes a reservation to the live mapping. Keyed on `operationId`. */
  activate(
    kind: CredentialMappingKind,
    hmac: string,
    operationId: string,
    userId: string,
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
   * `'advanced'`.
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
   * The eighth method, where `spec/domains/identity.md` names six and ADR-012
   * adds `reportResult` as the seventh. That column is listed with no writer
   * anywhere, and the reset-request entry cannot throttle on a value nothing
   * ever sets — see ADR-026. Like the rest it must run inside the same
   * transaction as the job row, so it belongs on this port rather than beside
   * it. The window's size, ceiling and decay are #18's.
   */
  recordResetRequested(
    kind: CredentialMappingKind,
    hmac: string,
    at: number,
  ): void;
}
