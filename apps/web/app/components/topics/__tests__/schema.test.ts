import { describe, expect, it } from "vitest";
import {
  createTopicSchema,
  isTopicResult,
  isTrashTopicResult,
  trashTopicSchema,
  updateTopicSchema,
} from "@/components/topics/schema";

describe("createTopicSchema", () => {
  it("takes a name and a nullable description", () => {
    expect(
      createTopicSchema.safeParse({ name: "x", description: null }).success,
    ).toBe(true);
    expect(
      createTopicSchema.safeParse({ name: "x", description: "d" }).success,
    ).toBe(true);
    expect(createTopicSchema.safeParse({ name: "x" }).success).toBe(false);
    expect(
      createTopicSchema.safeParse({ name: "x".repeat(401), description: null })
        .success,
    ).toBe(false);
  });
});

describe("updateTopicSchema", () => {
  it("rejects a topicId alone and accepts each single field", () => {
    expect(updateTopicSchema.safeParse({ topicId: "t1" }).success).toBe(false);
    expect(
      updateTopicSchema.safeParse({ topicId: "t1", name: "n" }).success,
    ).toBe(true);
    expect(
      updateTopicSchema.safeParse({ topicId: "t1", description: null }).success,
    ).toBe(true);
    expect(
      updateTopicSchema.safeParse({ topicId: "t1", description: "d" }).success,
    ).toBe(true);
    expect(
      updateTopicSchema.safeParse({ topicId: "t1", archived: false }).success,
    ).toBe(true);
    expect(
      updateTopicSchema.safeParse({ topicId: "", name: "n" }).success,
    ).toBe(false);
  });
});

describe("trashTopicSchema", () => {
  it("needs a non-empty topicId", () => {
    expect(trashTopicSchema.safeParse({ topicId: "t1" }).success).toBe(true);
    expect(trashTopicSchema.safeParse({ topicId: "" }).success).toBe(false);
  });
});

describe("result guards", () => {
  it("recognise a topic view and a trash answer, and nothing else", () => {
    expect(
      isTopicResult({ id: "t1", name: "n", status: "active", version: 0 }),
    ).toBe(true);
    expect(
      isTopicResult({ id: "t1", name: "n", status: "trashed", version: 0 }),
    ).toBe(false);
    expect(isTopicResult({ status: 500, unhandled: true })).toBe(false);
    expect(isTrashTopicResult({ topicId: "t1", trashedDocumentIds: [] })).toBe(
      true,
    );
    expect(isTrashTopicResult({ topicId: "t1" })).toBe(false);
    expect(isTrashTopicResult(null)).toBe(false);
  });
});
