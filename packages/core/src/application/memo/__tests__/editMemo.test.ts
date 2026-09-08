import { Actor, UserId } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { editMemo } from "../editMemo";
import type { EditMemoDto } from "../gateway";
import { memoContainer } from "./memoContainer";

const MEMO = {
  id: "memo-1",
  body: "after",
  postedAt: new Date("2026-07-22T01:00:00.000Z"),
  updatedAt: new Date("2026-07-22T02:00:00.000Z"),
  latestRevisionNumber: 2,
  version: 1,
} as const;

describe("editMemo", () => {
  it("carries the actor as primitives and never as a value object", async () => {
    const calls: [string, EditMemoDto][] = [];
    const container = memoContainer({
      editMemo: async (userId, input) => {
        calls.push([userId, input]);
        return { result: "saved", memo: MEMO, conflict: null };
      },
    });

    const result = await editMemo({
      container,
      input: {
        userId: "user-1",
        memoId: "memo-1",
        body: "after",
        expectedVersion: 0,
        actor: Actor.user(UserId.create("user-1")),
      },
    });

    expect(result.result).toBe("saved");
    expect(calls).toEqual([
      [
        "user-1",
        {
          memoId: "memo-1",
          body: "after",
          expectedVersion: 0,
          actor: { kind: "user", userId: "user-1" },
        },
      ],
    ]);
  });

  it("passes a conflict answer through untouched", async () => {
    const conflict = {
      currentBody: "somebody else",
      currentVersion: 3,
      latestRevision: {
        revisionNumber: 4,
        actor: { kind: "aiClient", clientName: "Claude" },
        createdAt: new Date("2026-07-22T03:00:00.000Z"),
      },
    } as const;
    const container = memoContainer({
      editMemo: async () => ({ result: "conflict", memo: MEMO, conflict }),
    });

    await expect(
      editMemo({
        container,
        input: {
          userId: "user-1",
          memoId: "memo-1",
          body: "mine",
          expectedVersion: 0,
          actor: Actor.user(UserId.create("user-1")),
        },
      }),
    ).resolves.toEqual({ result: "conflict", memo: MEMO, conflict });
  });
});
