import type { EditDocumentInput } from "@repo/core/application/knowledge/editDocument";
import type { RollbackDocumentInput } from "@repo/core/application/knowledge/rollbackDocument";
import type { EditMemoInput } from "@repo/core/application/memo/editMemo";
import type { RollbackMemoInput } from "@repo/core/application/memo/rollbackMemo";
import { describe, expect, it } from "vitest";
import type { AiToolContext } from "../tools";

// The type layer of the allow-list: the actor an AI tool holds cannot be
// handed to a human-only usecase. These lines are the guarantee — if a
// `UserActor` parameter ever widens to `Actor`, the `@ts-expect-error`
// below becomes an unused directive and `pnpm typecheck` fails.
const ctx = {
  actor: { kind: "aiClient", userId: "u", connectionId: "c", clientName: "n" },
} as unknown as AiToolContext;

describe("an AI actor cannot reach a human-only usecase", () => {
  it("is refused by the type system", () => {
    const editMemo: EditMemoInput = {
      userId: "u",
      memoId: "m",
      body: "b",
      expectedVersion: 0,
      // @ts-expect-error the input's `actor` is `UserActor`
      actor: ctx.actor,
    };
    const rollbackMemo: RollbackMemoInput = {
      userId: "u",
      memoId: "m",
      targetRevisionNumber: 1,
      // @ts-expect-error the input's `actor` is `UserActor`
      actor: ctx.actor,
    };
    const editDocument: EditDocumentInput = {
      userId: "u",
      documentId: "d",
      title: "t",
      body: "b",
      expectedVersion: 0,
      // @ts-expect-error the input's `actor` is `UserActor`
      actor: ctx.actor,
    };
    const rollbackDocument: RollbackDocumentInput = {
      userId: "u",
      documentId: "d",
      targetRevisionNumber: 1,
      // @ts-expect-error the input's `actor` is `UserActor`
      actor: ctx.actor,
    };
    expect([
      editMemo,
      rollbackMemo,
      editDocument,
      rollbackDocument,
    ]).toBeDefined();
  });
});
