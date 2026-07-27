import { describe, expect, it } from "vitest";
import {
  MAX_DOCUMENT_BODY_CODE_POINTS,
  prepareSemanticCommand,
} from "../prepareSemanticCommand";

function createDocument(body: string) {
  return {
    version: 1,
    operationId: "create-document",
    type: "create-document",
    document: {
      id: "document",
      title: "境界値",
      body,
      timestamp: 1,
      topicId: "topic",
      sourceMemoIds: [],
    },
  };
}

describe("prepareSemanticCommand", () => {
  it("accepts the Unicode document body boundary", () => {
    const body = "界".repeat(MAX_DOCUMENT_BODY_CODE_POINTS);

    expect(prepareSemanticCommand(createDocument(body), 2)).toMatchObject({
      type: "create-document",
      document: { body },
      completedAt: 2,
    });
  });

  it("rejects a document body above the Unicode boundary", () => {
    const body = "界".repeat(MAX_DOCUMENT_BODY_CODE_POINTS + 1);

    expect(() => prepareSemanticCommand(createDocument(body), 2)).toThrow(
      expect.objectContaining({ code: "DOCUMENT_BODY_TOO_LONG" }),
    );
  });

  it("requires expectedVersion zero or greater for mutations", () => {
    const update = {
      ...createDocument("body"),
      operationId: "update-document",
      type: "update-document",
      changeReason: "reason",
    };

    expect(() => prepareSemanticCommand(update, 2)).toThrow(
      expect.objectContaining({ code: "SEMANTIC_COMMAND_INVALID" }),
    );
    expect(
      prepareSemanticCommand({ ...update, expectedVersion: 0 }, 2),
    ).toMatchObject({ expectedVersion: 0 });
  });
});
