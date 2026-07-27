import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  accountHomeMigrations,
  migrateAccountHome,
} from "@repo/core/adapters/cloudflare/account-home/schema";
import {
  identityDirectoryMigrations,
  migrateIdentityDirectory,
} from "@repo/core/adapters/cloudflare/identity-directory/schema";
import {
  runOrderedMigrations,
  type OrderedMigration,
} from "@repo/core/adapters/cloudflare/migrations";
import {
  migrateUserData,
  userDataMigrations,
} from "@repo/core/adapters/cloudflare/user-data/schema";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountHomeDurableObject } from "../../durable-objects/AccountHomeDurableObject";
import type { IdentityDirectoryDurableObject } from "../../durable-objects/IdentityDirectoryDurableObject";
import type { UserDataDurableObject } from "../../durable-objects/UserDataDurableObject";

type TestEnv = Readonly<{
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
  IDENTITY_DIRECTORY: DurableObjectNamespace<IdentityDirectoryDurableObject>;
  ACCOUNT_HOME: DurableObjectNamespace<AccountHomeDurableObject>;
}>;

const bindings = env as unknown as TestEnv;

afterEach(() => reset());

type MigrationCase = Readonly<{
  name: string;
  stub: () => DurableObjectStub;
  migrations: readonly OrderedMigration[];
  migrate(storage: DurableObjectStorage, now: number): void;
}>;

const cases: readonly MigrationCase[] = [
  {
    name: "User Data",
    stub: () => bindings.USER_DATA.getByName("migration-user-data"),
    migrations: userDataMigrations,
    migrate: migrateUserData,
  },
  {
    name: "Identity Directory",
    stub: () =>
      bindings.IDENTITY_DIRECTORY.getByName("migration-identity-directory"),
    migrations: identityDirectoryMigrations,
    migrate: migrateIdentityDirectory,
  },
  {
    name: "Account Home",
    stub: () => bindings.ACCOUNT_HOME.getByName("migration-account-home"),
    migrations: accountHomeMigrations,
    migrate: migrateAccountHome,
  },
];

describe("ordered Durable Object migrations", () => {
  for (const migrationCase of cases) {
    it(`${migrationCase.name} is ordered, idempotent, forward-only, and atomic`, async () => {
      await runInDurableObject(migrationCase.stub(), (_instance, state) => {
        migrationCase.migrate(state.storage, 2);
        migrationCase.migrate(state.storage, 3);
        const versions = state.storage.sql
          .exec<{ version: number }>(
            "SELECT version FROM schema_migrations ORDER BY version",
          )
          .toArray()
          .map(({ version }) => version);
        expect(versions).toEqual(
          migrationCase.migrations.map(({ version }) => version),
        );

        const faultVersion =
          (migrationCase.migrations.at(-1)?.version ?? 0) + 1;
        expect(() =>
          runOrderedMigrations(state.storage, 4, migrationCase.name, [
            ...migrationCase.migrations,
            {
              version: faultVersion,
              up: [
                "CREATE TABLE migration_fault_marker (id INTEGER PRIMARY KEY)",
                "THIS IS NOT VALID SQL",
              ],
            },
          ]),
        ).toThrow();
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count FROM sqlite_master
               WHERE type = 'table' AND name = 'migration_fault_marker'`,
            )
            .one().count,
        ).toBe(0);
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?",
              faultVersion,
            )
            .one().count,
        ).toBe(0);

        state.storage.sql.exec(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (999, 5)",
        );
        expect(() => migrationCase.migrate(state.storage, 6)).toThrow(
          `Unsupported ${migrationCase.name} schema version: 999`,
        );
      });
    });
  }
});
