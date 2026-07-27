import type { DurableSqlStorage } from "../sql";

const VERSION = 1;

const statements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS credential_mappings (
    opaque_key TEXT PRIMARY KEY,
    generation TEXT NOT NULL,
    canonical_value TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('password', 'sso')),
    provider TEXT,
    user_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('reserved', 'initialized', 'active', 'tombstoned')
    ),
    password_hash TEXT,
    reservation_expires_at INTEGER,
    account_epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS credential_operation_uq
   ON credential_mappings(operation_id, opaque_key)`,
  `CREATE TABLE IF NOT EXISTS reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS rotation_checkpoints (
    generation TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    cursor_key TEXT,
    scanned_count INTEGER NOT NULL DEFAULT 0,
    moved_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    completed_at INTEGER,
    PRIMARY KEY (generation, bucket)
  )`,
] as const;

export function migrateIdentityDirectory(
  storage: DurableSqlStorage,
  now: number,
): void {
  storage.transactionSync(() => {
    storage.sql.exec(statements[0]);
    const current = storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .one().version;
    if (current > VERSION) {
      throw new Error(
        `Unsupported Identity Directory schema version: ${current}`,
      );
    }
    if (current === VERSION) return;
    for (const statement of statements.slice(1)) storage.sql.exec(statement);
    storage.sql.exec(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      VERSION,
      now,
    );
  });
}
