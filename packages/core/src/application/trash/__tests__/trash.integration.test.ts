import { runDurableObjectAlarm } from "cloudflare:test";
import {
  inUserDataStorage,
  userDataStubOf,
} from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import { createUserDataUnitOfWorkProvider } from "@repo/core/adapters/cloudflare/unitOfWork";
import {
  isConflictError,
  isNotFoundError,
  isValidationError,
} from "@repo/core/application/errors";
import { changeTrashRetentionDays } from "@repo/core/application/identity/changeTrashRetentionDays";
import { getCurrentUser } from "@repo/core/application/identity/getCurrentUser";
import { getDocument } from "@repo/core/application/knowledge/getDocument";
import { listDocumentSourceMemos } from "@repo/core/application/knowledge/listDocumentSourceMemos";
import { trashDocument } from "@repo/core/application/knowledge/trashDocument";
import { trashTopic } from "@repo/core/application/knowledge/trashTopic";
import { updateTopic } from "@repo/core/application/knowledge/updateTopic";
import { getTimeline } from "@repo/core/application/memo/getTimeline";
import { softDeleteMemo } from "@repo/core/application/memo/softDeleteMemo";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { ConsoleLogger } from "@repo/core/application/ports/logger";
import { search } from "@repo/core/application/search/search";
import { emptyTrash } from "@repo/core/application/trash/emptyTrash";
import { hardDeleteTrashItem } from "@repo/core/application/trash/hardDeleteTrashItem";
import { listTrash } from "@repo/core/application/trash/listTrash";
import { pruneExpiredTrashItems } from "@repo/core/application/trash/pruneExpiredTrashItems";
import { restoreDocument } from "@repo/core/application/trash/restoreDocument";
import { restoreMemo } from "@repo/core/application/trash/restoreMemo";
import { restoreTopic } from "@repo/core/application/trash/restoreTopic";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import {
  document,
  expectCode,
  post,
  purgeJobNextRunAt,
  readTopicRow,
  revisionRows,
  searchEntry,
  topic,
} from "../../knowledge/__tests__/knowledgeFixtures";

const DAY = 86_400_000;

async function setUp() {
  const container = createTestContainer();
  const { userId } = await registerTestUser(container);
  const list = (page = 1, limit = 100) =>
    listTrash({ container, input: { userId, page, limit } });
  const find = (keyword: string) =>
    search({ container, input: { userId, keyword, limit: 50 } });
  return { container, userId, list, find };
}

type Ctx = Awaited<ReturnType<typeof setUp>>;

/** The manual test's fixture: M1/M2 cited by D1 (T1), T2 with D2a/D2b and an individually deleted D4, T3 with D3. */
async function seed({ container, userId }: Ctx) {
  const m1 = await post(container, userId, "ゴミ箱テスト用メモM1 trashfix");
  const m2 = await post(container, userId, "ゴミ箱テスト用メモM2 trashfix");
  const t1 = await topic(container, userId, "ゴミ箱テストT1");
  const d1 = await document(container, userId, t1.id, {
    title: "単独復元用D1",
    body: "D1 trashfix",
    sourceMemoIds: [m1.id, m2.id],
  });
  const t2 = await topic(container, userId, "ゴミ箱テストT2");
  const d2a = await document(container, userId, t2.id, {
    title: "セット削除用D2a",
    body: "D2a trashfix",
  });
  const d2b = await document(container, userId, t2.id, {
    title: "セット削除用D2b",
    body: "D2b trashfix",
    sourceMemoIds: [m1.id],
  });
  const d4 = await document(container, userId, t2.id, {
    title: "個別削除用D4",
    body: "D4 trashfix",
  });
  const t3 = await topic(container, userId, "ゴミ箱テストT3");
  const d3 = await document(container, userId, t3.id, {
    title: "復元先選択用D3",
    body: "D3 trashfix",
  });
  return { m1, m2, t1, d1, t2, d2a, d2b, d4, t3, d3 };
}

/**
 * Makes a row expire at `at` the way time would: the deletion instant moves
 * back by the retention, so the stored deadline still equals
 * `trashed_at + retention` and the recalculation predicate leaves it alone.
 */
