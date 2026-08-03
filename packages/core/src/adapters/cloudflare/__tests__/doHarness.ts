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

/**
 * Takes the Durable Object's alarm away from the platform.
 *
 * **Call this after every real RPC entry whose queue the test then reads or
 * drives itself.** Every gated entry ends in `armAfterRpc`, and `clamp` turns a
 * job that is already due into `setAlarm(now + 1000)` — so one second after the
 * call, workerd delivers a genuine `alarm()` into the middle of the test. That
 * wake-up is a second driver of the same queue: it runs the due jobs with the
 * *Durable Object's own* dependencies (the noop mail sender, since
 * `MAIL_SENDER` is unbound here), settles the rows it ran, and deletes the
 * alarm when nothing is left. A test that counts rows, recipients or
 * `deleteAlarm` calls after that point is measuring a race against the wall
 * clock: it passes while the assertions land inside the first second and fails
 * when the suite is slow enough that they do not.
 *
 * There is no way to stop workerd delivering an alarm that is armed, so the
 * only sound observation is to leave none armed. One second is an eternity next
 * to an RPC that has already returned, so calling this immediately afterwards
 * is not itself a race.
 *
 * Two things it deliberately does not do. It does not touch the instance's
 * `AlarmCache`, so a suite whose subject *is* the arming decision (
 * `jobs/__tests__/alarm.integration.test.ts`) must not use it — there the alarm
 * is the observable. And it does not stop a hand-driven `alarm()` from arming
 * again: `rearmBeforeWork` schedules `MIN_RESUME_INTERVAL_MS` out, which is a
 * minute, so it never comes due inside a test.
 */
export function disarm(
  stub: Parameters<typeof runInDurableObject>[0],
): Promise<void> {
  return runInDurableObject(stub, (_instance, ctx) =>
    ctx.storage.deleteAlarm(),
  ) as Promise<void>;
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
