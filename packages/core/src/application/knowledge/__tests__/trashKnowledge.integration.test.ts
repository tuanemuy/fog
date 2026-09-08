import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import {
  isConflictError,
  isNotFoundError,
} from "@repo/core/application/errors";
import { trashDocument } from "@repo/core/application/knowledge/trashDocument";
import { trashTopic } from "@repo/core/application/knowledge/trashTopic";
import { updateTopic } from "@repo/core/application/knowledge/updateTopic";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import {
  document,
  expectCode,
  post,
  purgeJobNextRunAt,
  readDocumentRow,
  readTopicRow,
  searchEntry,
  topic,
} from "./knowledgeFixtures";

const DAY_MS = 86_400_000;

describe("trashDocument", () => {
  it("(a) trashes on its own, drops the entry, re-projects the sources and arms purge-trash", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const memo = await post(container, userId, "source");
    const created = await document(container, userId, t.id, {
      sourceMemoIds: [memo.id],
    });
    expect((await searchEntry(userId, memo.id))?.sourceIds).toEqual([
      created.id,
    ]);
    expect(await purgeJobNextRunAt(userId)).toBeNull();
    const before = Date.now();

    await expect(
      trashDocument({ container, input: { userId, documentId: created.id } }),
    ).resolves.toBeUndefined();
    const row = await readDocumentRow(userId, created.id);
    expect(row).toMatchObject({
      status: "trashed",
      version: 1,
      trashed_with: null,
    });
    if (!row?.trashed_at || !row.purge_after)
      throw new Error("trash fields expected");
    expect(row.trashed_at).toBeGreaterThanOrEqual(before);
    expect(row.purge_after).toBe(row.trashed_at + 30 * DAY_MS);
    expect(await searchEntry(userId, created.id)).toBeNull();
    expect((await searchEntry(userId, memo.id))?.sourceIds).toEqual([]);
    expect(await purgeJobNextRunAt(userId)).toBe(row.purge_after);
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM source_links WHERE document_id = ?",
            created.id,
          )
          .one().n,
      ).toBe(1);
      expect(
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM document_revisions WHERE document_id = ?",
            created.id,
          )
          .one().n,
      ).toBe(1);
    });

    await expectCode(
      trashDocument({ container, input: { userId, documentId: created.id } }),
      isNotFoundError,
      "DOCUMENT_NOT_FOUND",
    );
    await expectCode(
      trashDocument({ container, input: { userId, documentId: "nope" } }),
      isNotFoundError,
      "DOCUMENT_NOT_FOUND",
    );
    await expectCode(
      trashDocument({ container, input: { userId, documentId: "" } }),
      isBusinessRuleError,
      "INVALID_DOCUMENT_ID",
    );
  });
});

describe("trashTopic", () => {
  it("(b) trashes the topic with its active documents as a set, sharing one deadline", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    await updateTopic({
      container,
      input: { userId, topicId: t.id, archived: true },
    });
    const memo = await post(container, userId, "source");
    const d1 = await document(container, userId, t.id, {
      sourceMemoIds: [memo.id],
    });
    const d2 = await document(container, userId, t.id);
    const alone = await document(container, userId, t.id);
    await trashDocument({ container, input: { userId, documentId: alone.id } });

    const result = await trashTopic({
      container,
      input: { userId, topicId: t.id },
    });
    expect(result.topicId).toBe(t.id);
    expect([...result.trashedDocumentIds].sort()).toEqual(
      [d1.id, d2.id].sort(),
    );

    const topicRow = await readTopicRow(userId, t.id);
    expect(topicRow).toMatchObject({ status: "trashed", was_archived: 1 });
    for (const id of [d1.id, d2.id]) {
      const row = await readDocumentRow(userId, id);
      expect(row).toMatchObject({
        status: "trashed",
        trashed_with: t.id,
        purge_after: topicRow?.purge_after,
      });
      expect(await searchEntry(userId, id)).toBeNull();
    }
    expect(await readDocumentRow(userId, alone.id)).toMatchObject({
      status: "trashed",
      trashed_with: null,
    });
    expect((await searchEntry(userId, memo.id))?.sourceIds).toEqual([]);
    // The wake-up sits on the earliest deadline in the trash: the document
    // trashed on its own a moment earlier, not the set's.
    const aloneRow = await readDocumentRow(userId, alone.id);
    expect(aloneRow?.purge_after).toBeLessThanOrEqual(
      topicRow?.purge_after ?? 0,
    );
    expect(await purgeJobNextRunAt(userId)).toBe(aloneRow?.purge_after);

    await expectCode(
      trashTopic({ container, input: { userId, topicId: t.id } }),
      isNotFoundError,
      "TOPIC_NOT_FOUND",
    );
    const empty = await topic(container, userId, "empty");
    expect(
      (await trashTopic({ container, input: { userId, topicId: empty.id } }))
        .trashedDocumentIds,
    ).toEqual([]);
    await expectCode(
      trashTopic({ container, input: { userId, topicId: " " } }),
      isBusinessRuleError,
      "INVALID_TOPIC_ID",
    );
  });

  it("(c) rolls the whole set back when one document's save conflicts", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const d1 = await document(container, userId, t.id);
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        "CREATE TRIGGER occ_probe BEFORE UPDATE ON documents BEGIN SELECT RAISE(IGNORE); END",
      );
    });
    await expectCode(
      trashTopic({ container, input: { userId, topicId: t.id } }),
      isConflictError,
      "OPTIMISTIC_LOCK_FAILURE",
    );
    await inUserDataStorage(userId, (sql) => {
      sql.exec("DROP TRIGGER occ_probe");
    });
    expect(await readTopicRow(userId, t.id)).toMatchObject({
      status: "active",
    });
    expect(await readDocumentRow(userId, d1.id)).toMatchObject({
      status: "active",
    });
    expect(await searchEntry(userId, d1.id)).not.toBeNull();
    expect(await purgeJobNextRunAt(userId)).toBeNull();
  });
});
