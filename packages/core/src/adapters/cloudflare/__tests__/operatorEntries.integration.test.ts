import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerWithPassword } from "../../../application/identity/registerWithPassword";
import {
  deliveryTuning,
  directoryStubOf,
  inDirectoryStorage,
  inUserDataStorage,
  uniqueEmail,
  userDataStubOf,
} from "./helpers";
import {
  bucketOfEmail,
  createTestContainer,
  registerTestUser,
  TEST_PASSWORD,
} from "./testContainer";

function insertPoison(
  sql: SqlStorage,
  key: string,
  completedAt: number,
  reason = "forward-exhausted",
): void {
  sql.exec(
    `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
     VALUES (?, 'sweep-orphan-mapping', '{"secret":"never-listed"}', '{}', 4, NULL, 'poison', NULL, NULL, ?, ?)`,
    key,
    reason,
    completedAt,
  );
}

function insertQuarantined(
  sql: SqlStorage,
  id: string,
  completedAt: number,
): void {
  sql.exec(
    `INSERT INTO outbox_events (id, type, payload, aggregate_id, occurred_at, created_at, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
     VALUES (?, 'identity.passwordResetRequested', '{}', 'agg', ?, ?, 5, NULL, 'quarantined', NULL, 'old-owner-token', 'PUBLISH_FAILED', ?)`,
    id,
    completedAt,
    completedAt,
    completedAt,
  );
}

