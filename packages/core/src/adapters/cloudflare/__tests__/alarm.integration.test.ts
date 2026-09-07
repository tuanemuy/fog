import { runDurableObjectAlarm } from "cloudflare:test";
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
    expect(await stub.listBucketUserIds()).toEqual({ ok: true, value: [] });

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
});
