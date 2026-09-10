import type { JobKind } from "@repo/core/application/delivery/types";

/**
 * The two `jobs.kind` values that reach the table through the migration
 * gate rather than through `enqueueJob` — they are not enqueued from
 * usecases at all.
 */
export type MigrationSeedableJobKind = Extract<
  JobKind,
  "reindex" | "migrate-bulk"
>;

/**
 * A job the migration gate seeds when a step needs data rewritten or the
 * search index rebuilt.
 *
 * `TKind` is the seeding DO class's own share of
 * {@link MigrationSeedableJobKind}, so the gate is bound to the per-class
 * roster in `spec/async/index.md` on the same terms `enqueueJob` is. A
 * class that owns neither of the two kinds resolves it to `never` and can
 * therefore declare no seed at all.
 *
 * Seeding is a synchronous single-row write, so it does not break the
 * gate's "not one `await`" rule; arming the Alarm for it happens
 * **outside** the gate, because `setAlarm()` is asynchronous.
 */
export type MigrationJobSeed<TKind extends MigrationSeedableJobKind> =
  Readonly<{
    operationKey: string;
    kind: TKind;
    payload: Record<string, unknown>;
  }>;

/**
 * The data-rewriting half of a step, walked by `migrate-bulk` in chunks
 * under a cursor of its own (`spec/database/index.md`, データ書き換えを伴う
 * 部分はジョブへ逃がす). `run` is synchronous and executes inside one
 * transaction per chunk together with the cursor write; it returns the
 * position to resume from, or `null` once nothing is left. Written
 * idempotently, like the DDL: a chunk that committed may be re-run after
 * a reset from the cursor it wrote.
 */
export type BulkStep = Readonly<{
  /** Names the step in `migration_progress.step` (`migrate-bulk:<version>:<name>`). */
  name: string;
  run(
    sql: SqlStorage,
    cursor: string | null,
    limit: number,
  ): Readonly<{ nextCursor: string | null }>;
}>;

/**
 * One forward-only step. `version` is the `schema_version` the DO carries
 * once the step commits; `apply` runs inside the gate's `transactionSync`
 * together with the version update, so "applied but the version did not
 * move" is not a representable state.
 *
 * Steps are written re-runnably (`CREATE TABLE IF NOT EXISTS`), but being
 * idempotent is not the same as being bounded — a `CREATE INDEX` on an
 * already-large table is re-runnable and still will not finish in one
 * input. Work that is not bounded goes to `bulk`, which the step's
 * `migrate-bulk` seed walks after the DDL committed.
 */
export type MigrationStep<TKind extends MigrationSeedableJobKind> = Readonly<{
  version: number;
  apply(sql: SqlStorage): void;
  seedJobs?: readonly MigrationJobSeed<TKind>[];
  bulk?: BulkStep;
}>;

/**
 * The ordered steps this build knows. `targetVersion` is the maximum
 * `schema_version` the code understands; a DO carrying more than that is
 * failed closed rather than written through.
 *
 * **v1 is the whole schema and stays that way until first deployment.**
 * Nothing is deployed yet, so later slices extend v1 in place rather than
 * adding a v2 — `schema_version` moves only after the first production
 * deploy. Without that rule one slice would add a v2 while another
 * extended v1, and the fail-closed gate's expected maximum would diverge
 * between them.
 *
 * Limit — what that rule covers is **adding new objects**. Changing the
 * definition of an existing index or table does not reach a DO that has
 * already run v1, because the step itself never runs there: the gate
 * skips every step whose `version` is `<= schema_version`, so the DDL is
 * not issued at all. `IF NOT EXISTS` is what makes a first application
 * re-runnable, not a way to carry a definition change to an existing DO
 * — so once a single DO instance exists, a definition change needs a v2
 * step of its own and `targetVersion` moved forward with it.
 */
export type MigrationPlan<
  TKind extends MigrationSeedableJobKind = MigrationSeedableJobKind,
> = Readonly<{
  targetVersion: number;
  steps: readonly MigrationStep<TKind>[];
}>;

