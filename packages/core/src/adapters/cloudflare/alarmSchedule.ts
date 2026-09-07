type MinRow = Readonly<{ v: number | null }>;

function readMin(storage: DurableObjectStorage, query: string): number | null {
  return storage.sql.exec<MinRow>(query).toArray()[0]?.v ?? null;
}

/**
 * The four statements the wake-up time is composed from.
 *
 * **The canonical statement of the issued form is `spec/database/index.md`
 * "Alarm の多重化"; this block restates it on the code side.** Every
 * restatement — this one included — exists because that reader needs it
 * where they stand. Limit — nothing compares the restatements with the
 * canonical one: the `EXPLAIN QUERY PLAN` assertion measures the plan, not
 * the prose, so a change to the mechanism has to be carried to each
 * restatement by hand.
 *
 * **The four are issued as four statements on purpose.** Each one is a
 * leading-column equality plus the minimum of the next column, so each is
 * confined to the rows of a single `status`. Issuing
 * `min(max(next_run_at, lease_until))` as a single statement would need an
 * index keyed on that expression, which does not exist, so it would scan
 * both runnable sets together on every wake-up.
 *
 * **Only the runnable minima carry a redundant predicate, and they have
 * to.** The planner does not infer that `status = 'pending'` implies
 * `*_runnable_idx`'s partial predicate `status IN ('pending','running')`,
 * so it will not use that index unless the statement satisfies the
 * predicate syntactically — hence the `IN` term written out alongside the
 * equality that actually selects. The leased minima need no such term
 * because `*_lease_idx` leads on `status`, which gives the equality a
 * column to seek on directly.
 *
 * **Scope of the protection: dropping either mechanism costs a plan, not
 * an answer.** Without the redundant term the runnable minima fall back
 * to `*_completed_idx (status, completed_at)` — a seek to the status
 * group followed by a scan of it — silently, with nothing thrown. The
 * only thing that notices is the `EXPLAIN QUERY PLAN` assertion in
 * `alarmSchedule.integration.test.ts`, which is why the four statements
 * are exported rather than inlined.
 */
export const ALARM_MINIMUM_QUERIES = [
  `SELECT min(next_run_at) AS v FROM jobs
     WHERE status IN ('pending','running') AND status = 'pending'`,
  `SELECT min(lease_until) AS v FROM jobs
     WHERE status = 'running'`,
  `SELECT min(next_run_at) AS v FROM outbox_events
     WHERE status IN ('pending','publishing') AND status = 'pending'`,
  `SELECT min(lease_until) AS v FROM outbox_events
     WHERE status = 'publishing'`,
] as const;

/**
 * The next wake-up this DO should hold, as the composition of the four
 * minima — or `null` when both runnable sets are empty.
 *
 * **Leased rows count by `lease_until`, not `next_run_at`.** The claim CAS
 * requires the lease to have expired, so a DO left holding nothing but
 * claimed rows would otherwise re-arm on a past `next_run_at`, wake,
 * claim nothing, and re-arm on the same past time — spinning. The
 * composition agrees with the "count leased rows as
 * `max(next_run_at, lease_until)`" reading because on a leased row
 * `next_run_at <= lease_until` always holds: at claim time `next_run_at`
 * is in the past and `lease_until` in the future.
 *
 * **The runnable set is defined by `status` alone.** `next_run_at <= now`
 * is a claim-selection predicate, never part of the set definition:
 * folding it in would let a DO holding only not-yet-due rows satisfy the
 * `deleteAlarm()` condition and never wake again.
 */
export function nextAlarmTime(storage: DurableObjectStorage): number | null {
  const candidates = ALARM_MINIMUM_QUERIES.map((query) =>
    readMin(storage, query),
  ).filter((value): value is number => value !== null);

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/** True while either table still holds a row in its runnable set. */
export function hasRunnableRows(storage: DurableObjectStorage): boolean {
  const rows = storage.sql
    .exec<{ n: number }>(
      `SELECT (SELECT count(*) FROM jobs WHERE status IN ('pending','running'))
            + (SELECT count(*) FROM outbox_events WHERE status IN ('pending','publishing')) AS n`,
    )
    .toArray()[0];
  return (rows?.n ?? 0) > 0;
}

/**
 * The **single entry point** for arming the Alarm.
 *
 * Every path that adds a runnable row calls this right after the write
 * commits — `enqueueJob` / `enqueueEvent`, the `requeue-quarantined-event`
 * re-drive, the migration gate's job seeding, and any path added later.
 * The rule's scope is the fact that a row was added, not a closed list of
 * callers, so a new write path cannot claim to be an exception. Claiming,
 * terminating and pruning are outside it: they add no rows, and the tail
 * of `alarm()` recomputes from both tables anyway.
 *
 * **It arms even on a DO that has called `deleteAlarm()`.** A DO holding
 * only terminated rows is by definition disarmed, so writing a row with
 * `next_run_at = now` into it and not arming would leave that row
 * motionless until someone else happened to touch the DO — and for a
 * dormant Identity Directory bucket, nobody may.
 *
 * The time armed is the four-way minimum, never the `next_run_at` of the
 * row just written: another row or the other table may be due earlier, and
 * passing the new value directly would push an existing wake-up back.
 */
export async function rearm(storage: DurableObjectStorage): Promise<void> {
  const next = nextAlarmTime(storage);
  if (next !== null) {
    await storage.setAlarm(next);
    return;
  }
  // `deleteAlarm()` is conditioned on the runnable sets being empty, not
  // on the minima being absent. The two coincide today because every
  // runnable row carries a time, but conditioning on the set is what the
  // rule says — and if a row ever went runnable without one, disarming
  // would strand it permanently whereas leaving the Alarm alone will not.
  if (hasRunnableRows(storage)) return;
  await storage.deleteAlarm();
}
