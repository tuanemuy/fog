import type { DurableSqlStorage } from "../sql";

const VERSION = 1;

const statements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS profile (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    user_id TEXT NOT NULL,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    trash_retention_days INTEGER NOT NULL DEFAULT 30,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ai_client_connections (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    label TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_memo_id TEXT,
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS content (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('memo', 'document')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    topic_id TEXT,
    topic_archived INTEGER NOT NULL DEFAULT 0,
    trashed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS content_revisions (
    content_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (content_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS content_sources (
    content_id TEXT NOT NULL,
    memo_id TEXT NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (content_id, memo_id)
  )`,
  `CREATE TABLE IF NOT EXISTS trash (
    content_id TEXT PRIMARY KEY,
    content_kind TEXT NOT NULL,
    trashed_at INTEGER NOT NULL,
    purge_after INTEGER
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    content_id UNINDEXED,
    kind UNINDEXED,
    title,
    body,
    tokenize='trigram'
  )`,
  `CREATE TABLE IF NOT EXISTS idempotency (
    operation_id TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    completed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'poison')),
    attempt INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER NOT NULL,
    lease_until INTEGER,
    owner_token TEXT,
    provider_idempotency_key TEXT NOT NULL UNIQUE,
    terminal_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, next_run_at)",
] as const;

export function migrateUserData(storage: DurableSqlStorage, now: number): void {
  storage.transactionSync(() => {
    storage.sql.exec(statements[0]);
    const row = storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .one();
    if (row.version > VERSION) {
      throw new Error(`Unsupported User Data schema version: ${row.version}`);
    }
    if (row.version === VERSION) return;
    for (const statement of statements.slice(1)) storage.sql.exec(statement);
    storage.sql.exec(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      VERSION,
      now,
    );
  });
}
