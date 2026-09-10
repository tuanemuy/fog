import type { MappingRowDto } from "@repo/core/application/identity/rotation/transfer";
import type { CredentialKind } from "@repo/core/domain/identity/ports/credentialMappingRepository";
import { updateMatchedRow } from "../rowRunner";
import { SQL_MAX_BIND_PARAMETERS } from "../stores/bindChunks";

/**
 * The whole-row reads and writes the mapping-key transfer needs on
 * `credential_mappings`. Neither goes through the unit-of-work writers:
 * the transfer, like the expiry sweep, acts on rows as an adapter
 * (`spec/database/index.md`, `credential_mappings`), and it is the only
 * path that copies a row across buckets verbatim.
 */

type MappingRow = Readonly<{
  credential_id: string;
  kind: CredentialKind;
  hmac: string;
  generation: number;
  user_id: string | null;
  status: "reserved" | "active";
  password_verifier: string | null;
  pending_verifier: string | null;
  change_state: "pending" | "advanced" | null;
  change_origin: "password-change" | "reset" | null;
  credential_version: number;
  encrypted_canonical: string;
  encryption_generation: number;
  encryption_nonce: string;
  failed_attempts: number;
  next_attempt_allowed_at: number | null;
  operation_id: string | null;
  candidate_user_id: string | null;
  reserved_until: number;
  saga_committed: number | null;
  locators: string | null;
  coordinator_locator: string | null;
  caller_token: string;
  created_at: number;
  updated_at: number;
}>;

const COLUMNS = [
  "credential_id",
  "kind",
  "hmac",
  "generation",
  "user_id",
  "status",
  "password_verifier",
  "pending_verifier",
  "change_state",
  "change_origin",
  "credential_version",
  "encrypted_canonical",
  "encryption_generation",
  "encryption_nonce",
  "failed_attempts",
  "next_attempt_allowed_at",
  "operation_id",
  "candidate_user_id",
  "reserved_until",
  "saga_committed",
  "locators",
  "coordinator_locator",
  "caller_token",
  "created_at",
  "updated_at",
] as const;

export const MAPPING_COLUMN_COUNT = COLUMNS.length;

/**
 * Rows one `import-remapped-mappings` call may carry: the bind ceiling
 * divided by the row's column count (PH-09 △-18). `remap-chunk` sends one
 * row per call and never reaches it; it bounds a caller that batches.
 */
export const IMPORT_ROWS_PER_CALL = Math.floor(
  SQL_MAX_BIND_PARAMETERS / (MAPPING_COLUMN_COUNT + 2),
);

const SELECT = `SELECT ${COLUMNS.join(", ")} FROM credential_mappings`;

