import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import { isRehydrationError } from "@repo/core/domain/error";
import type { User } from "@repo/core/domain/identity/entity";
import { User as UserEntity } from "@repo/core/domain/identity/entity";
import type { UserSettingsRepository } from "@repo/core/domain/identity/ports/userSettingsRepository";
import { all, one, run, type Sql } from "../sql/exec";
import { conditionalUpdate } from "../sql/occ";

type SettingsRow = {
  trash_retention_days: number;
  version: number;
  created_at: number;
  updated_at: number;
};

type LocatorProjectionRow = {
  credential_id: string;
  kind: string;
  usable_for_login: number;
  label: string;
};

/**
 * `User` on the User Data DO side.
 *
 * The aggregate spans two tables: `user_settings` holds the scalar settings and
 * the OCC `version`, while `credentials` is a projection of
 * `credential_locators`. Only the first is written here — the credential set is
 * owned by `CredentialLocatorStore`, since what a credential *is* is decided on
 * the Identity Directory side and merely mirrored locally.
 */
export function createUserSettingsRepository(
  sql: Sql,
  now: () => number,
): UserSettingsRepository {
  return {
    insert(user: User): void {
      const timestamp = now();
      run(
        sql,
        `INSERT INTO user_settings (trash_retention_days, version, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        user.trashRetentionDays,
        user.version,
        timestamp,
        timestamp,
      );
    },

    save(user: User, expectedVersion: ExpectedVersion<User>): void {
      // Single-row table: no `id` predicate exists to add, so `version` alone
      // conditions the update.
      conditionalUpdate(
        sql,
        `UPDATE user_settings
            SET trash_retention_days = ?, version = ?, updated_at = ?
          WHERE version = ?
        RETURNING 1`,
        [user.trashRetentionDays, user.version, now(), expectedVersion],
        "user settings",
      );
    },

    find(): Versioned<User> | null {
      const row = one<SettingsRow>(
        sql,
        "SELECT trash_retention_days, version, created_at, updated_at FROM user_settings",
      );
      if (row === null) return null;

      const locators = all<LocatorProjectionRow>(
        sql,
        `SELECT credential_id, kind, usable_for_login, label
           FROM credential_locators
          WHERE status = 'active'
          ORDER BY credential_id, generation`,
      );

      try {
        const entity = UserEntity.reconstruct({
          // One instance holds one user, so the identity is the DO's own name.
          // It is threaded in by the facade, which is the only caller that has
          // it; see `createUserDataUnitOfWorkProvider`.
          id: selfUserId(sql),
          credentials: dedupeByCredentialId(locators),
          trashRetentionDays: row.trash_retention_days,
          version: row.version,
          createdAt: new Date(row.created_at),
          updatedAt: new Date(row.updated_at),
        });
        return {
          entity,
          expectedVersion: row.version as ExpectedVersion<User>,
        };
      } catch (error) {
        if (isRehydrationError(error)) {
          throw new SystemError(
            SystemErrorCode.DataIntegrityError,
            "Stored user settings could not be rehydrated",
            error,
          );
        }
        throw error;
      }
    },
  };
}

/**
 * A credential with rows in two routing-key generations must appear once:
 * `User.credentials` is a set of credentials, not of locator rows, and the
 * "last way in" check counts distinct `credentialId`s.
 *
 * Returns the loose row shape rather than `CredentialRef`. These are untrusted
 * persistence values and nothing here has checked them; `User.reconstruct` is
 * the one place that does, and a declared type claiming otherwise would only
 * mislead the next reader.
 */
function dedupeByCredentialId(rows: readonly LocatorProjectionRow[]): readonly {
  credentialId: string;
  kind: string;
  label: string;
  usableForLogin: boolean;
}[] {
  const seen = new Map<string, LocatorProjectionRow>();
  for (const row of rows) {
    const existing = seen.get(row.credential_id);
    // Later generations win on the mirrored fields, matching
    // `CredentialLocatorStore.record`'s overwrite semantics.
    if (
      existing === undefined ||
      row.usable_for_login > existing.usable_for_login
    ) {
      seen.set(row.credential_id, row);
    }
  }
  return [...seen.values()].map((row) => ({
    credentialId: row.credential_id,
    kind: row.kind,
    label: row.label,
    usableForLogin: row.usable_for_login === 1,
  }));
}

/**
 * The DO's own locator, which for a User Data DO *is* the `userId`.
 *
 * Read from `_meta` rather than passed in, so that no caller can hand this
 * repository somebody else's id — there is only one user here, and the row
 * says which.
 */
function selfUserId(sql: Sql): string {
  const row = one<{ self_locator: string }>(
    sql,
    "SELECT self_locator FROM _meta",
  );
  if (row === null || row.self_locator === "") {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      "This Durable Object has no recorded self locator",
    );
  }
  return row.self_locator;
}