async function setPurgeAfter(
  userId: string,
  table: "memos" | "documents" | "topics",
  id: string,
  at: number,
  retentionDays = 30,
) {
  await inUserDataStorage(userId, (sql) => {
    sql.exec(
      `UPDATE ${table} SET purge_after = ?, trashed_at = ? WHERE id = ?`,
      at,
      at - retentionDays * DAY,
      id,
    );
  });
}

function jobRow(userId: string) {
  return inUserDataStorage(
    userId,
    (sql) =>
      sql
        .exec<{
          status: string;
          next_run_at: number | null;
          attempt: number;
          terminal_reason: string | null;
        }>(
          "SELECT status, next_run_at, attempt, terminal_reason FROM jobs WHERE kind = 'purge-trash'",
        )
        .toArray()[0] ?? null,
  );
}

describe("listTrash", () => {
  it("(a) lists the three kinds newest first with the stored deadline, the set relation and paging", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await softDeleteMemo({ container, input: { userId, memoId: s.m1.id } });
    await trashDocument({ container, input: { userId, documentId: s.d1.id } });
    await trashDocument({ container, input: { userId, documentId: s.d4.id } });
    await trashTopic({ container, input: { userId, topicId: s.t2.id } });

    const page = await list();
    expect(page.totalCount).toBe(6);
    expect(page.page).toBe(1);
    const kinds = page.items.map((i) => `${i.kind}:${i.id}`);
    // Newest deletion first: the set (topic + D2a + D2b) at the same instant, then D4, D1, M1.
    expect(kinds.slice(3)).toEqual([
      `document:${s.d4.id}`,
      `document:${s.d1.id}`,
      `memo:${s.m1.id}`,
    ]);
    expect(new Set(kinds.slice(0, 3))).toEqual(
      new Set([
        `topic:${s.t2.id}`,
        `document:${s.d2a.id}`,
        `document:${s.d2b.id}`,
      ]),
    );
    const memoItem = page.items.find((i) => i.kind === "memo");
    expect(memoItem).toMatchObject({
      kind: "memo",
      excerpt: "ゴミ箱テスト用メモM1 trashfix",
    });
    expect(memoItem?.expiresAt.getTime()).toBe(
      (memoItem?.trashedAt.getTime() as number) + 30 * DAY,
    );
    const topicItem = page.items.find((i) => i.kind === "topic");
    expect(topicItem).toMatchObject({ name: "ゴミ箱テストT2" });
    expect(
      [
        ...(topicItem as { setDocumentIds: readonly string[] }).setDocumentIds,
      ].sort(),
    ).toEqual([s.d2a.id, s.d2b.id].sort());
    expect(page.items.find((i) => i.id === s.d4.id)).toMatchObject({
      kind: "document",
      deletedWithTopic: false,
      topicId: s.t2.id,
    });
    expect(page.items.find((i) => i.id === s.d2a.id)).toMatchObject({
      deletedWithTopic: true,
      title: "セット削除用D2a",
    });

    const second = await list(2, 4);
    expect(second.items.map((i) => i.id)).toEqual([s.d1.id, s.m1.id]);
    expect(second.totalCount).toBe(6);
    expect((await list(9, 4)).items).toEqual([]);
    await expectCode(list(0, 10), isValidationError, "INVALID_PAGE");
    await expectCode(list(1, 101), isValidationError, "INVALID_LIMIT");
  });
});

