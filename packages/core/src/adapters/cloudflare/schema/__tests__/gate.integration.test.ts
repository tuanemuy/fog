import { isSystemError } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import {
  ftsShadowTableNames,
  indexNames,
  inIdentityDirectory,
  inUserData,
  tableNames,
} from "../../__tests__/doHarness";
import { readSchemaVersion, readSelfLocator, runMigrationGate } from "../gate";
import {
  IDENTITY_DIRECTORY_CODE_VERSION,
  IDENTITY_DIRECTORY_STEPS,
} from "../identityDirectory";
import { USER_DATA_CODE_VERSION, USER_DATA_STEPS } from "../userData";

const USER_DATA_TABLES = [
  "_meta",
  "account",
  "ai_client_connections",
  "credential_locators",
  "document_revisions",
  "documents",
  "jobs",
  "memo_revisions",
  "memos",
  "migration_progress",
  "operations",
  "search_entries",
  "search_fts",
  "source_links",
  "topics",
  "user_settings",
];

const USER_DATA_INDEXES = [
  "acc_connected_idx",
  "account_singleton_uq",
  "cl_hmac_uq",
  "doc_revs_doc_rev_uq",
  "docs_purge_idx",
  "docs_topic_active_idx",
  "docs_topic_trashed_idx",
  "docs_trash_idx",
  "docs_updated_idx",
  "jobs_completed_idx",
  "jobs_lease_idx",
  "jobs_runnable_idx",
  "memos_purge_idx",
  "memos_timeline_idx",
  "memos_trash_idx",
  "meta_singleton_uq",
  "search_entries_id_uq",
  "search_entries_order_idx",
  "search_entries_topic_idx",
  "source_links_memo_idx",
  "topics_live_idx",
  "topics_purge_idx",
  "topics_trash_idx",
  "user_settings_singleton_uq",
];

const DIRECTORY_TABLES = [
  "_meta",
  "credential_mappings",
  "jobs",
  "password_reset_tokens",
  "rotation_checkpoints",
];

const DIRECTORY_INDEXES = [
  "cm_credential_id_uq",
  "cm_reservation_idx",
  "cm_user_idx",
  "jobs_completed_idx",
  "jobs_lease_idx",
  "jobs_runnable_idx",
  "meta_singleton_uq",
  "prt_credential_idx",
  "prt_expires_idx",
  "prt_token_hash_uq",
];

function gateUserData(name: string) {
  return inUserData(name, ({ ctx, sql }) => {
    runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
    return {
      tables: tableNames(sql),
      shadow: ftsShadowTableNames(sql),
      indexes: indexNames(sql),
      version: readSchemaVersion(sql),
      selfLocator: readSelfLocator(sql),
    };
  });
}

