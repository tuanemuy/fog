import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  CredentialLocator,
  CredentialLocatorStore,
} from "@repo/core/domain/identity/ports/credentialLocatorStore";
import type { CredentialId } from "@repo/core/domain/identity/valueObject";
import { all, one, run, type Sql } from "../sql/exec";

type LocatorRow = {
  credential_id: string;
  kind: string;
  hmac: string;
  generation: number;
  bucket_index: number;
  credential_version: number;
  usable_for_login: number;
  label: string;
};

function toLocator(row: LocatorRow): CredentialLocator {
  if (row.kind !== "email" && row.kind !== "sso") {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "Stored credential locator kind is outside its domain",
    );
  }
  return {
    credentialId: row.credential_id as CredentialId,
    kind: row.kind,
    hmac: row.hmac,
    generation: row.generation,
    bucketIndex: row.bucket_index,
    credentialVersion: row.credential_version,
    usableForLogin: row.usable_for_login === 1,
    label: row.label,
  };
}

const SELECT_COLUMNS = `credential_id, kind, hmac, generation, bucket_index,
       credential_version, usable_for_login, label`;

/**
 * `credential_locators` — the authority for login's reachability check.
 *
 * The three mutating methods are all keyed by `credential_id` alone, never by
 * `(credential_id, generation)`, so each of them reaches every generation of
 * that credential in one statement. Touching a single generation would leave a
 * disagreement with the Identity Directory that nothing later reconciles.
 */
export function createCredentialLocatorStore(
  sql: Sql,
  now: () => number,
): CredentialLocatorStore {
  return {
    list(): readonly CredentialLocator[] {
      return all<LocatorRow>(
        sql,
        `SELECT ${SELECT_COLUMNS} FROM credential_locators
          WHERE status = 'active'
          ORDER BY credential_id, generation`,
      ).map(toLocator);
    },

    findByCredentialId(credentialId: CredentialId): CredentialLocator | null {
      const row = one<LocatorRow>(
        sql,
        `SELECT ${SELECT_COLUMNS} FROM credential_locators
          WHERE credential_id = ? AND status = 'active'
          ORDER BY generation DESC`,
        credentialId,
      );
      return row === null ? null : toLocator(row);
    },

    record(locator: CredentialLocator): void {
      const timestamp = now();
      // Upsert on `(credential_id, generation)`. `credential_version` takes the
      // larger of the two values so it stays monotonically non-decreasing per
      // credential; `usable_for_login` and `label` are overwritten because the
      // Directory decides them. **Never a no-op on conflict** — a skipped
      // record locks the user out at the next reachability check.
      run(
        sql,
        `INSERT INTO credential_locators (
           credential_id, kind, hmac, generation, bucket_index,
           credential_version, status, usable_for_login, label,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
         ON CONFLICT (credential_id, generation) DO UPDATE SET
           kind = excluded.kind,
           hmac = excluded.hmac,
           bucket_index = excluded.bucket_index,
           credential_version = max(credential_locators.credential_version, excluded.credential_version),
           usable_for_login = excluded.usable_for_login,
           label = excluded.label,
           updated_at = excluded.updated_at`,
        locator.credentialId,
        locator.kind,
        locator.hmac,
        locator.generation,
        locator.bucketIndex,
        locator.credentialVersion,
        locator.usableForLogin ? 1 : 0,
        locator.label,
        timestamp,
        timestamp,
      );
    },

    advanceCredentialVersion(credentialId: CredentialId): void {
      run(
        sql,
        `UPDATE credential_locators
            SET credential_version = credential_version + 1, updated_at = ?
          WHERE credential_id = ?`,
        now(),
        credentialId,
      );
    },

    deleteByCredentialId(credentialId: CredentialId): void {
      run(
        sql,
        "DELETE FROM credential_locators WHERE credential_id = ?",
        credentialId,
      );
    },
  };
}
