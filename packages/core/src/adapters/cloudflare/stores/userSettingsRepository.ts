import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import { User } from "@repo/core/domain/identity/entity";
import type { UserSettingsRepository } from "@repo/core/domain/identity/ports/userSettingsRepository";
import { readSelfLocator } from "../migrationGate";
import { updateMatchedRow } from "../rowRunner";
import { listCredentialRefs } from "./credentialLocatorStore";
import { occConflict } from "./occ";

type SettingsRow = Readonly<{
  trash_retention_days: number;
  version: number;
  created_at: number;
  updated_at: number;
}>;

/**
 * `user_settings` — one row, no id. `save` conditions on `version` alone, and
 * the `RETURNING 1` row count is what says whether it matched. `User.credentials`
 * is the projection of `credential_locators`, deduplicated by `credentialId`.
 */
export function createUserSettingsRepository(
  sql: SqlStorage,
): UserSettingsRepository {
  return {
    insert(user) {
      sql.exec(
        `INSERT INTO user_settings (trash_retention_days, version, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        user.trashRetentionDays,
        user.version,
        user.createdAt.getTime(),
        user.updatedAt.getTime(),
      );
    },

    save(user, expectedVersion) {
      const matched = updateMatchedRow(
        sql,
        `UPDATE user_settings SET trash_retention_days = ?, version = ?, updated_at = ?
         WHERE version = ?`,
        user.trashRetentionDays,
        user.version,
        user.updatedAt.getTime(),
        expectedVersion as number,
      );
      if (!matched) throw occConflict();
    },

    find(): Versioned<User> | null {
      const row = sql
        .exec<SettingsRow>(
          "SELECT trash_retention_days, version, created_at, updated_at FROM user_settings LIMIT 1",
        )
        .toArray()[0];
      if (!row) return null;
      const id = readSelfLocator(sql);
      if (id === null) return null;
      const entity = User.reconstruct({
        id,
        credentials: listCredentialRefs(sql),
        trashRetentionDays: row.trash_retention_days,
        version: row.version,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      });
      return { entity, expectedVersion: row.version as ExpectedVersion<User> };
    },
  };
}
