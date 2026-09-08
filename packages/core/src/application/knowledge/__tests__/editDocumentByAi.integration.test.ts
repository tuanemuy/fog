import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import {
  isNotFoundError,
  isValidationError,
} from "@repo/core/application/errors";
import type { AiClientActorDto } from "@repo/core/application/identity/actorDto";
import { approveAiClientAuthorization } from "@repo/core/application/identity/approveAiClientAuthorization";
import { editDocumentByAi } from "@repo/core/application/knowledge/editDocumentByAi";
import { getDocument } from "@repo/core/application/knowledge/getDocument";
import { listDocumentRevisions } from "@repo/core/application/knowledge/listDocumentRevisions";
import { trashDocument } from "@repo/core/application/knowledge/trashDocument";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { KnowledgeErrorCode } from "@repo/core/domain/knowledge/errorCode";
import { describe, expect, it } from "vitest";
import {
  document,
  readDocumentRow,
  revisionRows,
  searchEntry,
  topic,
} from "./knowledgeFixtures";

async function aiActor(
  container: ReturnType<typeof createTestContainer>,
  userId: string,
): Promise<AiClientActorDto> {
  const { connectionId } = await approveAiClientAuthorization({
    container,
    input: { userId, clientName: "Claude" },
  });
  return { kind: "aiClient", userId, connectionId, clientName: "Claude" };
}

// R-AI-01 on the document side: the AI edit lands as one revision that
// names the client and carries the reason it had to give; a patch that
// cannot apply changes nothing; a trashed document is not there.
describe("editDocumentByAi through the User Data object", () => {
  it("patch, then replaceAll, then the same body again — three calls, two revisions", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const actor = await aiActor(container, userId);
    const t = await topic(container, userId);
    const doc = await document(container, userId, t.id, {
      body: "最初の本文。次の段落。",
    });

    const patched = await editDocumentByAi({
      container,
      input: {
        userId,
        actor,
        documentId: doc.id,
        edit: {
          mode: "patch",
          patches: [
            { oldText: "次の段落。", newText: "次の段落。AI が追記。" },
          ],
        },
        changeReason: " AI が追記 ",
      },
    });
    expect(patched).toMatchObject({ changed: true, latestRevision: 2 });

    const replaced = await editDocumentByAi({
      container,
      input: {
        userId,
        actor,
        documentId: doc.id,
        edit: { mode: "replaceAll", body: "全面書き直し salamander" },
        changeReason: "全面書き直し",
      },
    });
    expect(replaced).toMatchObject({ changed: true, latestRevision: 3 });

    const unchanged = await editDocumentByAi({
      container,
      input: {
        userId,
        actor,
        documentId: doc.id,
        edit: { mode: "replaceAll", body: "全面書き直し salamander" },
        changeReason: "同じ本文",
      },
    });
    expect(unchanged).toMatchObject({ changed: false, latestRevision: 3 });
    expect(unchanged.updatedAt).toEqual(replaced.updatedAt);

    expect(await revisionRows(userId, doc.id)).toMatchObject([
      { revision_number: 1, actor_type: "user" },
      {
        revision_number: 2,
        actor_type: "ai_client",
        change_reason: "AI が追記",
        body: "最初の本文。次の段落。AI が追記。",
      },
      {
        revision_number: 3,
        actor_type: "ai_client",
        change_reason: "全面書き直し",
        body: "全面書き直し salamander",
      },
    ]);
    expect(await readDocumentRow(userId, doc.id)).toMatchObject({
      latest_revision_number: 3,
      body: "全面書き直し salamander",
    });
    expect(await searchEntry(userId, doc.id)).not.toBeNull();

    // P-10 reads the client's name and the reason.
    const history = await listDocumentRevisions({
      container,
      input: { userId, documentId: doc.id },
    });
    expect(
      history.revisions.map((r) => [r.revisionNumber, r.actor, r.changeReason]),
    ).toEqual(
      expect.arrayContaining([
        [2, { kind: "aiClient", clientName: "Claude" }, "AI が追記"],
        [3, { kind: "aiClient", clientName: "Claude" }, "全面書き直し"],
      ]),
    );
  });

  it("a patch whose target is missing or repeated applies nothing — no revision, no body change", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const actor = await aiActor(container, userId);
    const t = await topic(container, userId);
    const doc = await document(container, userId, t.id, {
      body: "同じ語 と 同じ語",
    });
    const attempt = (patches: { oldText: string; newText: string }[]) =>
      editDocumentByAi({
        container,
        input: {
          userId,
          actor,
          documentId: doc.id,
          edit: { mode: "patch", patches },
          changeReason: "失敗する編集",
        },
      });

    for (const [patches, code] of [
      [
        [{ oldText: "無い語", newText: "x" }],
        KnowledgeErrorCode.PatchTargetNotFound,
      ],
      [
        [{ oldText: "同じ語", newText: "x" }],
        KnowledgeErrorCode.PatchTargetAmbiguous,
      ],
      [
        [
          { oldText: "同じ語 と", newText: "先に成功" },
          { oldText: "無い語", newText: "後で失敗" },
        ],
        KnowledgeErrorCode.PatchTargetNotFound,
      ],
    ] as const) {
      let caught: unknown = null;
      try {
        await attempt([...patches]);
      } catch (error) {
        caught = error;
      }
      expect(isBusinessRuleError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe(code);
    }
    expect(await readDocumentRow(userId, doc.id)).toMatchObject({
      latest_revision_number: 1,
      body: "同じ語 と 同じ語",
    });
    expect(await revisionRows(userId, doc.id)).toHaveLength(1);
  });

  it("a blank changeReason is refused before the object is asked; a trashed document is not found", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const actor = await aiActor(container, userId);
    const t = await topic(container, userId);
    const doc = await document(container, userId, t.id);

    for (const changeReason of ["", "   ", null, undefined]) {
      let caught: unknown = null;
      try {
        await editDocumentByAi({
          container,
          input: {
            userId,
            actor,
            documentId: doc.id,
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
    expect(await revisionRows(userId, doc.id)).toHaveLength(1);

    await trashDocument({ container, input: { userId, documentId: doc.id } });
    let caught: unknown = null;
    try {
      await editDocumentByAi({
        container,
        input: {
          userId,
          actor,
          documentId: doc.id,
          edit: { mode: "replaceAll", body: "x" },
          changeReason: "ゴミ箱の文書",
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(isNotFoundError(caught)).toBe(true);
    caught = null;
    try {
      await getDocument({ container, input: { userId, documentId: doc.id } });
    } catch (error) {
      caught = error;
    }
    expect(isNotFoundError(caught)).toBe(true);
  });
});
