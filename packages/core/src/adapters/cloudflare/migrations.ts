import type { DurableSqlStorage } from "./sql";

export type OrderedMigration = Readonly<{
  version: number;
  up: readonly string[];
}>;

export function runOrderedMigrations(
  storage: DurableSqlStorage,
  now: number,
  schemaName: string,
  migrations: readonly OrderedMigration[],
): void {
  if (
    migrations.length === 0 ||
    migrations.some(
      (migration, index) =>
        migration.version !== index + 1 || migration.up.length === 0,
    )
  ) {
    throw new Error(
      `${schemaName} migrations must be contiguous from version 1`,
    );
  }

  storage.transactionSync(() => {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
    const current = storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .one().version;
    const latest = migrations.at(-1)?.version ?? 0;
    if (current > latest) {
      throw new Error(`Unsupported ${schemaName} schema version: ${current}`);
    }
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      for (const statement of migration.up) storage.sql.exec(statement);
      storage.sql.exec(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        migration.version,
        now,
      );
    }
  });
}
