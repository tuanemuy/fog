import {
  ConflictError,
  SystemError,
  SystemErrorCode,
  ValidationError,
} from "@repo/core/application/errors";
import { SearchErrorCode } from "@repo/core/application/search/contracts";
import { type DurableSqlStorage, sqliteErrorCode } from "../sql";
import { canonicalJson, payloadDigest } from "./canonical";

const MAX_JOB_PAYLOAD_BYTES = 64 * 1024;
const MAX_CLAIM_BATCH = 25;
const COMPLETED_RETENTION_MS = 7 * 86_400_000;
const POISON_RETENTION_MS = 30 * 86_400_000;

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
    return this.withErrors(() =>
      this.storage.transactionSync(() => {
        this.enqueueInTransaction(input);
        return this.nextRunAtUnchecked();
      }),
    );
  }

  /** Inserts a job in the caller's existing synchronous transaction. */
  enqueueInTransaction(input: {
    id: string;
    kind: string;
    payload: unknown;
    nextRunAt: number;
    providerIdempotencyKey: string;
    now: number;
  }): void {
    const payloadJson = canonicalJson(input.payload);
    if (
      input.id.length === 0 ||
      input.kind.length === 0 ||
      input.providerIdempotencyKey.length === 0 ||
      !Number.isSafeInteger(input.nextRunAt) ||
      !Number.isSafeInteger(input.now)
    ) {
      throw new ValidationError(
        "JOB_INVALID_INPUT",
        "Persistent job input is invalid",
      );
    }
    if (
      new TextEncoder().encode(payloadJson).byteLength > MAX_JOB_PAYLOAD_BYTES
    ) {
      throw new ValidationError(
        "JOB_PAYLOAD_TOO_LARGE",
        "Persistent job payload exceeds 64 KiB",
      );
    }
    const digest = payloadDigest({ kind: input.kind, payload: input.payload });
    const existing = this.storage.sql
      .exec<{
        id: string;
        kind: string;
        payload_digest: string;
        provider_idempotency_key: string;
      }>(
        `SELECT id, kind, payload_digest, provider_idempotency_key
         FROM jobs
         WHERE id = ? OR provider_idempotency_key = ?
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
        input.id,
        input.providerIdempotencyKey,
        input.id,
      )
      .toArray()[0];
    if (existing) {
      if (
        existing.kind !== input.kind ||
        existing.payload_digest !== digest ||
        existing.provider_idempotency_key !== input.providerIdempotencyKey
      ) {
        throw new ConflictError(
          SearchErrorCode.JobIdempotencyConflict,
          "Job ID or provider idempotency key has a different payload",
        );
      }
      return;
    }
    this.storage.sql.exec(
      `INSERT INTO jobs(
         id, kind, payload_json, payload_digest, status, attempt,
         next_run_at, provider_idempotency_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      input.id,
      input.kind,
      payloadJson,
      digest,
      input.nextRunAt,
      input.providerIdempotencyKey,
      input.now,
      input.now,
    );
    this.pruneTerminalUnchecked(input.now);
  }

  claim(input: {
    now: number;
    leaseMs: number;
    ownerToken: string;
    limit: number;
  }): readonly PersistentJob[] {
    return this.withErrors(() =>
      this.storage.transactionSync(() => {
        if (
          !Number.isSafeInteger(input.now) ||
          !Number.isSafeInteger(input.leaseMs) ||
          input.leaseMs < 1_000 ||
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.ownerToken.length === 0
        ) {
          throw new ValidationError(
            "JOB_INVALID_CLAIM",
            "Persistent job claim input is invalid",
          );
        }
        this.pruneTerminalUnchecked(input.now);
        this.storage.sql.exec(
          `UPDATE jobs
           SET status = 'pending', lease_until = NULL, owner_token = NULL,
               updated_at = ?
           WHERE status = 'leased' AND lease_until <= ?`,
          input.now,
          input.now,
        );
        const due = this.storage.sql
          .exec<{
            id: string;
            kind: string;
            payload_json: string;
            payload_digest: string;
            attempt: number;
            provider_idempotency_key: string;
          }>(
            `SELECT id, kind, payload_json, payload_digest, attempt,
                    provider_idempotency_key
             FROM jobs
             WHERE status = 'pending' AND next_run_at <= ?
             ORDER BY next_run_at, id LIMIT ?`,
            input.now,
            Math.min(input.limit, MAX_CLAIM_BATCH),
          )
          .toArray();
        const claimed: PersistentJob[] = [];
        for (const job of due) {
          let payload: unknown;
          try {
            payload = JSON.parse(job.payload_json);
            if (
              payloadDigest({ kind: job.kind, payload }) !== job.payload_digest
            ) {
              throw new Error("PAYLOAD_DIGEST_MISMATCH");
            }
          } catch {
            this.storage.sql.exec(
              `UPDATE jobs
               SET status = 'poison', attempt = attempt + 1,
                   terminal_reason = 'STORED_JOB_PAYLOAD_INVALID',
                   terminal_at = ?, lease_until = NULL, owner_token = NULL,
                   updated_at = ?
               WHERE id = ? AND status = 'pending'`,
              input.now,
              input.now,
              job.id,
            );
            continue;
          }
          const cursor = this.storage.sql.exec(
            `UPDATE jobs
             SET status = 'leased', lease_until = ?, owner_token = ?,
                 attempt = attempt + 1, updated_at = ?
             WHERE id = ? AND status = 'pending'`,
            input.now + input.leaseMs,
            input.ownerToken,
            input.now,
            job.id,
          );
          if (cursor.rowsWritten === 0) continue;
          claimed.push({
            id: job.id,
            kind: job.kind,
            payload,
            attempt: job.attempt + 1,
            ownerToken: input.ownerToken,
            providerIdempotencyKey: job.provider_idempotency_key,
          });
        }
        return claimed;
      }),
    );
  }

  complete(id: string, ownerToken: string, now: number): boolean {
    return this.withErrors(() =>
      this.storage.transactionSync(() => {
        const cursor = this.storage.sql.exec(
          `UPDATE jobs
           SET status = 'completed', lease_until = NULL, owner_token = NULL,
               terminal_at = ?, updated_at = ?
           WHERE id = ? AND status = 'leased' AND owner_token = ?`,
          now,
          now,
          id,
          ownerToken,
        );
        return cursor.rowsWritten > 0;
      }),
    );
  }

  defer(
    id: string,
    ownerToken: string,
    now: number,
    nextRunAt: number,
  ): boolean {
    return this.withErrors(() =>
      this.storage.transactionSync(() => {
        const cursor = this.storage.sql.exec(
          `UPDATE jobs
           SET status = 'pending', next_run_at = ?, lease_until = NULL,
               owner_token = NULL, updated_at = ?
           WHERE id = ? AND status = 'leased' AND owner_token = ?`,
          Math.max(nextRunAt, now + 1),
          now,
          id,
          ownerToken,
        );
        return cursor.rowsWritten > 0;
      }),
    );
  }

  retryOrPoison(input: {
    id: string;
    ownerToken: string;
    now: number;
    maxAttempts: number;
    retryAt: number;
    reason: string;
  }): number | null {
    return this.withErrors(() =>
      this.storage.transactionSync(() => {
        const row = this.storage.sql
          .exec<{ attempt: number }>(
            `SELECT attempt FROM jobs
             WHERE id = ? AND status = 'leased' AND owner_token = ?`,
            input.id,
            input.ownerToken,
          )
          .toArray()[0];
        if (!row) return this.nextRunAtUnchecked();
        if (row.attempt >= input.maxAttempts) {
          this.storage.sql.exec(
            `UPDATE jobs
             SET status = 'poison', terminal_reason = ?, terminal_at = ?,
                 lease_until = NULL, owner_token = NULL, updated_at = ?
             WHERE id = ? AND status = 'leased' AND owner_token = ?`,
            input.reason.slice(0, 512),
            input.now,
            input.now,
            input.id,
            input.ownerToken,
          );
        } else {
          this.storage.sql.exec(
            `UPDATE jobs
             SET status = 'pending', next_run_at = ?, lease_until = NULL,
                 owner_token = NULL, updated_at = ?
             WHERE id = ? AND status = 'leased' AND owner_token = ?`,
            Math.max(input.retryAt, input.now + 1),
            input.now,
            input.id,
            input.ownerToken,
          );
        }
        return this.nextRunAtUnchecked();
      }),
    );
  }

  nextRunAt(): number | null {
    return this.withErrors(() => this.nextRunAtUnchecked());
  }

  pruneTerminal(now: number): number {
    return this.withErrors(() =>
      this.storage.transactionSync(() => this.pruneTerminalUnchecked(now)),
    );
  }

  private nextRunAtUnchecked(): number | null {
    return this.storage.sql
      .exec<{ next_run_at: number | null }>(
        `SELECT MIN(
           CASE
             WHEN status = 'leased' THEN lease_until
             WHEN status = 'pending' THEN next_run_at
             WHEN status = 'completed' THEN terminal_at + ?
             WHEN status = 'poison' THEN terminal_at + ?
           END
         ) AS next_run_at
         FROM jobs`,
        COMPLETED_RETENTION_MS,
        POISON_RETENTION_MS,
      )
      .one().next_run_at;
  }

  private pruneTerminalUnchecked(now: number): number {
    return this.storage.sql.exec(
      `DELETE FROM jobs
       WHERE (status = 'completed' AND terminal_at <= ?)
          OR (status = 'poison' AND terminal_at <= ?)`,
      now - COMPLETED_RETENTION_MS,
      now - POISON_RETENTION_MS,
    ).rowsWritten;
  }

  private withErrors<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (
        error instanceof ConflictError ||
        error instanceof ValidationError ||
        error instanceof SystemError
      ) {
        throw error;
      }
      const code = sqliteErrorCode(error);
      if (code === "SQLITE_FULL") {
        throw new SystemError(
          SystemErrorCode.StorageCapacityExceeded,
          "User data storage capacity was exceeded",
          error,
        );
      }
      throw new SystemError(
        SystemErrorCode.DatabaseError,
        "Persistent job storage operation failed",
        error,
      );
    }
  }
}
