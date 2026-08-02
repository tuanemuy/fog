import { ConflictError, isConflictError } from "@repo/core/application/errors";
import type { CredentialMappingKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type {
  CredentialMappingStore,
  ReserveCredentialArgs,
} from "@repo/core/domain/identity/ports/credentialMappingStore";
import type { CredentialId } from "@repo/core/domain/identity/valueObject";
import { one, run, type Sql } from "../sql/exec";
import { matchOpaque } from "./opaqueBinding";

/**
 * The seven writes against `credential_mappings`.
 *
 * Every one is a CAS conditioned on `operationId`, `payloadDigest`, `status` or
 * `changeState`. **None uses `conditionalUpdate`**: that helper is the OCC
 * guard, and this table has no `version` column — those CAS predicates already
 * serialise writes to a row, and adding a generic OCC on top would make two
 * things authoritative at once.
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
             NULL, ?,
             ?, ?, NULL, ?,
             ?, ?, ?, ?
           )`,
          args.credentialId,
          args.kind,
          args.hmac,
          args.generation,
          args.passwordVerifier ?? null,
          args.encryptedCanonical ?? null,
          args.encryptionGeneration ?? null,
          args.encryptionNonce ?? null,
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
    ): void {
      run(
        sql,
        `UPDATE credential_mappings
            SET status = 'active', user_id = ?, candidate_user_id = NULL,
                updated_at = ?
          WHERE kind = ? AND hmac = ? AND operation_id = ?`,
        userId,
        now(),
        kind,
        hmac,
        operationId,
      );
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
      run(
        sql,
        `UPDATE credential_mappings
            SET pending_verifier = ?, change_state = 'pending', change_origin = ?,
                operation_id = ?, updated_at = ?
          WHERE credential_id = ? AND change_state IS NULL`,
        pendingVerifier,
        origin,
        operationId,
        now(),
        credentialId,
      );
    },

    promote(credentialId: CredentialId, operationId: string): void {
      // `change_state = 'advanced'` only. Promoting while still `'pending'`
      // would make the new material authoritative before the User Data side
      // has moved, leaving the two permanently out of step.
      run(
        sql,
        `UPDATE credential_mappings
            SET password_verifier = pending_verifier, pending_verifier = NULL,
                change_state = NULL, change_origin = NULL,
                credential_version = credential_version + 1,
                failed_attempts = 0, next_attempt_allowed_at = NULL,
                updated_at = ?
          WHERE credential_id = ? AND operation_id = ? AND change_state = 'advanced'`,
        now(),
        credentialId,
        operationId,
      );
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
      // Unconditional on the row's state: it must run for a throttled request
      // too, or a caller could hold the window open by retrying.
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
