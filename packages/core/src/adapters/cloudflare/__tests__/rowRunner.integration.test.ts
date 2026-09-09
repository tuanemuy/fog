import { describe, expect, it } from "vitest";
import {
  claimCandidatesQuery,
  claimStatement,
  finalizeStatement,
  JOBS_TABLE,
  OUTBOX_TABLE,
  type RowTableDescriptor,
} from "../rowRunner";
import {
  directoryStubOf,
  inDirectoryStorage,
  inUserDataStorage,
} from "./helpers";
import { expectIndexSeek, expectKeySeek, queryPlan } from "./planAssertions";
import { createTestContainer, registerTestUser } from "./testContainer";

// Generation 8200+ is outside the keyring, so no registration routes here.
const BUCKET = { generation: 8200, bucketIndex: 0 } as const;

const TABLES: ReadonlyArray<readonly [RowTableDescriptor, string]> = [
  [JOBS_TABLE, "jobs_runnable_idx"],
  [OUTBOX_TABLE, "outbox_runnable_idx"],
];

function assertRunnerPlans(sql: SqlStorage): void {
  for (const [descriptor, runnableIndex] of TABLES) {
    // The candidate SELECT: the runnable set through the partial index.
    expectIndexSeek(
      queryPlan(sql, claimCandidatesQuery(descriptor)),
      runnableIndex,
    );
    // The claim and the terminal CAS: one row, by its key.
    expectKeySeek(queryPlan(sql, claimStatement(descriptor)), descriptor.table);
    expectKeySeek(
      queryPlan(sql, finalizeStatement(descriptor)),
      descriptor.table,
    );
  }
}

// Same limits as `alarmSchedule.integration.test.ts`: an empty DO, no
// `sqlite_stat1`, SQLite's own version-dependent plan.
describe("row runner: claim and finalize statements seek their declared indexes", () => {
  it("Identity Directory DO", async () => {
    const stub = directoryStubOf(BUCKET.generation, BUCKET.bucketIndex);
    expect((await stub.readDeliveryBacklog()).ok).toBe(true);
    await inDirectoryStorage(BUCKET.generation, BUCKET.bucketIndex, (sql) => {
      assertRunnerPlans(sql);
    });
  });

  it("User Data DO", async () => {
    const { userId } = await registerTestUser(createTestContainer());
    await inUserDataStorage(userId, (sql) => {
      assertRunnerPlans(sql);
    });
  });
});
