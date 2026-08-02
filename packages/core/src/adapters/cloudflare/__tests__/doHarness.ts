import { env, runInDurableObject } from "cloudflare:test";
import type { DurableObjectState, SqlStorage } from "@cloudflare/workers-types";

/**
 * Runs a synchronous body inside a Durable Object's context, with direct
 * access to its `SqlStorage`. Integration tests for the DO-side adapters use
 * this instead of going through an RPC entry, so that a failure points at the
 * module under test rather than at the entry-point wrapper.
 *
 * Each call takes a distinct `name`, which is also what `ctx.id.name` — and
 * therefore `_meta.self_locator` — resolves to.
 */

type Ctx = { readonly sql: SqlStorage; readonly ctx: DurableObjectState };

function inNamespace(
  namespace: "USER_DATA" | "IDENTITY_DIRECTORY",
  name: string,
) {
  const ns = env[namespace];
  return ns.get(ns.idFromName(name));
}

export function inUserData<T>(name: string, fn: (io: Ctx) => T): Promise<T> {
  const stub = inNamespace("USER_DATA", name);
  return runInDurableObject(stub, (_instance, ctx) =>
    fn({ sql: ctx.storage.sql as SqlStorage, ctx: ctx as DurableObjectState }),
  ) as Promise<T>;
}

export function inIdentityDirectory<T>(
  name: string,
  fn: (io: Ctx) => T,
): Promise<T> {
  const stub = inNamespace("IDENTITY_DIRECTORY", name);
  return runInDurableObject(stub, (_instance, ctx) =>
    fn({ sql: ctx.storage.sql as SqlStorage, ctx: ctx as DurableObjectState }),
  ) as Promise<T>;
}

export function tableNames(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE 'search\\_fts\\_%' ESCAPE '\\'
        ORDER BY name`,
    )
    .toArray()
    .map((row) => row.name);
}

export function ftsShadowTableNames(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name LIKE 'search\\_fts\\_%' ESCAPE '\\'
        ORDER BY name`,
    )
    .toArray()
    .map((row) => row.name);
}

export function indexNames(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE 'search\\_fts\\_%' ESCAPE '\\'
        ORDER BY name`,
    )
    .toArray()
    .map((row) => row.name);
}
