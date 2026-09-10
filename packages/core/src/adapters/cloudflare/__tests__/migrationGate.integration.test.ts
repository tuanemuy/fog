import { runDurableObjectAlarm } from "cloudflare:test";
import { createDocument } from "@repo/core/application/knowledge/createDocument";
import { createTopic } from "@repo/core/application/knowledge/createTopic";
import { postMemo } from "@repo/core/application/memo/postMemo";
import { Actor, UserId } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { migrateBulkOperationKey, migrateBulkStep } from "../jobs/migrateBulk";
import { reindexOperationKey } from "../jobs/reindex";
import type { MigrationPlan } from "../schema/plan";
import { USER_DATA_PLAN } from "../schema/userDataPlan";
import { removeSearchEntry } from "../stores/searchProjection";
import {
  inUserDataStorage,
  overrideUserDataPlan,
  userDataStubOf,
} from "./helpers";
import { createTestContainer, registerTestUser } from "./testContainer";

const BULK = "tag-memos";

/** v2: no DDL, a reindex, and a bulk step that tags every memo body once. */
const PLAN_V2: MigrationPlan<"reindex" | "migrate-bulk"> = {
  targetVersion: 2,
  steps: [
    ...USER_DATA_PLAN.steps,
    {
      version: 2,
      apply: () => {},
      seedJobs: [
        {
          operationKey: reindexOperationKey(2),
          kind: "reindex",
          payload: { targetVersion: 2 },
        },
        {
          operationKey: migrateBulkOperationKey(2),
          kind: "migrate-bulk",
          payload: { targetVersion: 2 },
        },
      ],
      bulk: {
        name: BULK,
        run(sql, cursor, limit) {
          const ids = sql
            .exec<{ id: string }>(
              "SELECT id FROM memos WHERE id > ? ORDER BY id LIMIT ?",
              cursor ?? "",
              limit,
            )
            .toArray()
            .map((r) => r.id);
          for (const id of ids) {
            sql.exec(
              "UPDATE memos SET body = body || ' [v2]' WHERE id = ?",
              id,
            );
          }
          const last = ids[ids.length - 1];
          return {
            nextCursor: ids.length < limit || last === undefined ? null : last,
          };
        },
      },
    },
  ],
};

type JobRow = Readonly<{
  operation_key: string;
  status: string;
  payload: string;
}>;

function state(userId: string) {
  return inUserDataStorage(userId, (sql, _i, s) => ({
    version: sql
      .exec<{ schema_version: number }>("SELECT schema_version FROM _meta")
      .one().schema_version,
    jobs: sql
      .exec<JobRow>(
        "SELECT operation_key, status, payload FROM jobs WHERE kind IN ('reindex','migrate-bulk') ORDER BY operation_key",
      )
      .toArray(),
    progress: sql
      .exec<{ target_version: number; step: string; cursor: string }>(
        "SELECT target_version, step, cursor FROM migration_progress ORDER BY step",
      )
      .toArray(),
    entries: sql
      .exec<{ id: string }>("SELECT id FROM search_entries ORDER BY id")
      .toArray()
      .map((r) => r.id),
    bodies: sql
      .exec<{ body: string }>("SELECT body FROM memos ORDER BY id")
      .toArray()
      .map((r) => r.body),
    alarm: s.storage.getAlarm(),
  }));
}

async function runUntilDone(userId: string): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    const { jobs } = await state(userId);
    if (jobs.length === 2 && jobs.every((j) => j.status === "done")) return;
    await inUserDataStorage(userId, async (sql, _i, s) => {
      sql.exec(
        "UPDATE jobs SET next_run_at = ? WHERE status = 'pending'",
        Date.now() - 1_000,
      );
      await s.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(userDataStubOf(userId))).toBe(true);
  }
}