describe("migration gate — User Data DO", () => {
  it("creates all 16 tables on the first pass", async () => {
    const { tables } = await gateUserData("gate-ud-tables");
    // `sqlite_master` is not counted raw: an external-content FTS5 table adds
    // four shadow tables of its own, so the exclusion is what keeps this
    // assertion about the schema instead of about FTS5's internals.
    expect(tables).toEqual(USER_DATA_TABLES);
  });

  it("creates exactly the four FTS5 shadow tables the exclusion filters out", async () => {
    // Asserted directly so the exclusion above cannot pass by matching
    // nothing — an empty result would mean the table is not external-content.
    const { shadow } = await gateUserData("gate-ud-shadow");
    expect(shadow).toEqual([
      "search_fts_config",
      "search_fts_data",
      "search_fts_docsize",
      "search_fts_idx",
    ]);
  });

  it("creates every named index", async () => {
    // `sqlite_autoindex_%` is excluded: inline PRIMARY KEY / UNIQUE generate
    // unnameable indexes, and only the named ones are ours to assert.
    const { indexes } = await gateUserData("gate-ud-indexes");
    expect(indexes).toEqual(USER_DATA_INDEXES);
  });

  it("records the schema version and the self locator", async () => {
    const result = await gateUserData("gate-ud-meta");
    expect(result.version).toBe(USER_DATA_CODE_VERSION);
    expect(result.selfLocator).toBe("gate-ud-meta");
  });

  it("is idempotent", async () => {
    const name = "gate-ud-idempotent";
    await gateUserData(name);
    const second = await inUserData(name, ({ ctx, sql }) => {
      runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
      runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
      return { version: readSchemaVersion(sql), tables: tableNames(sql) };
    });
    expect(second.version).toBe(USER_DATA_CODE_VERSION);
    expect(second.tables).toEqual(USER_DATA_TABLES);
  });

  it("builds search_fts as external content with the trigram tokenizer", async () => {
    const sqlText = await inUserData("gate-ud-fts", ({ ctx, sql }) => {
      runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, "x");
      return (
        sql
          .exec<{ sql: string }>(
            "SELECT sql FROM sqlite_master WHERE name = 'search_fts'",
          )
          .one().sql ?? ""
      );
    });
    expect(sqlText).toContain("content='search_entries'");
    expect(sqlText).toContain("content_rowid='rowid'");
    expect(sqlText).toContain("tokenize='trigram'");
  });

  it("fails closed when the stored version is newer than the code", async () => {
    const name = "gate-ud-failclosed";
    await gateUserData(name);
    const error = await inUserData(name, ({ ctx, sql }) => {
      sql.exec(
        "UPDATE _meta SET schema_version = ?",
        USER_DATA_CODE_VERSION + 1,
      );
      try {
        runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, name);
        return null;
      } catch (thrown) {
        return {
          system: isSystemError(thrown),
          message: (thrown as Error).message,
        };
      }
    });
    expect(error?.system).toBe(true);
    expect(error?.message).toContain("newer than this deployment");
  });

  it("keeps the single-row tables to one row", async () => {
    const outcome = await inUserData("gate-ud-singleton", ({ ctx, sql }) => {
      runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, "x");
      sql.exec(
        "INSERT INTO user_settings (trash_retention_days, version, created_at, updated_at) VALUES (30, 0, 1, 1)",
      );
      try {
        sql.exec(
          "INSERT INTO user_settings (trash_retention_days, version, created_at, updated_at) VALUES (60, 0, 1, 1)",
        );
        return "second row accepted";
      } catch {
        return "second row rejected";
      }
    });
    expect(outcome).toBe("second row rejected");
  });
});

describe("migration gate — Identity Directory DO", () => {
  function gateDirectory(name: string) {
    return inIdentityDirectory(name, ({ ctx, sql }) => {
      runMigrationGate(
        ctx,
        IDENTITY_DIRECTORY_STEPS,
        IDENTITY_DIRECTORY_CODE_VERSION,
        name,
      );
      return {
        tables: tableNames(sql),
        indexes: indexNames(sql),
        version: readSchemaVersion(sql),
        selfLocator: readSelfLocator(sql),
      };
    });
  }

  it("creates all 5 tables and every named index", async () => {
    const result = await gateDirectory("dir:g1:b0001");
    expect(result.tables).toEqual(DIRECTORY_TABLES);
    expect(result.indexes).toEqual(DIRECTORY_INDEXES);
    expect(result.version).toBe(IDENTITY_DIRECTORY_CODE_VERSION);
    expect(result.selfLocator).toBe("dir:g1:b0001");
  });

  it("is idempotent", async () => {
    const name = "dir:g1:b0002";
    await gateDirectory(name);
    const second = await gateDirectory(name);
    expect(second.tables).toEqual(DIRECTORY_TABLES);
    expect(second.version).toBe(IDENTITY_DIRECTORY_CODE_VERSION);
  });
});