describe("restore", () => {
  it("(b) puts a memo back at its place, out of the trash and into the search index and the citing documents", async () => {
    const ctx = await setUp();
    const { container, userId, list, find } = ctx;
    const s = await seed(ctx);
    await softDeleteMemo({ container, input: { userId, memoId: s.m1.id } });
    expect((await find("メモM1")).count).toBe(0);
    expect((await searchEntry(userId, s.d1.id))?.sourceIds).toEqual([s.m2.id]);

    expect(
      await restoreMemo({ container, input: { userId, memoId: s.m1.id } }),
    ).toEqual({ memoId: s.m1.id });
    expect((await list()).totalCount).toBe(0);
    expect((await find("メモM1")).items.map((i) => i.id)).toEqual([s.m1.id]);
    expect((await searchEntry(userId, s.d1.id))?.sourceIds).toEqual(
      [s.m1.id, s.m2.id].sort(),
    );
    const timeline = await getTimeline({
      container,
      input: { userId, limit: 10 },
    });
    expect(timeline.items.find((i) => i.id === s.m1.id)?.postedAt).toEqual(
      s.m1.postedAt,
    );
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql
          .exec<{ p: number | null }>(
            "SELECT purge_after AS p FROM memos WHERE id = ?",
            s.m1.id,
          )
          .one().p,
      ).toBeNull();
    });
    await expectCode(
      restoreMemo({ container, input: { userId, memoId: s.m1.id } }),
      isNotFoundError,
      "MEMO_NOT_FOUND",
    );
  });

  it("(c) restores a document alone under a live (or archived) topic, touching the topic", async () => {
    const ctx = await setUp();
    const { container, userId, find } = ctx;
    const s = await seed(ctx);
    await trashDocument({ container, input: { userId, documentId: s.d1.id } });
    const before = (await readTopicRow(userId, s.t1.id))?.version ?? -1;
    const out = await restoreDocument({
      container,
      input: { userId, documentId: s.d1.id },
    });
    expect(out).toEqual({
      result: "restored",
      documentId: s.d1.id,
      restoredTopicId: null,
    });
    expect((await readTopicRow(userId, s.t1.id))?.version).toBe(before + 1);
    expect(
      (await getDocument({ container, input: { userId, documentId: s.d1.id } }))
        .topicId,
    ).toBe(s.t1.id);
    expect((await find("D1 trashfix")).items.map((i) => i.id)).toEqual([
      s.d1.id,
    ]);
    expect((await searchEntry(userId, s.m1.id))?.sourceIds).toContain(s.d1.id);

    await updateTopic({
      container,
      input: { userId, topicId: s.t3.id, archived: true },
    });
    await trashDocument({ container, input: { userId, documentId: s.d3.id } });
    expect(
      (
        await restoreDocument({
          container,
          input: { userId, documentId: s.d3.id },
        })
      ).result,
    ).toBe("restored");
    await expectCode(
      restoreDocument({ container, input: { userId, documentId: s.d3.id } }),
      isNotFoundError,
      "TRASH_ITEM_NOT_FOUND",
    );
  });

  it("(d) asks before restoring with a trashed topic, then restores the set — and the document asked for even when it was deleted alone", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await trashDocument({ container, input: { userId, documentId: s.d4.id } });
    await trashTopic({ container, input: { userId, topicId: s.t2.id } });

    const ask = await restoreDocument({
      container,
      input: { userId, documentId: s.d2a.id },
    });
    expect(ask).toEqual({
      result: "setRestoreConfirmationRequired",
      documentId: s.d2a.id,
      topicId: s.t2.id,
      topicName: "ゴミ箱テストT2",
    });
    expect((await list()).totalCount).toBe(4);

    const done = await restoreDocument({
      container,
      input: { userId, documentId: s.d4.id, confirmSetRestore: true },
    });
    expect(done).toEqual({
      result: "restored",
      documentId: s.d4.id,
      restoredTopicId: s.t2.id,
    });
    expect((await list()).totalCount).toBe(0);
    expect((await readTopicRow(userId, s.t2.id))?.status).toBe("active");
    expect(
      (await getDocument({ container, input: { userId, documentId: s.d4.id } }))
        .topicId,
    ).toBe(s.t2.id);
    expect((await searchEntry(userId, s.m1.id))?.sourceIds).toContain(s.d2b.id);
  });

  it("(d2) leaves other individually deleted documents in the trash on a set restore, and a trashed-with-topic restore keeps them too", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await trashDocument({ container, input: { userId, documentId: s.d4.id } });
    await trashTopic({ container, input: { userId, topicId: s.t2.id } });
    const out = await restoreDocument({
      container,
      input: { userId, documentId: s.d2b.id, confirmSetRestore: true },
    });
    expect(out.result).toBe("restored");
    expect((await list()).items.map((i) => i.id)).toEqual([s.d4.id]);
  });

  it("(e) needs a destination once the topic is hard-deleted: an existing live topic, or a new one", async () => {
    const ctx = await setUp();
    const { container, userId, find } = ctx;
    const s = await seed(ctx);
    await trashDocument({ container, input: { userId, documentId: s.d3.id } });
    await trashTopic({ container, input: { userId, topicId: s.t3.id } });
    await hardDeleteTrashItem({
      container,
      input: { userId, kind: "topic", id: s.t3.id },
    });
    expect(await readTopicRow(userId, s.t3.id)).toBeFalsy();

    expect(
      await restoreDocument({
        container,
        input: { userId, documentId: s.d3.id },
      }),
    ).toEqual({
      result: "destinationSelectionRequired",
      documentId: s.d3.id,
    });
    await trashTopic({ container, input: { userId, topicId: s.t2.id } });
    await expectCode(
      restoreDocument({
        container,
        input: {
          userId,
          documentId: s.d3.id,
          destination: { kind: "existing", topicId: s.t2.id },
        },
      }),
      isNotFoundError,
      "TOPIC_NOT_FOUND",
    );
    await expectCode(
      restoreDocument({
        container,
        input: {
          userId,
          documentId: s.d3.id,
          destination: { kind: "new", name: " ", description: null },
        },
      }),
      isBusinessRuleError,
    );
    const before = (await readTopicRow(userId, s.t1.id))?.version ?? -1;
    const moved = await restoreDocument({
      container,
      input: {
        userId,
        documentId: s.d3.id,
        destination: { kind: "existing", topicId: s.t1.id },
      },
    });
    expect(moved).toEqual({
      result: "restored",
      documentId: s.d3.id,
      restoredTopicId: s.t1.id,
    });
    expect((await readTopicRow(userId, s.t1.id))?.version).toBe(before + 1);
    expect(
      (await getDocument({ container, input: { userId, documentId: s.d3.id } }))
        .topicId,
    ).toBe(s.t1.id);
    expect((await find("D3 trashfix")).items[0]).toMatchObject({
      type: "document",
      topicId: s.t1.id,
    });

    await trashDocument({ container, input: { userId, documentId: s.d3.id } });
    await trashTopic({ container, input: { userId, topicId: s.t1.id } });
    await hardDeleteTrashItem({
      container,
      input: { userId, kind: "topic", id: s.t1.id },
    });
    const created = await restoreDocument({
      container,
      input: {
        userId,
        documentId: s.d3.id,
        destination: { kind: "new", name: "新しい置き場", description: null },
      },
    });
    expect(created.result).toBe("restored");
    const newTopicId = (created as { restoredTopicId: string }).restoredTopicId;
    expect(await readTopicRow(userId, newTopicId)).toMatchObject({
      name: "新しい置き場",
      status: "active",
    });
    expect(
      (await getDocument({ container, input: { userId, documentId: s.d3.id } }))
        .topicId,
    ).toBe(newTopicId);
  });

  it("(f) restores a topic with its set, back to archived when it was, leaving the individually deleted document", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await updateTopic({
      container,
      input: { userId, topicId: s.t2.id, archived: true },
    });
    await trashDocument({ container, input: { userId, documentId: s.d4.id } });
    await trashTopic({ container, input: { userId, topicId: s.t2.id } });
    const out = await restoreTopic({
      container,
      input: { userId, topicId: s.t2.id },
    });
    expect(out.topicId).toBe(s.t2.id);
    expect([...out.restoredDocumentIds].sort()).toEqual(
      [s.d2a.id, s.d2b.id].sort(),
    );
    expect((await readTopicRow(userId, s.t2.id))?.status).toBe("archived");
    expect((await list()).items.map((i) => i.id)).toEqual([s.d4.id]);
    await expectCode(
      restoreTopic({ container, input: { userId, topicId: s.t2.id } }),
      isNotFoundError,
      "TOPIC_NOT_FOUND",
    );
  });

  it("(g) reports a concurrent trashTopic as a conflict on the touch and restores nothing", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await trashDocument({ container, input: { userId, documentId: s.d1.id } });
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        "CREATE TRIGGER occ_probe BEFORE UPDATE ON topics BEGIN SELECT RAISE(IGNORE); END",
      );
    });
    await expectCode(
      restoreDocument({ container, input: { userId, documentId: s.d1.id } }),
      isConflictError,
      "OPTIMISTIC_LOCK_FAILURE",
    );
    expect((await list()).totalCount).toBe(1);
  });
});

