import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import { isNotFoundError } from "@repo/core/application/errors";
import { listDocumentSourceMemos } from "@repo/core/application/knowledge/listDocumentSourceMemos";
import { listDocumentsReferencingMemo } from "@repo/core/application/knowledge/listDocumentsReferencingMemo";
import { trashDocument } from "@repo/core/application/knowledge/trashDocument";
import { editMemo } from "@repo/core/application/memo/editMemo";
import { getTimeline } from "@repo/core/application/memo/getTimeline";
import { jumpToDate } from "@repo/core/application/memo/jumpToDate";
import { showMemoInTimeline } from "@repo/core/application/memo/showMemoInTimeline";
import { softDeleteMemo } from "@repo/core/application/memo/softDeleteMemo";
import { describe, expect, it } from "vitest";
import {
  document,
  expectCode,
  post,
  topic,
  userActor,
} from "./knowledgeFixtures";

describe("listDocumentSourceMemos", () => {
  it("(a) lists the sources in link order with the latest body, trashed flagged, hard-deleted gone", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const m1 = await post(container, userId, "first source");
    const m2 = await post(container, userId, "second source");
    const m3 = await post(container, userId, "third source");
    const created = await document(container, userId, t.id, {
      sourceMemoIds: [m1.id, m2.id, m3.id],
    });
    await editMemo({
      container,
      input: {
        userId,
        memoId: m1.id,
        body: "first source, edited",
        expectedVersion: 0,
        actor: userActor(userId),
      },
    });
    await softDeleteMemo({ container, input: { userId, memoId: m2.id } });
    await inUserDataStorage(userId, (sql) => {
      sql.exec("DELETE FROM source_links WHERE memo_id = ?", m3.id);
      sql.exec("DELETE FROM memos WHERE id = ?", m3.id);
    });

    const view = await listDocumentSourceMemos({
      container,
      input: { userId, documentId: created.id },
    });
    expect(
      view.sourceMemos.map((s) => [s.memoId, s.snippet, s.deleted]),
    ).toEqual([
      [m1.id, "first source, edited", false],
      [m2.id, "second source", true],
    ]);
    expect(view.sourceMemos[0]?.linkedAt).toEqual(created.createdAt);
    expect(view.sourceMemos[0]?.postedAt).toEqual(m1.postedAt);

    await trashDocument({
      container,
      input: { userId, documentId: created.id },
    });
    expect(
      (
        await listDocumentSourceMemos({
          container,
          input: { userId, documentId: created.id },
        })
      ).sourceMemos,
    ).toHaveLength(2);
    const bare = await document(container, userId, t.id);
    expect(
      (
        await listDocumentSourceMemos({
          container,
          input: { userId, documentId: bare.id },
        })
      ).sourceMemos,
    ).toEqual([]);
    await expectCode(
      listDocumentSourceMemos({
        container,
        input: { userId, documentId: "nope" },
      }),
      isNotFoundError,
      "DOCUMENT_NOT_FOUND",
    );
  });
});

describe("listDocumentsReferencingMemo", () => {
  it("(b) lists the citing documents with the trashed flag, also for a trashed memo", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const memo = await post(container, userId, "cited");
    const d1 = await document(container, userId, t.id, {
      title: "doc 1",
      sourceMemoIds: [memo.id],
    });
    const d2 = await document(container, userId, t.id, {
      title: "doc 2",
      sourceMemoIds: [memo.id],
    });
    const d3 = await document(container, userId, t.id, {
      title: "doc 3",
      sourceMemoIds: [memo.id],
    });
    await trashDocument({ container, input: { userId, documentId: d2.id } });
    await inUserDataStorage(userId, (sql) => {
      sql.exec("DELETE FROM source_links WHERE document_id = ?", d3.id);
      sql.exec("DELETE FROM documents WHERE id = ?", d3.id);
    });

    const view = await listDocumentsReferencingMemo({
      container,
      input: { userId, memoId: memo.id },
    });
    expect(
      view.documents.map((d) => [d.documentId, d.title, d.topicId, d.deleted]),
    ).toEqual([
      [d1.id, "doc 1", t.id, false],
      [d2.id, "doc 2", t.id, true],
    ]);
    await softDeleteMemo({ container, input: { userId, memoId: memo.id } });
    expect(
      (
        await listDocumentsReferencingMemo({
          container,
          input: { userId, memoId: memo.id },
        })
      ).documents,
    ).toHaveLength(2);
    const lonely = await post(container, userId, "uncited");
    expect(
      (
        await listDocumentsReferencingMemo({
          container,
          input: { userId, memoId: lonely.id },
        })
      ).documents,
    ).toEqual([]);
    await expectCode(
      listDocumentsReferencingMemo({
        container,
        input: { userId, memoId: "nope" },
      }),
      isNotFoundError,
      "MEMO_NOT_FOUND",
    );
  });
});

describe("the timeline's sourceDocuments trail", () => {
  it("(c) attaches the citing documents on every read of the timeline, trashed flagged, hard-deleted dropped", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const t = await topic(container, userId);
    const cited = await post(container, userId, "cited memo");
    const plain = await post(container, userId, "plain memo");
    const d1 = await document(container, userId, t.id, {
      title: "alive",
      sourceMemoIds: [cited.id],
    });
    const d2 = await document(container, userId, t.id, {
      title: "trashed",
      sourceMemoIds: [cited.id],
    });
    const d3 = await document(container, userId, t.id, {
      title: "removed",
      sourceMemoIds: [cited.id],
    });
    await trashDocument({ container, input: { userId, documentId: d2.id } });
    await inUserDataStorage(userId, (sql) => {
      sql.exec("DELETE FROM source_links WHERE document_id = ?", d3.id);
      sql.exec("DELETE FROM documents WHERE id = ?", d3.id);
    });

    const expected = [
      { documentId: d1.id, title: "alive", isTrashed: false },
      { documentId: d2.id, title: "trashed", isTrashed: true },
    ];
    const page = await getTimeline({ container, input: { userId } });
    const byId = new Map(
      page.items.map((item) => [item.id, item.sourceDocuments]),
    );
    expect(byId.get(cited.id)).toEqual(expected);
    expect(byId.get(plain.id)).toEqual([]);

    const day = new Date(cited.postedAt);
    day.setUTCHours(0, 0, 0, 0);
    const window = await jumpToDate({
      container,
      input: {
        userId,
        date: day,
        dayEnd: new Date(day.getTime() + 86_400_000),
      },
    });
    expect(
      window.items.find((item) => item.id === cited.id)?.sourceDocuments,
    ).toEqual(expected);

    const shown = await showMemoInTimeline({
      container,
      input: { userId, memoId: cited.id },
    });
    expect(
      shown.items.find((item) => item.id === cited.id)?.sourceDocuments,
    ).toEqual(expected);
  });
});