/**
 * DDL shared by both DO classes: the two asynchronous-work tables and
 * their three indexes each. The Alarm multiplexes both tables, so both
 * classes carry both.
 *
 * **The `status` column of `*_lease_idx` is redundant with that index's
 * own partial predicate, and is there anyway.** SQLite does not use a
 * partial index's predicate to satisfy a `WHERE` term, only to decide the
 * index is usable, so without the leading column the leased minimum has
 * no equality to seek on and the planner answers it from
 * `*_completed_idx` instead. The runnable minima solve the mirror-image
 * problem from the query side, in `alarmSchedule.ts`. That each index
 * exists under the name declared here is pinned by
 * `schema.integration.test.ts`, which compares the whole list of names. A
 * change that leaves the names and the count alone — a column list
 * reworked to `(next_run_at, status)` or `(lease_until, status)`, or a
 * partial predicate widened by a further status — costs the plan and not
 * the answer, so only an `EXPLAIN QUERY PLAN` assertion catches it. There
 * are **two**, covering different statements: `alarmSchedule.integration.test.ts`
 * for the Alarm's four re-arm minima, and `rowRunner.integration.test.ts`
 * for the claim `SELECT`.
 *
 * Measured on the DO pool, identically for both tables:
 *
 *  - `*_runnable_idx` narrowed to `status = 'pending'` — the re-arm's
 *    runnable statement spells that same term out, so it stays
 *    syntactically satisfied and **the re-arm assertion does not catch
 *    it**. The claim spells `status IN ('pending','<leasedStatus>')`,
 *    which no longer is, so it falls to `*_completed_idx` and
 *    `rowRunner.integration.test.ts` turns red.
 *  - The same predicate narrowed to `status IN ('pending')` — SQLite does
 *    not derive the one-element `IN` from the equality either, so the
 *    re-arm statement falls too and **both** assertions turn red.
 *  - `*_lease_idx` narrowed by an added term (`AND lease_until IS NOT NULL`)
 *    — the leased statements spell the predicate's only term, so they
 *    stop satisfying it and `alarmSchedule.integration.test.ts` turns red
 *    on its own. The claim never reads this index.
 *
 * Limits — both assertions measure an empty DO with no `sqlite_stat1`, so
 * the plan under gathered statistics is unmeasured, and the plan is
 * SQLite's, hence version-dependent.
 */
export function applyAsyncWorkTables(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
    operation_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    next_run_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending','running','done','poison')),
    lease_until INTEGER,
    owner_token TEXT,
    terminal_reason TEXT,
    completed_at INTEGER
  )`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS jobs_runnable_idx ON jobs (status, next_run_at) WHERE status IN ('pending','running')`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs (status, lease_until) WHERE status = 'running'`,
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS jobs_completed_idx ON jobs (status, completed_at)",
  );

  // No partial UNIQUE index here on purpose: there is no `dedupe_key`,
  // so there is nothing to deduplicate on. An event is one row, immutable,
  // and never converges — folding two occurrences into one row would lose
  // one delivery.
  sql.exec(`CREATE TABLE IF NOT EXISTS outbox_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    next_run_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending','publishing','published','quarantined')),
    lease_until INTEGER,
    owner_token TEXT,
    terminal_reason TEXT,
    completed_at INTEGER
  )`);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS outbox_runnable_idx ON outbox_events (status, next_run_at) WHERE status IN ('pending','publishing')`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS outbox_lease_idx ON outbox_events (status, lease_until) WHERE status = 'publishing'`,
  );
  sql.exec(
    "CREATE INDEX IF NOT EXISTS outbox_completed_idx ON outbox_events (status, completed_at)",
  );
}

/**
 * `_meta` — two columns, one row.
 *
 * The single-row property is held structurally rather than by a
 * constraint: the migration gate is the only writer in the system (there
 * is no usecase-facing write path to `_meta` at all), and it inserts
 * exactly once, in the initialisation branch, which by definition runs
 * only while the table has no row. A `CHECK` cannot express "one row",
 * and a unique index on a constant expression would buy an index for a
 * property nothing can violate.
 */
export function applyMetaTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS _meta (
    schema_version INTEGER NOT NULL,
    self_locator TEXT NOT NULL
  )`);
}
