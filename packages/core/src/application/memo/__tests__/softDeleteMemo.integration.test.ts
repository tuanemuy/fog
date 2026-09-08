import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import { isNotFoundError } from "@repo/core/application/errors";
import { getTimeline } from "@repo/core/application/memo/getTimeline";
import { softDeleteMemo } from "@repo/core/application/memo/softDeleteMemo";
import { PURGE_TRASH_OPERATION_KEY } from "@repo/core/application/trash/armPurgeTrash";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import {
  countRevisions,
  editAsAiClient,
  expectCode,
  post,
  readMemoRow,
  searchHits,
} from "./memoFixtures";

const DAY_MS = 86_400_000;

type JobRow = Readonly<{
  operation_key: string;
  kind: string;
  status: string;
  next_run_at: number | null;
  payload: string;
}>;

function purgeJob(userId: string): Promise<JobRow | undefined> {
  return inUserDataStorage(
    userId,
    (sql) =>
      sql
        .exec<JobRow>(
          "SELECT operation_key, kind, status, next_run_at, payload FROM jobs WHERE kind = 'purge-trash'",
        )
        .toArray()[0],
  );
}

function setRetentionDays(userId: string, days: number): Promise<void> {
  return inUserDataStorage(userId, (sql) => {
    sql.exec("UPDATE user_settings SET trash_retention_days = ?", days);
  });
}

describe("softDeleteMemo", () => {
  it("(a) moves the memo to the trash with its deadline and drops the projection", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const kept = await post(container, userId, "stays visible");
    const memo = await post(container, userId, "delete me quokka");
    await editAsAiClient(userId, memo.id, "delete me quokka v2", "Claude");
    const before = Date.now();

    await expect(
      softDeleteMemo({ container, input: { userId, memoId: memo.id } }),
    ).resolves.toBeUndefined();

    const row = await readMemoRow(userId, memo.id);
    expect(row).toMatchObject({
      status: "trashed",
      version: 2,
      body: "delete me quokka v2",
      posted_at: memo.postedAt.getTime(),
    });
    if (!row || row.trashed_at === null || row.purge_after === null) {
      throw new Error("the row must carry its trash timestamps");
    }
    expect(row.trashed_at).toBeGreaterThanOrEqual(before);
    expect(row.updated_at).toBe(row.trashed_at);
    expect(row.purge_after).toBe(row.trashed_at + 30 * DAY_MS);

    expect(await countRevisions(userId, memo.id)).toBe(2);
    expect(await searchHits(userId, "quokka")).toEqual([]);
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql
          .exec<{ id: string }>("SELECT id FROM search_entries")
          .toArray()
          .map((r) => r.id),
      ).toEqual([kept.id]);
    });
    const page = await getTimeline({ container, input: { userId } });
    expect(page.items.map((item) => item.id)).toEqual([kept.id]);
  });

  it("(b) answers NotFound twice over and for a blank id", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await post(container, userId, "once");
    await softDeleteMemo({ container, input: { userId, memoId: memo.id } });
    await expectCode(
      softDeleteMemo({ container, input: { userId, memoId: memo.id } }),
      isNotFoundError,
      "MEMO_NOT_FOUND",
    );
    await expectCode(
      softDeleteMemo({ container, input: { userId, memoId: "nope" } }),
      isNotFoundError,
      "MEMO_NOT_FOUND",
    );
    await expectCode(
      softDeleteMemo({ container, input: { userId, memoId: "" } }),
      isBusinessRuleError,
      "INVALID_MEMO_ID",
    );
    expect(await readMemoRow(userId, memo.id)).toMatchObject({
      status: "trashed",
      version: 1,
    });
  });

  it("(c) arms purge-trash on the earliest deadline in the trash, moving it earlier only, and revives a done row", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const first = await post(container, userId, "first");
    const second = await post(container, userId, "second");
    const third = await post(container, userId, "third");
    const fourth = await post(container, userId, "fourth");
    const del = (memoId: string) =>
      softDeleteMemo({ container, input: { userId, memoId } });

    expect(await purgeJob(userId)).toBeUndefined();

    await del(first.id);
    const firstRow = await readMemoRow(userId, first.id);
    const job1 = await purgeJob(userId);
    expect(job1).toEqual({
      operation_key: PURGE_TRASH_OPERATION_KEY,
      kind: "purge-trash",
      status: "pending",
      next_run_at: firstRow?.purge_after,
      payload: "{}",
    });

    // A shorter retention produces an earlier deadline: the wake-up moves.
    await setRetentionDays(userId, 1);
    await del(second.id);
    const secondRow = await readMemoRow(userId, second.id);
    expect(secondRow?.purge_after).toBeLessThan(firstRow?.purge_after ?? 0);
    expect((await purgeJob(userId))?.next_run_at).toBe(secondRow?.purge_after);

    // A later deadline leaves the earlier wake-up where it is.
    await setRetentionDays(userId, 30);
    await del(third.id);
    expect((await purgeJob(userId))?.next_run_at).toBe(secondRow?.purge_after);

    // Rule (3): a `done` row of a re-arming kind comes back as pending, on
    // the earliest deadline still in the trash.
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        "UPDATE jobs SET status = 'done', next_run_at = NULL, completed_at = ? WHERE kind = 'purge-trash'",
        Date.now(),
      );
    });
    await del(fourth.id);
    expect(await purgeJob(userId)).toMatchObject({
      status: "pending",
      next_run_at: secondRow?.purge_after,
    });
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM jobs WHERE kind = 'purge-trash'",
          )
          .one().n,
      ).toBe(1);
    });
  });
});
