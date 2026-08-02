import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  CredentialChangeState,
  CredentialMapping,
  CredentialMappingKind,
  CredentialMappingRepository,
  CredentialMappingStatus,
} from "@repo/core/domain/identity/ports/credentialMappingRepository";
import type { CredentialId } from "@repo/core/domain/identity/valueObject";
import { exists, one, type Sql } from "../sql/exec";

/**
 * Reads against `credential_mappings`.
 *
 * ## Why the signature is `(kind, hmac)` and not `(email)` / `(provider, subject)`
 *
 * `spec/domains/identity.md` defines the port as `findByEmail(email: Email)` and
 * `findBySsoIdentity(provider, providerSubject)`. **That is the contract as the
 * request Worker sees it, and it cannot be implemented here.** Rows are keyed by
 * `(kind, full-length hmac)`, and deriving that HMAC needs
 * `DIRECTORY_ROUTING_SECRET`, which is distributed to the request Worker only.
 * Shipping the routing secret to the state Worker so this signature could be
 * honoured literally would break the non-duplicated-distribution rule — the very
 * property that keeps a raw address from being reconstructable inside a bucket.
 *
 * The responsibilities therefore split at the boundary: **canonicalisation
 * (`Email.create` / `ssoCanonical`) and HMAC derivation
 * (`directoryLocator.forCanonical`) run in the request Worker; resolving a row
 * from `(kind, hmac)` runs here** (ADR-016). The email / SSO distinction is not
 * lost — it survives as the `kind` argument, supplied by the side that knows
 * which canonical it built.
 */
export function createCredentialMappingRepository(
  sql: Sql,
): CredentialMappingRepository {
  return {
    findByLocatorKey(
      kind: CredentialMappingKind,
      hmac: string,
    ): CredentialMapping | null {
      const row = one<MappingRow>(
        sql,
        `SELECT ${COLUMNS} FROM credential_mappings WHERE kind = ? AND hmac = ?`,
        kind,
        hmac,
      );
      return row === null ? null : toMapping(row);
    },

    findByCredentialId(credentialId: CredentialId): CredentialMapping | null {
      const row = one<MappingRow>(
        sql,
        `SELECT ${COLUMNS} FROM credential_mappings WHERE credential_id = ?`,
        credentialId,
      );
      return row === null ? null : toMapping(row);
    },

    checkPreviousGeneration(
      kind: CredentialMappingKind,
      hmac: string,
    ): boolean {
      // One bit, no side effect. Deliberately carries no additional binding:
      // computing the locator already requires the routing secret, and the
      // answer discloses no more than throwing one signup at the bucket would.
      return exists(
        sql,
        "SELECT 1 FROM credential_mappings WHERE kind = ? AND hmac = ?",
        kind,
        hmac,
      );
    },
  };
}

const COLUMNS = `credential_id, kind, hmac, generation, user_id, candidate_user_id,
       status, password_verifier, credential_version, change_state, change_origin,
       failed_attempts, next_attempt_allowed_at, last_reset_requested_at,
       operation_id, caller_token, reserved_until, saga_committed`;

type MappingRow = {
  credential_id: string;
  kind: string;
  hmac: string;
  generation: number;
  user_id: string | null;
  candidate_user_id: string | null;
  status: string;
  password_verifier: string | null;
  credential_version: number;
  change_state: string | null;
  change_origin: string | null;
  failed_attempts: number;
  next_attempt_allowed_at: number | null;
  last_reset_requested_at: number | null;
  operation_id: string | null;
  caller_token: string | null;
  reserved_until: number;
  saga_committed: number | null;
};

function toMapping(row: MappingRow): CredentialMapping {
  if (row.kind !== "email" && row.kind !== "sso") {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "Stored credential mapping kind is outside its domain",
    );
  }
  if (row.status !== "reserved" && row.status !== "active") {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "Stored credential mapping status is outside its domain",
    );
  }
  return {
    credentialId: row.credential_id as CredentialId,
    userId: row.user_id,
    candidateUserId: row.candidate_user_id,
    kind: row.kind as CredentialMappingKind,
    status: row.status as CredentialMappingStatus,
    passwordVerifier: row.password_verifier,
    credentialVersion: row.credential_version,
    changeState: row.change_state as CredentialChangeState,
    changeOrigin: row.change_origin as "password-change" | "reset" | null,
    failedAttempts: row.failed_attempts,
    nextAttemptAllowedAt: row.next_attempt_allowed_at,
    lastResetRequestedAt: row.last_reset_requested_at,
    operationId: row.operation_id,
    callerToken: row.caller_token,
    reservedUntil: row.reserved_until,
    sagaCommitted: row.saga_committed !== null,
    generation: row.generation,
    hmac: row.hmac,
  };
}
