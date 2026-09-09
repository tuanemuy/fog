import { describe, expect, it } from "vitest";
import { ALARM_MINIMUM_QUERIES } from "../alarmSchedule";
import {
  directoryStubOf,
  inDirectoryStorage,
  inUserDataStorage,
} from "./helpers";
import { expectIndexSeek, queryPlan } from "./planAssertions";
import { createTestContainer, registerTestUser } from "./testContainer";

// Generation 8100+ is outside the keyring, so no registration routes here.
const BUCKET = { generation: 8100, bucketIndex: 0 } as const;

// One index per statement, in the order `ALARM_MINIMUM_QUERIES` declares
// them: the runnable minimum and the leased minimum of each table.
const EXPECTED_INDEXES = [
  "jobs_runnable_idx",
  "jobs_lease_idx",
  "outbox_runnable_idx",
  "outbox_lease_idx",
] as const;

function assertMinimaPlans(sql: SqlStorage): void {
  expect(ALARM_MINIMUM_QUERIES).toHaveLength(EXPECTED_INDEXES.length);
  ALARM_MINIMUM_QUERIES.forEach((statement, i) => {
    const index = EXPECTED_INDEXES[i];
    if (index === undefined) throw new Error("unreachable");
    expectIndexSeek(queryPlan(sql, statement), index);
  });
}

// The plan is measured on an empty DO with no `sqlite_stat1`: the plan
// under gathered statistics is unmeasured, and the plan is SQLite's,
// hence version-dependent (`schema/plan.ts`).
describe("alarm re-arm minima: each statement seeks its declared index", () => {
  it("Identity Directory DO", async () => {
    const stub = directoryStubOf(BUCKET.generation, BUCKET.bucketIndex);
    expect((await stub.readDeliveryBacklog()).ok).toBe(true);
    await inDirectoryStorage(BUCKET.generation, BUCKET.bucketIndex, (sql) => {
      assertMinimaPlans(sql);
    });
  });

  it("User Data DO", async () => {
    const { userId } = await registerTestUser(createTestContainer());
    await inUserDataStorage(userId, (sql) => {
      assertMinimaPlans(sql);
    });
  });

  // The negative control for the assertion itself: the runnable minimum
  // without its redundant `status IN (...)` term is answered from
  // `jobs_completed_idx`, exactly the silent fallback `alarmSchedule.ts`
  // spells the term out to avoid.
  it("catches the fallback the redundant predicate exists to prevent", async () => {
    await inDirectoryStorage(BUCKET.generation, BUCKET.bucketIndex, (sql) => {
      const plan = queryPlan(
        sql,
        "SELECT min(next_run_at) AS v FROM jobs WHERE status = 'pending'",
      );
      expect(plan.some((line) => line.includes("jobs_runnable_idx"))).toBe(
        false,
      );
      expect(() => expectIndexSeek(plan, "jobs_runnable_idx")).toThrow();
    });
  });
});
