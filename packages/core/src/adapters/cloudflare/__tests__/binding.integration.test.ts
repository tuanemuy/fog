import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Proves the *binding shape* on its own, before any DDL runs. `useSQLite: true`
// in `vitest.config.integration.ts` is what makes `ctx.storage.sql` exist; if
// this file goes red, the schema tests are failing for an environment reason,
// not a DDL one.
describe("durable object bindings", () => {
  it.each([
    ["USER_DATA", () => env.USER_DATA],
    ["IDENTITY_DIRECTORY", () => env.IDENTITY_DIRECTORY],
  ] as const)("%s is backed by SQLite storage", async (name, get) => {
    const ns = get();
    const stub = ns.get(ns.idFromName(`binding-${name}`));
    const result = await runInDurableObject(stub, (_instance, ctx) =>
      ctx.storage.sql.exec<{ one: number }>("SELECT 1 AS one").one(),
    );
    expect(result.one).toBe(1);
  });
});
