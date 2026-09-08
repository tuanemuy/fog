import { isValidationError } from "@repo/core/application/errors";
import type { AiClientActorDto } from "@repo/core/application/identity/actorDto";
import { describe, expect, it } from "vitest";
import { trippingKnowledgeGateway } from "../../__tests__/fakes";
import {
  makeContainer,
  recordingGateway,
} from "../../identity/__tests__/unitContainer";
import { editDocumentByAi } from "../editDocumentByAi";
import type { EditDocumentByAiDto, KnowledgeGateway } from "../gateway";

const ACTOR: AiClientActorDto = {
  kind: "aiClient",
  userId: "u",
  connectionId: "c",
  clientName: "Claude",
};

function containerWith(gateway: KnowledgeGateway) {
  return makeContainer(recordingGateway([], {}), { knowledgeGateway: gateway });
}

describe("editDocumentByAi (request side)", () => {
  it("requires a change reason before reaching the object, and trims it", async () => {
    const sent: EditDocumentByAiDto[] = [];
    const gateway = trippingKnowledgeGateway(
      (name) => {
        throw new Error(`unexpected knowledge gateway call: ${name}`);
      },
      {
        editDocumentByAi: async (_userId, dto) => {
          sent.push(dto);
          return { changed: true, latestRevision: 2, updatedAt: new Date(0) };
        },
      },
    );
    const container = containerWith(gateway);
    for (const changeReason of [undefined, null, "", "   "]) {
      let caught: unknown = null;
      try {
        await editDocumentByAi({
          container,
          input: {
            userId: "u",
            actor: ACTOR,
            documentId: "d",
            edit: { mode: "replaceAll", body: "x" },
            changeReason,
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(isValidationError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe("CHANGE_REASON_REQUIRED");
    }
    expect(sent).toHaveLength(0);

    await editDocumentByAi({
      container,
      input: {
        userId: "u",
        actor: ACTOR,
        documentId: "d",
        edit: { mode: "patch", patches: [{ oldText: "a", newText: "b" }] },
        changeReason: "  typo  ",
      },
    });
    expect(sent[0]).toEqual({
      actor: ACTOR,
      documentId: "d",
      edit: { mode: "patch", patches: [{ oldText: "a", newText: "b" }] },
      changeReason: "typo",
    });
  });
});
