import type { JobKind } from "./jobKind";

/**
 * Tuning constants for the Alarm job runner.
 *
 * Like `jobKind.ts` this is a leaf: the only import is a *type* import, so no
 * module here is ever evaluated by pulling a constant in. Composition roots
 * and DO execution modules must read tuning values from this file and from
 * nowhere else — an execution module that exports its own `DEFAULT_*` is what
 * dragged module-scope randomness into the top-level Worker in #40.
 *
 * The values are the starting points measured in the #37 spike
 * (`.thread/37/adr.md` の付録). Operational tuning is #38.
 */

/** Outer bound on how many jobs one alarm wake-up may run. */
export const MAX_JOBS_PER_ALARM = 25;

/**
 * How far ahead `alarm()` re-arms itself before doing any work, and the fixed
 * interval a fail-closed DO re-arms at. No backoff is applied to the latter.
 */
export const MIN_RESUME_INTERVAL_MS = 60_000;

/** Claim lease. A `running` row past this is reclaimable (DO reset). */
export const DEFAULT_LEASE_MS = 60_000;

/** Attempts before a job is terminal (`poison` + `terminal_reason`). */
export const DEFAULT_MAX_ATTEMPTS = 8;

/** How long `done` rows survive before the runner prunes them. */
export const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** How long `poison` rows survive; longer, because they need operator eyes. */
export const POISON_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Retention for a `send-mail` row that resolved to no recipient (no mapping,
 * or throttled). `send-mail` is not a re-arming kind, so its surviving `done`
 * row is what refuses a repeat request — this value *is* the throttle window.
 */
export const SEND_MAIL_EMPTY_RETENTION_MS = 15 * 60 * 1000;

/** Upper bound on rows deleted by one prune pass. */
export const PRUNE_ROW_LIMIT = 1000;

export const DEFAULT_CHUNK_ROW_LIMIT = 1000;
export const DEFAULT_MAX_CHUNKS_PER_JOB = 20;

/**
 * Per-kind bound on chunked work: `chunkRowLimit` rows per transaction,
 * `maxChunks` transactions per claim. Bounded by row count, never by elapsed
 * time — `Date.now()` does not advance reliably inside a CPU-bound run, so a
 * time-based cut-off fails to fire exactly when it is needed.
 */
export const CHUNK_BUDGETS: Readonly<
  Record<
    JobKind,
    { readonly chunkRowLimit: number; readonly maxChunks: number }
  >
> = {
  "purge-trash": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  reindex: {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  "migrate-bulk": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  "finalize-withdrawal": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  "sweep-orphan-mapping": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  "resume-link": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  "send-mail": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  "resume-signup": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  "resume-credential-change": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  "sweep-reservations": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  "sweep-reset-tokens": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
  "rotate-encryption": {
    chunkRowLimit: DEFAULT_CHUNK_ROW_LIMIT,
    maxChunks: DEFAULT_MAX_CHUNKS_PER_JOB,
  },
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

/** Exponential backoff, capped. `attempt` is the count of failures so far. */
export function backoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt, 32));
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_MAX_MS);
}