describe("hard delete and empty", () => {
  it("(h) erases a memo with its revisions and links: the citing documents forget it, search and history have nothing", async () => {
    const ctx = await setUp();
    const { container, userId, find, list } = ctx;
    const s = await seed(ctx);
    await softDeleteMemo({ container, input: { userId, memoId: s.m2.id } });
    await hardDeleteTrashItem({
      container,
      input: { userId, kind: "memo", id: s.m2.id },
    });
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql.exec("SELECT 1 FROM memos WHERE id = ?", s.m2.id).toArray(),
      ).toEqual([]);
      expect(
        sql
          .exec("SELECT 1 FROM memo_revisions WHERE memo_id = ?", s.m2.id)
          .toArray(),
      ).toEqual([]);
      expect(
        sql
          .exec("SELECT 1 FROM source_links WHERE memo_id = ?", s.m2.id)
          .toArray(),
      ).toEqual([]);
    });
    expect((await searchEntry(userId, s.d1.id))?.sourceIds).toEqual([s.m1.id]);
    const sources = await listDocumentSourceMemos({
      container,
      input: { userId, documentId: s.d1.id },
    });
    expect(sources.sourceMemos.map((m) => m.memoId)).toEqual([s.m1.id]);
    expect((await find("メモM2")).count).toBe(0);
    expect((await list()).totalCount).toBe(0);
    await expectCode(
      hardDeleteTrashItem({
        container,
        input: { userId, kind: "memo", id: s.m2.id },
      }),
      isNotFoundError,
      "TRASH_ITEM_NOT_FOUND",
    );
    await expectCode(
      hardDeleteTrashItem({
        container,
        input: { userId, kind: "memo", id: s.m1.id },
      }),
      isNotFoundError,
      "TRASH_ITEM_NOT_FOUND",
    );
  });

  it("(i) erases a topic with its set only; the individually deleted document stays, revisions and links go", async () => {
    const ctx = await setUp();
    const { container, userId, list, find } = ctx;
    const s = await seed(ctx);
    await trashDocument({ container, input: { userId, documentId: s.d4.id } });
    await trashTopic({ container, input: { userId, topicId: s.t2.id } });
    await hardDeleteTrashItem({
      container,
      input: { userId, kind: "topic", id: s.t2.id },
    });
    expect((await list()).items.map((i) => i.id)).toEqual([s.d4.id]);
    expect(await revisionRows(userId, s.d2b.id)).toEqual([]);
    expect((await searchEntry(userId, s.m1.id))?.sourceIds).toEqual([s.d1.id]);
    expect((await find("D2a trashfix")).count).toBe(0);
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql.exec("SELECT 1 FROM topics WHERE id = ?", s.t2.id).toArray(),
      ).toEqual([]);
    });
  });

  it("(j) empties everything once, counting items not rows, and answers 0 on an empty trash", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await softDeleteMemo({ container, input: { userId, memoId: s.m2.id } });
    await trashDocument({ container, input: { userId, documentId: s.d1.id } });
    await trashDocument({ container, input: { userId, documentId: s.d4.id } });
    await trashTopic({ container, input: { userId, topicId: s.t2.id } });
    expect((await list()).totalCount).toBe(6);
    expect(await emptyTrash({ container, input: { userId } })).toEqual({
      deletedCount: 6,
      failedCount: 0,
    });
    expect((await list()).totalCount).toBe(0);
    expect(await emptyTrash({ container, input: { userId } })).toEqual({
      deletedCount: 0,
      failedCount: 0,
    });
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql.exec<{ n: number }>("SELECT count(*) AS n FROM documents").one().n,
      ).toBe(1);
      expect(
        sql.exec<{ n: number }>("SELECT count(*) AS n FROM source_links").one()
          .n,
      ).toBe(0);
    });
  });

  it("(k) defers an item it cannot erase and still erases the rest", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await softDeleteMemo({ container, input: { userId, memoId: s.m1.id } });
    await trashDocument({ container, input: { userId, documentId: s.d4.id } });
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        "CREATE TRIGGER occ_probe BEFORE DELETE ON memos BEGIN SELECT RAISE(IGNORE); END",
      );
    });
    expect(await emptyTrash({ container, input: { userId } })).toEqual({
      deletedCount: 1,
      failedCount: 1,
    });
    expect((await list()).items.map((i) => i.kind)).toEqual(["memo"]);
  });
});

