import {
  createTestContainer,
  registerTestUser,
} from "@repo/core/adapters/cloudflare/__tests__/testContainer";
import type { RequestContainer } from "@repo/core/application/di/types";
import { isValidationError } from "@repo/core/application/errors";
import { getTimeline } from "@repo/core/application/memo/getTimeline";
import { jumpToDate } from "@repo/core/application/memo/jumpToDate";
import { showMemoInTimeline } from "@repo/core/application/memo/showMemoInTimeline";
import { softDeleteMemo } from "@repo/core/application/memo/softDeleteMemo";
import type {
  TimelineItemView,
  TimelineWindowView,
} from "@repo/core/application/memo/view";
import { describe, expect, it } from "vitest";
import {
  expectCode,
  expectNewestFirst,
  jst,
  post,
  postAt,
} from "./memoFixtures";

const EMPTY_WINDOW = {
  items: [],
  pivotId: null,
  olderCursor: null,
  newerCursor: null,
};

function ids(items: readonly TimelineItemView[]): string[] {
  return items.map((item) => item.id);
}

/**
 * Walks both continuations of a window with `getTimeline` and answers every
 * id seen, so the suites can assert "no duplicates, no gaps" against the
 * whole account.
 */
async function walkBothWays(
  container: RequestContainer,
  userId: string,
  window: TimelineWindowView,
  keyword: string | null = null,
): Promise<string[]> {
  const seen = ids(window.items);
  let older = window.olderCursor;
  while (older !== null) {
    const page = await getTimeline({
      container,
      input: { userId, cursor: older, direction: "older", limit: 2, keyword },
    });
    seen.push(...ids(page.items));
    older = page.nextCursor;
  }
  let newer = window.newerCursor;
  while (newer !== null) {
    const page = await getTimeline({
      container,
      input: { userId, cursor: newer, direction: "newer", limit: 2, keyword },
    });
    seen.unshift(...ids(page.items));
    newer = page.nextCursor;
  }
  return seen;
}

function day(container: RequestContainer, userId: string, ymd: string) {
  return (extra: { limit?: number; keyword?: string | null } = {}) =>
    jumpToDate({
      container,
      input: {
        userId,
        date: jst(`${ymd}T00:00:00`),
        dayEnd: new Date(jst(`${ymd}T00:00:00`).getTime() + 86_400_000),
        ...extra,
      },
    });
}

describe("getTimeline keyword: a LIKE substring with the wildcards escaped", () => {
  it("(a) takes %, _ and \\ literally, folds ASCII case only, applies no NFKC", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const percent = await post(container, userId, "100% done");
    await post(container, userId, "100 percent");
    const underscore = await post(container, userId, "snake_case");
    await post(container, userId, "snakeXcase");
    const backslash = await post(container, userId, "a\\b path");
    const upper = await post(container, userId, "Hello World");
    const lower = await post(container, userId, "say hello");
    await post(container, userId, "ｶﾀｶﾅ half width");

    const filtered = async (keyword: string) =>
      ids(
        (await getTimeline({ container, input: { userId, keyword } })).items,
      ).sort();

    expect(await filtered("100%")).toEqual([percent.id]);
    expect(await filtered("e_c")).toEqual([underscore.id]);
    expect(await filtered("\\")).toEqual([backslash.id]);
    expect(await filtered("hello")).toEqual([upper.id, lower.id].sort());
    expect(await filtered("カタカナ")).toEqual([]);
  });
});

