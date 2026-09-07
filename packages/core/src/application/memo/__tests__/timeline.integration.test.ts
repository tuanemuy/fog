import { inUserDataStorage } from "@repo/core/adapters/cloudflare/__tests__/helpers";
import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import type { RequestContainer } from "@repo/core/application/di/types";
import { isValidationError } from "@repo/core/application/errors";
import {
  type GetTimelineInput,
  getTimeline,
} from "@repo/core/application/memo/getTimeline";
import { postMemo } from "@repo/core/application/memo/postMemo";
import type { MemoView } from "@repo/core/application/memo/view";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { Actor, UserId } from "@repo/core/domain/identity/valueObject";
import { MEMO_BODY_MAX_CODE_POINTS } from "@repo/core/domain/memo/valueObject";
import { describe, expect, it } from "vitest";

function post(
  container: RequestContainer,
  userId: string,
  body: string,
): Promise<MemoView> {
  return postMemo({
    container,
    input: { userId, body, actor: Actor.user(UserId.create(userId)) },
  }).then((output) => output.memo);
}

function timeline(
  container: RequestContainer,
  input: GetTimelineInput,
): ReturnType<typeof getTimeline> {
  return getTimeline({ container, input });
}

async function expectCode(
  promise: Promise<unknown>,
  guard: (error: unknown) => boolean,
  code?: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  expect(guard(caught)).toBe(true);
  if (code !== undefined) {
    expect((caught as { code: string }).code).toBe(code);
  }
}

/** Newest first: `postedAt` never increases along the page. */
function expectNewestFirst(items: readonly MemoView[]): void {
  for (let i = 1; i < items.length; i += 1) {
    const previous = items[i - 1];
    const current = items[i];
    if (!previous || !current) throw new Error("unreachable");
    expect(previous.postedAt.getTime()).toBeGreaterThanOrEqual(
      current.postedAt.getTime(),
    );
  }
}

describe("postMemo", () => {
  it("(a) writes the memo, its first revision and the search projection in one call", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const body = "今日の気づき: the projection lands with the row";

    const memo = await post(container, userId, body);
    expect(memo.body).toBe(body);
    expect(memo.latestRevisionNumber).toBe(1);
    expect(memo.version).toBe(0);
    expect(memo.postedAt.getTime()).toBe(memo.updatedAt.getTime());

    await inUserDataStorage(userId, (sql) => {
      const memos = sql
        .exec<{ id: string; body: string; status: string; version: number }>(
          "SELECT id, body, status, version FROM memos",
        )
        .toArray();
      expect(memos).toEqual([
        { id: memo.id, body, status: "active", version: 0 },
      ]);

      const revisions = sql
        .exec<{
          memo_id: string;
          revision_number: number;
          actor_type: string;
          body: string;
        }>(
          "SELECT memo_id, revision_number, actor_type, body FROM memo_revisions",
        )
        .toArray();
      expect(revisions).toEqual([
        { memo_id: memo.id, revision_number: 1, actor_type: "user", body },
      ]);

      const entries = sql
        .exec<{ rowid: number; id: string; type: string; body: string }>(
          "SELECT rowid, id, type, body FROM search_entries",
        )
        .toArray();
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (!entry) throw new Error("unreachable");
      expect(entry.id).toBe(memo.id);
      expect(entry.type).toBe("memo");

      const hits = sql
        .exec<{ rowid: number }>(
          "SELECT rowid FROM search_fts WHERE search_fts MATCH ?",
          "projection",
        )
        .toArray()
        .map((row) => row.rowid);
      expect(hits).toEqual([entry.rowid]);
    });
  });

  it("(b) enforces the body invariants in code points", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);

    await expectCode(
      post(container, userId, ""),
      isBusinessRuleError,
      "EMPTY_BODY",
    );
    await expectCode(
      post(container, userId, "   \n\t "),
      isBusinessRuleError,
      "EMPTY_BODY",
    );

    // A non-BMP code point is two UTF-16 units, so the bound must count code points.
    const emoji = "😀";
    expect(emoji.length).toBe(2);
    const exactly = emoji.repeat(MEMO_BODY_MAX_CODE_POINTS);
    const tooLong = emoji.repeat(MEMO_BODY_MAX_CODE_POINTS + 1);

    await expectCode(
      post(container, userId, tooLong),
      isBusinessRuleError,
      "BODY_TOO_LONG",
    );
    const accepted = await post(container, userId, exactly);
    expect(accepted.body).toBe(exactly);

    await inUserDataStorage(userId, (sql) => {
      expect(
        sql.exec<{ n: number }>("SELECT count(*) AS n FROM memos").one().n,
      ).toBe(1);
      expect(
        sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM memo_revisions")
          .one().n,
      ).toBe(1);
      expect(
        sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM search_entries")
          .one().n,
      ).toBe(1);
    });
  });
});

