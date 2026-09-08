import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { CredentialRefInput } from "@repo/core/domain/identity/entity";
import type {
  CredentialLocator,
  CredentialLocatorStore,
} from "@repo/core/domain/identity/ports/credentialLocatorStore";
import { CredentialId } from "@repo/core/domain/identity/valueObject";
import { decodeMapping, encodeMapping } from "../crypto/locatorDerivation";

type LocatorRow = Readonly<{
  credential_id: string;
  kind: "email" | "sso";
  hmac: string;
  generation: number;
  bucket_index: number;
  credential_version: number;
  usable_for_login: number;
  label: string;
}>;

function toLocator(row: LocatorRow): CredentialLocator {
  return {
    credentialId: CredentialId.create(row.credential_id),
    kind: row.kind,
    mapping: encodeMapping({
      kind: row.kind,
      hmac: row.hmac,
      generation: row.generation,
      bucketIndex: row.bucket_index,
    }),
    credentialVersion: row.credential_version,
    usableForLogin: row.usable_for_login === 1,
    label: row.label,
  };
}

const SELECT = `SELECT credential_id, kind, hmac, generation, bucket_index, credential_version, usable_for_login, label
  FROM credential_locators`;

/**
 * `credential_locators`. Every write acts on all generations of a
 * `credentialId`; `record` keeps `credential_version` at the maximum over
 * every existing row of that credential so generations never diverge.
 */
export function createCredentialLocatorStore(
  sql: SqlStorage,
  now: () => number,
): CredentialLocatorStore {
  return {
    list() {
      return sql
        .exec<LocatorRow>(`${SELECT} ORDER BY credential_id, generation DESC`)
        .toArray()
        .map(toLocator);
    },

    findByCredentialId(credentialId) {
      const row = sql
        .exec<LocatorRow>(
          `${SELECT} WHERE credential_id = ? ORDER BY generation DESC LIMIT 1`,
          credentialId,
        )
        .toArray()[0];
      return row ? toLocator(row) : null;
    },

    listByCredentialId(credentialId) {
      return sql
        .exec<LocatorRow>(
          `${SELECT} WHERE credential_id = ? ORDER BY generation DESC`,
          credentialId,
        )
        .toArray()
        .map(toLocator);
    },

    record(locator) {
      const derived = decodeMapping(locator.kind, locator.mapping);
      if (derived === null) {
        throw new SystemError(
          SystemErrorCode.DataIntegrityError,
          "The credential locator carries an unreadable mapping",
        );
      }
      const at = now();
      const current = sql
        .exec<{ v: number | null }>(
          "SELECT max(credential_version) AS v FROM credential_locators WHERE credential_id = ?",
          locator.credentialId,
        )
        .one().v;
      const version = Math.max(locator.credentialVersion, current ?? 0);
      sql.exec(
        `INSERT INTO credential_locators
           (credential_id, kind, hmac, generation, bucket_index, credential_version, status, usable_for_login, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
         ON CONFLICT (credential_id, generation) DO UPDATE SET
           hmac = excluded.hmac,
           bucket_index = excluded.bucket_index,
           credential_version = excluded.credential_version,
           usable_for_login = excluded.usable_for_login,
           label = excluded.label,
           updated_at = excluded.updated_at`,
        locator.credentialId,
        locator.kind,
        derived.hmac,
        derived.generation,
        derived.bucketIndex,
        version,
        locator.usableForLogin ? 1 : 0,
        locator.label,
        at,
        at,
      );
      sql.exec(
        "UPDATE credential_locators SET credential_version = ?, updated_at = ? WHERE credential_id = ? AND credential_version <> ?",
        version,
        at,
        locator.credentialId,
        version,
      );
    },

    advanceCredentialVersion(credentialId) {
      const next =
        (sql
          .exec<{ v: number | null }>(
            "SELECT max(credential_version) AS v FROM credential_locators WHERE credential_id = ?",
            credentialId,
          )
          .one().v ?? 0) + 1;
      sql.exec(
        "UPDATE credential_locators SET credential_version = ?, updated_at = ? WHERE credential_id = ?",
        next,
        now(),
        credentialId,
      );
      return next;
    },

    deleteByCredentialId(credentialId) {
      sql.exec(
        "DELETE FROM credential_locators WHERE credential_id = ?",
        credentialId,
      );
    },
  };
}

/** The `User.credentials` projection: one element per distinct `credentialId`. */
export function listCredentialRefs(sql: SqlStorage): CredentialRefInput[] {
  const seen = new Map<string, CredentialRefInput>();
  for (const row of sql
    .exec<LocatorRow>(`${SELECT} ORDER BY credential_id, generation DESC`)
    .toArray()) {
    if (seen.has(row.credential_id)) continue;
    seen.set(row.credential_id, {
      credentialId: row.credential_id,
      kind: row.kind,
      label: row.label,
      usableForLogin: row.usable_for_login === 1,
    });
  }
  return [...seen.values()];
}
