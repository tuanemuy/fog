import { JOBS_DDL } from "./jobsDdl";
import { codeVersionOf, type MigrationStep } from "./types";

/**
 * DDL for the User Data Durable Object, transcribed from
 * `spec/database/index.md`「User Data DO のテーブル」. That file is the source
 * of truth; a change there is a change here in the same commit.
 *
 * Version 1 creates **15 tables** — the 16 in the spec minus `_meta`, which
 * only the gate's bootstrap creates so that the authority over
 * `schema_version` stays in one place (`schema/gate.ts`).
 *
 * Statements are plain strings, never template literals: no column name is
 * ever interpolated, so what is written here is what runs.
 *
 * The single-row tables (`account` / `user_settings`) carry no business
 * primary key, and the spec leaves the mechanism open. It is a unique index
 * over a constant-valued expression rather than a surrogate `id` column, so
 * the column list stays verbatim identical to the spec.
 */
const V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS account (
  status TEXT NOT NULL CHECK (status IN ('active','deleting','deleted')),
  session_epoch INTEGER NOT NULL,
  deleted_at INTEGER,
  caller_token TEXT,
  reset_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'deleted' AND deleted_at IS NOT NULL) OR
    (status <> 'deleted' AND deleted_at IS NULL)
  )
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS account_singleton_uq
  ON account ((status IS NOT NULL))`,

  `CREATE TABLE IF NOT EXISTS user_settings (
  trash_retention_days INTEGER NOT NULL CHECK (trash_retention_days >= 1),
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS user_settings_singleton_uq
  ON user_settings ((trash_retention_days IS NOT NULL))`,

  `CREATE TABLE IF NOT EXISTS credential_locators (
  credential_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email','sso')),
  hmac TEXT NOT NULL,
  generation INTEGER NOT NULL,
  bucket_index INTEGER NOT NULL,
  credential_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status = 'active'),
  usable_for_login INTEGER NOT NULL CHECK (usable_for_login IN (0,1)),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (credential_id, generation)
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cl_hmac_uq
  ON credential_locators (kind, hmac, generation)`,

  `CREATE TABLE IF NOT EXISTS ai_client_connections (
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
    (status = 'active'  AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL)
  )
)`,
  `CREATE INDEX IF NOT EXISTS acc_connected_idx
  ON ai_client_connections (connected_at DESC)`,

  `CREATE TABLE IF NOT EXISTS memos (
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
    (status = 'active'  AND trashed_at IS NULL     AND purge_after IS NULL) OR
    (status = 'trashed' AND trashed_at IS NOT NULL AND purge_after IS NOT NULL)
  )
)`,
  `CREATE INDEX IF NOT EXISTS memos_timeline_idx
  ON memos (posted_at DESC, id DESC)
  WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS memos_trash_idx
  ON memos (trashed_at DESC)
  WHERE status = 'trashed'`,
  `CREATE INDEX IF NOT EXISTS memos_purge_idx
  ON memos (purge_after)
  WHERE status = 'trashed'`,

  `CREATE TABLE IF NOT EXISTS memo_revisions (
  memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','ai_client')),
  actor_connection_id TEXT,
  actor_client_name TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memo_id, revision_number),
  CHECK (
    (actor_type = 'user'
      AND actor_connection_id IS NULL AND actor_client_name IS NULL)
    OR
    (actor_type = 'ai_client'
      AND actor_connection_id IS NOT NULL AND actor_client_name IS NOT NULL)
  )
)`,

  `CREATE TABLE IF NOT EXISTS topics (
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
    (status IN ('active','archived')
      AND trashed_at IS NULL AND purge_after IS NULL AND was_archived IS NULL)
    OR
    (status = 'trashed'
      AND trashed_at IS NOT NULL AND purge_after IS NOT NULL
      AND was_archived IS NOT NULL AND was_archived IN (0, 1))
  )
)`,
  `CREATE INDEX IF NOT EXISTS topics_live_idx
  ON topics (status, name)`,
  `CREATE INDEX IF NOT EXISTS topics_trash_idx
  ON topics (trashed_at DESC)
  WHERE status = 'trashed'`,
  `CREATE INDEX IF NOT EXISTS topics_purge_idx
  ON topics (purge_after)
  WHERE status = 'trashed'`,

  `CREATE TABLE IF NOT EXISTS documents (
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
    (status = 'active'
      AND trashed_at IS NULL AND purge_after IS NULL AND trashed_with IS NULL) OR
    (status = 'trashed'
      AND trashed_at IS NOT NULL AND purge_after IS NOT NULL)
  ),
  CHECK (trashed_with IS NULL OR trashed_with = topic_id)
)`,
  `CREATE INDEX IF NOT EXISTS docs_topic_active_idx
  ON documents (topic_id)
  WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS docs_topic_trashed_idx
  ON documents (topic_id)
  WHERE status = 'trashed'`,
  `CREATE INDEX IF NOT EXISTS docs_trash_idx
  ON documents (trashed_at DESC)
  WHERE status = 'trashed'`,
  `CREATE INDEX IF NOT EXISTS docs_purge_idx
  ON documents (purge_after)
  WHERE status = 'trashed'`,
  `CREATE INDEX IF NOT EXISTS docs_updated_idx
  ON documents (updated_at DESC)
  WHERE status = 'active'`,

  `CREATE TABLE IF NOT EXISTS document_revisions (
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
    (actor_type = 'user'
      AND actor_connection_id IS NULL AND actor_client_name IS NULL)
    OR
    (actor_type = 'ai_client'
      AND actor_connection_id IS NOT NULL AND actor_client_name IS NOT NULL)
  )
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS doc_revs_doc_rev_uq
  ON document_revisions (document_id, revision_number)`,

  `CREATE TABLE IF NOT EXISTS source_links (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  memo_id TEXT NOT NULL REFERENCES memos(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, memo_id)
)`,
  `CREATE INDEX IF NOT EXISTS source_links_memo_idx
  ON source_links (memo_id)`,

  `CREATE TABLE IF NOT EXISTS search_entries (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('memo','document')),
  topic_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  source_ids TEXT NOT NULL
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS search_entries_id_uq
  ON search_entries (id)`,
  `CREATE INDEX IF NOT EXISTS search_entries_topic_idx
  ON search_entries (topic_id)
  WHERE topic_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS search_entries_order_idx
  ON search_entries (timestamp DESC, type, id)`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title,
  body,
  content='search_entries',
  content_rowid='rowid',
  tokenize='trigram'
)`,

  ...JOBS_DDL,

  `CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  phase TEXT NOT NULL,
  target_locators TEXT,
  terminal_reason TEXT,
  created_at INTEGER NOT NULL
)`,

  `CREATE TABLE IF NOT EXISTS migration_progress (
  target_version INTEGER NOT NULL,
  step TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_version, step)
)`,
];

export const USER_DATA_STEPS: readonly MigrationStep[] = [
  { version: 1, statements: V1 },
];

export const USER_DATA_CODE_VERSION = codeVersionOf(USER_DATA_STEPS);
