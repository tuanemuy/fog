import { type OrderedMigration, runOrderedMigrations } from "../migrations";
import type { DurableSqlStorage } from "../sql";

const initialSchema = [
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
    trashed_at INTEGER,
    purge_after INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(source_memo_id) REFERENCES content(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS content (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('memo', 'document')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    topic_id TEXT,
    topic_archived INTEGER NOT NULL DEFAULT 0,
    trashed_at INTEGER,
    trashed_with_topic_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(topic_id) REFERENCES topics(id),
    FOREIGN KEY(trashed_with_topic_id) REFERENCES topics(id)
  )`,
  `CREATE TABLE IF NOT EXISTS content_revisions (
    content_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (content_id, version),
    FOREIGN KEY(content_id) REFERENCES content(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS content_sources (
    content_id TEXT NOT NULL,
    memo_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (content_id, memo_id),
    FOREIGN KEY(content_id) REFERENCES content(id) ON DELETE CASCADE,
    FOREIGN KEY(memo_id) REFERENCES content(id) ON DELETE CASCADE,
    CHECK (content_id <> memo_id)
  )`,
  `CREATE INDEX IF NOT EXISTS content_sources_memo_idx
   ON content_sources(memo_id, content_id)`,
  `CREATE TABLE IF NOT EXISTS trash (
    content_id TEXT PRIMARY KEY,
    content_kind TEXT NOT NULL,
    trashed_at INTEGER NOT NULL,
    purge_after INTEGER,
    FOREIGN KEY(content_id) REFERENCES content(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS search_entries (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('memo', 'document')),
    entity_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    topic_id TEXT,
    UNIQUE(entity_type, entity_id)
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title,
    body,
    content='search_entries',
    content_rowid='rowid',
    tokenize='trigram'
  )`,
  `CREATE TABLE IF NOT EXISTS search_snapshots (
    id TEXT PRIMARY KEY,
    query_digest TEXT NOT NULL,
    total_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS search_snapshot_items (
    snapshot_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    item_json TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, ordinal),
    FOREIGN KEY(snapshot_id) REFERENCES search_snapshots(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS search_snapshots_expiry_idx
   ON search_snapshots(expires_at)`,
  `CREATE TABLE IF NOT EXISTS idempotency (
    namespace TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    command_kind TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    result_json TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    PRIMARY KEY(namespace, operation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'poison')),
    attempt INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER NOT NULL,
    lease_until INTEGER,
    owner_token TEXT,
    provider_idempotency_key TEXT NOT NULL UNIQUE,
    terminal_reason TEXT,
    terminal_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, next_run_at)",
  "CREATE INDEX IF NOT EXISTS jobs_reclaim_idx ON jobs(status, lease_until)",
  "CREATE INDEX IF NOT EXISTS jobs_terminal_idx ON jobs(status, terminal_at)",
] as const;

export const userDataMigrations: readonly OrderedMigration[] = [
  { version: 1, up: initialSchema },
];

export function migrateUserData(storage: DurableSqlStorage, now: number): void {
  storage.sql.exec("PRAGMA foreign_keys = ON");
  runOrderedMigrations(storage, now, "User Data", userDataMigrations);
}
