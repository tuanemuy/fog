import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import {
  isConflictError,
  isNotFoundError,
  isValidationError,
} from "@repo/core/application/errors";
import { getTopic } from "@repo/core/application/knowledge/getTopic";
import { getTopicName } from "@repo/core/application/knowledge/getTopicName";
import { listTopics } from "@repo/core/application/knowledge/listTopics";
import { trashTopic } from "@repo/core/application/knowledge/trashTopic";
import { updateTopic } from "@repo/core/application/knowledge/updateTopic";
import { softDeleteMemo } from "@repo/core/application/memo/softDeleteMemo";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import {
  document,
  expectCode,
  post,
  readTopicRow,
  topic,
} from "./knowledgeFixtures";

describe("createTopic / updateTopic", () => {
  it("(a) creates active at version 0, with the description optional and the name bounded", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const created = await topic(container, userId, "  読書メモ  ", "本の要約");
    expect(created).toMatchObject({
      name: "読書メモ",
      description: "本の要約",
      status: "active",
      version: 0,
    });
    expect((await topic(container, userId, "x")).description).toBeNull();
    // Names are not unique.
    expect((await topic(container, userId, "読書メモ")).id).not.toBe(
      created.id,
    );
    expect(
      (await topic(container, userId, "あ".repeat(100))).name,
    ).toHaveLength(100);
    await expectCode(
      topic(container, userId, "あ".repeat(101)),
      isBusinessRuleError,
      "TOPIC_NAME_TOO_LONG",
    );
    await expectCode(
      topic(container, userId, "   "),
      isBusinessRuleError,
      "EMPTY_TOPIC_NAME",
    );
    await expectCode(
      topic(container, userId, "a\nb"),
      isBusinessRuleError,
      "TOPIC_NAME_MULTILINE",
    );
    await expectCode(
      topic(container, userId, "x", ""),
      isBusinessRuleError,
      "EMPTY_TOPIC_DESCRIPTION",
    );
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM search_entries")
          .one().n,
      ).toBe(0);
    });
  });

  it("(b) renames, re-describes, archives and unarchives, refuses an empty update", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const created = await topic(container, userId, "before", "desc");
    const update = (input: {
      name?: string;
      description?: string | null;
      archived?: boolean;
    }) =>
      updateTopic({
        container,
        input: { userId, topicId: created.id, ...input },
      });

    expect(await update({ name: "after" })).toMatchObject({
      name: "after",
      version: 1,
      status: "active",
    });
    expect((await update({ description: null })).description).toBeNull();
    expect(await update({ archived: true })).toMatchObject({
      status: "archived",
      version: 3,
    });
    // Same state: nothing applied, the row still saved.
    expect(await update({ archived: true })).toMatchObject({
      status: "archived",
      version: 4,
    });
    expect(await update({ name: "again" })).toMatchObject({
      status: "archived",
      name: "again",
    });
    expect(await update({ archived: false })).toMatchObject({
      status: "active",
      version: 6,
    });
    await expectCode(update({}), isValidationError, "NO_CHANGES");
    await expectCode(
      update({ name: "" }),
      isBusinessRuleError,
      "EMPTY_TOPIC_NAME",
    );
    await expectCode(
      updateTopic({ container, input: { userId, topicId: "nope", name: "x" } }),
      isNotFoundError,
      "TOPIC_NOT_FOUND",
    );
    expect(await readTopicRow(userId, created.id)).toMatchObject({
      version: 6,
      name: "again",
    });
  });

  it("(c) answers OCC as a conflict when the row moved under the token", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const created = await topic(container, userId);
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        "CREATE TRIGGER occ_probe BEFORE UPDATE ON topics BEGIN SELECT RAISE(IGNORE); END",
      );
    });
    await expectCode(
      updateTopic({
        container,
        input: { userId, topicId: created.id, name: "x" },
      }),
      isConflictError,
      "OPTIMISTIC_LOCK_FAILURE",
    );
    await inUserDataStorage(userId, (sql) => {
      sql.exec("DROP TRIGGER occ_probe");
    });
    expect(await readTopicRow(userId, created.id)).toMatchObject({
      version: 0,
      name: "読書メモ",
    });
  });
});

