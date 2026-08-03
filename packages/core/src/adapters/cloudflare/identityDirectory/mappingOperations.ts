import { ConflictError, isConflictError } from "@repo/core/application/errors";
import type { CredentialMappingKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type {
  CredentialMappingStore,
  ReserveCredentialArgs,
} from "@repo/core/domain/identity/ports/credentialMappingStore";
import type { CredentialId } from "@repo/core/domain/identity/valueObject";
import { all, one, run, type Sql } from "../sql/exec";
import { matchOpaque } from "./opaqueBinding";

/**
 * The eight writes against `credential_mappings`.
 *
 * Every one is a CAS conditioned on `operationId`, `payloadDigest`, `status` or
 * `changeState`. **None uses `conditionalUpdate`**: that helper is the OCC
 * guard, and this table has no `version` column — those CAS predicates already
 * serialise writes to a row, and adding a generic OCC on top would make two
 * things authoritative at once.
 *
 * ## Which ones read the match back, and why the others do not
 *
 * **All eight are classified here; the three groups are exhaustive.**
 *
 * `activate`, `promote` and `beginChange` count the matched rows and raise
 * `ConflictError` on zero. They advance a saga, so a predicate that matched
 * nothing means the saga cannot complete — reporting success would let signup
 * run to the end with a reservation still `reserved`, producing an account that
 * can never log in and gives no reason why. `beginChange`'s predicate
 * (`change_state IS NULL`) genuinely misses whenever another change is already
 * in flight, and it is the instant from which the old material stops verifying,
 * so a silent no-op would hand the caller a fail-closed state it never entered.
 *
 * `cancel`, `delete` and `reportResult` deliberately treat an absent row as
 * success. The first two are recovery, which is retried and whose goal a row
 * somebody else already removed has met; the third must answer identically for
 * a locator naming no row, or it becomes an enumeration oracle.
 * `recordResetRequested` is in this group for the same reason as `reportResult`.
 *
 * `reserve` is the remaining one and reads nothing back on purpose: it is an
 * `INSERT`, so the primary key — not a matched-row count — is what decides the
 * race, and the driver's violation is translated in place.
 *
 * A facade never imports this module. It reaches these operations only through
 * the context `identityDirectory/unitOfWork.ts` assembles, which is what keeps
 * "the reservation row and its jobs are written in one `transactionSync`"
 * expressible without putting raw `sql` on a context (ADR-012).
 */
export function createCredentialMappingStore(
  sql: Sql,
  now: () => number,
): CredentialMappingStore {
  return {
    reserve(args: ReserveCredentialArgs): void {
      const existing = one<{ status: string; operation_id: string | null }>(
        sql,
        `SELECT status, operation_id
           FROM credential_mappings WHERE kind = ? AND hmac = ?`,
        args.kind,
        args.hmac,
      );

      if (existing !== null) {
        // Re-sending the same operation converges on the same row rather than
        // failing: an application-level retry after a lost response lands here.
        // The comparison is on `operationId` alone because the table has no
        // `payload_digest` column (ADR-024); the digest CAS lives on the User
        // Data side's `operations` row.
        if (existing.operation_id === args.operationId) return;
        throw alreadyRegistered(args.kind);
      }

      const timestamp = now();
      try {
        run(
          sql,
          `INSERT INTO credential_mappings (
             credential_id, kind, hmac, generation, user_id, status,
             password_verifier, pending_verifier, change_state, change_origin,
             credential_version, encrypted_canonical, encryption_generation,
             encryption_nonce, failed_attempts, next_attempt_allowed_at,
             last_reset_requested_at, operation_id,
             candidate_user_id, reserved_until, saga_committed, locators,
             coordinator_locator, caller_token, created_at, updated_at
           ) VALUES (
             ?, ?, ?, ?, NULL, 'reserved',
             ?, NULL, NULL, NULL,
             0, ?, ?,
             ?, 0, NULL,
             ?, ?,
             ?, ?, NULL, ?,
             ?, ?, ?, ?
           )`,
          args.credentialId,
          args.kind,
          args.hmac,
          args.generation,
          args.passwordVerifier ?? null,
          args.sealedCanonical.ciphertext,
          args.sealedCanonical.generation,
          args.sealedCanonical.nonce,
          // `last_reset_requested_at` starts at `created_at`, not NULL. The
          // window-uniqueness invariant `recordResetRequested` maintains only
          // covers instants at which the row exists; a row born NULL is
          // immediately eligible, and an earlier request against the *same
          // address while it was unregistered* has already left a `send-mail`
          // row under this window's key — `send-mail` does not re-arm, so the
          // token would be minted with no job left to deliver it. Stamping the
          // row's own birth instant closes that gap: the first window in which
          // a fresh mapping can be eligible is the one after it was created,
          // and no request can have run in that window yet.
          timestamp,
          args.operationId,
          args.candidateUserId,
          args.reservedUntil,
          args.locators === undefined ? null : JSON.stringify(args.locators),
          args.coordinatorLocator ?? null,
          args.callerToken,
          timestamp,
          timestamp,
        );
      } catch (error) {
        // The pre-read above loses to a concurrent reservation of the same
        // canonical; the loser only finds out when the primary key fires. The
        // translation lives **here**, in the adapter, and not in the usecase:
        // with a synchronous commit the violation is raised in this very frame,
        // so there is no deferred flush to catch it further out.
        if (isConflictError(error) && error.code === "UNIQUE_VIOLATION") {
          throw alreadyRegistered(args.kind, error);
        }
        throw error;
      }
    },

    activate(
      kind: CredentialMappingKind,
      hmac: string,
      operationId: string,
      userId: string,
      callerToken: string,
    ): void {
      const row = one<{
        status: string;
        user_id: string | null;
        candidate_user_id: string | null;
        operation_id: string | null;
        caller_token: string | null;
      }>(
        sql,
        `SELECT status, user_id, candidate_user_id, operation_id, caller_token
           FROM credential_mappings WHERE kind = ? AND hmac = ?`,
        kind,
        hmac,
      );
      // Read-then-CAS rather than one statement, because `caller_token` has to
      // be compared in constant time and SQL cannot — the same shape `cancel`
      // and `delete` use. The whole method runs inside one `transactionSync`,
      // so nothing can interleave between the read and the update.
      if (row === null) throw notActivatable();
      if (row.operation_id !== operationId) throw notActivatable();
      if (!matchOpaque(row.caller_token, callerToken)) throw notActivatable();
      // Already promoted by this same operation: the phase is re-run by the
      // coordinator's alarm, so this has to be success rather than a conflict.
      if (row.status === "active" && row.user_id === userId) return;
      if (row.candidate_user_id !== userId) throw notActivatable();

      const updated = all(
        sql,
        `UPDATE credential_mappings
            SET status = 'active', user_id = ?, candidate_user_id = NULL,
                updated_at = ?
          WHERE kind = ? AND hmac = ? AND operation_id = ?
            AND candidate_user_id = ?
        RETURNING 1`,
        userId,
        now(),
        kind,
        hmac,
        operationId,
        userId,
      );
      if (updated.length === 0) throw notActivatable();
    },

    cancel(
      kind: CredentialMappingKind,
      hmac: string,
      operationId: string,
      callerToken: string,
    ): void {
      const row = one<{
        operation_id: string | null;
        caller_token: string | null;
      }>(
        sql,
        `SELECT operation_id, caller_token FROM credential_mappings
          WHERE kind = ? AND hmac = ?`,
        kind,
        hmac,
      );
      // "Absent is success" — recovery is retried, and a row somebody else
      // already cleaned up is the outcome this asked for.
      if (row === null) return;
      if (row.operation_id !== operationId) return;
      if (!matchOpaque(row.caller_token, callerToken)) return;
      // `status` is deliberately not in the predicate: a row already promoted
      // to `active` by a partially-completed saga is exactly what recovery has
      // to be able to remove.
      run(
        sql,
        "DELETE FROM credential_mappings WHERE kind = ? AND hmac = ? AND operation_id = ?",
        kind,
        hmac,
        operationId,
      );
    },

    beginChange(
      credentialId: CredentialId,
      pendingVerifier: string,
      origin: "password-change" | "reset",
      operationId: string,
    ): void {
      // `change_state IS NULL` is a predicate that really misses — a second
      // change started while one is in flight — and this write is the moment
      // the old material stops verifying. Zero rows therefore has to be a
      // conflict, not a quiet success that leaves the caller believing a
      // fail-closed window opened when it did not.
      const updated = all(
        sql,
        `UPDATE credential_mappings
            SET pending_verifier = ?, change_state = 'pending', change_origin = ?,
                operation_id = ?, updated_at = ?
          WHERE credential_id = ? AND change_state IS NULL
        RETURNING 1`,
        pendingVerifier,
        origin,
        operationId,
        now(),
        credentialId,
      );
      if (updated.length === 0) throw notStartable();
    },

    promote(credentialId: CredentialId, operationId: string): void {
      // `change_state = 'advanced'` only. Promoting while still `'pending'`
      // would make the new material authoritative before the User Data side
      // has moved, leaving the two permanently out of step.
      const updated = all(
        sql,
        `UPDATE credential_mappings
            SET password_verifier = pending_verifier, pending_verifier = NULL,
                change_state = NULL, change_origin = NULL,
                credential_version = credential_version + 1,
                failed_attempts = 0, next_attempt_allowed_at = NULL,
                updated_at = ?
          WHERE credential_id = ? AND operation_id = ? AND change_state = 'advanced'
        RETURNING 1`,
        now(),
        credentialId,
        operationId,
      );
      if (updated.length === 0) {
        throw new ConflictError(
          "CREDENTIAL_CHANGE_NOT_ADVANCED",
          "No credential change is ready to be promoted",
        );
      }
    },

    delete(credentialId: CredentialId, callerToken: string): void {
      const row = one<{ caller_token: string | null }>(
        sql,
        "SELECT caller_token FROM credential_mappings WHERE credential_id = ?",
        credentialId,
      );
      if (row === null) return;
      if (!matchOpaque(row.caller_token, callerToken)) return;
      run(
        sql,
        "DELETE FROM credential_mappings WHERE credential_id = ?",
        credentialId,
      );
      run(
        sql,
        "DELETE FROM password_reset_tokens WHERE credential_id = ?",
        credentialId,
      );
    },

    reportResult(kind: CredentialMappingKind, hmac: string, ok: boolean): void {
      // A locator naming no row in this bucket updates nothing and still
      // reports success: creating a row would make an unauthenticated caller
      // able to grow the table, and refusing would tell them the canonical is
      // unregistered.
      if (ok) {
        run(
          sql,
          `UPDATE credential_mappings
              SET failed_attempts = 0, next_attempt_allowed_at = NULL, updated_at = ?
            WHERE kind = ? AND hmac = ?`,
          now(),
          kind,
          hmac,
        );
        return;
      }
      // Attempts made while already throttled do not advance the counter —
      // without that, an attacker refreshes the lockout indefinitely and the
      // ceiling and decay rules below stop meaning anything. The ceiling and
      // the decay curve themselves are #18.
      run(
        sql,
        `UPDATE credential_mappings
            SET failed_attempts = failed_attempts + 1,
                next_attempt_allowed_at = ?,
                updated_at = ?
          WHERE kind = ? AND hmac = ?
            AND (next_attempt_allowed_at IS NULL OR next_attempt_allowed_at <= ?)`,
        now() + FAILED_ATTEMPT_BACKOFF_MS,
        now(),
        kind,
        hmac,
        now(),
      );
    },

    recordResetRequested(
      kind: CredentialMappingKind,
      hmac: string,
      at: number,
    ): void {
      // Unconditional on the row's state, and that is what makes the reset
      // request's `operationKey` window-unique: because every request — not
      // only the eligible ones — leaves its own instant here, an eligible
      // request's window number is provably greater than that of any request
      // before it, so no row can already exist under the key it enqueues. Do
      // not "optimise" this into an eligible-only write.
      //
      // It is safe against the lockout the sliding form used to allow, because
      // eligibility compares window numbers rather than elapsed time
      // (`domain/identity/credentialMappingRules.ts`).
      run(
        sql,
        `UPDATE credential_mappings
            SET last_reset_requested_at = ?, updated_at = ?
          WHERE kind = ? AND hmac = ?`,
        at,
        now(),
        kind,
        hmac,
      );
    },
  };
}

/**
 * Placeholder throttle window. The ceiling, the decay and the real numbers are
 * #18; what #37 owns is the column and the update point.
 */
const FAILED_ATTEMPT_BACKOFF_MS = 30_000;

/**
 * One answer for every way the promotion can fail to match.
 *
 * Not split by cause on purpose: the caller is a saga phase that can only
 * abort, and a message distinguishing "no such reservation" from "wrong caller
 * token" would report on a bucket's contents to whoever could reach the entry.
 */
function notActivatable(): ConflictError {
  return new ConflictError(
    "RESERVATION_NOT_ACTIVATABLE",
    "No matching reservation could be activated",
  );
}

/**
 * One answer for both ways `beginChange` can miss — no such credential, and a
 * change already in flight — for the same reason `notActivatable` is undivided:
 * splitting them would report on a bucket's contents. #12 owns the entry that
 * calls this and may narrow the answer there, where the caller is authenticated.
 */
function notStartable(): ConflictError {
  return new ConflictError(
    "CREDENTIAL_CHANGE_NOT_STARTABLE",
    "No credential change could be started",
  );
}

function alreadyRegistered(
  kind: CredentialMappingKind,
  cause?: unknown,
): ConflictError {
  return kind === "email"
    ? new ConflictError(
        "EMAIL_ALREADY_REGISTERED",
        "That email address is already registered",
        cause,
      )
    : new ConflictError(
        "SSO_IDENTITY_ALREADY_REGISTERED",
        "That SSO identity is already registered",
        cause,
      );
}
