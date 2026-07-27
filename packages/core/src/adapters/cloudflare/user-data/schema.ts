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

const historyAndOwnershipSchema = [
  "ALTER TABLE profile ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)",
  "ALTER TABLE ai_client_connections ADD COLUMN client_name TEXT",
  "ALTER TABLE ai_client_connections ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked'))",
  "ALTER TABLE ai_client_connections ADD COLUMN connected_at INTEGER",
  "ALTER TABLE ai_client_connections ADD COLUMN last_used_at INTEGER",
  "ALTER TABLE ai_client_connections ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)",
  `UPDATE ai_client_connections
   SET client_name = label,
       connected_at = created_at,
       status = CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END
   WHERE client_name IS NULL OR connected_at IS NULL`,
  "ALTER TABLE topics ADD COLUMN description TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE topics ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)",
  "ALTER TABLE content ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)",
  "ALTER TABLE content ADD COLUMN latest_revision_version INTEGER NOT NULL DEFAULT 0 CHECK (latest_revision_version >= 0)",
  "ALTER TABLE content ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'local-user'",
  "ALTER TABLE content_revisions ADD COLUMN actor_id TEXT NOT NULL DEFAULT 'local-user'",
  "ALTER TABLE content_revisions ADD COLUMN change_reason TEXT",
  `UPDATE content
   SET latest_revision_version = COALESCE(
     (SELECT MAX(r.version) FROM content_revisions r WHERE r.content_id = content.id),
     0
   )`,
  `CREATE TABLE IF NOT EXISTS user_data_delete_markers (
    operation_id TEXT PRIMARY KEY,
    expected_user_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    completed_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idempotency_completed_idx
   ON idempotency(completed_at, namespace, operation_id)`,
  `CREATE TRIGGER IF NOT EXISTS document_revision_reason_insert
   BEFORE INSERT ON content_revisions
   WHEN EXISTS (
     SELECT 1 FROM content
     WHERE id = NEW.content_id AND kind = 'document'
   ) AND (NEW.change_reason IS NULL OR trim(NEW.change_reason) = '')
   BEGIN
     SELECT RAISE(ABORT, 'DOCUMENT_REVISION_CHANGE_REASON_REQUIRED');
   END`,
  `CREATE TRIGGER IF NOT EXISTS settings_version_guard
   BEFORE UPDATE ON settings
   WHEN NEW.version < 1 OR NEW.trash_retention_days < 1
   BEGIN
     SELECT RAISE(ABORT, 'SETTINGS_INVARIANT_INVALID');
   END`,
  `CREATE TRIGGER IF NOT EXISTS ai_client_connection_insert_guard
   BEFORE INSERT ON ai_client_connections
   WHEN NEW.client_name IS NULL OR trim(NEW.client_name) = ''
     OR NEW.connected_at IS NULL
   BEGIN
     SELECT RAISE(ABORT, 'AI_CLIENT_CONNECTION_PROVENANCE_REQUIRED');
   END`,
  `CREATE TRIGGER IF NOT EXISTS ai_client_connection_update_guard
   BEFORE UPDATE ON ai_client_connections
   WHEN NEW.client_name IS NULL OR trim(NEW.client_name) = ''
     OR NEW.connected_at IS NULL OR NEW.version < 1
   BEGIN
     SELECT RAISE(ABORT, 'AI_CLIENT_CONNECTION_PROVENANCE_REQUIRED');
   END`,
] as const;

export const userDataMigrations: readonly OrderedMigration[] = [
  { version: 1, up: initialSchema },
  { version: 2, up: historyAndOwnershipSchema },
];

export function migrateUserData(storage: DurableSqlStorage, now: number): void {
  storage.sql.exec("PRAGMA foreign_keys = ON");
  runOrderedMigrations(storage, now, "User Data", userDataMigrations);
}
