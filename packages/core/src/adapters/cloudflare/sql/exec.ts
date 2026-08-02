import type { SqlStorage, SqlStorageValue } from "@cloudflare/workers-types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import { translateSqliteError } from "./errors";

/**
 * The only way DO-side code issues SQL. Everything goes through here so that
 * (i) cursor handling is written once, (ii) the 100-bind-parameter platform
 * limit is caught at the call site instead of as an opaque driver failure,
 * and (iii) driver errors are translated into the shared error contracts
 * before any application code sees them.
 *
 * Every function is synchronous: `SqlStorage` is, and that is what lets a
 * whole unit of work run inside one `transactionSync`.
 */

export type Sql = SqlStorage;

export type Row = Record<string, SqlStorageValue>;

const MAX_BIND_PARAMETERS = 100;

function assertBindings(query: string, bindings: readonly unknown[]): void {
  if (bindings.length > MAX_BIND_PARAMETERS) {
    throw new SystemError(
      SystemErrorCode.DataIntegrityError,
      `Query uses ${bindings.length} bind parameters, over the platform limit of ${MAX_BIND_PARAMETERS}. Chunk the statement. Query: ${query}`,
    );
  }
}

export function run(sql: Sql, query: string, ...bindings: unknown[]): void {
  assertBindings(query, bindings);
  try {
    sql.exec(query, ...bindings).toArray();
  } catch (error) {
    translateSqliteError(error);
  }
}

export function all<T extends Row>(
  sql: Sql,
  query: string,
  ...bindings: unknown[]
): T[] {
  assertBindings(query, bindings);
  try {
    return sql.exec<T>(query, ...bindings).toArray();
  } catch (error) {
    return translateSqliteError(error);
  }
}

export function one<T extends Row>(
  sql: Sql,
  query: string,
  ...bindings: unknown[]
): T | null {
  const rows = all<T>(sql, query, ...bindings);
  return rows.length === 0 ? null : (rows[0] as T);
}

export function exists(
  sql: Sql,
  query: string,
  ...bindings: unknown[]
): boolean {
  return all<Row>(sql, query, ...bindings).length > 0;
}