// Every column of every table is written and read back once. Without a typed
// query builder (ADR-009) a column-name typo is otherwise invisible until it
// reaches production.
describe("every column round-trips", () => {
  it("User Data DO", async () => {
    const values = await inUserData("gate-ud-columns", ({ ctx, sql }) => {
      runMigrationGate(ctx, USER_DATA_STEPS, USER_DATA_CODE_VERSION, "u1");
      sql.exec(
        "INSERT INTO account (status, session_epoch, deleted_at, caller_token, reset_version, version, created_at, updated_at) VALUES ('active', 1, NULL, 'tok', 2, 0, 10, 11)",
      );
      sql.exec(
        "INSERT INTO user_settings (trash_retention_days, version, created_at, updated_at) VALUES (30, 0, 10, 11)",
      );
      sql.exec(
        "INSERT INTO credential_locators (credential_id, kind, hmac, generation, bucket_index, credential_version, status, usable_for_login, label, created_at, updated_at) VALUES ('c1', 'email', 'ab', 1, 7, 3, 'active', 1, '', 10, 11)",
      );
      sql.exec(
        "INSERT INTO ai_client_connections (id, client_name, scope, status, connected_at, revoked_at, last_used_at, created_at_reset_version, version, created_at, updated_at) VALUES ('ac1', 'cli', 'memo:read', 'active', 10, NULL, 12, 2, 0, 10, 11)",
      );
      sql.exec(
        "INSERT INTO memos (id, body, latest_revision_number, posted_at, status, trashed_at, purge_after, version, updated_at) VALUES ('m1', 'body', 1, 100, 'active', NULL, NULL, 0, 101)",
      );
      sql.exec(
        "INSERT INTO memo_revisions (memo_id, revision_number, actor_type, actor_connection_id, actor_client_name, body, created_at) VALUES ('m1', 1, 'ai_client', 'ac1', 'cli', 'body', 100)",
      );
      sql.exec(
        "INSERT INTO topics (id, name, description, status, trashed_at, purge_after, was_archived, version, created_at, updated_at) VALUES ('t1', 'topic', 'desc', 'active', NULL, NULL, NULL, 0, 10, 11)",
      );
      sql.exec(
        "INSERT INTO documents (id, topic_id, title, body, latest_revision_number, status, trashed_at, purge_after, trashed_with, version, created_at, updated_at) VALUES ('d1', 't1', 'title', 'body', 1, 'active', NULL, NULL, NULL, 0, 10, 11)",
      );
      sql.exec(
        "INSERT INTO document_revisions (id, document_id, revision_number, title, body, actor_type, actor_connection_id, actor_client_name, change_reason, created_at) VALUES ('dr1', 'd1', 1, 'title', 'body', 'user', NULL, NULL, 'created', 10)",
      );
      sql.exec(
        "INSERT INTO source_links (document_id, memo_id, created_at) VALUES ('d1', 'm1', 10)",
      );
      sql.exec(
        "INSERT INTO search_entries (rowid, id, type, topic_id, title, body, timestamp, source_ids) VALUES (1, 'm1', 'memo', NULL, '', 'body', 100, '[]')",
      );
      sql.exec(
        "INSERT INTO search_fts (rowid, title, body) VALUES (1, '', 'body')",
      );
      sql.exec(
        "INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, provider_idempotency_key, terminal_reason, completed_at) VALUES ('purge-trash', 'purge-trash', '{}', 'dg', 0, 200, 'pending', NULL, NULL, NULL, NULL, NULL)",
      );
      sql.exec(
        "INSERT INTO operations (operation_id, kind, payload_digest, phase, target_locators, terminal_reason, created_at) VALUES ('op1', 'signup', 'dg', 'phase-1', '[]', NULL, 10)",
      );
      sql.exec(
        "INSERT INTO migration_progress (target_version, step, cursor, updated_at) VALUES (2, 'reindex', 'c', 10)",
      );
      return {
        account: sql
          .exec(
            "SELECT status, session_epoch, deleted_at, caller_token, reset_version, version, created_at, updated_at FROM account",
          )
          .toArray().length,
        locator: sql
          .exec(
            "SELECT credential_id, kind, hmac, generation, bucket_index, credential_version, status, usable_for_login, label, created_at, updated_at FROM credential_locators",
          )
          .toArray().length,
        connection: sql
          .exec(
            "SELECT id, client_name, scope, status, connected_at, revoked_at, last_used_at, created_at_reset_version, version, created_at, updated_at FROM ai_client_connections",
          )
          .toArray().length,
        memo: sql
          .exec(
            "SELECT id, body, latest_revision_number, posted_at, status, trashed_at, purge_after, version, updated_at FROM memos",
          )
          .toArray().length,
        memoRevision: sql
          .exec(
            "SELECT memo_id, revision_number, actor_type, actor_connection_id, actor_client_name, body, created_at FROM memo_revisions",
          )
          .toArray().length,
        topic: sql
          .exec(
            "SELECT id, name, description, status, trashed_at, purge_after, was_archived, version, created_at, updated_at FROM topics",
          )
          .toArray().length,
        document: sql
          .exec(
            "SELECT id, topic_id, title, body, latest_revision_number, status, trashed_at, purge_after, trashed_with, version, created_at, updated_at FROM documents",
          )
          .toArray().length,
        documentRevision: sql
          .exec(
            "SELECT id, document_id, revision_number, title, body, actor_type, actor_connection_id, actor_client_name, change_reason, created_at FROM document_revisions",
          )
          .toArray().length,
        sourceLink: sql
          .exec("SELECT document_id, memo_id, created_at FROM source_links")
          .toArray().length,
        searchEntry: sql
          .exec(
            "SELECT rowid, id, type, topic_id, title, body, timestamp, source_ids FROM search_entries",
          )
          .toArray().length,
        job: sql
          .exec(
            "SELECT operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, provider_idempotency_key, terminal_reason, completed_at FROM jobs",
          )
          .toArray().length,
        operation: sql
          .exec(
            "SELECT operation_id, kind, payload_digest, phase, target_locators, terminal_reason, created_at FROM operations",
          )
          .toArray().length,
        progress: sql
          .exec(
            "SELECT target_version, step, cursor, updated_at FROM migration_progress",
          )
          .toArray().length,
        settings: sql
          .exec(
            "SELECT trash_retention_days, version, created_at, updated_at FROM user_settings",
          )
          .toArray().length,
        meta: sql
          .exec("SELECT schema_version, self_locator FROM _meta")
          .toArray().length,
      };
    });
    for (const [table, count] of Object.entries(values)) {
      expect(`${table}=${count}`).toBe(`${table}=1`);
    }
  });

  it("Identity Directory DO", async () => {
    const values = await inIdentityDirectory("dir:g1:b0003", ({ ctx, sql }) => {
      runMigrationGate(
        ctx,
        IDENTITY_DIRECTORY_STEPS,
        IDENTITY_DIRECTORY_CODE_VERSION,
        "dir:g1:b0003",
      );
      sql.exec(
        "INSERT INTO credential_mappings (credential_id, kind, hmac, generation, user_id, status, password_verifier, pending_verifier, change_state, change_origin, credential_version, encrypted_canonical, encryption_generation, encryption_nonce, failed_attempts, next_attempt_allowed_at, last_reset_requested_at, operation_id, candidate_user_id, reserved_until, saga_committed, locators, coordinator_locator, caller_token, created_at, updated_at) VALUES ('c1','email','ab',1,'u1','active','pv','pnd','pending','reset',3,'enc',1,'nonce',0,NULL,NULL,'op1','u1',999,1,'[]','dir:g1:b0000','tok',10,11)",
      );
      sql.exec(
        "INSERT INTO password_reset_tokens (token_id, token_hash, credential_id, expires_at, used_at, change_auth_token, consumed_by_operation_id, token_key_generation, created_at) VALUES ('tid','th','c1',999,NULL,NULL,NULL,1,10)",
      );
      sql.exec(
        "INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, provider_idempotency_key, terminal_reason, completed_at) VALUES ('send-mail:1','send-mail','{}','dg',0,200,'pending',NULL,NULL,'idem',NULL,NULL)",
      );
      sql.exec(
        "INSERT INTO rotation_checkpoints (rotation_kind, bucket_index, generation, previous_count, scanned_at, conflict_count, last_conflict_at, last_conflict_credential_id) VALUES ('remap', 1, 1, 0, 10, 0, NULL, NULL)",
      );
      return {
        mapping: sql
          .exec(
            "SELECT credential_id, kind, hmac, generation, user_id, status, password_verifier, pending_verifier, change_state, change_origin, credential_version, encrypted_canonical, encryption_generation, encryption_nonce, failed_attempts, next_attempt_allowed_at, last_reset_requested_at, operation_id, candidate_user_id, reserved_until, saga_committed, locators, coordinator_locator, caller_token, created_at, updated_at FROM credential_mappings",
          )
          .toArray().length,
        token: sql
          .exec(
            "SELECT token_id, token_hash, credential_id, expires_at, used_at, change_auth_token, consumed_by_operation_id, token_key_generation, created_at FROM password_reset_tokens",
          )
          .toArray().length,
        job: sql
          .exec(
            "SELECT operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, provider_idempotency_key, terminal_reason, completed_at FROM jobs",
          )
          .toArray().length,
        checkpoint: sql
          .exec(
            "SELECT rotation_kind, bucket_index, generation, previous_count, scanned_at, conflict_count, last_conflict_at, last_conflict_credential_id FROM rotation_checkpoints",
          )
          .toArray().length,
        meta: sql
          .exec("SELECT schema_version, self_locator FROM _meta")
          .toArray().length,
      };
    });
    for (const [table, count] of Object.entries(values)) {
      expect(`${table}=${count}`).toBe(`${table}=1`);
    }
  });
});

// The fail-closed alarm — no jobs run, no `deleteAlarm`, a fixed-interval
// re-arm — is covered by `__tests__/alarmEntry.integration.test.ts` and
// `jobs/__tests__/alarm.integration.test.ts`, which drive the real DO class.
