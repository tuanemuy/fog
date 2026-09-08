import { isBusinessRuleError } from "@repo/core/domain/error";
import { Actor, UserId } from "@repo/core/domain/identity/valueObject";
import { MemoId } from "@repo/core/domain/memo/valueObject";
import { describe, expect, it } from "vitest";
import {
  type ActiveDocument,
  type ActiveTopic,
  Document,
  type DocumentRevision,
  Topic,
} from "../entity";
import {
  DocumentId,
  DocumentRevisionId,
  DocumentTitle,
  RevisionNumber,
  TopicId,
} from "../valueObject";

const NOW = new Date("2026-09-08T00:00:00.000Z");
const LATER = new Date("2026-09-08T01:00:00.000Z");
const USER = UserId.create("user-1");
const ACTOR = Actor.user(USER);

function topic(): ActiveTopic {
  return Topic.create(
    { id: "t1", userId: USER, name: "読書メモ", description: "本の要約" },
    NOW,
  );
}

function document(sourceMemoIds: string[] = []) {
  return Document.create(
    {
      id: "d1",
      revisionId: "r1",
      userId: USER,
      topicId: TopicId.create("t1"),
      title: "タイトル",
      body: "本文",
      actor: ACTOR,
      changeReason: "作成",
      sourceMemoIds: sourceMemoIds.map((id) => MemoId.create(id)),
    },
    NOW,
  );
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (isBusinessRuleError(error)) return error.code;
    throw error;
  }
  return null;
}

describe("Topic", () => {
  it("is born active at version 0, with null for no description", () => {
    const t = topic();
    expect(t).toMatchObject({ status: "active", version: 0, name: "読書メモ" });
    expect(
      Topic.create(
        { id: "t2", userId: USER, name: "x", description: null },
        NOW,
      ).description,
    ).toBeNull();
  });

  it("renames and re-describes while keeping the status", () => {
    const archived = Topic.archive(topic(), NOW);
    const renamed = Topic.rename(archived, "新しい名前", LATER);
    expect(renamed).toMatchObject({
      status: "archived",
      name: "新しい名前",
      version: 2,
      updatedAt: LATER,
    });
    expect(
      Topic.changeDescription(renamed, null, LATER).description,
    ).toBeNull();
    expect(codeOf(() => Topic.rename(archived, " ", NOW))).toBe(
      "EMPTY_TOPIC_NAME",
    );
    expect(codeOf(() => Topic.changeDescription(archived, "", NOW))).toBe(
      "EMPTY_TOPIC_DESCRIPTION",
    );
  });

  it("archives and unarchives, one version each", () => {
    const archived = Topic.archive(topic(), NOW);
    expect(archived.status).toBe("archived");
    const back = Topic.unarchive(archived, LATER);
    expect(back).toMatchObject({ status: "active", version: 2 });
  });

  it("remembers the archived state across the trash and drops purgeAfter on restore", () => {
    const purgeAfter = new Date("2026-10-08T00:00:00.000Z");
    const trashed = Topic.softDelete(
      Topic.archive(topic(), NOW),
      purgeAfter,
      LATER,
    );
    expect(trashed).toMatchObject({
      status: "trashed",
      wasArchived: true,
      trashedAt: LATER,
      purgeAfter,
      version: 2,
    });
    const restored = Topic.restore(trashed, LATER);
    expect(restored.status).toBe("archived");
    expect(restored.version).toBe(3);
    expect("purgeAfter" in restored).toBe(false);
    expect(
      Topic.restore(Topic.softDelete(topic(), purgeAfter, NOW), NOW).status,
    ).toBe("active");
  });
});

describe("Document.create", () => {
  it("starts at revision 1 / version 0 with de-duplicated source links", () => {
    const { document: d, revision, sourceLinks } = document(["m1", "m2", "m1"]);
    expect(d).toMatchObject({
      status: "active",
      version: 0,
      latestRevision: 1,
      topicId: "t1",
    });
    expect(revision).toMatchObject({
      id: "r1",
      documentId: "d1",
      revisionNumber: 1,
      changeReason: "作成",
      body: "本文",
    });
    expect(sourceLinks.map((link) => link.memoId)).toEqual(["m1", "m2"]);
    expect(sourceLinks[0]?.createdAt).toBe(NOW);
    expect(document().sourceLinks).toEqual([]);
  });

  it("accepts an empty body and holds the title and change-reason rules", () => {
    expect(
      Document.create(
        {
          id: "d",
          revisionId: "r",
          userId: USER,
          topicId: TopicId.create("t"),
          title: "t",
          body: "",
          actor: ACTOR,
          changeReason: "作成",
          sourceMemoIds: [],
        },
        NOW,
      ).document.body,
    ).toBe("");
    expect(
      codeOf(() =>
        Document.create(
          {
            id: "d",
            revisionId: "r",
            userId: USER,
            topicId: TopicId.create("t"),
            title: "",
            body: "",
            actor: ACTOR,
            changeReason: "作成",
            sourceMemoIds: [],
          },
          NOW,
        ),
      ),
    ).toBe("EMPTY_DOCUMENT_TITLE");
    expect(
      codeOf(() =>
        Document.create(
          {
            id: "d",
            revisionId: "r",
            userId: USER,
            topicId: TopicId.create("t"),
            title: "t",
            body: "",
            actor: ACTOR,
            changeReason: "",
            sourceMemoIds: [],
          },
          NOW,
        ),
      ),
    ).toBe("EMPTY_CHANGE_REASON");
  });
});

