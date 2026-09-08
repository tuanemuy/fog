import { describe, expect, it } from "vitest";
import { isValidationError } from "../../errors";
import type { JumpToDateDto } from "../gateway";
import { TIMELINE_DEFAULT_LIMIT, TIMELINE_MAX_LIMIT } from "../getTimeline";
import { jumpToDate, normalizeJumpToDate } from "../jumpToDate";
import { EMPTY_WINDOW, memoContainer } from "./memoContainer";

const DAY = new Date("2026-07-22T00:00:00.000+09:00");
const DAY_END = new Date("2026-07-23T00:00:00.000+09:00");

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (isValidationError(error)) return error.code;
    throw error;
  }
  return null;
}

describe("normalizeJumpToDate", () => {
  it("fills in the limit and folds a blank keyword to null", () => {
    expect(
      normalizeJumpToDate({
        userId: "user-1",
        date: DAY,
        dayEnd: DAY_END,
        keyword: "   ",
      }),
    ).toEqual({
      date: DAY,
      dayEnd: DAY_END,
      limit: TIMELINE_DEFAULT_LIMIT,
      keyword: null,
    });
  });

  it("keeps a trimmed keyword so a jump under a filter stays filtered", () => {
    expect(
      normalizeJumpToDate({
        userId: "user-1",
        date: DAY,
        dayEnd: DAY_END,
        keyword: " 買い物 ",
      }).keyword,
    ).toBe("買い物");
  });

  it("accepts the limit bounds and rejects what falls outside them", () => {
    expect(
      normalizeJumpToDate({ userId: "u", date: DAY, dayEnd: DAY_END, limit: 1 })
        .limit,
    ).toBe(1);
    expect(
      normalizeJumpToDate({
        userId: "u",
        date: DAY,
        dayEnd: DAY_END,
        limit: TIMELINE_MAX_LIMIT,
      }).limit,
    ).toBe(100);
    for (const limit of [0, 101, 1.5]) {
      expect(
        codeOf(() =>
          normalizeJumpToDate({
            userId: "u",
            date: DAY,
            dayEnd: DAY_END,
            limit,
          }),
        ),
      ).toBe("INVALID_LIMIT");
    }
  });

  it("rejects an Invalid Date and a day that does not end after it", () => {
    expect(
      codeOf(() =>
        normalizeJumpToDate({
          userId: "u",
          date: new Date("nonsense"),
          dayEnd: DAY_END,
        }),
      ),
    ).toBe("INVALID_DATE");
    expect(
      codeOf(() =>
        normalizeJumpToDate({
          userId: "u",
          date: DAY,
          dayEnd: new Date("nonsense"),
        }),
      ),
    ).toBe("INVALID_DATE");
    expect(
      codeOf(() =>
        normalizeJumpToDate({ userId: "u", date: DAY, dayEnd: DAY }),
      ),
    ).toBe("INVALID_DATE");
    expect(
      codeOf(() =>
        normalizeJumpToDate({ userId: "u", date: DAY_END, dayEnd: DAY }),
      ),
    ).toBe("INVALID_DATE");
  });
});

describe("jumpToDate", () => {
  it("hands the day and the filter to the user's Durable Object", async () => {
    const calls: [string, JumpToDateDto][] = [];
    const container = memoContainer({
      jumpToDate: async (userId, input) => {
        calls.push([userId, input]);
        return EMPTY_WINDOW;
      },
    });

    await expect(
      jumpToDate({
        container,
        input: {
          userId: "user-1",
          date: DAY,
          dayEnd: DAY_END,
          keyword: "買い物",
          limit: 20,
        },
      }),
    ).resolves.toEqual(EMPTY_WINDOW);
    expect(calls).toEqual([
      ["user-1", { date: DAY, dayEnd: DAY_END, limit: 20, keyword: "買い物" }],
    ]);
  });
});
