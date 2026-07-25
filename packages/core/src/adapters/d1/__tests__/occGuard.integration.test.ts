import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { occGuard, outboxEvents, users } from "../schema";

// Phase-1 hypothesis check: does the `_occ_guard` CHECK-constraint trick
// actually abort an entire D1 batch when an OCC-guarded UPDATE matches
// zero rows?
//
// The deferred-batch UoW design hinges on this. If D1 happens to commit
// the batch despite the CHECK violation (or if `changes()` does not
// reflect the prior statement's row count inside a batch), the whole
// approach is unworkable and we need a different abort mechanism.
//
// These tests pin the contract end-to-end against a real Workers /
// Miniflare D1 binding.
describe("OCC guard via _occ_guard CHECK constraint", () => {
  const now = new Date();
  const seedRow = (id: string) => ({
    id,
    email: `${id}@example.com`,
    authMethod: "password",
    passwordHash: "stored-hash",
    ssoProvider: null,
    ssoProviderSubject: null,
    trashRetentionDays: 30,
    version: 0,
    createdAt: now,
    updatedAt: now,
  });

  it("aborts the entire batch when the guarded UPDATE matches zero rows", async () => {
    const db = drizzle(env.DB, { schema: { users, occGuard } });
    await db.insert(users).values(seedRow("user-1"));

    // Stale version: row is at v=0, attempt to advance from v=99 → v=100.
    // The UPDATE will match zero rows, the guard INSERT will violate the
    // CHECK constraint, and the entire batch must roll back.
    const stalePreviousVersion = 99;
    const promise = db.batch([
      db
        .update(users)
        .set({ trashRetentionDays: 1, version: 100, updatedAt: now })
        .where(
          sql`${users.id} = 'user-1' AND ${users.version} = ${stalePreviousVersion}`,
        ),
      db.run(
        sql`INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0`,
      ),
    ]);

    await expect(promise).rejects.toThrow();

    // Row must be untouched. If the batch silently succeeded despite the
    // UPDATE matching zero rows, this read would still see v=0 / 30 — which
    // is the same observation, so we also assert the row count and the
    // absence of stray guard rows below.
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "user-1",
      trashRetentionDays: 30,
      version: 0,
    });

    // The guard INSERT must have rolled back too — no stray rows.
    const guardRows = await db.select().from(occGuard);
    expect(guardRows).toHaveLength(0);
  });

  it("commits the batch when the guarded UPDATE matches a row", async () => {
    const db = drizzle(env.DB, { schema: { users, occGuard } });
    await db.insert(users).values(seedRow("user-2"));

    // Matching version → UPDATE touches 1 row → guard SELECT yields no
    // rows → INSERT is a no-op → batch commits cleanly with the guard
    // table left empty.
    await db.batch([
      db
        .update(users)
        .set({ trashRetentionDays: 7, version: 1, updatedAt: now })
        .where(sql`${users.id} = 'user-2' AND ${users.version} = 0`),
      db.run(
        sql`INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0`,
      ),
    ]);

    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "user-2",
      trashRetentionDays: 7,
      version: 1,
    });

    const guardRows = await db.select().from(occGuard);
    expect(guardRows).toHaveLength(0);
  });

  it("rolls back co-batched INSERTs when a later OCC-guarded UPDATE fails", async () => {
    const db = drizzle(env.DB, { schema: { users, occGuard } });
    await db.insert(users).values(seedRow("user-3"));

    // Simulates: aggregate save (UPDATE with stale version) plus an
    // outbox event INSERT in the same batch. The outbox row must NOT
    // be persisted when the OCC check fails — this is the property
    // that makes "writes ⇔ outbox" atomicity hold under D1.
    const promise = db.batch([
      db.insert(outboxEvents).values({
        id: "evt-1",
        eventType: "identity.trashRetentionChanged",
        aggregateId: "user-3",
        payload: {},
        occurredAt: now,
        createdAt: now,
      }),
      db
        .update(users)
        .set({ trashRetentionDays: 1, version: 100, updatedAt: now })
        .where(sql`${users.id} = 'user-3' AND ${users.version} = 99`),
      db.run(
        sql`INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0`,
      ),
    ]);

    await expect(promise).rejects.toThrow();

    const outboxRows = await db.select().from(outboxEvents);
    expect(outboxRows).toHaveLength(0);
  });
});
