import { describe, expect, it } from "vitest";
import {
  createDocumentSchema,
  diffDocumentRevisionsSchema,
  editDocumentSchema,
  isEditDocumentResult,
  rollbackDocumentSchema,
} from "@/components/documents/schema";

const base = { topicId: "t1", title: "t", body: "", sourceMemoIds: [] };

describe("createDocumentSchema", () => {
  it("bounds the body in UTF-16 units at twice the code-point limit", () => {
    expect(
      createDocumentSchema.safeParse({ ...base, body: "x".repeat(800_000) })
        .success,
    ).toBe(true);
    expect(
      createDocumentSchema.safeParse({ ...base, body: "x".repeat(800_001) })
        .success,
    ).toBe(false);
  });

  it("caps the source list at 100 non-empty ids and passes the title bound to the value object", () => {
    expect(
      createDocumentSchema.safeParse({
        ...base,
        sourceMemoIds: new Array(100).fill("m"),
      }).success,
    ).toBe(true);
    expect(
      createDocumentSchema.safeParse({
        ...base,
        sourceMemoIds: new Array(101).fill("m"),
      }).success,
    ).toBe(false);
    expect(
      createDocumentSchema.safeParse({ ...base, sourceMemoIds: [""] }).success,
    ).toBe(false);
    expect(
      createDocumentSchema.safeParse({ ...base, title: "あ".repeat(201) })
        .success,
    ).toBe(true);
  });
});

describe("editDocumentSchema / rollbackDocumentSchema / diffDocumentRevisionsSchema", () => {
  it("takes a non-negative integer version and a null-able reason", () => {
    const ok = {
      documentId: "d1",
      title: "t",
      body: "",
      changeReason: null,
      expectedVersion: 0,
    };
    expect(editDocumentSchema.safeParse(ok).success).toBe(true);
    expect(
      editDocumentSchema.safeParse({ ...ok, expectedVersion: -1 }).success,
    ).toBe(false);
    expect(
      editDocumentSchema.safeParse({ ...ok, expectedVersion: 1.5 }).success,
    ).toBe(false);
  });

  it("wants revision numbers of at least 1 and does not judge equality", () => {
    expect(
      rollbackDocumentSchema.safeParse({ documentId: "d1", revisionNumber: 0 })
        .success,
    ).toBe(false);
    expect(
      diffDocumentRevisionsSchema.safeParse({
        documentId: "d1",
        baseRevisionNumber: 2,
        targetRevisionNumber: 2,
      }).success,
    ).toBe(true);
  });
});

describe("isEditDocumentResult", () => {
  const meta = {
    revisionNumber: 2,
    actor: { kind: "user" },
    changeReason: "x",
    createdAt: new Date(),
  };

  it("accepts the three answers and refuses a conflict without its view", () => {
    const head = { latestRevision: 2, version: 1, updatedAt: new Date() };
    expect(
      isEditDocumentResult({ ...head, result: "saved", conflict: null }),
    ).toBe(true);
    expect(
      isEditDocumentResult({
        ...head,
        result: "conflict",
        conflict: {
          currentTitle: "t",
          currentBody: "b",
          currentVersion: 1,
          latestRevision: meta,
        },
      }),
    ).toBe(true);
    expect(
      isEditDocumentResult({ ...head, result: "conflict", conflict: null }),
    ).toBe(false);
    expect(isEditDocumentResult({ status: 500, unhandled: true })).toBe(false);
  });
});