describe("the poisoned-job entries", () => {
  it("lists five columns oldest first with a keyset cursor, and never the payload", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const stub = userDataStubOf(userId);
    await inUserDataStorage(userId, (sql) => {
      for (let i = 0; i < 3; i++) insertPoison(sql, `poison-${i}`, 1_000 + i);
      insertPoison(
        sql,
        "poison-same",
        1_001,
        "cleanup-material-lost:forward-conflict op",
      );
    });
    const first = await stub.listPoisonedJobs();
    if (!first.ok) throw new Error("listing failed");
    expect(first.value.rows.map((r) => r.operationKey)).toEqual([
      "poison-0",
      "poison-1",
      "poison-same",
      "poison-2",
    ]);
    expect(first.value.rows[0]).toEqual({
      operationKey: "poison-0",
      kind: "sweep-orphan-mapping",
      attempt: 4,
      completedAt: 1_000,
      terminalReason: "forward-exhausted",
    });
    expect(JSON.stringify(first.value)).not.toContain("never-listed");
    expect(first.value.nextCursor).toBeNull();
    // Paging: a page of one at a time walks the same order.
    const withLimit = await inUserDataStorage(
      userId,
      async (_sql, instance) => {
        const page = await instance.listPoisonedJobs({
          completedAt: 1_001,
          operationKey: "poison-1",
        });
        return page.ok ? page.value.rows.map((r) => r.operationKey) : [];
      },
    );
    expect(withLimit).toEqual(["poison-same", "poison-2"]);
    expect(deliveryTuning.listPoisonedJobsLimit).toBe(50);
  });

  it("requeue writes the four columns, keeps the reason and re-arms; delete removes without re-arming", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const stub = userDataStubOf(userId);
    // A DO holding nothing runnable is disarmed. The re-driven row is the
    // orphan sweep over a record it cannot read, so its forward run fails
    // and backs off instead of finishing: the row stays observable.
    await inUserDataStorage(userId, async (sql, _i, state) => {
      sql.exec("DELETE FROM jobs");
      sql.exec(
        `INSERT INTO operations (operation_id, kind, payload_digest, phase, target_locators, terminal_reason, created_at)
         VALUES ('unreadable', 'unlink', '{}', 'deleting', ?, NULL, ?)`,
        JSON.stringify([{ credentialId: "c", kind: "sso", mapping: "nope" }]),
        Date.now(),
      );
      insertPoison(sql, "sweep-orphan-mapping", 5_000, "forward-conflict op-1");
      insertPoison(sql, "p2", 6_000);
      await state.storage.deleteAlarm();
    });
    expect(
      await inUserDataStorage(userId, (_s, _i, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeNull();

    expect(await stub.requeuePoisonedJob("sweep-orphan-mapping")).toEqual({
      ok: true,
      value: { requeued: true },
    });
    const row = await inUserDataStorage(userId, (sql) =>
      sql
        .exec<{
          status: string;
          attempt: number;
          next_run_at: number | null;
          completed_at: number | null;
          terminal_reason: string | null;
        }>(
          "SELECT status, attempt, next_run_at, completed_at, terminal_reason FROM jobs WHERE operation_key = 'sweep-orphan-mapping'",
        )
        .one(),
    );
    // The alarm the re-arm set is due at once and the pool fires it, so
    // the forward run may already have failed once (attempt 1, backoff).
    expect(row).toMatchObject({
      status: "pending",
      completed_at: null,
      terminal_reason: "forward-conflict op-1",
    });
    expect(row.attempt).toBeLessThanOrEqual(1);
    expect(row.next_run_at).not.toBeNull();
    expect(
      await inUserDataStorage(userId, (_s, _i, state) =>
        state.storage.getAlarm(),
      ),
    ).not.toBeNull();
    expect(await stub.requeuePoisonedJob("sweep-orphan-mapping")).toEqual({
      ok: true,
      value: { requeued: false },
    });

    await inUserDataStorage(userId, async (_s, _i, state) => {
      await state.storage.deleteAlarm();
    });
    expect(await stub.deletePoisonedJob("p2")).toEqual({
      ok: true,
      value: { deleted: true },
    });
    expect(await stub.deletePoisonedJob("p2")).toEqual({
      ok: true,
      value: { deleted: false },
    });
    expect(await stub.deletePoisonedJob("sweep-orphan-mapping")).toEqual({
      ok: true,
      value: { deleted: false },
    });
    expect(
      await inUserDataStorage(userId, (_s, _i, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeNull();
  });
});

describe("the quarantined-event entries and the backlog", () => {
  it("delete removes a quarantined row only, without re-arming; the backlog counts the live statuses", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const stub = userDataStubOf(userId);
    await inUserDataStorage(userId, async (sql, _i, state) => {
      insertQuarantined(sql, "q1", 1_000);
      insertQuarantined(sql, "q2", 2_000);
      sql.exec(
        `INSERT INTO outbox_events (id, type, payload, aggregate_id, occurred_at, created_at, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
         VALUES ('live', 'identity.passwordResetRequested', '{}', 'agg', 3000, 3000, 0, 9999999999999, 'pending', NULL, NULL, NULL, NULL)`,
      );
      await state.storage.deleteAlarm();
    });
    expect(await stub.readDeliveryBacklog()).toEqual({
      ok: true,
      value: { pendingCount: 1, publishingCount: 0, oldestCreatedAt: 3000 },
    });
    expect(await stub.deleteQuarantinedEvent("q1")).toEqual({
      ok: true,
      value: { deleted: true },
    });
    expect(await stub.deleteQuarantinedEvent("q1")).toEqual({
      ok: true,
      value: { deleted: false },
    });
    expect(await stub.deleteQuarantinedEvent("live")).toEqual({
      ok: true,
      value: { deleted: false },
    });
    expect(
      await inUserDataStorage(userId, (_s, _i, state) =>
        state.storage.getAlarm(),
      ),
    ).toBeNull();
    const listed = await stub.listQuarantinedEvents();
    expect(listed.ok && listed.value.rows.map((r) => r.eventId)).toEqual([
      "q2",
    ]);
    expect(await stub.requeueQuarantinedEvent("q2")).toEqual({
      ok: true,
      value: { requeued: true },
    });
    // Re-armed at once: the pool fires the due alarm and the relay takes
    // the row on, so what is observable is that it left the quarantine.
    const requeued = await inUserDataStorage(userId, (sql) =>
      sql
        .exec<{ status: string; owner_token: string | null }>(
          "SELECT status, owner_token FROM outbox_events WHERE id = 'q2'",
        )
        .one(),
    );
    expect(requeued.status).not.toBe("quarantined");
    expect(requeued.owner_token).not.toBe("old-owner-token");
  });
});

describe("purge-user-mappings and list-bucket-user-ids", () => {
  it("removes every mapping of the account in the bucket, reserved or active, with its reset tokens", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const bucket = await bucketOfEmail(email);
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    const listed = await stub.listBucketUserIds();
    expect(listed.ok && listed.value).toContain(userId);
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      const credentialId = sql
        .exec<{ credential_id: string }>(
          "SELECT credential_id FROM credential_mappings WHERE user_id = ?",
          userId,
        )
        .one().credential_id;
      sql.exec(
        `INSERT INTO password_reset_tokens (token_id, token_hash, credential_id, expires_at, used_at, change_auth_token, consumed_by_operation_id, token_key_generation, created_at)
         VALUES ('tok-purge', 'h', ?, ?, NULL, NULL, NULL, 1, ?)`,
        credentialId,
        Date.now() + 60_000,
        Date.now(),
      );
    });
    expect(await stub.purgeUserMappings(userId)).toEqual({
      ok: true,
      value: { deletedMappings: 1, deletedTokens: 1 },
    });
    const after = await stub.listBucketUserIds();
    expect(after.ok && after.value).not.toContain(userId);
    // The canonical is free again: the same address registers anew.
    await expect(
      registerWithPassword({
        container,
        input: { email, password: TEST_PASSWORD },
      }),
    ).resolves.toBeDefined();
    expect(await stub.purgeUserMappings(userId)).toEqual({
      ok: true,
      value: { deletedMappings: 0, deletedTokens: 0 },
    });
  });
});