describe("purge-trash", () => {
  function pruneDirectly(
    userId: string,
    now: Date,
    budget: { chunkLimit: number; maxChunks: number },
  ) {
    return inUserDataStorage(userId, (_sql, _instance, state) => {
      const provider = createUserDataUnitOfWorkProvider({
        storage: state.storage,
        clock: SystemClock,
        idGenerator: UuidV7Generator,
        selfLocator: userId,
      });
      return pruneExpiredTrashItems((fn) => provider.run(fn), {
        now,
        budget,
        logger: ConsoleLogger,
      });
    });
  }

  it("(l) the alarm erases the expired rows, re-arms on the next deadline, and finishes on an empty trash", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await softDeleteMemo({ container, input: { userId, memoId: s.m1.id } });
    await trashDocument({ container, input: { userId, documentId: s.d4.id } });
    const past = Date.now() - 60_000;
    await setPurgeAfter(userId, "memos", s.m1.id, past);
    const later = (await list()).items
      .find((i) => i.id === s.d4.id)
      ?.expiresAt.getTime() as number;
    await inUserDataStorage(userId, async (sql, _i, state) => {
      sql.exec(
        "UPDATE jobs SET next_run_at = ? WHERE kind = 'purge-trash'",
        past,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(userDataStubOf(userId))).toBe(true);
    expect((await list()).items.map((i) => i.id)).toEqual([s.d4.id]);
    expect(await jobRow(userId)).toMatchObject({
      status: "pending",
      next_run_at: later,
      attempt: 0,
      terminal_reason: null,
    });

    await setPurgeAfter(userId, "documents", s.d4.id, past);
    await inUserDataStorage(userId, async (sql, _i, state) => {
      sql.exec(
        "UPDATE jobs SET next_run_at = ? WHERE kind = 'purge-trash'",
        past,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(userDataStubOf(userId))).toBe(true);
    expect((await list()).totalCount).toBe(0);
    expect(await jobRow(userId)).toMatchObject({
      status: "done",
      next_run_at: null,
    });
    // A later soft delete revives the done row.
    await softDeleteMemo({ container, input: { userId, memoId: s.m2.id } });
    expect(await jobRow(userId)).toMatchObject({ status: "pending" });
    expect(await purgeJobNextRunAt(userId)).toBe(
      (await list()).items[0]?.expiresAt.getTime(),
    );
  });

  it("(m) judges strictly (`purge_after < now`), never touches what is within its deadline, and takes a set with the topic", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await softDeleteMemo({ container, input: { userId, memoId: s.m1.id } });
    await softDeleteMemo({ container, input: { userId, memoId: s.m2.id } });
    await trashTopic({ container, input: { userId, topicId: s.t2.id } });
    const now = Date.now();
    await setPurgeAfter(userId, "memos", s.m1.id, now);
    await setPurgeAfter(userId, "memos", s.m2.id, now - 1);
    await setPurgeAfter(userId, "topics", s.t2.id, now - 1);
    const out = await pruneDirectly(userId, new Date(now), {
      chunkLimit: 10,
      maxChunks: 5,
    });
    expect(out).toMatchObject({
      processedCount: 2,
      failedCount: 0,
      hasMore: false,
    });
    expect(out.nextPurgeAfter?.getTime()).toBe(now);
    const rest = await list();
    expect(rest.items.map((i) => i.id)).toEqual([s.m1.id]);
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM documents WHERE id IN (?, ?)",
            s.d2a.id,
            s.d2b.id,
          )
          .one().n,
      ).toBe(0);
    });
  });

  it("(n) stops on the chunk budget and leaves the rest for the next wake-up", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const memos = [];
    for (let n = 0; n < 25; n += 1)
      memos.push(await post(container, userId, `expired ${n}`));
    for (const m of memos) {
      await softDeleteMemo({ container, input: { userId, memoId: m.id } });
    }
    // Expire them only once the last soft delete armed the wake-up on a
    // future deadline: a past one would fire the real job mid-fixture.
    const past = Date.now() - 1_000;
    for (const m of memos) await setPurgeAfter(userId, "memos", m.id, past);
    const first = await pruneDirectly(userId, new Date(), {
      chunkLimit: 10,
      maxChunks: 2,
    });
    expect(first).toEqual({
      processedCount: 20,
      failedCount: 0,
      hasMore: true,
      nextPurgeAfter: new Date(past),
    });
    expect((await list()).totalCount).toBe(5);
    const second = await pruneDirectly(userId, new Date(), {
      chunkLimit: 10,
      maxChunks: 2,
    });
    expect(second).toMatchObject({
      processedCount: 5,
      hasMore: false,
      nextPurgeAfter: null,
    });
  });

  it("(o) finishes a pending recalculation before judging anything, so an extension protects the rows", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await softDeleteMemo({ container, input: { userId, memoId: s.m1.id } });
    const past = Date.now() - DAY;
    await setPurgeAfter(userId, "memos", s.m1.id, past);
    // The setting moved to 60 days but the rows were not recalculated (a change that ran out of budget).
    await inUserDataStorage(userId, (sql) => {
      sql.exec("UPDATE user_settings SET trash_retention_days = 60");
    });
    const first = await pruneDirectly(userId, new Date(), {
      chunkLimit: 10,
      maxChunks: 1,
    });
    expect(first).toMatchObject({ processedCount: 0, hasMore: true });
    const item = (await list()).items[0];
    expect(item?.id).toBe(s.m1.id);
    expect(item?.expiresAt.getTime()).toBe(
      (item?.trashedAt.getTime() as number) + 60 * DAY,
    );
    const second = await pruneDirectly(userId, new Date(), {
      chunkLimit: 10,
      maxChunks: 2,
    });
    expect(second).toMatchObject({ processedCount: 0, hasMore: false });
    expect((await list()).totalCount).toBe(1);
  });
});

