import {
  applyAsyncWorkTables,
  applyMetaTable,
  type MigrationPlan,
} from "./plan";

/**
 * v1 of the User Data DO: the seventeen tables of `spec/database/index.md`
 * plus the FTS5 virtual table. Nothing is deployed yet, so later slices extend
 * this step in place rather than adding a v2; `targetVersion` moves only after
 * the first production deploy.
 */
export function applyUserDataSchemaV1(sql: SqlStorage): void {
  applyMetaTable(sql);
  applyAsyncWorkTables(sql);

  sql.exec(`CREATE TABLE IF NOT EXISTS account (
    status TEXT NOT NULL CHECK (status IN ('active','deleting','deleted')),
    session_epoch INTEGER NOT NULL,
    deleted_at INTEGER,
    caller_token TEXT,
    reset_version INTEGER NOT NULL,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS user_settings (
    trash_retention_days INTEGER NOT NULL CHECK (trash_retention_days >= 1),
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS credential_locators (
    credential_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('email','sso')),
    hmac TEXT NOT NULL,
    generation INTEGER NOT NULL,
    bucket_index INTEGER NOT NULL,
    credential_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status = 'active'),
    usable_for_login INTEGER NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (credential_id, generation)
  )`);
  sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS cl_hmac_uq ON credential_locators (kind, hmac, generation)",
  );

  sql.exec(`CREATE TABLE IF NOT EXISTS ai_client_connections (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    scope TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','revoked')),
    connected_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER,
    created_at_reset_version INTEGER NOT NULL,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (status = 'active' AND revoked_at IS NULL) OR
      (status = 'revoked' AND revoked_at IS NOT NULL)
    )
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS acc_connected_idx ON ai_client_connections (connected_at DESC)",
  );

  // OAuth 2.1 authorization codes are signed, self-contained values; the
  // only persistence is the `jti` of a code already exchanged, kept until
  // the code's own expiry (`spec/database/index.md`). Adapter-owned: no
  // store, no registration point — the token endpoint's facade writes it.
  sql.exec(`CREATE TABLE IF NOT EXISTS oauth_consumed_codes (
    jti TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS occ_expires_idx ON oauth_consumed_codes (expires_at)",
  );

  sql.exec(`CREATE TABLE IF NOT EXISTS memos (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    latest_revision_number INTEGER NOT NULL CHECK (latest_revision_number >= 1),
    posted_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','trashed')),
    trashed_at INTEGER,
    purge_after INTEGER,
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (status = 'active' AND trashed_at IS NULL AND purge_after IS NULL) OR
      (status = 'trashed' AND trashed_at IS NOT NULL AND purge_after IS NOT NULL)
    )
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS memos_timeline_idx ON memos (posted_at DESC, id DESC) WHERE status = 'active'",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS memos_trash_idx ON memos (trashed_at DESC) WHERE status = 'trashed'",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS memos_purge_idx ON memos (purge_after) WHERE status = 'trashed'",
  );

  sql.exec(`CREATE TABLE IF NOT EXISTS memo_revisions (
    memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user','ai_client')),
    actor_connection_id TEXT,
    actor_client_name TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (memo_id, revision_number),
    CHECK (
      (actor_type = 'user' AND actor_connection_id IS NULL AND actor_client_name IS NULL) OR
      (actor_type = 'ai_client' AND actor_connection_id IS NOT NULL AND actor_client_name IS NOT NULL)
    )
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL CHECK (status IN ('active','archived','trashed')),
    trashed_at INTEGER,
    purge_after INTEGER,
    was_archived INTEGER,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (status IN ('active','archived') AND trashed_at IS NULL AND purge_after IS NULL AND was_archived IS NULL) OR
      (status = 'trashed' AND trashed_at IS NOT NULL AND purge_after IS NOT NULL AND was_archived IS NOT NULL AND was_archived IN (0, 1))
    )
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS topics_live_idx ON topics (status, name)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS topics_trash_idx ON topics (trashed_at DESC) WHERE status = 'trashed'",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS topics_purge_idx ON topics (purge_after) WHERE status = 'trashed'",
  );

  // `topic_id` carries no FK on purpose (ADR-001): a trashed document may
  // legitimately point at a topic that was hard-deleted.
  sql.exec(`CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    latest_revision_number INTEGER NOT NULL CHECK (latest_revision_number >= 1),
    status TEXT NOT NULL CHECK (status IN ('active','trashed')),
    trashed_at INTEGER,
    purge_after INTEGER,
    trashed_with TEXT,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (status = 'active' AND trashed_at IS NULL AND purge_after IS NULL AND trashed_with IS NULL) OR
      (status = 'trashed' AND trashed_at IS NOT NULL AND purge_after IS NOT NULL)
    ),
    CHECK (trashed_with IS NULL OR trashed_with = topic_id)
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS docs_topic_active_idx ON documents (topic_id) WHERE status = 'active'",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS docs_topic_trashed_idx ON documents (topic_id) WHERE status = 'trashed'",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS docs_trash_idx ON documents (trashed_at DESC) WHERE status = 'trashed'",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS docs_purge_idx ON documents (purge_after) WHERE status = 'trashed'",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS docs_updated_idx ON documents (updated_at DESC) WHERE status = 'active'",
  );

  sql.exec(`CREATE TABLE IF NOT EXISTS document_revisions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user','ai_client')),
    actor_connection_id TEXT,
    actor_client_name TEXT,
    change_reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (
      (actor_type = 'user' AND actor_connection_id IS NULL AND actor_client_name IS NULL) OR
      (actor_type = 'ai_client' AND actor_connection_id IS NOT NULL AND actor_client_name IS NOT NULL)
    )
  )`);
  sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS doc_revs_doc_rev_uq ON document_revisions (document_id, revision_number)",
  );

  sql.exec(`CREATE TABLE IF NOT EXISTS source_links (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (document_id, memo_id)
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS source_links_memo_idx ON source_links (memo_id)",
  );

  sql.exec(`CREATE TABLE IF NOT EXISTS search_entries (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('memo','document')),
    topic_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    source_ids TEXT NOT NULL
  )`);
  sql.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS search_entries_id_uq ON search_entries (id)",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS search_entries_topic_idx ON search_entries (topic_id) WHERE topic_id IS NOT NULL",
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS search_entries_order_idx ON search_entries (timestamp DESC, type, id)",
  );

  // External-content FTS5: the projection code issues the two-step
  // delete-by-old-value → insert-by-new-value; no trigger does.
  sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title,
    body,
    content='search_entries',
    content_rowid='rowid',
    tokenize='trigram'
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('signup','link','unlink','credential-change','withdrawal')),
    payload_digest TEXT NOT NULL,
    phase TEXT NOT NULL,
    target_locators TEXT,
    terminal_reason TEXT,
    created_at INTEGER NOT NULL
  )`);

  sql.exec(`CREATE TABLE IF NOT EXISTS migration_progress (
    target_version INTEGER NOT NULL,
    step TEXT NOT NULL,
    cursor TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (target_version, step)
  )`);
}

export const USER_DATA_TABLE_NAMES = [
  "oauth_consumed_codes",
  "_meta",
  "jobs",
  "outbox_events",
  "account",
  "user_settings",
  "credential_locators",
  "ai_client_connections",
  "memos",
  "memo_revisions",
  "topics",
  "documents",
  "document_revisions",
  "source_links",
  "search_entries",
  "search_fts",
  "operations",
  "migration_progress",
] as const;

export const USER_DATA_INDEX_NAMES = [
  "occ_expires_idx",
  "jobs_runnable_idx",
  "jobs_lease_idx",
  "jobs_completed_idx",
  "outbox_runnable_idx",
  "outbox_lease_idx",
  "outbox_completed_idx",
  "cl_hmac_uq",
  "acc_connected_idx",
  "memos_timeline_idx",
  "memos_trash_idx",
  "memos_purge_idx",
  "topics_live_idx",
  "topics_trash_idx",
  "topics_purge_idx",
  "docs_topic_active_idx",
  "docs_topic_trashed_idx",
  "docs_trash_idx",
  "docs_purge_idx",
  "docs_updated_idx",
  "doc_revs_doc_rev_uq",
  "source_links_memo_idx",
  "search_entries_id_uq",
  "search_entries_topic_idx",
  "search_entries_order_idx",
] as const;

export const USER_DATA_PLAN: MigrationPlan<"reindex" | "migrate-bulk"> = {
  targetVersion: 1,
  steps: [{ version: 1, apply: applyUserDataSchemaV1 }],
};
