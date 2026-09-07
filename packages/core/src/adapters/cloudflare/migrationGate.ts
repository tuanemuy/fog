import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { MigrationPlan } from "./schema/plan";
import { writeEnqueuedJob } from "./stores/jobWriter";

export type MigrationGateInput = Readonly<{
  storage: DurableObjectStorage;
  plan: MigrationPlan;
  /**
   * The DO's own locator, resolved by the caller from `ctx.id.name`.
   * The gate writes it to `_meta.self_locator` on initialisation and only
   * compares against it afterwards.
   */
  selfLocator: string;
  /**
   * Whether **this** entry may run the initialisation branch.
   *
   * `false` for every production User Data DO entry. The one path allowed
   * to materialise a User Data DO is `initialize-account`, and it does not
   * initialise through the gate at all: it calls
   * {@link applyInitialSchema} from inside the same `transactionSync` as
   * its business write, so a failure in that write leaves the object at
   * zero bytes rather than leaving an initialised but empty one behind.
   * That is what keeps "a signed session for a `userId` that does not
   * exist" from creating an empty DO nobody can find or reclaim.
   *
   * Identity Directory buckets pass `true` unconditionally — their names
   * are bounded by the keyring's bucket count, and the first reservation
   * initialising a bucket is the normal case. Restricting it there would
   * leave every bucket uninitialised and make registration impossible.
   */
  allowInitialize: boolean;
  now: number;
}>;

export type MigrationGateResult = Readonly<{
  schemaVersion: number;
  /**
   * True when this pass seeded at least one job row. The caller re-arms
   * the Alarm on it — `setAlarm()` is asynchronous and cannot be issued
   * from inside the gate, which holds its exclusion by never awaiting.
   */
  seededJobs: boolean;
}>;

type MetaRow = Readonly<{ schema_version: number; self_locator: string }>;

/**
 * The initialisation branch, as a statement sequence a caller can place
 * inside a transaction of its own.
 *
 * **It opens no transaction.** That is the whole reason it exists apart
 * from the gate: `initialize-account` has to commit the schema and its
 * first business rows together, so that a failure in either leaves the
 * Durable Object at zero bytes. An object that kept its tables but lost
 * its account row would hold no mapping, could not be reached from the
 * bucket's user listing, and could be neither found nor reclaimed.
 *
 * The gate wraps this in a transaction of its own for the classes that may
 * still initialise through it.
 *
 * **Job seeds are deliberately not run here**: an object that has just
 * been created holds no rows for a backfill to walk, so seeding would
 * enqueue guaranteed no-ops.
 */
export function applyInitialSchema(
  sql: SqlStorage,
  plan: MigrationPlan,
  selfLocator: string,
): void {
  for (const step of plan.steps) step.apply(sql);
  sql.exec(
    "INSERT INTO _meta (schema_version, self_locator) VALUES (?, ?)",
    plan.targetVersion,
    selfLocator,
  );
}

/** Whether the initialisation branch has already run on this object. */
export function isInitialized(sql: SqlStorage): boolean {
  return readMeta(sql) !== null;
}

/**
 * The schema-version gate that runs at the head of every RPC entry and of
 * `alarm()`.
 *
 * **Two branches, and they commit differently.** The migration branch
 * commits each step in a transaction of its own, here. The initialisation
 * branch is {@link applyInitialSchema}, which this function merely wraps
 * for the classes allowed to initialise through it — the one path that
 * initialises a User Data DO instead calls it inside its own unit of work.
 *
 * **Synchronous throughout, with not one `await`.** `blockConcurrencyWhile`
 * is unusable here (it resets the DO after 30 seconds, and a DO grown to
 * 10 GB has no guarantee of finishing inside one callback), so the input
 * gate is what provides exclusion — and it only does so while no
 * continuation point exists between reading `schema_version` and applying
 * the last step. A single `await` lets a concurrent RPC interleave and
 * observe a half-applied ordered sequence.
 *
 * Each step and its `schema_version` update commit in the same
 * `transactionSync`, so "applied but the version did not move" is not a
 * representable state; a step that fails rolls back whole and is retried
 * from the same point on the next pass. Migrations are forward-only.
 */
export function runMigrationGate(
  input: MigrationGateInput,
): MigrationGateResult {
  const sql = input.storage.sql;
  const meta = readMeta(sql);

  if (meta === null) {
    if (!input.allowInitialize) {
      throw new SystemError(
        SystemErrorCode.NotInitialized,
        "This Durable Object has not been initialised",
      );
    }
    input.storage.transactionSync(() => {
      applyInitialSchema(sql, input.plan, input.selfLocator);
    });
    return { schemaVersion: input.plan.targetVersion, seededJobs: false };
  }

  if (meta.schema_version > input.plan.targetVersion) {
    // Reading nothing is better than corrupting: code that does not know
    // the newer columns would write incomplete rows. Not `poison` — the
    // cause is deployment state, and it clears when the deploy catches up.
    throw new SystemError(
      SystemErrorCode.SchemaVersionAhead,
      `Durable Object schema_version ${meta.schema_version} is ahead of this build (${input.plan.targetVersion})`,
    );
  }

  if (meta.self_locator !== input.selfLocator) {
    throw new SystemError(
      SystemErrorCode.ConfigurationError,
      "Durable Object self locator does not match the stored one",
    );
  }

  let seededJobs = false;
  for (const step of input.plan.steps) {
    if (step.version <= meta.schema_version) continue;
    input.storage.transactionSync(() => {
      step.apply(sql);
      sql.exec("UPDATE _meta SET schema_version = ?", step.version);
      for (const seed of step.seedJobs ?? []) {
        writeEnqueuedJob(sql, {
          operationKey: seed.operationKey,
          kind: seed.kind,
          payload: seed.payload,
          nextRunAt: new Date(input.now),
        });
        seededJobs = true;
      }
    });
  }

  return { schemaVersion: input.plan.targetVersion, seededJobs };
}

/**
 * Reads `_meta` without going through the gate and without writing a
 * single row — this is what lets the `read-schema-version` diagnostic
 * report an uninitialised DO **as** uninitialised instead of creating it.
 */
export function readSchemaVersion(sql: SqlStorage): number | null {
  return readMeta(sql)?.schema_version ?? null;
}

export function readSelfLocator(sql: SqlStorage): string | null {
  return readMeta(sql)?.self_locator ?? null;
}

function readMeta(sql: SqlStorage): MetaRow | null {
  const tables = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_meta'",
    )
    .toArray();
  if (tables.length === 0) return null;
  return (
    sql
      .exec<MetaRow>("SELECT schema_version, self_locator FROM _meta LIMIT 1")
      .toArray()[0] ?? null
  );
}
