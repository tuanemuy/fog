import { Actor, UserId } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { isValidationError } from "../../errors";
import { diffMemoRevisions } from "../diffMemoRevisions";
import type { DiffRevisionsDto, RollbackMemoDto } from "../gateway";
import { listMemoRevisions } from "../listMemoRevisions";
import { rollbackMemo } from "../rollbackMemo";
import { softDeleteMemo } from "../softDeleteMemo";
import { memoContainer } from "./memoContainer";

const REVISION = {
  revisionNumber: 1,
  actor: { kind: "user" },
  createdAt: new Date("2026-07-22T01:00:00.000Z"),
  body: "first",
} as const;

const MEMO = {
  id: "memo-1",
  body: "first",
  postedAt: new Date("2026-07-22T01:00:00.000Z"),
  updatedAt: new Date("2026-07-22T01:00:00.000Z"),
  latestRevisionNumber: 1,
  version: 0,
} as const;

describe("listMemoRevisions", () => {
  it("asks the user's Durable Object for the memo's history", async () => {
    const calls: [string, string][] = [];
    const view = {
      memoId: "memo-1",
      latestRevisionNumber: 1,
      revisions: [
        {
          revisionNumber: REVISION.revisionNumber,
          actor: REVISION.actor,
          createdAt: REVISION.createdAt,
        },
      ],
    };
    const container = memoContainer({
      listMemoRevisions: async (userId, memoId) => {
        calls.push([userId, memoId]);
        return view;
      },
    });

    await expect(
      listMemoRevisions({
        container,
        input: { userId: "user-1", memoId: "memo-1" },
      }),
    ).resolves.toEqual(view);
    expect(calls).toEqual([["user-1", "memo-1"]]);
  });
});

describe("diffMemoRevisions", () => {
  it("passes the two revision numbers through in the order given", async () => {
    const calls: [string, DiffRevisionsDto][] = [];
    const container = memoContainer({
      diffMemoRevisions: async (userId, input) => {
        calls.push([userId, input]);
        return { base: REVISION, target: { ...REVISION, revisionNumber: 3 } };
      },
    });

    const result = await diffMemoRevisions({
      container,
      input: {
        userId: "user-1",
        memoId: "memo-1",
        baseRevisionNumber: 3,
        targetRevisionNumber: 1,
      },
    });
    expect(result.base.revisionNumber).toBe(1);
    expect(calls).toEqual([
      [
        "user-1",
        { memoId: "memo-1", baseRevisionNumber: 3, targetRevisionNumber: 1 },
      ],
    ]);
  });

  it("refuses the same revision twice before reaching the gateway", async () => {
    const container = memoContainer({
      diffMemoRevisions: async () => {
        throw new Error("must not be reached");
      },
    });
    await expect(
      diffMemoRevisions({
        container,
        input: {
          userId: "user-1",
          memoId: "memo-1",
          baseRevisionNumber: 2,
          targetRevisionNumber: 2,
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isValidationError(error) && error.code === "SAME_REVISION",
    );
  });
});

describe("rollbackMemo", () => {
  it("carries no expectedVersion — the intent does not depend on one", async () => {
    const calls: [string, RollbackMemoDto][] = [];
    const container = memoContainer({
      rollbackMemo: async (userId, input) => {
        calls.push([userId, input]);
        return { result: "rolledBack", memo: MEMO };
      },
    });

    await rollbackMemo({
      container,
      input: {
        userId: "user-1",
        memoId: "memo-1",
        targetRevisionNumber: 1,
        actor: Actor.user(UserId.create("user-1")),
      },
    });
    expect(calls).toEqual([
      [
        "user-1",
        {
          memoId: "memo-1",
          targetRevisionNumber: 1,
          actor: { kind: "user", userId: "user-1" },
        },
      ],
    ]);
  });
});

describe("softDeleteMemo", () => {
  it("answers nothing; the removal from the list is the screen's to show", async () => {
    const calls: [string, string][] = [];
    const container = memoContainer({
      softDeleteMemo: async (userId, memoId) => {
        calls.push([userId, memoId]);
      },
    });

    await expect(
      softDeleteMemo({
        container,
        input: { userId: "user-1", memoId: "memo-1" },
      }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([["user-1", "memo-1"]]);
  });
});
