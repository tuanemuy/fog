import type { DurableSqlStorage } from "../sql";

export type PersistentJob = Readonly<{
  id: string;
  kind: string;
  payload: unknown;
  attempt: number;
  ownerToken: string;
  providerIdempotencyKey: string;
}>;

export class DurableJobStore {
  constructor(private readonly storage: DurableSqlStorage) {}

  enqueue(input: {
    id: string;
    kind: string;
    payload: unknown;
    nextRunAt: number;
    providerIdempotencyKey: string;
    now: number;
  }): number | null {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO jobs(
           id, kind, payload_json, status, attempt, next_run_at,
           provider_idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
        input.id,
        input.kind,
        JSON.stringify(input.payload),
        input.nextRunAt,
        input.providerIdempotencyKey,
        input.now,
        input.now,
      );
      return this.nextRunAt();
    });
  }

  claim(input: {
    now: number;
    leaseMs: number;
    ownerToken: string;
    limit: number;
  }): readonly PersistentJob[] {
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE jobs SET status = 'pending', lease_until = NULL, owner_token = NULL
         WHERE status = 'leased' AND lease_until <= ?`,
        input.now,
      );
      const due = this.storage.sql
        .exec<{
          id: string;
          kind: string;
          payload_json: string;
          attempt: number;
          provider_idempotency_key: string;
        }>(
          `SELECT id, kind, payload_json, attempt, provider_idempotency_key
           FROM jobs WHERE status = 'pending' AND next_run_at <= ?
           ORDER BY next_run_at, id LIMIT ?`,
          input.now,
          Math.min(Math.max(input.limit, 1), 50),
        )
        .toArray();
      for (const job of due) {
        this.storage.sql.exec(
          `UPDATE jobs SET status = 'leased', lease_until = ?, owner_token = ?,
             attempt = attempt + 1, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
          input.now + input.leaseMs,
          input.ownerToken,
          input.now,
          job.id,
        );
      }
      return due.map((job) => ({
        id: job.id,
        kind: job.kind,
        payload: JSON.parse(job.payload_json) as unknown,
        attempt: job.attempt + 1,
        ownerToken: input.ownerToken,
        providerIdempotencyKey: job.provider_idempotency_key,
      }));
    });
  }

  complete(id: string, ownerToken: string, now: number): boolean {
    return this.storage.transactionSync(() => {
      const cursor = this.storage.sql.exec(
        `UPDATE jobs SET status = 'completed', lease_until = NULL,
           owner_token = NULL, updated_at = ?
         WHERE id = ? AND status = 'leased' AND owner_token = ?`,
        now,
        id,
        ownerToken,
      );
      return cursor.rowsWritten > 0;
    });
  }

  retryOrPoison(input: {
    id: string;
    ownerToken: string;
    now: number;
    maxAttempts: number;
    retryAt: number;
    reason: string;
  }): number | null {
    return this.storage.transactionSync(() => {
      const row = this.storage.sql
        .exec<{ attempt: number }>(
          `SELECT attempt FROM jobs
           WHERE id = ? AND status = 'leased' AND owner_token = ?`,
          input.id,
          input.ownerToken,
        )
        .toArray()[0];
      if (!row) return this.nextRunAt();
      if (row.attempt >= input.maxAttempts) {
        this.storage.sql.exec(
          `UPDATE jobs SET status = 'poison', terminal_reason = ?,
             lease_until = NULL, owner_token = NULL, updated_at = ?
           WHERE id = ? AND owner_token = ?`,
          input.reason.slice(0, 512),
          input.now,
          input.id,
          input.ownerToken,
        );
      } else {
        this.storage.sql.exec(
          `UPDATE jobs SET status = 'pending', next_run_at = ?,
             lease_until = NULL, owner_token = NULL, updated_at = ?
           WHERE id = ? AND owner_token = ?`,
          input.retryAt,
          input.now,
          input.id,
          input.ownerToken,
        );
      }
      return this.nextRunAt();
    });
  }

  nextRunAt(): number | null {
    const row = this.storage.sql
      .exec<{ next_run_at: number | null }>(
        `SELECT MIN(
           CASE WHEN status = 'leased' THEN lease_until ELSE next_run_at END
         ) AS next_run_at
         FROM jobs WHERE status IN ('pending', 'leased')`,
      )
      .one();
    return row.next_run_at;
  }
}
