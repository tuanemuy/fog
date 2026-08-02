import type { DurableObjectState } from "@cloudflare/workers-types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import { one, run, type Sql } from "../sql/exec";
import type { MigrationStep } from "./types";

/**
 * Lazy, forward-only schema migration.
 *
 * Call this at the head of **every** RPC entry and of `alarm()`. The only
 * exceptions are the two operator diagnostics (`read-schema-version` /
 * `list-bucket-user-ids`), which write nothing and read nothing shape-dependent.
 *
 * The function is **synchronous and contains no `await`** — from reading
 * `schema_version` through applying every DDL statement. That is what makes
 * the Durable Object's input gate the exclusion mechanism: no other request
 * can interleave, so `blockConcurrencyWhile` is neither used nor needed.
 *
 * Each step applies its statements and advances `schema_version` in **one**
 * `transactionSync`, which makes "applied but not recorded" unrepresentable.
 */
export function runMigrationGate(
  ctx: DurableObjectState,
  steps: readonly MigrationStep[],
  codeVersion: number,
  selfLocator: string,
): void {
  const sql = ctx.storage.sql;

  const current = bootstrap(ctx, selfLocator);

  if (current > codeVersion) {
    // Fail-closed. A DO that has already been migrated by a newer deployment
    // must not be served by this one: forward-only means there is no way to
    // undo the newer step, and serving it would corrupt data silently. The
    // caller sees a SystemError; `alarm()` catches it, re-arms and returns
    // without deleting the alarm.
    throw new SystemError(
      SystemErrorCode.DatabaseError,
      "Schema version is newer than this deployment",
    );
  }

  for (const step of steps) {
    if (step.version <= current) continue;
    ctx.storage.transactionSync(() => {
      for (const statement of step.statements) {
        run(sql, statement);
      }
      run(sql, "UPDATE _meta SET schema_version = ?", step.version);
    });
  }
}

const META_DDL = `CREATE TABLE IF NOT EXISTS _meta (
  schema_version INTEGER NOT NULL,
  self_locator TEXT NOT NULL
)`;

const META_SINGLETON_DDL = `CREATE UNIQUE INDEX IF NOT EXISTS meta_singleton_uq
  ON _meta ((schema_version IS NOT NULL))`;

/**
 * `_meta` is created here and nowhere else — it is deliberately absent from
 * the version-1 step arrays so that the authority over `schema_version` is not
 * split between the gate and the DDL it applies.
 *
 * Table creation and the initial row go in one transaction: a half-created
 * `_meta` would read as "version 0 with no row" and every later gate call
 * would try to bootstrap again.
 */
function bootstrap(ctx: DurableObjectState, selfLocator: string): number {
  const sql = ctx.storage.sql;
  return ctx.storage.transactionSync(() => {
    run(sql, META_DDL);
    run(sql, META_SINGLETON_DDL);
    const row = one<{ schema_version: number }>(
      sql,
      "SELECT schema_version FROM _meta",
    );
    if (row === null) {
      run(
        sql,
        "INSERT INTO _meta (schema_version, self_locator) VALUES (?, ?)",
        0,
        selfLocator,
      );
      return 0;
    }
    return row.schema_version;
  });
}

function metaExists(sql: Sql): boolean {
  const row = one<{ n: number }>(
    sql,
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_meta'",
  );
  return (row?.n ?? 0) > 0;
}

/**
 * Reads `_meta.schema_version` without running the gate, for the two operator
 * diagnostics. Returns 0 for a Durable Object that has never been through the
 * gate — which is the same value the bootstrap writes, so a caller cannot tell
 * "never migrated" apart from "migrated to version 0", and does not need to.
 *
 * Lives here because `_meta` has exactly one owner (this module) and reading
 * it from a DO class would put a second one in play.
 */
export function readSchemaVersion(sql: Sql): number {
  if (!metaExists(sql)) return 0;
  const row = one<{ schema_version: number }>(
    sql,
    "SELECT schema_version FROM _meta",
  );
  return row?.schema_version ?? 0;
}

/** `_meta.self_locator`, or `null` before the gate has ever bootstrapped. */
export function readSelfLocator(sql: Sql): string | null {
  if (!metaExists(sql)) return null;
  const row = one<{ self_locator: string }>(
    sql,
    "SELECT self_locator FROM _meta",
  );
  return row?.self_locator ?? null;
}
