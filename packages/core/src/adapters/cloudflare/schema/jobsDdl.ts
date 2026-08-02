/**
 * `jobs` is byte-for-byte the same table in both DO classes — same 12 columns,
 * same three indexes, same rules (`spec/database/index.md`「jobs（Identity
 * Directory DO）」). Only the `kind` value range differs, and that is enforced
 * by the handler registry rather than by a CHECK, so the DDL is shared here
 * instead of being copied into both schema modules where it could drift.
 */
export const JOBS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS jobs (
  operation_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  next_run_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','poison')),
  lease_until INTEGER,
  owner_token TEXT,
  provider_idempotency_key TEXT,
  terminal_reason TEXT,
  completed_at INTEGER
)`,
  `CREATE INDEX IF NOT EXISTS jobs_runnable_idx
  ON jobs (status, next_run_at)
  WHERE status IN ('pending','running')`,
  `CREATE INDEX IF NOT EXISTS jobs_lease_idx
  ON jobs (lease_until)
  WHERE status = 'running'`,
  `CREATE INDEX IF NOT EXISTS jobs_completed_idx
  ON jobs (status, completed_at)`,
];