function toDto(row: MappingRow): MappingRowDto {
  return {
    credentialId: row.credential_id,
    kind: row.kind,
    hmac: row.hmac,
    generation: row.generation,
    userId: row.user_id,
    status: row.status,
    passwordVerifier: row.password_verifier,
    pendingVerifier: row.pending_verifier,
    changeState: row.change_state,
    changeOrigin: row.change_origin,
    credentialVersion: row.credential_version,
    encryptedCanonical: row.encrypted_canonical,
    encryptionGeneration: row.encryption_generation,
    encryptionNonce: row.encryption_nonce,
    failedAttempts: row.failed_attempts,
    nextAttemptAllowedAt: row.next_attempt_allowed_at,
    operationId: row.operation_id,
    candidateUserId: row.candidate_user_id,
    reservedUntil: row.reserved_until,
    sagaCommitted: row.saga_committed,
    locators: row.locators,
    coordinatorLocator: row.coordinator_locator,
    callerToken: row.caller_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function bindingsOf(row: MappingRowDto): SqlStorageValue[] {
  return [
    row.credentialId,
    row.kind,
    row.hmac,
    row.generation,
    row.userId,
    row.status,
    row.passwordVerifier,
    row.pendingVerifier,
    row.changeState,
    row.changeOrigin,
    row.credentialVersion,
    row.encryptedCanonical,
    row.encryptionGeneration,
    row.encryptionNonce,
    row.failedAttempts,
    row.nextAttemptAllowedAt,
    row.operationId,
    row.candidateUserId,
    row.reservedUntil,
    row.sagaCommitted,
    row.locators,
    row.coordinatorLocator,
    row.callerToken,
    row.createdAt,
    row.updatedAt,
  ];
}

/** The scan of s1: `credential_id` ascending from the exclusive cursor, `cm_credential_id_uq` resolves it. */
export function selectMappingRowsAfter(
  sql: SqlStorage,
  afterCredentialId: string | null,
  limit: number,
): MappingRowDto[] {
  const rows =
    afterCredentialId === null
      ? sql
          .exec<MappingRow>(`${SELECT} ORDER BY credential_id LIMIT ?`, limit)
          .toArray()
      : sql
          .exec<MappingRow>(
            `${SELECT} WHERE credential_id > ? ORDER BY credential_id LIMIT ?`,
            afterCredentialId,
            limit,
          )
          .toArray();
  return rows.map(toDto);
}

export function readMappingRowByKey(
  sql: SqlStorage,
  kind: CredentialKind,
  hmac: string,
): MappingRowDto | null {
  const row = sql
    .exec<MappingRow>(`${SELECT} WHERE kind = ? AND hmac = ?`, kind, hmac)
    .toArray()[0];
  return row ? toDto(row) : null;
}

export function countMappingRows(sql: SqlStorage): number {
  return sql
    .exec<{ n: number }>("SELECT count(*) AS n FROM credential_mappings")
    .one().n;
}

/**
 * Verdict (a): the conditional insert. The condition is spelled in the
 * statement rather than left to the primary key, so a row that appeared
 * between the judgement and the write is a miss to re-judge, not a
 * constraint violation to translate.
 */
export function insertMappingRowIfAbsent(
  sql: SqlStorage,
  row: MappingRowDto,
): boolean {
  return updateMatchedRow(
    sql,
    `INSERT INTO credential_mappings (${COLUMNS.join(", ")})
     SELECT ${COLUMNS.map(() => "?").join(", ")}
     WHERE NOT EXISTS (SELECT 1 FROM credential_mappings WHERE kind = ? AND hmac = ?)`,
    ...bindingsOf(row),
    row.kind,
    row.hmac,
  );
}

/**
 * Verdicts (c) / (d): predicate 1 of `spec/rotation/index.md` —
 * `status = 'active' AND change_state IS NULL AND credential_version =
 * <the destination's read value>`. Neither abuse counter is in it.
 */
export function overwriteMappingRowIfUnchanged(
  sql: SqlStorage,
  row: MappingRowDto,
  expectedCredentialVersion: number,
): boolean {
  const assignable = COLUMNS.filter((c) => c !== "kind" && c !== "hmac");
  const values = bindingsOf(row);
  const assignments = assignable.map((c) => `${c} = ?`).join(", ");
  const bindings = COLUMNS.flatMap((c, i) =>
    c === "kind" || c === "hmac" ? [] : [values[i] ?? null],
  );
  return updateMatchedRow(
    sql,
    `UPDATE credential_mappings SET ${assignments}
     WHERE kind = ? AND hmac = ? AND status = 'active' AND change_state IS NULL AND credential_version = ?`,
    ...bindings,
    row.kind,
    row.hmac,
    expectedCredentialVersion,
  );
}

/**
 * s5: predicate 2 — the source row goes only if its authentication state
 * is the one s1 read; the credential's reset tokens go with it in the
 * same transaction (the caller's). `false` leaves the row for the next
 * chunk to re-judge.
 */
export function deleteSourceRowIfUnchanged(
  sql: SqlStorage,
  row: MappingRowDto,
): boolean {
  const deleted = updateMatchedRow(
    sql,
    `DELETE FROM credential_mappings
     WHERE kind = ? AND hmac = ? AND status = 'active' AND change_state IS NULL AND credential_version = ?`,
    row.kind,
    row.hmac,
    row.credentialVersion,
  );
  if (deleted) {
    sql.exec(
      "DELETE FROM password_reset_tokens WHERE credential_id = ?",
      row.credentialId,
    );
  }
  return deleted;
}
