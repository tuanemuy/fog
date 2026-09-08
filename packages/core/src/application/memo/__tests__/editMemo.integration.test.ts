import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import type { RequestContainer } from "@repo/core/application/di/types";
import {
  isConflictError,
  isNotFoundError,
} from "@repo/core/application/errors";
import { editMemo } from "@repo/core/application/memo/editMemo";
import { softDeleteMemo } from "@repo/core/application/memo/softDeleteMemo";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { MEMO_BODY_MAX_CODE_POINTS } from "@repo/core/domain/memo/valueObject";
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

function edit(
  container: RequestContainer,
  userId: string,
  memoId: string,
  body: string,
  expectedVersion: number,
) {
  return editMemo({
    container,
    input: { userId, memoId, body, expectedVersion, actor: userActor(userId) },
  });
}

describe("editMemo", () => {
  it("(a) stacks a revision, re-projects the body and leaves postedAt alone", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await post(container, userId, "first draft alpha");
    const before = Date.now();

    const result = await edit(
      container,
      userId,
      memo.id,
      "second draft bravo",
      0,
    );
    expect(result.result).toBe("saved");
    expect(result.conflict).toBeNull();
    expect(result.memo).toMatchObject({
      id: memo.id,
      body: "second draft bravo",
      version: 1,
      latestRevisionNumber: 2,
      postedAt: memo.postedAt,
    });
    expect(result.memo.updatedAt.getTime()).toBeGreaterThanOrEqual(before);

    const row = await readMemoRow(userId, memo.id);
    expect(row).toMatchObject({
      status: "active",
      version: 1,
      body: "second draft bravo",
      latest_revision_number: 2,
      posted_at: memo.postedAt.getTime(),
    });
    await inUserDataStorage(userId, (sql) => {
      const revisions = sql
        .exec<{ revision_number: number; actor_type: string; body: string }>(
          "SELECT revision_number, actor_type, body FROM memo_revisions WHERE memo_id = ? ORDER BY revision_number",
          memo.id,
        )
        .toArray();
      expect(revisions).toEqual([
        { revision_number: 1, actor_type: "user", body: "first draft alpha" },
        { revision_number: 2, actor_type: "user", body: "second draft bravo" },
      ]);
      expect(
        sql
          .exec<{ body: string }>(
            "SELECT body FROM search_entries WHERE id = ?",
            memo.id,
          )
          .one().body,
      ).toBe("second draft bravo");
    });
    expect(await searchHits(userId, "bravo")).toEqual([memo.id]);
    expect(await searchHits(userId, "alpha")).toEqual([]);
  });

  it("(b) writes nothing for the same body, and a trailing space is a different body", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await post(container, userId, "same");

    const unchanged = await edit(container, userId, memo.id, "same", 0);
    expect(unchanged).toMatchObject({ result: "unchanged", conflict: null });
    expect(unchanged.memo.version).toBe(0);
    expect(await readMemoRow(userId, memo.id)).toMatchObject({ version: 0 });
    expect(await countRevisions(userId, memo.id)).toBe(1);

    const spaced = await edit(container, userId, memo.id, "same ", 0);
    expect(spaced.result).toBe("saved");
    expect(spaced.memo.version).toBe(1);
    expect(await countRevisions(userId, memo.id)).toBe(2);
  });

  it("(c) answers a conflict without writing, then applies the body on top with the current version", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await post(container, userId, "original");
    await editAsAiClient(userId, memo.id, "AI rewrote this", "Claude");

    const conflict = await edit(container, userId, memo.id, "mine", 0);
    expect(conflict.result).toBe("conflict");
    expect(conflict.memo).toMatchObject({
      body: "AI rewrote this",
      version: 1,
      latestRevisionNumber: 2,
    });
    expect(conflict.conflict).toMatchObject({
      currentBody: "AI rewrote this",
      currentVersion: 1,
      latestRevision: {
        revisionNumber: 2,
        actor: { kind: "aiClient", clientName: "Claude" },
      },
    });
    expect(conflict.conflict?.latestRevision.createdAt).toBeInstanceOf(Date);
    expect(await readMemoRow(userId, memo.id)).toMatchObject({
      version: 1,
      body: "AI rewrote this",
    });
    expect(await countRevisions(userId, memo.id)).toBe(2);

    const saved = await edit(
      container,
      userId,
      memo.id,
      "mine",
      conflict.conflict?.currentVersion ?? -1,
    );
    expect(saved.result).toBe("saved");
    expect(saved.memo).toMatchObject({
      body: "mine",
      version: 2,
      latestRevisionNumber: 3,
    });
    await inUserDataStorage(userId, (sql) => {
      expect(
        sql
          .exec<{ revision_number: number; actor_client_name: string | null }>(
            "SELECT revision_number, actor_client_name FROM memo_revisions WHERE memo_id = ? ORDER BY revision_number",
            memo.id,
          )
          .toArray(),
      ).toEqual([
        { revision_number: 1, actor_client_name: null },
        { revision_number: 2, actor_client_name: "Claude" },
        { revision_number: 3, actor_client_name: null },
      ]);
    });
  });

  it("(d) names the user as the latest actor when another session of theirs edited first", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await post(container, userId, "original");
    await edit(container, userId, memo.id, "other tab", 0);

    const conflict = await edit(container, userId, memo.id, "this tab", 0);
    expect(conflict.result).toBe("conflict");
    expect(conflict.conflict?.latestRevision.actor).toEqual({ kind: "user" });
  });

  it("(e) holds the body invariants: 10,000 code points pass, 10,001 and blank fail", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await post(container, userId, "seed");

    const exactly = "😀".repeat(MEMO_BODY_MAX_CODE_POINTS);
    const saved = await edit(container, userId, memo.id, exactly, 0);
    expect(saved.result).toBe("saved");

    await expectCode(
      edit(container, userId, memo.id, `${exactly}😀`, 1),
      isBusinessRuleError,
      "BODY_TOO_LONG",
    );
    await expectCode(
      edit(container, userId, memo.id, "", 1),
      isBusinessRuleError,
      "EMPTY_BODY",
    );
    await expectCode(
      edit(container, userId, memo.id, " \n\t ", 1),
      isBusinessRuleError,
      "EMPTY_BODY",
    );
    expect(await readMemoRow(userId, memo.id)).toMatchObject({
      version: 1,
      body: exactly,
    });
    expect(await countRevisions(userId, memo.id)).toBe(2);
  });

  it("(f) answers NotFound for a missing memo, a trashed one and a blank id", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    await expectCode(
      edit(container, userId, "no-such-memo", "x", 0),
      isNotFoundError,
      "MEMO_NOT_FOUND",
    );
    const memo = await post(container, userId, "to trash");
    await softDeleteMemo({ container, input: { userId, memoId: memo.id } });
    await expectCode(
      edit(container, userId, memo.id, "x", 1),
      isNotFoundError,
      "MEMO_NOT_FOUND",
    );
    await expectCode(
      edit(container, userId, "   ", "x", 0),
      isBusinessRuleError,
      "INVALID_MEMO_ID",
    );
  });

  // T-1: the OCC signal is the guarded UPDATE matching no row. A BEFORE
  // UPDATE trigger that raises IGNORE makes the statement skip the row the
  // way a concurrent writer's version bump would, which is the only way to
  // open that window from outside a single-threaded transaction. What is
  // under test is the whole path the conflict then travels: `save` →
  // `ConflictError` → the DO's envelope → `callDurableObject` → the request
  // side, as the same `kind` and `code`.
  it("(g) T-1: a save that matches no row reaches the request side as ConflictError(OPTIMISTIC_LOCK_FAILURE)", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await post(container, userId, "before");
    await inUserDataStorage(userId, (sql) => {
      sql.exec(
        "CREATE TRIGGER occ_probe BEFORE UPDATE ON memos BEGIN SELECT RAISE(IGNORE); END",
      );
    });

    let caught: unknown = null;
    try {
      await edit(container, userId, memo.id, "after", 0);
    } catch (error) {
      caught = error;
    }
    expect(isConflictError(caught)).toBe(true);
    if (!isConflictError(caught)) throw caught;
    expect(caught.code).toBe("OPTIMISTIC_LOCK_FAILURE");
    expect(caught.toSerialized()).toMatchObject({
      kind: "conflict",
      code: "OPTIMISTIC_LOCK_FAILURE",
    });

    // The transaction unwound: no revision, no projection change.
    expect(await readMemoRow(userId, memo.id)).toMatchObject({
      version: 0,
      body: "before",
    });
    expect(await countRevisions(userId, memo.id)).toBe(1);
    expect(await searchHits(userId, "after")).toEqual([]);

    await inUserDataStorage(userId, (sql) => {
      sql.exec("DROP TRIGGER occ_probe");
    });
    const saved = await edit(container, userId, memo.id, "after", 0);
    expect(saved.result).toBe("saved");
  });
});