describe("getTimeline", () => {
  it("(c) answers an empty page for an account with no memos", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);

    expect(await timeline(container, { userId })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("(d) pages both ways without duplicates or gaps and validates the query", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);

    const posted: MemoView[] = [];
    for (let i = 1; i <= 7; i += 1) {
      posted.push(
        await post(
          container,
          userId,
          `memo ${i}${i % 2 === 0 ? " 買い物" : ""}`,
        ),
      );
    }
    const allIds = new Set(posted.map((memo) => memo.id));

    const page1 = await timeline(container, { userId, limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    expectNewestFirst(page1.items);
    for (const item of page1.items) expect(item.sourceDocuments).toEqual([]);

    const page2 = await timeline(container, {
      userId,
      limit: 3,
      cursor: page1.nextCursor,
      direction: "older",
    });
    expect(page2.items).toHaveLength(3);
    expect(page2.nextCursor).not.toBeNull();
    expectNewestFirst(page2.items);

    const page3 = await timeline(container, {
      userId,
      limit: 3,
      cursor: page2.nextCursor,
      direction: "older",
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const olderIds = [...page1.items, ...page2.items, ...page3.items].map(
      (item) => item.id,
    );
    expect(new Set(olderIds).size).toBe(7);
    expect(new Set(olderIds)).toEqual(allIds);
    expectNewestFirst([...page1.items, ...page2.items, ...page3.items]);

    // Newer from the second page's cursor climbs back toward the head.
    const newer1 = await timeline(container, {
      userId,
      limit: 3,
      cursor: page2.nextCursor,
      direction: "newer",
    });
    expect(newer1.items.map((item) => item.id)).toEqual(
      [page1.items[2], page2.items[0], page2.items[1]].map((item) => item?.id),
    );
    expect(newer1.nextCursor).not.toBeNull();
    expectNewestFirst(newer1.items);

    const newer2 = await timeline(container, {
      userId,
      limit: 3,
      cursor: newer1.nextCursor,
      direction: "newer",
    });
    expect(newer2.items.map((item) => item.id)).toEqual(
      [page1.items[0], page1.items[1]].map((item) => item?.id),
    );
    expect(newer2.nextCursor).toBeNull();

    // The whole set in one page.
    const single = await timeline(container, { userId, limit: 100 });
    expect(single.items).toHaveLength(7);
    expect(single.nextCursor).toBeNull();

    // Shape checks at the transport-facing usecase.
    await expectCode(
      timeline(container, { userId, limit: 0 }),
      isValidationError,
    );
    await expectCode(
      timeline(container, { userId, limit: 101 }),
      isValidationError,
    );
    await expectCode(
      timeline(container, { userId, limit: 1.5 }),
      isValidationError,
    );
    await expectCode(
      timeline(container, { userId, direction: "newer", cursor: null }),
      isValidationError,
    );
    await expectCode(
      timeline(container, { userId, cursor: "not-a-cursor" }),
      isValidationError,
      "INVALID_CURSOR",
    );

    // Keyword filtering is a body substring; a blank keyword is no filter.
    const filtered = await timeline(container, { userId, keyword: "買い物" });
    expect(filtered.items).toHaveLength(3);
    for (const item of filtered.items) expect(item.body).toContain("買い物");
    expect(filtered.nextCursor).toBeNull();

    const unfiltered = await timeline(container, { userId, keyword: "  " });
    expect(unfiltered.items).toHaveLength(7);

    const none = await timeline(container, { userId, keyword: "nothing-here" });
    expect(none).toEqual({ items: [], nextCursor: null });
  });
});
