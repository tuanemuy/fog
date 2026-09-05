import type { Client } from "@libsql/client";

export const fogSchema = [
  `CREATE TABLE IF NOT EXISTS fog_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
    retention_days INTEGER NOT NULL DEFAULT 30 CHECK(retention_days > 0)
  )`,
  `CREATE TABLE IF NOT EXISTS fog_password_credentials (
    user_id TEXT PRIMARY KEY REFERENCES fog_users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fog_sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES fog_users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS fog_sessions_user ON fog_sessions(user_id)",
  `CREATE TABLE IF NOT EXISTS fog_auth_attempts (
    key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fog_memos (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES fog_users(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK(length(trim(body)) > 0), created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1),
    deleted_at TEXT, deletion_group TEXT, UNIQUE(id, owner_id)
  )`,
  "CREATE INDEX IF NOT EXISTS fog_memos_timeline ON fog_memos(owner_id, deleted_at, created_at DESC, id DESC)",
  `CREATE TABLE IF NOT EXISTS fog_memo_revisions (
    memo_id TEXT NOT NULL, owner_id TEXT NOT NULL, version INTEGER NOT NULL,
    body TEXT NOT NULL, actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human', 'ai')),
    actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(memo_id, version),
    FOREIGN KEY(memo_id, owner_id) REFERENCES fog_memos(id, owner_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS fog_topics (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES fog_users(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(trim(title))>0), description TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
    deleted_at TEXT, deletion_group TEXT, UNIQUE(id,owner_id)
  )`,
  "CREATE INDEX IF NOT EXISTS fog_topics_owner ON fog_topics(owner_id,deleted_at,completed,updated_at DESC,id DESC)",
  `CREATE TABLE IF NOT EXISTS fog_documents (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES fog_users(id) ON DELETE CASCADE, topic_id TEXT,
    title TEXT NOT NULL CHECK(length(trim(title))>0), body TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1),
    deleted_at TEXT, deletion_group TEXT, UNIQUE(id,owner_id),
    CHECK(topic_id IS NOT NULL OR deleted_at IS NOT NULL),
    FOREIGN KEY(topic_id,owner_id) REFERENCES fog_topics(id,owner_id)
  )`,
  "CREATE INDEX IF NOT EXISTS fog_documents_topic ON fog_documents(owner_id,topic_id,deleted_at,updated_at DESC,id DESC)",
  `CREATE TABLE IF NOT EXISTS fog_document_revisions (
    document_id TEXT NOT NULL, owner_id TEXT NOT NULL, version INTEGER NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason))>0),
    actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','ai')), actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(document_id,version),
    FOREIGN KEY(document_id,owner_id) REFERENCES fog_documents(id,owner_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS fog_document_sources (
    document_id TEXT NOT NULL, memo_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    PRIMARY KEY(document_id,memo_id),
    FOREIGN KEY(document_id,owner_id) REFERENCES fog_documents(id,owner_id) ON DELETE CASCADE,
    FOREIGN KEY(memo_id,owner_id) REFERENCES fog_memos(id,owner_id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS fog_document_sources_memo ON fog_document_sources(owner_id,memo_id)",
  `CREATE TABLE IF NOT EXISTS fog_ai_authorization_requests (
    token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    state TEXT NOT NULL, code_challenge TEXT NOT NULL, expires_at TEXT NOT NULL,
    owner_id TEXT REFERENCES fog_users(id) ON DELETE CASCADE,
    consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
  )`,
  `CREATE TABLE IF NOT EXISTS fog_ai_authorization_codes (
    code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, client_name TEXT NOT NULL,
    redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES fog_users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fog_ai_connections (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES fog_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, client_name TEXT NOT NULL,
    created_at TEXT NOT NULL, last_used_at TEXT, expires_at TEXT NOT NULL, revoked_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS fog_ai_connections_owner ON fog_ai_connections(owner_id,revoked_at,expires_at)",
  `CREATE TABLE IF NOT EXISTS fog_ai_idempotency (
    connection_id TEXT NOT NULL REFERENCES fog_ai_connections(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, operation TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE, resource_kind TEXT CHECK(resource_kind IN ('memo','document','topic')),
    resource_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(connection_id,key_hash),
    CHECK((resource_kind IS NULL AND resource_id IS NULL) OR (resource_kind IS NOT NULL AND resource_id IS NOT NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS fog_google_credentials (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES fog_users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL UNIQUE CHECK(length(subject)>0), email TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS fog_google_credentials_owner ON fog_google_credentials(owner_id)",
  `CREATE TABLE IF NOT EXISTS fog_google_requests (
    state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL,
    return_to TEXT NOT NULL, expires_at TEXT NOT NULL, consumed INTEGER NOT NULL CHECK(consumed IN (0,1)),
    mode TEXT NOT NULL CHECK(mode IN ('login','link')), owner_id TEXT REFERENCES fog_users(id) ON DELETE CASCADE,
    CHECK((mode='login' AND owner_id IS NULL) OR (mode='link' AND owner_id IS NOT NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS fog_password_resets (
    token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES fog_users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS fog_password_resets_owner ON fog_password_resets(owner_id)",
  `CREATE TABLE IF NOT EXISTS fog_account_recovery (
    owner_id TEXT PRIMARY KEY REFERENCES fog_users(id) ON DELETE CASCADE, last_reset_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fog_reset_emails (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES fog_users(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL, reset_url TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
    available_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
    lease_token TEXT, lease_until TEXT,
    CHECK((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
  )`,
  "CREATE INDEX IF NOT EXISTS fog_reset_emails_pending ON fog_reset_emails(available_at,lease_until,expires_at)",
];

export async function migrateFog(client: Client): Promise<void> {
  await client.batch(fogSchema, "write");
  const columns = await client.execute("PRAGMA table_info(fog_documents)");
  if (
    columns.rows.some((row) => row.name === "topic_id" && row.notnull === 1)
  ) {
    const table = (name: string) => {
      const statement = fogSchema.find((sql) =>
        sql.startsWith(`CREATE TABLE IF NOT EXISTS ${name} (`),
      );
      if (!statement) throw new Error(`Missing schema: ${name}`);
      return statement;
    };
    await client.batch(
      [
        table("fog_documents").replace("fog_documents (", "fog_documents_v2 ("),
        "INSERT INTO fog_documents_v2 SELECT * FROM fog_documents",
        "CREATE TABLE fog_document_revisions_backup AS SELECT * FROM fog_document_revisions",
        "CREATE TABLE fog_document_sources_backup AS SELECT * FROM fog_document_sources",
        "DROP TABLE fog_document_sources",
        "DROP TABLE fog_document_revisions",
        "DROP TABLE fog_documents",
        "ALTER TABLE fog_documents_v2 RENAME TO fog_documents",
        table("fog_document_revisions"),
        table("fog_document_sources"),
        "INSERT INTO fog_document_revisions SELECT * FROM fog_document_revisions_backup",
        "INSERT INTO fog_document_sources SELECT * FROM fog_document_sources_backup",
        "DROP TABLE fog_document_revisions_backup",
        "DROP TABLE fog_document_sources_backup",
        ...fogSchema.filter((sql) => sql.startsWith("CREATE INDEX")),
      ],
      "write",
    );
  }
}