describe("Document.edit / rollback", () => {
  const edit = (d: ActiveDocument, title: string, body: string) =>
    Document.edit(
      d,
      { revisionId: "r2", title, body, actor: ACTOR, changeReason: "手動編集" },
      LATER,
    );

  it("is unchanged for the same title and body, edited for a title-only change", () => {
    const { document: d } = document();
    expect(edit(d, "タイトル", "本文")).toEqual({
      kind: "unchanged",
      document: d,
    });
    const outcome = edit(d, "別タイトル", "本文");
    expect(outcome.kind).toBe("edited");
    if (outcome.kind !== "edited") throw new Error("unreachable");
    expect(outcome.document).toMatchObject({
      title: "別タイトル",
      latestRevision: 2,
      version: 1,
      updatedAt: LATER,
      createdAt: NOW,
    });
    expect(outcome.revision).toMatchObject({
      id: "r2",
      revisionNumber: 2,
      title: "別タイトル",
      body: "本文",
      changeReason: "手動編集",
      createdAt: LATER,
    });
  });

  it("rolls back to a revision's title and body as a new revision, and refuses another document's", () => {
    const { document: d, revision: first } = document();
    const edited = edit(d, "v2", "body v2");
    if (edited.kind !== "edited") throw new Error("unreachable");
    const rolled = Document.rollback(
      edited.document,
      first,
      {
        revisionId: "r3",
        actor: ACTOR,
        changeReason: "リビジョン1の内容に戻す",
      },
      LATER,
    );
    expect(rolled.kind).toBe("edited");
    if (rolled.kind !== "edited") throw new Error("unreachable");
    expect(rolled.document).toMatchObject({
      title: "タイトル",
      body: "本文",
      latestRevision: 3,
      version: 2,
    });
    expect(rolled.revision.revisionNumber).toBe(3);
    // Same content as now: nothing to stack.
    expect(
      Document.rollback(
        rolled.document,
        first,
        { revisionId: "r4", actor: ACTOR, changeReason: "x" },
        LATER,
      ).kind,
    ).toBe("unchanged");

    const foreign: DocumentRevision = {
      ...first,
      id: DocumentRevisionId.create("rx"),
      documentId: DocumentId.create("d-other"),
      revisionNumber: RevisionNumber.create(1),
      title: DocumentTitle.create("other"),
    };
    expect(
      codeOf(() =>
        Document.rollback(
          edited.document,
          foreign,
          { revisionId: "r5", actor: ACTOR, changeReason: "x" },
          LATER,
        ),
      ),
    ).toBe("REVISION_DOCUMENT_MISMATCH");
  });
});

describe("Document.softDelete / restore / moveToTopic", () => {
  const purgeAfter = new Date("2026-10-08T00:00:00.000Z");

  it("records the set topic only when it is the document's own", () => {
    const { document: d } = document();
    const alone = Document.softDelete(d, null, purgeAfter, LATER);
    expect(alone).toMatchObject({
      status: "trashed",
      trashedWith: null,
      trashedAt: LATER,
      purgeAfter,
      version: 1,
    });
    const set = Document.softDelete(d, TopicId.create("t1"), purgeAfter, LATER);
    expect(set.trashedWith).toBe("t1");
    expect(
      codeOf(() =>
        Document.softDelete(d, TopicId.create("t9"), purgeAfter, LATER),
      ),
    ).toBe("TRASHED_WITH_MISMATCH");
  });

  it("restores without the trash fields and moves to another topic first when asked", () => {
    const { document: d } = document();
    const trashed = Document.softDelete(
      d,
      TopicId.create("t1"),
      purgeAfter,
      LATER,
    );
    const moved = Document.moveToTopic(trashed, TopicId.create("t2"), LATER);
    expect(moved).toMatchObject({
      topicId: "t2",
      trashedWith: null,
      version: 2,
    });
    const restored = Document.restore(moved, LATER);
    expect(restored).toMatchObject({
      status: "active",
      topicId: "t2",
      version: 3,
    });
    expect("trashedWith" in restored).toBe(false);
    expect("purgeAfter" in restored).toBe(false);
  });
});
