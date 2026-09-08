import {
  ConflictError,
  SystemError,
  SystemErrorCode,
} from "@repo/core/application/errors";
import { CALLER_TOKEN_MIN_LENGTH } from "@repo/core/application/identity/callerToken";
import type {
  CredentialAttemptRecorder,
  CredentialKind,
  CredentialMappingReader,
  CredentialMappingRecord,
  CredentialMappingWriter,
} from "@repo/core/domain/identity/ports/credentialMappingRepository";
import {
  CredentialId,
  PasswordHash,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { decodeMapping } from "../crypto/locatorDerivation";
import { updateMatchedRow } from "../rowRunner";

type MappingRow = Readonly<{
  credential_id: string;
  kind: CredentialKind;
  hmac: string;
  generation: number;
  user_id: string | null;
  status: "reserved" | "active";
  password_verifier: string | null;
  change_state: "pending" | "advanced" | null;
  change_origin: "password-change" | "reset" | null;
  credential_version: number;
  encrypted_canonical: string;
  encryption_generation: number;
  encryption_nonce: string;
  failed_attempts: number;
  next_attempt_allowed_at: number | null;
}>;

const SELECT = `SELECT credential_id, kind, hmac, generation, user_id, status, password_verifier,
  change_state, change_origin, credential_version, encrypted_canonical, encryption_generation,
  encryption_nonce, failed_attempts, next_attempt_allowed_at FROM credential_mappings`;

function toRecord(row: MappingRow): CredentialMappingRecord {
  return {
    credentialId: CredentialId.create(row.credential_id),
    userId: row.user_id === null ? null : UserId.create(row.user_id),
    kind: row.kind,
    usableForLogin: row.kind === "sso" || row.password_verifier !== null,
    credentialVersion: row.credential_version,
    changeState: row.change_state,
    changeOrigin: row.change_origin,
    failedAttempts: row.failed_attempts,
    nextAttemptAllowedAt:
      row.next_attempt_allowed_at === null
        ? null
        : new Date(row.next_attempt_allowed_at),
    passwordVerifier:
      row.password_verifier === null
        ? null
        : PasswordHash.create(row.password_verifier),
    sealedCanonical: {
      ciphertext: row.encrypted_canonical,
      encryptionGeneration: row.encryption_generation,
      nonce: row.encryption_nonce,
    },
  };
}

function hmacOf(kind: CredentialKind, mapping: string): string {
  const derived = decodeMapping(kind, mapping);
  if (derived === null) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "The credential coordinate carries an unreadable mapping",
    );
  }
  return derived.hmac;
}

export function createCredentialMappingReader(
  sql: SqlStorage,
): CredentialMappingReader {
  return {
    findByLocator(kind, mapping) {
      const row = sql
        .exec<MappingRow>(
          `${SELECT} WHERE kind = ? AND hmac = ?`,
          kind,
          hmacOf(kind, mapping),
        )
        .toArray()[0];
      return row ? toRecord(row) : null;
    },
    findByCredentialId(credentialId) {
      const row = sql
        .exec<MappingRow>(`${SELECT} WHERE credential_id = ?`, credentialId)
        .toArray()[0];
      return row ? toRecord(row) : null;
    },
  };
}

/** The `(kind, hmac)` of a credential's row: what a coordinate needs beyond the bucket itself. */
export function readMappingCoordinate(
  sql: SqlStorage,
  credentialId: string,
): { kind: CredentialKind; hmac: string } | null {
  const row = sql
    .exec<{ kind: CredentialKind; hmac: string }>(
      "SELECT kind, hmac FROM credential_mappings WHERE credential_id = ?",
      credentialId,
    )
    .toArray()[0];
  return row ?? null;
}

/** The bucket's own `userId` listing for the diagnostics entry and the withdrawal path. */
export function listMappedUserIds(sql: SqlStorage): string[] {
  return sql
    .exec<{ user_id: string }>(
      "SELECT DISTINCT user_id FROM credential_mappings WHERE user_id IS NOT NULL ORDER BY user_id",
    )
    .toArray()
    .map((row) => row.user_id);
}

/**
 * The six procedure stages, each one CAS statement. `reserveCredential` is
 * the only stage that translates a miss into `ConflictError`: a live row for
 * the same canonical is the definition of "already registered", while the
 * same operation re-sent converges onto its own row.
 */
