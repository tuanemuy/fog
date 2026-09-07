import { isBusinessRuleError } from "@repo/core/domain/error";
import { Actor, UserId } from "@repo/core/domain/identity/valueObject";
import { describe, expect, it } from "vitest";
import { Memo, type MemoRevision } from "../entity";
import { MemoErrorCode } from "../errorCode";

const NOW = new Date("2026-09-08T00:00:00.000Z");
const LATER = new Date("2026-09-08T01:00:00.000Z");
const PURGE_AFTER = new Date("2026-10-08T01:00:00.000Z");
const ACTOR = Actor.user(UserId.create("user-1"));

function businessCodeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (isBusinessRuleError(error)) return error.code;
    throw error;
  }
  return null;
}

function createMemo(body = "first") {
  return Memo.create(
    { id: "memo-1", userId: "user-1", body, actor: ACTOR },
    NOW,
  );
}

describe("Memo.create", () => {
  it("is born active at revision 1 and version 0, posted at now", () => {
    const { memo, initialRevision } = createMemo();

    expect(memo).toEqual({
      id: "memo-1",
      userId: "user-1",
      body: "first",
      latestRevisionNumber: 1,
      postedAt: NOW,
      version: 0,
      updatedAt: NOW,
      status: "active",
    });
    expect(initialRevision).toEqual({
      memoId: "memo-1",
      revisionNumber: 1,
      actor: ACTOR,
      body: "first",
      createdAt: NOW,
    });
  });

  it("refuses an empty body", () => {
    expect(businessCodeOf(() => createMemo(" "))).toBe(MemoErrorCode.EmptyBody);
  });
});

describe("Memo.edit", () => {
  it("returns the same memo object and no revision for an unchanged body", () => {
    const { memo } = createMemo();
    const result = Memo.edit(memo, { body: "first", actor: ACTOR }, LATER);

    expect(result.memo).toBe(memo);
    expect(result.newRevision).toBeNull();
  });

  it("appends revision 2 and bumps the version for a new body, leaving postedAt alone", () => {
    const { memo } = createMemo();
    const result = Memo.edit(memo, { body: "second", actor: ACTOR }, LATER);

    expect(result.memo).toEqual({
      ...memo,
      body: "second",
      latestRevisionNumber: 2,
      version: 1,
      updatedAt: LATER,
    });
    expect(result.memo.postedAt).toBe(NOW);
    expect(result.newRevision).toEqual({
      memoId: "memo-1",
      revisionNumber: 2,
      actor: ACTOR,
      body: "second",
      createdAt: LATER,
    });
  });

  it("validates the new body", () => {
    const { memo } = createMemo();
    expect(
      businessCodeOf(() => Memo.edit(memo, { body: "", actor: ACTOR }, LATER)),
    ).toBe(MemoErrorCode.EmptyBody);
  });
});

describe("Memo.rollback", () => {
  it("refuses a revision that belongs to another memo", () => {
    const { memo } = createMemo();
    const foreign: MemoRevision = {
      ...createMemo().initialRevision,
      memoId: Memo.create(
        { id: "memo-2", userId: "user-1", body: "x", actor: ACTOR },
        NOW,
      ).memo.id,
    };

    expect(
      businessCodeOf(() =>
        Memo.rollback(memo, { targetRevision: foreign, actor: ACTOR }, LATER),
      ),
    ).toBe(MemoErrorCode.RevisionMismatch);
  });

  it("yields no revision when the target already matches the current body", () => {
    const { memo, initialRevision } = createMemo();
    const result = Memo.rollback(
      memo,
      { targetRevision: initialRevision, actor: ACTOR },
      LATER,
    );

    expect(result.memo).toBe(memo);
    expect(result.newRevision).toBeNull();
  });

  it("records the past body as a new revision rather than rewinding history", () => {
    const { memo, initialRevision } = createMemo();
    const edited = Memo.edit(memo, { body: "second", actor: ACTOR }, LATER);
    const result = Memo.rollback(
      edited.memo,
      { targetRevision: initialRevision, actor: ACTOR },
      LATER,
    );

    expect(result.memo.body).toBe("first");
    expect(result.memo.latestRevisionNumber).toBe(3);
    expect(result.memo.version).toBe(2);
    expect(result.newRevision?.revisionNumber).toBe(3);
    expect(result.newRevision?.body).toBe("first");
  });
});

describe("Memo.softDelete / Memo.restore", () => {
  it("round-trips through trash, bumping the version each way", () => {
    const { memo } = createMemo();
    const trashed = Memo.softDelete(memo, PURGE_AFTER, LATER);

    expect(trashed.status).toBe("trashed");
    expect(trashed.trashedAt).toBe(LATER);
    expect(trashed.purgeAfter).toBe(PURGE_AFTER);
    expect(trashed.version).toBe(1);
    expect(trashed.updatedAt).toBe(LATER);
    expect(trashed.postedAt).toBe(NOW);

    const restoreAt = new Date("2026-09-08T02:00:00.000Z");
    const restored = Memo.restore(trashed, restoreAt);

    expect(restored).toEqual({
      ...memo,
      status: "active",
      version: 2,
      updatedAt: restoreAt,
    });
    expect("trashedAt" in restored).toBe(false);
    expect("purgeAfter" in restored).toBe(false);
  });
});