describe("fail-closed: a schema ahead of the code", () => {
  it("every entry answers SCHEMA_VERSION_AHEAD, the alarm is kept at the fixed interval, and the next deploy recovers it", async () => {
    const container = createTestContainer();
    const email = uniqueEmail();
    const { userId } = await registerTestUser(container, { email });
    const stub = userDataStubOf(userId);
    await inUserDataStorage(userId, async (sql, _i, state) => {
      sql.exec("UPDATE _meta SET schema_version = 99");
      // A pending row whose due time is in the past: the spin the fixed
      // interval exists to prevent.
      sql.exec(
        `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
         VALUES ('purge-trash', 'purge-trash', '{}', '{}', 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
        Date.now() - 1_000,
      );
      await state.storage.setAlarm(Date.now() + 1_000);
    });
    const refused = await stub.readAccountState();
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "SCHEMA_VERSION_AHEAD" },
    });
    expect(await stub.listPoisonedJobs()).toMatchObject({
      ok: false,
      error: { code: "SCHEMA_VERSION_AHEAD" },
    });
    // The two diagnostics still answer.
    expect(await stub.readSchemaVersion()).toEqual({
      ok: true,
      value: { schemaVersion: 99 },
    });
    const bucket = await bucketOfEmail(email);
    const bucketStub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      sql.exec("UPDATE _meta SET schema_version = 99");
    });
    expect(await bucketStub.readDeliveryBacklog()).toMatchObject({
      ok: false,
      error: { code: "SCHEMA_VERSION_AHEAD" },
    });
    // `list-bucket-user-ids` is outside the gate: a fail-closed bucket
    // still names its accounts, which is how an operator maps the blast
    // radius (`spec/database/index.md`, PITR).
    const named = await bucketStub.listBucketUserIds();
    expect(named.ok && named.value).toContain(userId);
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      sql.exec("UPDATE _meta SET schema_version = 1");
    });

    const before = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const armed = await inUserDataStorage(userId, (_s, _i, state) =>
      state.storage.getAlarm(),
    );
    expect(armed).not.toBeNull();
    expect((armed ?? 0) - before).toBeGreaterThanOrEqual(
      deliveryTuning.failClosedRearmIntervalMs - 5_000,
    );
    // Nothing ran: the row is untouched.
    const untouched = await inUserDataStorage(userId, (sql) =>
      sql
        .exec<{ status: string; attempt: number }>(
          "SELECT status, attempt FROM jobs WHERE operation_key = 'purge-trash'",
        )
        .one(),
    );
    expect(untouched).toEqual({ status: "pending", attempt: 0 });

    // The deploy catches up.
    await inUserDataStorage(userId, (sql) => {
      sql.exec("UPDATE _meta SET schema_version = 1");
    });
    expect(await stub.readAccountState()).toMatchObject({ ok: true });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const ran = await inUserDataStorage(userId, (sql) =>
      sql
        .exec<{ status: string }>(
          "SELECT status FROM jobs WHERE operation_key = 'purge-trash'",
        )
        .one(),
    );
    expect(ran.status).toBe("done");
  });
});