describe("jumpToDate: the window around a day", () => {
  // A at 07-20 10:00, B at 07-22 23:00, C at 07-26 01:00 (JST). The past
  // candidate is measured from the day's end and the future one from its
  // start, so for a jump to 07-24 both B and C sit exactly 49 h away.
  async function seed(container: RequestContainer, userId: string) {
    const a = await postAt(container, userId, "A", jst("2026-07-20T10:00:00"));
    const b = await postAt(container, userId, "B", jst("2026-07-22T23:00:00"));
    const c = await postAt(container, userId, "C", jst("2026-07-26T01:00:00"));
    return { a, b, c };
  }

  it("(b) pivots on the day's newest memo and continues both ways without gaps", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const { a, b, c } = await seed(container, userId);
    const jump = day(container, userId, "2026-07-22");

    const window = await jump({ limit: 1 });
    expect(ids(window.items)).toEqual([b.id]);
    expect(window.pivotId).toBe(b.id);
    expect(window.olderCursor).not.toBeNull();
    expect(window.newerCursor).not.toBeNull();
    expect(await walkBothWays(container, userId, window)).toEqual([
      c.id,
      b.id,
      a.id,
    ]);

    const two = await jump({ limit: 2 });
    expect(ids(two.items)).toEqual([c.id, b.id]);
    // The pivot is the day's memo, not the window's newest row.
    expect(two.pivotId).toBe(b.id);
    expectNewestFirst(two.items);
    expect(two.newerCursor).toBeNull();
    expect(two.olderCursor).not.toBeNull();

    const all = await jump({ limit: 100 });
    expect(ids(all.items)).toEqual([c.id, b.id, a.id]);
    expect(all).toMatchObject({ olderCursor: null, newerCursor: null });
    for (const item of all.items) expect(item.sourceDocuments).toEqual([]);
  });

  it("(c) picks the nearer neighbour of an empty day, the past on a tie", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const { b, c } = await seed(container, userId);

    // 07-23: B is 25 h before the day's end, C is 73 h after its start.
    expect(
      ids((await day(container, userId, "2026-07-23")({ limit: 1 })).items),
    ).toEqual([b.id]);
    // 07-24: 49 h to B from the day's end, 49 h to C from its start — a tie.
    const tie = await day(container, userId, "2026-07-24")({ limit: 1 });
    expect(ids(tie.items)).toEqual([b.id]);
    expect(tie.pivotId).toBe(b.id);
    expect(await walkBothWays(container, userId, tie)).toContain(c.id);
  });

  it("(d) takes the future side when it is strictly closer", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const { b, c } = await seed(container, userId);
    const near = await postAt(
      container,
      userId,
      "C2",
      jst("2026-07-26T00:30:00"),
    );
    // 07-24: 49 h to B, 48.5 h to C2 — the future wins.
    const window = await day(container, userId, "2026-07-24")({ limit: 1 });
    expect(ids(window.items)).toEqual([near.id]);
    expect(window.pivotId).toBe(near.id);
    expect(await walkBothWays(container, userId, window)).toContain(b.id);
    expect(await walkBothWays(container, userId, window)).toContain(c.id);
  });

  it("(e) lands on the oldest / newest memo outside the whole range", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const { a, c } = await seed(container, userId);

    const past = await day(container, userId, "2020-01-01")({ limit: 1 });
    expect(ids(past.items)).toEqual([a.id]);
    expect(past.olderCursor).toBeNull();
    expect(past.newerCursor).not.toBeNull();

    const future = await day(container, userId, "2030-01-01")({ limit: 1 });
    expect(ids(future.items)).toEqual([c.id]);
    expect(future.newerCursor).toBeNull();
    expect(future.olderCursor).not.toBeNull();
  });

  it("(f) answers an empty window for an empty account and for a keyword with no match", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    expect(await day(container, userId, "2026-07-22")()).toEqual(EMPTY_WINDOW);

    await seed(container, userId);
    expect(
      await day(container, userId, "2026-07-22")({ keyword: "nothing" }),
    ).toEqual(EMPTY_WINDOW);
  });

  it("(g) keeps the keyword filter while jumping", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const { b } = await seed(container, userId);
    const k1 = await postAt(
      container,
      userId,
      "買い物 1",
      jst("2026-07-21T09:00:00"),
    );
    const k2 = await postAt(
      container,
      userId,
      "買い物 2",
      jst("2026-07-26T09:00:00"),
    );

    // 07-22 has only B, which does not match: the nearest match decides.
    const window = await day(
      container,
      userId,
      "2026-07-22",
    )({ limit: 1, keyword: "買い物" });
    expect(ids(window.items)).toEqual([k1.id]);
    expect(ids(window.items)).not.toContain(b.id);
    expect(await walkBothWays(container, userId, window, "買い物")).toEqual([
      k2.id,
      k1.id,
    ]);
  });

  it("(h) validates the day and the limit before reaching the Durable Object", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const date = jst("2026-07-22T00:00:00");
    await expectCode(
      jumpToDate({ container, input: { userId, date, dayEnd: date } }),
      isValidationError,
      "INVALID_DATE",
    );
    await expectCode(
      jumpToDate({
        container,
        input: { userId, date: new Date("x"), dayEnd: date },
      }),
      isValidationError,
      "INVALID_DATE",
    );
    for (const limit of [0, 101]) {
      await expectCode(
        day(container, userId, "2026-07-22")({ limit }),
        isValidationError,
        "INVALID_LIMIT",
      );
    }
  });
});