/** Two memos, one topic and one document; the search index holds three entries. */
async function seedContent(userId: string) {
  const container = createTestContainer();
  const actor = Actor.user(UserId.create(userId));
  const first = await postMemo({
    container,
    input: { userId, body: "alpha memo about gardening", actor },
  });
  await postMemo({ container, input: { userId, body: "beta memo", actor } });
  const topic = await createTopic({
    container,
    input: { userId, name: "topic" },
  });
  await createDocument({
    container,
    input: {
      userId,
      actor,
      topicId: topic.id,
      title: "doc",
      body: "document body",
      sourceMemoIds: [first.memo.id],
    },
  });
  return { firstMemoId: first.memo.id };
}

// `jobsMaxRowsPerChunk` is 100, so each walk below is a single chunk; the
// cursor's shape is what the suite pins, not its advancement across chunks.
describe("the migration gate seeds reindex / migrate-bulk and they walk to completion", () => {
  it("through an RPC: the DDL commits with the seeds, the alarm is armed, both jobs finish, the index is rebuilt and the bulk step ran once", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const { firstMemoId } = await seedContent(userId);
    expect((await state(userId)).entries).toHaveLength(3);
    await inUserDataStorage(userId, (sql) => {
      removeSearchEntry(sql, firstMemoId);
    });
    expect((await state(userId)).entries).toHaveLength(2);

    await overrideUserDataPlan(userId, PLAN_V2);
    expect((await userDataStubOf(userId).readAccountState()).ok).toBe(true);
    const seeded = await state(userId);
    expect(seeded.version).toBe(2);
    expect(seeded.jobs.map((j) => j.operation_key)).toEqual([
      migrateBulkOperationKey(2),
      reindexOperationKey(2),
    ]);
    for (const job of seeded.jobs) {
      expect(["pending", "done"]).toContain(job.status);
      expect(JSON.parse(job.payload)).toEqual({ targetVersion: 2 });
    }
    expect(seeded.alarm).not.toBeNull();

    await runUntilDone(userId);
    const done = await state(userId);
    expect(done.jobs.map((j) => j.status)).toEqual(["done", "done"]);
    expect(done.entries).toHaveLength(3);
    expect(done.entries).toContain(firstMemoId);
    const hits = await inUserDataStorage(
      userId,
      (sql) =>
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM search_fts WHERE search_fts MATCH ?",
            "gardening",
          )
          .one().n,
    );
    expect(hits).toBe(1);
    expect(done.bodies).toEqual([
      "alpha memo about gardening [v2]",
      "beta memo [v2]",
    ]);
    expect(done.progress).toEqual([
      {
        target_version: 2,
        step: migrateBulkStep(2, BULK),
        cursor: JSON.stringify({ done: true }),
      },
      {
        target_version: 2,
        step: "reindex",
        cursor: JSON.stringify({ done: true }),
      },
    ]);

    // Passing the gate again seeds nothing and moves no cursor.
    expect((await userDataStubOf(userId).readAccountState()).ok).toBe(true);
    const again = await state(userId);
    expect(again.jobs).toEqual(done.jobs);
    expect(again.progress).toEqual(done.progress);
    expect(again.bodies).toEqual(done.bodies);
  });

  it("through alarm(): the gate seeds during the wake-up and step (4) re-arms for the rows it wrote", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    await seedContent(userId);
    await overrideUserDataPlan(userId, PLAN_V2);
    await inUserDataStorage(userId, async (_s, _i, s) => {
      await s.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(userDataStubOf(userId))).toBe(true);
    const seeded = await state(userId);
    expect(seeded.version).toBe(2);
    expect(seeded.jobs).toHaveLength(2);
    expect(seeded.alarm).not.toBeNull();

    await runUntilDone(userId);
    const done = await state(userId);
    expect(done.jobs.map((j) => j.status)).toEqual(["done", "done"]);
    expect(done.bodies.every((b) => b.endsWith(" [v2]"))).toBe(true);
    expect(done.progress).toHaveLength(2);
  });
});