describe("changeTrashRetentionDays", () => {
  it("(p) recalculates every trashed row's deadline and arms the wake-up on the new earliest", async () => {
    const ctx = await setUp();
    const { container, userId, list } = ctx;
    const s = await seed(ctx);
    await softDeleteMemo({ container, input: { userId, memoId: s.m1.id } });
    await trashDocument({ container, input: { userId, documentId: s.d1.id } });
    await trashTopic({ container, input: { userId, topicId: s.t2.id } });
    await changeTrashRetentionDays({
      container,
      input: { userId, retentionDays: 7 },
    });
    expect(
      (await getCurrentUser({ container, input: { userId } }))
        .trashRetentionDays,
    ).toBe(7);
    const items = (await list()).items;
    // M1, D1 and the set of T2 (D2a, D2b and the still-active D4).
    expect(items).toHaveLength(6);
    for (const item of items) {
      expect(item.expiresAt.getTime()).toBe(item.trashedAt.getTime() + 7 * DAY);
    }
    expect(await purgeJobNextRunAt(userId)).toBe(
      Math.min(...items.map((i) => i.expiresAt.getTime())),
    );
    // Extending re-computes the rows but the wake-up is only ever moved earlier (convergence rule 1).
    const armed = await purgeJobNextRunAt(userId);
    await changeTrashRetentionDays({
      container,
      input: { userId, retentionDays: 60 },
    });
    for (const item of (await list()).items) {
      expect(item.expiresAt.getTime()).toBe(
        item.trashedAt.getTime() + 60 * DAY,
      );
    }
    expect(await purgeJobNextRunAt(userId)).toBe(armed);
    await expectCode(
      changeTrashRetentionDays({
        container,
        input: { userId, retentionDays: 0 },
      }),
      isBusinessRuleError,
      "INVALID_TRASH_RETENTION_DAYS",
    );
    await expectCode(
      changeTrashRetentionDays({
        container,
        input: { userId, retentionDays: 1.5 },
      }),
      isBusinessRuleError,
      "INVALID_TRASH_RETENTION_DAYS",
    );
    // A soft delete after the change takes the new retention.
    await softDeleteMemo({ container, input: { userId, memoId: s.m2.id } });
    const fresh = (await list()).items.find((i) => i.id === s.m2.id);
    expect(fresh?.expiresAt.getTime()).toBe(
      (fresh?.trashedAt.getTime() as number) + 60 * DAY,
    );
  });

  it("(q) on an empty trash changes the setting and arms nothing", async () => {
    const { container, userId } = await setUp();
    await changeTrashRetentionDays({
      container,
      input: { userId, retentionDays: 3 },
    });
    expect(
      (await getCurrentUser({ container, input: { userId } }))
        .trashRetentionDays,
    ).toBe(3);
    expect(await jobRow(userId)).toBeNull();
  });
});
