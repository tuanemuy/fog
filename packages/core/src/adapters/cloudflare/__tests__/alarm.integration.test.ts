import { runDurableObjectAlarm } from "cloudflare:test";
import { DELIVERY_TUNING_DEFAULTS } from "@repo/core/application/delivery/tuning";
import { describe, expect, it } from "vitest";
import { directoryStubOf, inDirectoryStorage } from "./helpers";

type JobStatusRow = Readonly<{
  status: string;
  attempt: number;
  terminal_reason: string | null;
  completed_at: number | null;
  next_run_at: number | null;
  lease_until: number | null;
  owner_token: string | null;
}>;

type OutboxStatusRow = Readonly<{
  status: string;
  attempt: number;
  terminal_reason: string | null;
  completed_at: number | null;
  next_run_at: number | null;
  lease_until: number | null;
  owner_token: string | null;
}>;

// Generation 8000+ is outside the keyring, so no registration routes here.
const BUCKET = { generation: 8000, bucketIndex: 1 } as const;

describe("alarm(): one relay pass and one jobs pass per wake-up", () => {
  it("publishes the due outbox row and finishes the due job in a single wake-up", async () => {
    const stub = directoryStubOf(BUCKET.generation, BUCKET.bucketIndex);
    // The first gated RPC initialises the bucket's schema.
    expect((await stub.readDeliveryBacklog()).ok).toBe(true);

    const now = Date.now();
    const past = now - 1_000;

    await inDirectoryStorage(
      BUCKET.generation,
      BUCKET.bucketIndex,
      async (sql, _instance, state) => {
        state.storage.transactionSync(() => {
          sql.exec(
            `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
             VALUES ('sweep-reservations', 'sweep-reservations', '{}', '{}', 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
            past,
          );
          sql.exec(
            `INSERT INTO outbox_events (id, type, payload, aggregate_id, occurred_at, created_at, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
             VALUES ('evt-alarm-1', 'identity.passwordResetRequested', '{"tokenId":"t","mailKind":"password-reset"}', 'w', ?, ?, 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
            now,
            now,
            past,
          );
        });
        // Armed in the future so workerd does not fire it on its own before
        // `runDurableObjectAlarm` executes it explicitly.
        await state.storage.setAlarm(Date.now() + 60_000);
      },
    );

    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    await inDirectoryStorage(BUCKET.generation, BUCKET.bucketIndex, (sql) => {
      const job = sql
        .exec<JobStatusRow>(
          "SELECT status, attempt, terminal_reason, completed_at, next_run_at, lease_until, owner_token FROM jobs WHERE operation_key = 'sweep-reservations'",
        )
        .one();
      expect(job.status).toBe("done");
      expect(job.attempt).toBe(0);
      expect(job.terminal_reason).toBeNull();
      expect(job.completed_at).not.toBeNull();
      expect(job.next_run_at).toBeNull();
      expect(job.lease_until).toBeNull();
      expect(job.owner_token).toBeNull();

      const event = sql
        .exec<OutboxStatusRow>(
          "SELECT status, attempt, terminal_reason, completed_at, next_run_at, lease_until, owner_token FROM outbox_events WHERE id = 'evt-alarm-1'",
        )
        .one();
      expect(event.status).toBe("published");
      expect(event.attempt).toBe(0);
      expect(event.terminal_reason).toBeNull();
      expect(event.completed_at).not.toBeNull();
      expect(event.next_run_at).toBeNull();
      expect(event.lease_until).toBeNull();
      // `outbox_events` keeps `owner_token` on termination for the send-materials guard.
      expect(event.owner_token).not.toBeNull();

      // Both runnable sets are empty, so the tail re-arm disarmed the DO.
      const runnable = sql
        .exec<{ n: number }>(
          `SELECT (SELECT count(*) FROM jobs WHERE status IN ('pending','running'))
                + (SELECT count(*) FROM outbox_events WHERE status IN ('pending','publishing')) AS n`,
        )
        .one().n;
      expect(runnable).toBe(0);
    });

    await inDirectoryStorage(
      BUCKET.generation,
      BUCKET.bucketIndex,
      async (_sql, _instance, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
      },
    );

    // Nothing is due any more, so a second wake-up is not even scheduled.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("holds the relay's and the jobs pass's count limits independently", async () => {
    const bucket = { generation: 8000, bucketIndex: 2 } as const;
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    expect((await stub.readDeliveryBacklog()).ok).toBe(true);
    const relayLimit = DELIVERY_TUNING_DEFAULTS.relayMaxRowsPerPass;
    const jobsLimit = DELIVERY_TUNING_DEFAULTS.jobsMaxJobsPerPass;
    const past = Date.now() - 1_000;

    await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      async (sql, _instance, state) => {
        state.storage.transactionSync(() => {
          for (let i = 0; i < relayLimit + 2; i += 1) {
            sql.exec(
              `INSERT INTO outbox_events (id, type, payload, aggregate_id, occurred_at, created_at, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
               VALUES (?, 'identity.passwordResetRequested', '{"tokenId":"t","mailKind":"password-reset"}', 'w', ?, ?, 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
              `evt-limit-${i}`,
              past,
              past,
              past,
            );
          }
          for (let i = 0; i < jobsLimit + 2; i += 1) {
            sql.exec(
              `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
               VALUES (?, 'sweep-reservations', '{}', '{}', 0, ?, 'pending', NULL, NULL, NULL, NULL)`,
              `sweep-reservations:limit-${i}`,
              past,
            );
          }
        });
        await state.storage.setAlarm(Date.now() + 60_000);
      },
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      const count = (query: string) => sql.exec<{ n: number }>(query).one().n;
      // A backlog in one table neither eats the other pass's budget nor
      // stops the other pass from running: each spent exactly its own.
      expect(
        count(
          "SELECT count(*) AS n FROM outbox_events WHERE status = 'published'",
        ),
      ).toBe(relayLimit);
      expect(
        count(
          "SELECT count(*) AS n FROM outbox_events WHERE status = 'pending'",
        ),
      ).toBe(2);
      expect(
        count("SELECT count(*) AS n FROM jobs WHERE status = 'done'"),
      ).toBe(jobsLimit);
      expect(
        count("SELECT count(*) AS n FROM jobs WHERE status = 'pending'"),
      ).toBe(2);
    });

    // The tail re-arm left the DO armed on the leftovers' past `next_run_at`,
    // so the next wake-up (whether workerd has already fired it or this
    // call runs it) drains both tables.
    await runDurableObjectAlarm(stub);
    await inDirectoryStorage(bucket.generation, bucket.bucketIndex, (sql) => {
      const left = sql
        .exec<{ n: number }>(
          `SELECT (SELECT count(*) FROM outbox_events WHERE status = 'pending')
                + (SELECT count(*) FROM jobs WHERE status = 'pending') AS n`,
        )
        .one().n;
      expect(left).toBe(0);
    });
  });

  it("re-arms on the earliest lease when every runnable row is claimed", async () => {
    const bucket = { generation: 8000, bucketIndex: 3 } as const;
    const stub = directoryStubOf(bucket.generation, bucket.bucketIndex);
    expect((await stub.readDeliveryBacklog()).ok).toBe(true);
    const now = Date.now();
    const jobLease = now + 30_000;
    const eventLease = now + 45_000;

    await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      async (sql, _instance, state) => {
        state.storage.transactionSync(() => {
          // Claimed rows whose `next_run_at` is already past: re-arming on
          // that value would wake the DO at once, claim nothing, and spin.
          sql.exec(
            `INSERT INTO jobs (operation_key, kind, payload, payload_digest, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
             VALUES ('sweep-reservations', 'sweep-reservations', '{}', '{}', 0, ?, 'running', ?, 'held', NULL, NULL)`,
            now - 5_000,
            jobLease,
          );
          sql.exec(
            `INSERT INTO outbox_events (id, type, payload, aggregate_id, occurred_at, created_at, attempt, next_run_at, status, lease_until, owner_token, terminal_reason, completed_at)
             VALUES ('evt-leased', 'identity.passwordResetRequested', '{"tokenId":"t","mailKind":"password-reset"}', 'w', ?, ?, 0, ?, 'publishing', ?, 'held', NULL, NULL)`,
            now - 5_000,
            now - 5_000,
            now - 5_000,
            eventLease,
          );
        });
        await state.storage.setAlarm(now + 60_000);
      },
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await inDirectoryStorage(
      bucket.generation,
      bucket.bucketIndex,
      async (sql, _instance, state) => {
        expect(
          sql
            .exec<{ status: string; owner_token: string | null }>(
              "SELECT status, owner_token FROM jobs WHERE operation_key = 'sweep-reservations'",
            )
            .one(),
        ).toEqual({ status: "running", owner_token: "held" });
        expect(await state.storage.getAlarm()).toBe(jobLease);
      },
    );
  });
});
