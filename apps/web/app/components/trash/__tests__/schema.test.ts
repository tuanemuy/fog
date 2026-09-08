import { describe, expect, it } from "vitest";
import {
  hardDeleteTrashItemSchema,
  isRestoreDocumentResult,
  isTrashList,
  listTrashSchema,
  restoreDocumentSchema,
} from "../schema";

const AT = new Date("2026-09-08T00:00:00Z");

describe("trash schemas", () => {
  it("bounds the listing and the kinds, and accepts both destination shapes", () => {
    expect(listTrashSchema.safeParse({ page: 1, limit: 100 }).success).toBe(
      true,
    );
    expect(listTrashSchema.safeParse({ page: 0, limit: 1 }).success).toBe(
      false,
    );
    expect(listTrashSchema.safeParse({ page: 1, limit: 101 }).success).toBe(
      false,
    );
    expect(
      hardDeleteTrashItemSchema.safeParse({ kind: "user", id: "x" }).success,
    ).toBe(false);
    expect(
      hardDeleteTrashItemSchema.safeParse({ kind: "topic", id: "" }).success,
    ).toBe(false);
    expect(restoreDocumentSchema.safeParse({ documentId: "d" }).success).toBe(
      true,
    );
    expect(
      restoreDocumentSchema.safeParse({
        documentId: "d",
        confirmSetRestore: true,
      }).success,
    ).toBe(true);
    expect(
      restoreDocumentSchema.safeParse({
        documentId: "d",
        destination: { kind: "existing", topicId: "t" },
      }).success,
    ).toBe(true);
    expect(
      restoreDocumentSchema.safeParse({
        documentId: "d",
        destination: { kind: "new", name: "n", description: null },
      }).success,
    ).toBe(true);
    expect(
      restoreDocumentSchema.safeParse({
        documentId: "d",
        destination: { kind: "new", name: "", description: null },
      }).success,
    ).toBe(false);
    expect(
      restoreDocumentSchema.safeParse({
        documentId: "d",
        destination: { kind: "other" },
      }).success,
    ).toBe(false);
  });

  it("recognises the result shapes", () => {
    expect(
      isTrashList({
        items: [
          { kind: "memo", id: "m", excerpt: "e", trashedAt: AT, expiresAt: AT },
          {
            kind: "document",
            id: "d",
            title: "t",
            topicId: "t1",
            deletedWithTopic: true,
            trashedAt: AT,
            expiresAt: AT,
          },
          {
            kind: "topic",
            id: "t1",
            name: "n",
            setDocumentIds: ["d"],
            trashedAt: AT,
            expiresAt: AT,
          },
        ],
        totalCount: 3,
        page: 1,
        limit: 100,
      }),
    ).toBe(true);
    expect(
      isTrashList({
        items: [{ kind: "memo", id: "m" }],
        totalCount: 1,
        page: 1,
        limit: 1,
      }),
    ).toBe(false);
    expect(
      isRestoreDocumentResult({
        result: "restored",
        documentId: "d",
        restoredTopicId: null,
      }),
    ).toBe(true);
    expect(
      isRestoreDocumentResult({
        result: "setRestoreConfirmationRequired",
        documentId: "d",
        topicId: "t",
        topicName: "n",
      }),
    ).toBe(true);
    expect(
      isRestoreDocumentResult({
        result: "destinationSelectionRequired",
        documentId: "d",
      }),
    ).toBe(true);
    expect(isRestoreDocumentResult({ result: "nope", documentId: "d" })).toBe(
      false,
    );
  });
});
