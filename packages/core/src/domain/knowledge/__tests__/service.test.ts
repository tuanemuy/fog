import { isBusinessRuleError } from "@repo/core/domain/error";
import { Actor, UserId } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { type ActiveDocument, Document, Topic } from "../entity";
import { TopicTrashService } from "../service";
import { TopicId } from "../valueObject";

const NOW = new Date("2026-09-08T00:00:00.000Z");
const PURGE = new Date("2026-10-08T00:00:00.000Z");
const USER = UserId.create("user-1");

function doc(id: string, topicId: string): ActiveDocument {
  return Document.create(
    {
      id,
      revisionId: `${id}-r1`,
      userId: USER,
      topicId: TopicId.create(topicId),
      title: id,
      body: "",
      actor: Actor.user(USER),
      changeReason: "作成",
      sourceMemoIds: [],
    },
    NOW,
  ).document;
}

describe("TopicTrashService.trashTopicSet", () => {
  it("trashes the topic and every document with the same deadline and trashedWith", () => {
    const topic = Topic.archive(
      Topic.create(
        { id: "t1", userId: USER, name: "t", description: null },
        NOW,
      ),
      NOW,
    );
    const result = TopicTrashService.trashTopicSet(
      topic,
      [doc("d1", "t1"), doc("d2", "t1")],
      PURGE,
      NOW,
    );
    expect(result.topic).toMatchObject({
      status: "trashed",
      wasArchived: true,
      purgeAfter: PURGE,
    });
    expect(
      result.documents.map((d) => [d.id, d.trashedWith, d.purgeAfter]),
    ).toEqual([
      ["d1", "t1", PURGE],
      ["d2", "t1", PURGE],
    ]);
    expect(
      TopicTrashService.trashTopicSet(topic, [], PURGE, NOW).documents,
    ).toEqual([]);
  });
});

describe("TopicTrashService.restoreTopicSet", () => {
  it("restores the set members, skips individually trashed ones, refuses another topic's", () => {
    const topic = Topic.softDelete(
      Topic.create(
        { id: "t1", userId: USER, name: "t", description: null },
        NOW,
      ),
      PURGE,
      NOW,
    );
    const withTopic = Document.softDelete(
      doc("d1", "t1"),
      TopicId.create("t1"),
      PURGE,
      NOW,
    );
    const alone = Document.softDelete(doc("d2", "t1"), null, PURGE, NOW);
    const result = TopicTrashService.restoreTopicSet(
      topic,
      [withTopic, alone],
      NOW,
    );
    expect(result.topic.status).toBe("active");
    expect(result.restoredDocuments.map((d) => d.id)).toEqual(["d1"]);
    expect(result.restoredDocuments[0]?.status).toBe("active");
    expect(result.skippedDocuments).toEqual([alone]);

    const foreign = Document.softDelete(doc("d3", "t2"), null, PURGE, NOW);
    let code: string | null = null;
    try {
      TopicTrashService.restoreTopicSet(topic, [foreign], NOW);
    } catch (error) {
      if (isBusinessRuleError(error)) code = error.code;
    }
    expect(code).toBe("TRASHED_WITH_MISMATCH");
  });
});
