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
import { opaqueCredentialKey } from "@repo/core/adapters/cloudflare/identityPhysical";
import {
  type OrderedMigration,
  runOrderedMigrations,
} from "@repo/core/adapters/cloudflare/migrations";
import {
  migrateUserData,
  userDataMigrations,
} from "@repo/core/adapters/cloudflare/user-data/schema";
import { rpcQuery } from "@repo/core/application/identity/rpc";
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
      name: "User Data",
      stub: () => bindings.USER_DATA.getByName("migration-v1-user-data"),
      migrations: userDataMigrations,
      seed(storage: DurableObjectStorage) {
        storage.sql.exec(
          `INSERT INTO profile(
             singleton, user_id, display_name, created_at, updated_at
           ) VALUES (1, 'user-v1', 'V1 User', 1, 1)`,
        );
        storage.sql.exec(
          `INSERT INTO settings(
             singleton, trash_retention_days, version, updated_at
           ) VALUES (1, 30, 1, 1)`,
        );
        storage.sql.exec(
          `INSERT INTO content(
             id, kind, title, body, topic_id, topic_archived, trashed_at,
             trashed_with_topic_id, created_at, updated_at
           ) VALUES (
             'memo-v1', 'memo', '', 'preserved v1 memo', NULL, 0, NULL,
             NULL, 1, 1
           )`,
        );
        storage.sql.exec(
          `INSERT INTO content_revisions(
             content_id, version, title, body, created_at
           ) VALUES ('memo-v1', 1, '', 'preserved v1 memo', 1)`,
        );
        storage.sql.exec(
          `INSERT INTO ai_client_connections(
             id, client_id, label, scopes_json, created_at, revoked_at
           ) VALUES (
             'ai-v1', 'legacy-client', 'Legacy Assistant', '["search"]',
             1, 2
           )`,
        );
      },
      async invoke(stub: DurableObjectStub<UserDataDurableObject>) {
        return stub.identityGetProfileV1(
          rpcQuery({
            userId: "user-v1",
          }),
        );
      },
      assertFixture(storage: DurableObjectStorage) {
        expect(
          storage.sql
            .exec<{ user_id: string; version: number }>(
              "SELECT user_id, version FROM profile WHERE singleton = 1",
            )
            .one(),
        ).toEqual({ user_id: "user-v1", version: 0 });
        expect(
          storage.sql
            .exec<{
              body: string;
              version: number;
              latest_revision_version: number;
            }>(
              `SELECT body, version, latest_revision_version
               FROM content WHERE id = 'memo-v1'`,
            )
            .one(),
        ).toEqual({
          body: "preserved v1 memo",
          version: 0,
          latest_revision_version: 1,
        });
        expect(
          storage.sql
            .exec<{
              id: string;
              client_name: string;
              status: string;
              connected_at: number;
              revoked_at: number | null;
              version: number;
            }>(
              `SELECT id, client_name, status, connected_at, revoked_at, version
               FROM ai_client_connections WHERE id = 'ai-v1'`,
            )
            .one(),
        ).toEqual({
          id: "ai-v1",
          client_name: "Legacy Assistant",
          status: "revoked",
          connected_at: 1,
          revoked_at: 2,
          version: 0,
        });
        expect(
          storage.sql
            .exec<{ name: string }>(
              `SELECT name FROM pragma_table_info('ai_client_connections')
               ORDER BY cid`,
            )
            .toArray()
            .map(({ name }) => name),
        ).toEqual([
          "id",
          "client_name",
          "status",
          "connected_at",
          "last_used_at",
          "revoked_at",
          "version",
        ]);
        storage.sql.exec(
          `INSERT INTO ai_client_connections(
             id, client_name, status, connected_at, version
           ) VALUES ('ai-current', 'Current Assistant', 'active', 3, 0)`,
        );
        storage.sql.exec(
          `UPDATE ai_client_connections
           SET status = 'revoked', revoked_at = 4, version = version + 1
           WHERE id = 'ai-current' AND version = 0`,
        );
        expect(
          storage.sql
            .exec<{
              status: string;
              revoked_at: number | null;
              version: number;
            }>(
              `SELECT status, revoked_at, version
               FROM ai_client_connections WHERE id = 'ai-current'`,
            )
            .one(),
        ).toEqual({ status: "revoked", revoked_at: 4, version: 1 });
      },
    },
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
        state.storage.sql.exec("DROP TABLE IF EXISTS search_fts");
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
