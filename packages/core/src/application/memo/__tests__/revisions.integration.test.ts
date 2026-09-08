import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import type { RequestContainer } from "@repo/core/application/di/types";
import {
  isNotFoundError,
  isValidationError,
} from "@repo/core/application/errors";
import { diffMemoRevisions } from "@repo/core/application/memo/diffMemoRevisions";
import { editMemo } from "@repo/core/application/memo/editMemo";
import { listMemoRevisions } from "@repo/core/application/memo/listMemoRevisions";
import { rollbackMemo } from "@repo/core/application/memo/rollbackMemo";
import { softDeleteMemo } from "@repo/core/application/memo/softDeleteMemo";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import {
  countRevisions,
  editAsAiClient,
  expectCode,
  post,
  readMemoRow,
  searchHits,
  userActor,
} from "./memoFixtures";

/** A memo with three revisions: user, AI client, user. */
async function threeRevisions(container: RequestContainer, userId: string) {
  const memo = await post(container, userId, "one first");
  await editAsAiClient(userId, memo.id, "two second", "Claude");
  const third = await editMemo({
    container,
    input: {
      userId,
      memoId: memo.id,
      body: "three third",
      expectedVersion: 1,
      actor: userActor(userId),
    },
  });
  expect(third.result).toBe("saved");
  return memo;
}

describe("listMemoRevisions", () => {
  it("(a) lists who and when in ascending order, without bodies, for active and trashed memos", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await threeRevisions(container, userId);

    const view = await listMemoRevisions({
      container,
      input: { userId, memoId: memo.id },
    });
    expect(view.memoId).toBe(memo.id);
    expect(view.latestRevisionNumber).toBe(3);
    expect(view.revisions.map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
    expect(view.revisions.map((r) => r.actor)).toEqual([
      { kind: "user" },
      { kind: "aiClient", clientName: "Claude" },
      { kind: "user" },
    ]);
    for (const revision of view.revisions) {
      expect(Object.keys(revision).sort()).toEqual([
        "actor",
        "createdAt",
        "revisionNumber",
      ]);
      expect(revision.createdAt).toBeInstanceOf(Date);
    }

    await softDeleteMemo({ container, input: { userId, memoId: memo.id } });
    const trashed = await listMemoRevisions({
      container,
      input: { userId, memoId: memo.id },
    });
    expect(trashed.revisions).toHaveLength(3);
  });

  it("(b) answers one revision right after posting and NotFound for an unknown memo", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await post(container, userId, "fresh");
    const view = await listMemoRevisions({
      container,
      input: { userId, memoId: memo.id },
    });
    expect(view.revisions.map((r) => r.revisionNumber)).toEqual([1]);
    await expectCode(
      listMemoRevisions({ container, input: { userId, memoId: "nope" } }),
      isNotFoundError,
      "MEMO_NOT_FOUND",
    );
    await expectCode(
      listMemoRevisions({ container, input: { userId, memoId: " " } }),
      isBusinessRuleError,
      "INVALID_MEMO_ID",
    );
  });
});

describe("diffMemoRevisions", () => {
  it("(c) returns the two snapshots in the order asked, with their actors", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await threeRevisions(container, userId);
    const diff = (base: number, target: number) =>
      diffMemoRevisions({
        container,
        input: {
          userId,
          memoId: memo.id,
          baseRevisionNumber: base,
          targetRevisionNumber: target,
        },
      });

    const forward = await diff(1, 3);
    expect(forward.base).toMatchObject({
      revisionNumber: 1,
      body: "one first",
      actor: { kind: "user" },
    });
    expect(forward.target).toMatchObject({
      revisionNumber: 3,
      body: "three third",
    });

    const backward = await diff(3, 1);
    expect(backward.base.revisionNumber).toBe(3);
    expect(backward.target.revisionNumber).toBe(1);

    const ai = await diff(1, 2);
    expect(ai.target.actor).toEqual({ kind: "aiClient", clientName: "Claude" });

    await expectCode(diff(2, 2), isValidationError, "SAME_REVISION");
    await expectCode(diff(1, 4), isNotFoundError, "REVISION_NOT_FOUND");
    await expectCode(
      diff(0, 1),
      isBusinessRuleError,
      "INVALID_REVISION_NUMBER",
    );
    await expectCode(
      diff(1, 1.5),
      isBusinessRuleError,
      "INVALID_REVISION_NUMBER",
    );
    await expectCode(
      diffMemoRevisions({
        container,
        input: {
          userId,
          memoId: "nope",
          baseRevisionNumber: 1,
          targetRevisionNumber: 2,
        },
      }),
      isNotFoundError,
      "REVISION_NOT_FOUND",
    );

    await softDeleteMemo({ container, input: { userId, memoId: memo.id } });
    expect((await diff(1, 2)).base.body).toBe("one first");
  });
});

describe("rollbackMemo", () => {
  it("(d) stacks the target body as a new revision and keeps the history", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await threeRevisions(container, userId);
    const rollback = (targetRevisionNumber: number) =>
      rollbackMemo({
        container,
        input: {
          userId,
          memoId: memo.id,
          targetRevisionNumber,
          actor: userActor(userId),
        },
      });

    const rolled = await rollback(1);
    expect(rolled.result).toBe("rolledBack");
    expect(rolled.memo).toMatchObject({
      body: "one first",
      latestRevisionNumber: 4,
      version: 3,
      postedAt: memo.postedAt,
    });
    expect(await countRevisions(userId, memo.id)).toBe(4);
    const history = await listMemoRevisions({
      container,
      input: { userId, memoId: memo.id },
    });
    expect(history.revisions.map((r) => r.revisionNumber)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(history.revisions[3]?.actor).toEqual({ kind: "user" });
    expect(await searchHits(userId, "first")).toEqual([memo.id]);
    expect(await searchHits(userId, "third")).toEqual([]);

    // Now identical to revision 1 and to revision 4: both are no-ops.
    expect(await rollback(1)).toMatchObject({ result: "unchanged" });
    expect(await rollback(4)).toMatchObject({ result: "unchanged" });
    expect(await countRevisions(userId, memo.id)).toBe(4);
    expect(await readMemoRow(userId, memo.id)).toMatchObject({ version: 3 });

    await expectCode(rollback(99), isNotFoundError, "REVISION_NOT_FOUND");
    await expectCode(
      rollback(0),
      isBusinessRuleError,
      "INVALID_REVISION_NUMBER",
    );
  });

  it("(e) answers unchanged for the latest revision and NotFound past the trash", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await threeRevisions(container, userId);
    const rollback = (memoId: string, targetRevisionNumber: number) =>
      rollbackMemo({
        container,
        input: {
          userId,
          memoId,
          targetRevisionNumber,
          actor: userActor(userId),
        },
      });

    expect(await rollback(memo.id, 3)).toMatchObject({ result: "unchanged" });
    await expectCode(rollback("nope", 1), isNotFoundError, "MEMO_NOT_FOUND");
    await softDeleteMemo({ container, input: { userId, memoId: memo.id } });
    await expectCode(rollback(memo.id, 1), isNotFoundError, "MEMO_NOT_FOUND");
  });
});
