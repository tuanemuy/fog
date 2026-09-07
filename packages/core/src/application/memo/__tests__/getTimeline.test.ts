import { describe, expect, it } from "vitest";
import { isValidationError } from "../../errors";
import {
  normalizeTimelineQuery,
  TIMELINE_DEFAULT_LIMIT,
  TIMELINE_MAX_LIMIT,
} from "../getTimeline";

function validationCodeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (isValidationError(error)) return error.code;
    throw error;
  }
  return null;
}

describe("normalizeTimelineQuery", () => {
  it("fills in the defaults", () => {
    expect(normalizeTimelineQuery({ userId: "user-1" })).toEqual({
      cursor: null,
      direction: "older",
      limit: TIMELINE_DEFAULT_LIMIT,
      keyword: null,
    });
    expect(TIMELINE_DEFAULT_LIMIT).toBe(50);
  });

  it("trims the keyword and folds a blank one to null", () => {
    expect(
      normalizeTimelineQuery({ userId: "user-1", keyword: "  買い物 " })
        .keyword,
    ).toBe("買い物");
    expect(
      normalizeTimelineQuery({ userId: "user-1", keyword: "   " }).keyword,
    ).toBeNull();
    expect(
      normalizeTimelineQuery({ userId: "user-1", keyword: null }).keyword,
    ).toBeNull();
  });

  it("passes a cursor and direction through", () => {
    expect(
      normalizeTimelineQuery({
        userId: "user-1",
        cursor: "abc",
        direction: "newer",
        limit: TIMELINE_MAX_LIMIT,
      }),
    ).toEqual({
      cursor: "abc",
      direction: "newer",
      limit: 100,
      keyword: null,
    });
  });

  it("accepts the limit bounds", () => {
    expect(normalizeTimelineQuery({ userId: "user-1", limit: 1 }).limit).toBe(
      1,
    );
    expect(normalizeTimelineQuery({ userId: "user-1", limit: 100 }).limit).toBe(
      100,
    );
  });

  it.each([0, 101, 1.5])("rejects a limit of %s", (limit) => {
    expect(
      validationCodeOf(() =>
        normalizeTimelineQuery({ userId: "user-1", limit }),
      ),
    ).toBe("INVALID_LIMIT");
  });

  it("requires a cursor when reading newer", () => {
    expect(
      validationCodeOf(() =>
        normalizeTimelineQuery({ userId: "user-1", direction: "newer" }),
      ),
    ).toBe("CURSOR_REQUIRED");
    expect(
      validationCodeOf(() =>
        normalizeTimelineQuery({
          userId: "user-1",
          direction: "newer",
          cursor: null,
        }),
      ),
    ).toBe("CURSOR_REQUIRED");
  });
});
