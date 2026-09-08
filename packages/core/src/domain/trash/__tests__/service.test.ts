import type {
  DocumentId,
  TopicId,
} from "@repo/core/domain/knowledge/valueObject";
import type { MemoId } from "@repo/core/domain/memo/valueObject";
import { describe, expect, it } from "vitest";
import { HardDeletePolicy, RestorePolicy } from "../service";
import type { TrashedDocumentItem, TrashedTopicItem } from "../valueObject";

const AT = new Date("2026-09-08T00:00:00Z");
const doc: TrashedDocumentItem = {
  kind: "document",
  id: "d1" as DocumentId,
  title: "t",
  topicId: "t1" as TopicId,
  deletedWithTopic: false,
  trashedAt: AT,
  expiresAt: AT,
};

describe("RestorePolicy.decideDocumentRestore", () => {
  it("restores alone under a live topic, with the topic when it is trashed, and asks for a destination when it is gone", () => {
    expect(
      RestorePolicy.decideDocumentRestore(doc, { kind: "active" }),
    ).toEqual({ kind: "restoreAlone" });
    expect(
      RestorePolicy.decideDocumentRestore(doc, { kind: "trashed" }),
    ).toEqual({
      kind: "restoreWithTopic",
      topicId: "t1",
    });
    expect(
      RestorePolicy.decideDocumentRestore(doc, { kind: "hardDeleted" }),
    ).toEqual({
      kind: "selectDestination",
    });
  });
});

describe("HardDeletePolicy.expandTargets", () => {
  it("names the item itself for a memo and a document, and the set for a topic", () => {
    expect(
      HardDeletePolicy.expandTargets({
        kind: "memo",
        id: "m1" as MemoId,
        excerpt: "",
        trashedAt: AT,
        expiresAt: AT,
      }),
    ).toEqual({ memoIds: ["m1"], documentIds: [], topicIds: [] });
    expect(HardDeletePolicy.expandTargets(doc)).toEqual({
      memoIds: [],
      documentIds: ["d1"],
      topicIds: [],
    });
    const topic: TrashedTopicItem = {
      kind: "topic",
      id: "t1" as TopicId,
      name: "n",
      setDocumentIds: ["d2", "d3"] as DocumentId[],
      trashedAt: AT,
      expiresAt: AT,
    };
    expect(HardDeletePolicy.expandTargets(topic)).toEqual({
      memoIds: [],
      documentIds: ["d2", "d3"],
      topicIds: ["t1"],
    });
    expect(
      HardDeletePolicy.expandTargets({ ...topic, setDocumentIds: [] })
        .documentIds,
    ).toEqual([]);
  });
});