describe("showMemoInTimeline: the window around a memo", () => {
  it("(i) finds a memo in the middle, at the head and at the tail, and alone", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const a = await postAt(container, userId, "A", jst("2026-07-20T10:00:00"));
    const b = await postAt(container, userId, "B", jst("2026-07-22T23:00:00"));
    const c = await postAt(container, userId, "C", jst("2026-07-25T01:00:00"));
    const show = (memoId: string, limit: number) =>
      showMemoInTimeline({ container, input: { userId, memoId, limit } });

    const middle = await show(b.id, 2);
    expect(middle.targetState).toBe("found");
    expect(middle.pivotId).toBe(b.id);
    expect(middle.targetMemoId).toBe(b.id);
    expect(ids(middle.items)).toEqual([c.id, b.id]);
    expect(middle.newerCursor).toBeNull();
    expect(middle.olderCursor).not.toBeNull();
    expect(await walkBothWays(container, userId, middle)).toEqual([
      c.id,
      b.id,
      a.id,
    ]);

    const head = await show(c.id, 1);
    expect(ids(head.items)).toEqual([c.id]);
    expect(head.newerCursor).toBeNull();
    expect(head.olderCursor).not.toBeNull();

    const tail = await show(a.id, 1);
    expect(ids(tail.items)).toEqual([a.id]);
    expect(tail.olderCursor).toBeNull();
    expect(tail.newerCursor).not.toBeNull();
    expect(await walkBothWays(container, userId, tail)).toEqual([
      c.id,
      b.id,
      a.id,
    ]);

    const container2 = createTestContainer();
    const { userId: lonely } = await registerTestUser(container2);
    const only = await post(container2, lonely, "only");
    const alone = await showMemoInTimeline({
      container: container2,
      input: { userId: lonely, memoId: only.id },
    });
    expect(ids(alone.items)).toEqual([only.id]);
    expect(alone).toMatchObject({ olderCursor: null, newerCursor: null });
  });

  it("(j) reports the trash and absence as states, not errors", async () => {
    const container = createTestContainer();
    const { userId } = await registerTestUser(container);
    const memo = await post(container, userId, "gone soon");
    await softDeleteMemo({ container, input: { userId, memoId: memo.id } });

    expect(
      await showMemoInTimeline({
        container,
        input: { userId, memoId: memo.id },
      }),
    ).toEqual({
      ...EMPTY_WINDOW,
      targetState: "trashed",
      targetMemoId: memo.id,
    });
    expect(
      await showMemoInTimeline({
        container,
        input: { userId, memoId: "no-such-memo" },
      }),
    ).toEqual({
      ...EMPTY_WINDOW,
      targetState: "notFound",
      targetMemoId: "no-such-memo",
    });
    for (const limit of [0, 101]) {
      await expectCode(
        showMemoInTimeline({
          container,
          input: { userId, memoId: memo.id, limit },
        }),
        isValidationError,
        "INVALID_LIMIT",
      );
    }
  });
});
