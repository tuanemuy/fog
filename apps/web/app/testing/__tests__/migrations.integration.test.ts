import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
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
import { rpcQuery } from "@repo/core/application/identity/rpc";
import { opaqueCredentialKey } from "@repo/core/application/identity/contracts";
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

  const upgradeCases = [
    {
      name: "Identity Directory",
      stub: () =>
        bindings.IDENTITY_DIRECTORY.getByName("migration-v1-directory"),
      migrations: identityDirectoryMigrations,
      migrate: migrateIdentityDirectory,
      seed(storage: DurableObjectStorage) {
        storage.sql.exec(
          `INSERT INTO credential_mappings(
             opaque_key, generation, canonical_value, kind, provider, user_id,
             operation_id, state, password_hash, reservation_expires_at,
             account_epoch, created_at, updated_at
           ) VALUES (
             'opaque-v1', 'v1', 'email:v1@example.com', 'password', NULL,
             'user-v1', 'operation-v1', 'active', 'hash-v1', NULL, 1, 1, 1
           )`,
        );
      },
      async invoke(stub: DurableObjectStub<IdentityDirectoryDurableObject>) {
        return stub.lookup(
          rpcQuery({
            locator: {
              generation: "v1",
              bucket: 0,
              opaqueKey: opaqueCredentialKey("opaque-v1"),
            },
          }),
        );
      },
      assertFixture(storage: DurableObjectStorage) {
        expect(
          storage.sql
            .exec<{ user_id: string }>(
              "SELECT user_id FROM credential_mappings WHERE opaque_key = 'opaque-v1'",
            )
            .one().user_id,
        ).toBe("user-v1");
        expect(
          storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM pragma_table_info('credential_mappings') WHERE name = 'bucket'",
            )
            .one().name,
        ).toBe("bucket");
      },
    },
    {
      name: "Account Home",
      stub: () => bindings.ACCOUNT_HOME.getByName("migration-v1-account"),
      migrations: accountHomeMigrations,
      migrate: migrateAccountHome,
      seed(storage: DurableObjectStorage) {
        storage.sql.exec(
          `INSERT INTO account(
             singleton, user_id, status, primary_email, auth_method,
             session_epoch, operation_epoch, created_at, updated_at
           ) VALUES (
             1, 'user-v1', 'active', 'v1@example.com', 'password', 1, 1, 1, 1
           )`,
        );
      },
      async invoke(stub: DurableObjectStub<AccountHomeDurableObject>) {
        return stub.getAuthSummary(rpcQuery({}));
      },
      assertFixture(storage: DurableObjectStorage) {
        expect(
          storage.sql
            .exec<{ user_id: string }>(
              "SELECT user_id FROM account WHERE singleton = 1",
            )
            .one().user_id,
        ).toBe("user-v1");
        expect(
          storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM pragma_table_info('credential_locators') WHERE name = 'bucket'",
            )
            .one().name,
        ).toBe("bucket");
      },
    },
  ] as const;

  for (const upgradeCase of upgradeCases) {
    it(`${upgradeCase.name} upgrades a real v1 fixture lazily and survives eviction`, async () => {
      const stub = upgradeCase.stub();
      await runInDurableObject(stub, (_instance, state) => {
        const tables = state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .toArray()
          .map(({ name }) => name);
        for (const table of tables) {
          state.storage.sql.exec(`DROP TABLE "${table.replaceAll('"', '""')}"`);
        }
        runOrderedMigrations(
          state.storage,
          1,
          upgradeCase.name,
          upgradeCase.migrations.slice(0, 1),
        );
        upgradeCase.seed(state.storage);

        expect(() =>
          runOrderedMigrations(state.storage, 2, upgradeCase.name, [
            ...upgradeCase.migrations,
            {
              version: (upgradeCase.migrations.at(-1)?.version ?? 0) + 1,
              up: ["THIS IS NOT VALID SQL"],
            },
          ]),
        ).toThrow();
        expect(
          state.storage.sql
            .exec<{ version: number }>(
              "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
            )
            .one().version,
        ).toBe(1);

        upgradeCase.migrate(state.storage, 3);
        upgradeCase.assertFixture(state.storage);
      });

      await evictDurableObject(stub);
      const result = await upgradeCase.invoke(stub as never);
      expect(result.ok).toBe(true);
      await runInDurableObject(stub, (_instance, state) => {
        expect(
          state.storage.sql
            .exec<{ version: number }>(
              "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
            )
            .one().version,
        ).toBe(upgradeCase.migrations.at(-1)?.version);
        upgradeCase.assertFixture(state.storage);
      });
    });
  }
});