export function createCredentialMappingWriter(
  sql: SqlStorage,
  now: () => number,
): CredentialMappingWriter {
  return {
    reserveCredential(params) {
      const { coordinate } = params;
      const derived = decodeMapping(coordinate.kind, coordinate.mapping);
      if (derived === null) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "The credential coordinate carries an unreadable mapping",
        );
      }
      const existing = sql
        .exec<{ operation_id: string | null; credential_id: string }>(
          "SELECT operation_id, credential_id FROM credential_mappings WHERE kind = ? AND hmac = ?",
          coordinate.kind,
          derived.hmac,
        )
        .toArray()[0];
      if (existing) {
        if (
          existing.operation_id === params.operationId &&
          existing.credential_id === coordinate.credentialId
        ) {
          return;
        }
        throw new ConflictError(
          "EMAIL_ALREADY_REGISTERED",
          "This email address is already registered",
        );
      }
      const at = now();
      const locators =
        params.coordinator.role === "coordinator"
          ? JSON.stringify(params.coordinator.locators)
          : null;
      const coordinatorLocator =
        params.coordinator.role === "member"
          ? params.coordinator.coordinatorLocator
          : null;
      sql.exec(
        `INSERT INTO credential_mappings
           (credential_id, kind, hmac, generation, user_id, status, password_verifier,
            pending_verifier, change_state, change_origin, credential_version,
            encrypted_canonical, encryption_generation, encryption_nonce,
            failed_attempts, next_attempt_allowed_at, operation_id, candidate_user_id,
            reserved_until, saga_committed, locators, coordinator_locator, caller_token,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'reserved', ?, NULL, NULL, NULL, 1, ?, ?, ?, 0, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        coordinate.credentialId,
        coordinate.kind,
        derived.hmac,
        derived.generation,
        params.passwordVerifier,
        params.sealedCanonical.ciphertext,
        params.sealedCanonical.encryptionGeneration,
        params.sealedCanonical.nonce,
        params.operationId,
        params.candidateUserId,
        params.reservedUntil.getTime(),
        locators,
        coordinatorLocator,
        params.callerToken,
        at,
        at,
      );
    },

    commitSaga(params) {
      const { coordinate } = params;
      return updateMatchedRow(
        sql,
        `UPDATE credential_mappings
           SET saga_committed = 1, updated_at = ?
         WHERE kind = ? AND hmac = ? AND credential_id = ? AND operation_id = ?
           AND status IN ('reserved', 'active')`,
        now(),
        coordinate.kind,
        hmacOf(coordinate.kind, coordinate.mapping),
        coordinate.credentialId,
        params.operationId,
      );
    },

    activateReservation(params) {
      const { coordinate } = params;
      return updateMatchedRow(
        sql,
        `UPDATE credential_mappings
           SET status = 'active', user_id = ?, updated_at = ?
         WHERE kind = ? AND hmac = ? AND credential_id = ? AND operation_id = ?
           AND (status = 'reserved' OR (status = 'active' AND user_id = ?))`,
        params.userId,
        now(),
        coordinate.kind,
        hmacOf(coordinate.kind, coordinate.mapping),
        coordinate.credentialId,
        params.operationId,
        params.userId,
      );
    },

    beginCredentialChange(params) {
      const { coordinate } = params;
      const hmac = hmacOf(coordinate.kind, coordinate.mapping);
      const at = now();
      let matched: boolean;
      if (params.origin === "reset") {
        // Bound to the one-shot bearer the token consumption minted:
        // `value → NULL`, so a second change on the same consumption misses.
        if (
          params.changeAuthToken === null ||
          params.changeAuthToken.length < CALLER_TOKEN_MIN_LENGTH
        ) {
          return false;
        }
        const authorised = updateMatchedRow(
          sql,
          `UPDATE password_reset_tokens SET change_auth_token = NULL
           WHERE credential_id = ? AND change_auth_token = ?`,
          coordinate.credentialId,
          params.changeAuthToken,
        );
        if (!authorised) return false;
        matched = updateMatchedRow(
          sql,
          `UPDATE credential_mappings
             SET pending_verifier = ?, change_state = 'pending', change_origin = 'reset',
                 operation_id = ?, updated_at = ?
           WHERE kind = ? AND hmac = ? AND credential_id = ? AND status = 'active'
             AND password_verifier IS NOT NULL`,
          params.pendingVerifier,
          params.operationId,
          at,
          coordinate.kind,
          hmac,
          coordinate.credentialId,
        );
      } else {
        matched = updateMatchedRow(
          sql,
          `UPDATE credential_mappings
             SET pending_verifier = ?, change_state = 'pending', change_origin = 'password-change',
                 operation_id = ?, updated_at = ?
           WHERE kind = ? AND hmac = ? AND credential_id = ? AND status = 'active'
             AND password_verifier IS NOT NULL AND change_state IS NULL`,
          params.pendingVerifier,
          params.operationId,
          at,
          coordinate.kind,
          hmac,
          coordinate.credentialId,
        );
      }
      if (!matched) return false;
      // The credential's unused links die with the change; used rows keep
      // their record but lose the bearer.
      sql.exec(
        "DELETE FROM password_reset_tokens WHERE credential_id = ? AND used_at IS NULL",
        coordinate.credentialId,
      );
      sql.exec(
        "UPDATE password_reset_tokens SET change_auth_token = NULL WHERE credential_id = ?",
        coordinate.credentialId,
      );
      return true;
    },

    markCredentialChangeAdvanced(params) {
      const { coordinate } = params;
      return updateMatchedRow(
        sql,
        `UPDATE credential_mappings SET change_state = 'advanced', updated_at = ?
         WHERE kind = ? AND hmac = ? AND credential_id = ?
           AND change_state = 'pending' AND operation_id = ?`,
        now(),
        coordinate.kind,
        hmacOf(coordinate.kind, coordinate.mapping),
        coordinate.credentialId,
        params.operationId,
      );
    },

    promoteVerifier(params) {
      const { coordinate } = params;
      return updateMatchedRow(
        sql,
        `UPDATE credential_mappings
           SET password_verifier = pending_verifier, pending_verifier = NULL,
               change_state = NULL, change_origin = NULL,
               credential_version = ?, failed_attempts = 0, next_attempt_allowed_at = NULL,
               updated_at = ?
         WHERE kind = ? AND hmac = ? AND credential_id = ?
           AND change_state = 'advanced' AND operation_id = ? AND pending_verifier IS NOT NULL`,
        params.credentialVersion,
        now(),
        coordinate.kind,
        hmacOf(coordinate.kind, coordinate.mapping),
        coordinate.credentialId,
        params.operationId,
      );
    },

    deleteMapping(params) {
      const { coordinate } = params;
      if (params.callerToken.length < CALLER_TOKEN_MIN_LENGTH) return;
      sql.exec(
        `DELETE FROM credential_mappings
         WHERE kind = ? AND hmac = ? AND credential_id = ? AND user_id = ? AND caller_token = ?`,
        coordinate.kind,
        hmacOf(coordinate.kind, coordinate.mapping),
        coordinate.credentialId,
        params.userId,
        params.callerToken,
      );
      sql.exec(
        "DELETE FROM password_reset_tokens WHERE credential_id = ?",
        coordinate.credentialId,
      );
    },

    cancelReservation(params) {
      const { coordinate } = params;
      if (params.callerToken.length < CALLER_TOKEN_MIN_LENGTH) return;
      sql.exec(
        `DELETE FROM credential_mappings
         WHERE kind = ? AND hmac = ? AND credential_id = ? AND caller_token = ?`,
        coordinate.kind,
        hmacOf(coordinate.kind, coordinate.mapping),
        coordinate.credentialId,
        params.callerToken,
      );
      sql.exec(
        "DELETE FROM password_reset_tokens WHERE credential_id = ?",
        coordinate.credentialId,
      );
    },
  };
}

/**
 * The seventh write. Success resets in the statement; failure is a CAS on the
 * observed counter with the fall-through `spec/domains/identity.md` fixes.
 */
export function createCredentialAttemptRecorder(
  sql: SqlStorage,
  now: () => number,
): CredentialAttemptRecorder {
  return {
    recordAttemptOutcome(coordinate, outcome) {
      const hmac = hmacOf(coordinate.kind, coordinate.mapping);
      const at = now();
      if (outcome.outcome === "success") {
        sql.exec(
          `UPDATE credential_mappings SET failed_attempts = 0, next_attempt_allowed_at = NULL, updated_at = ?
           WHERE kind = ? AND hmac = ? AND credential_id = ?`,
          at,
          coordinate.kind,
          hmac,
          coordinate.credentialId,
        );
        return;
      }
      const reported = outcome.nextAttemptAllowedAt?.getTime() ?? null;
      const matched = updateMatchedRow(
        sql,
        `UPDATE credential_mappings SET failed_attempts = ?, next_attempt_allowed_at = ?, updated_at = ?
         WHERE kind = ? AND hmac = ? AND credential_id = ? AND failed_attempts = ?`,
        outcome.failedAttempts,
        reported,
        at,
        coordinate.kind,
        hmac,
        coordinate.credentialId,
        outcome.observedFailedAttempts,
      );
      if (matched) return;
      sql.exec(
        `UPDATE credential_mappings
           SET failed_attempts = failed_attempts + 1,
               next_attempt_allowed_at = CASE
                 WHEN ? IS NULL THEN next_attempt_allowed_at
                 WHEN next_attempt_allowed_at IS NULL THEN ?
                 ELSE max(next_attempt_allowed_at, ?)
               END,
               updated_at = ?
         WHERE kind = ? AND hmac = ? AND credential_id = ?`,
        reported,
        reported,
        reported,
        at,
        coordinate.kind,
        hmac,
        coordinate.credentialId,
      );
    },
  };
}