describe("listTopics / getTopic / getTopicName", () => {
  it("(d) lists live topics by name with their active documents grouped, archived on request only", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const b = await topic(container, userId, "b topic");
    const a = await topic(container, userId, "a topic");
    const archived = await topic(container, userId, "c archived");
    await updateTopic({
      container,
      input: { userId, topicId: archived.id, archived: true },
    });
    const trashed = await topic(container, userId, "d trashed");
    await trashTopic({ container, input: { userId, topicId: trashed.id } });
    const d1 = await document(container, userId, a.id, { title: "doc 1" });
    const d2 = await document(container, userId, a.id, { title: "doc 2" });
    const d3 = await document(container, userId, archived.id, {
      title: "doc 3",
    });
    await document(container, userId, b.id, { title: "doc 4 gone" }).then(
      (doc) =>
        inUserDataStorage(userId, (sql) => {
          sql.exec(
            "UPDATE documents SET status='trashed', trashed_at=1, purge_after=2 WHERE id = ?",
            doc.id,
          );
        }),
    );

    const active = await listTopics({
      container,
      input: { userId, includeArchived: false },
    });
    expect(active.topics.map((t) => t.name)).toEqual(["a topic", "b topic"]);
    expect(active.topics[0]?.documents.map((d) => d.id).sort()).toEqual(
      [d1.id, d2.id].sort(),
    );
    expect(active.topics[1]?.documents).toEqual([]);

    const all = await listTopics({
      container,
      input: { userId, includeArchived: true },
    });
    expect(all.topics.map((t) => [t.name, t.status])).toEqual([
      ["a topic", "active"],
      ["b topic", "active"],
      ["c archived", "archived"],
    ]);
    expect(all.topics[2]?.documents.map((d) => d.id)).toEqual([d3.id]);

    const empty = createTestContainer();
    const { userId: nobody } = await registerTestUser(empty);
    expect(
      await listTopics({
        container: empty,
        input: { userId: nobody, includeArchived: true },
      }),
    ).toEqual({ topics: [] });
  });

  it("(e) details a topic with its documents (updatedAt desc) and the de-duplicated related memos", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const m1 = await post(container, userId, "shared source\nsecond line");
    const m2 = await post(container, userId, "trashed source");
    const m3 = await post(container, userId, "hard deleted source");
    const older = await document(container, userId, t.id, {
      title: "older",
      sourceMemoIds: [m1.id, m2.id],
    });
    const newer = await document(container, userId, t.id, {
      title: "newer",
      sourceMemoIds: [m1.id, m3.id],
    });
    await softDeleteMemo({ container, input: { userId, memoId: m2.id } });
    await inUserDataStorage(userId, (sql) => {
      sql.exec("DELETE FROM source_links WHERE memo_id = ?", m3.id);
      sql.exec("DELETE FROM memos WHERE id = ?", m3.id);
    });

    const detail = await getTopic({
      container,
      input: { userId, topicId: t.id },
    });
    expect(detail.topic).toMatchObject({ id: t.id, name: "読書メモ" });
    expect(detail.documents.map((d) => d.id)).toEqual([newer.id, older.id]);
    expect(
      detail.relatedMemos.map((m) => [m.memoId, m.deleted, m.snippet]),
    ).toEqual([
      [m2.id, true, "trashed source"],
      [m1.id, false, "shared source second line"],
    ]);

    const archived = await updateTopic({
      container,
      input: { userId, topicId: t.id, archived: true },
    });
    expect(
      (await getTopic({ container, input: { userId, topicId: t.id } })).topic
        .status,
    ).toBe(archived.status);
    expect(
      await getTopicName({ container, input: { userId, topicId: t.id } }),
    ).toEqual({ topicId: t.id, name: "読書メモ" });

    await trashTopic({ container, input: { userId, topicId: t.id } });
    await expectCode(
      getTopic({ container, input: { userId, topicId: t.id } }),
      isNotFoundError,
      "TOPIC_NOT_FOUND",
    );
    await expectCode(
      getTopicName({ container, input: { userId, topicId: t.id } }),
      isNotFoundError,
      "TOPIC_NOT_FOUND",
    );
    await expectCode(
      getTopic({ container, input: { userId, topicId: " " } }),
      isBusinessRuleError,
      "INVALID_TOPIC_ID",
    );
  });
});
