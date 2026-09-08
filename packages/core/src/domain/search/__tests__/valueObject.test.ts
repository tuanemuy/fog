import { isBusinessRuleError } from "@repo/core/domain/error";
import { TopicId } from "@repo/core/domain/knowledge/valueObject";
import { describe, expect, it } from "vitest";
import { SearchErrorCode } from "../errorCode";
import {
  SEARCH_KEYWORD_MAX_CODE_POINTS,
  SearchCursor,
  SearchQuery,
} from "../valueObject";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return isBusinessRuleError(error) ? error.code : "not-a-business-rule";
  }
}

describe("SearchQuery.create", () => {
  it("trims the keyword and keeps the scope and cursor only when given", () => {
    const topicId = TopicId.create("t1");
    const cursor = SearchCursor.create("abc");
    expect(SearchQuery.create({ keyword: "  fog  ", limit: 20 })).toEqual({
      keyword: "fog",
      limit: 20,
    });
    expect(
      SearchQuery.create({ keyword: "fog", limit: 1, topicId, cursor }),
    ).toEqual({ keyword: "fog", limit: 1, topicId, cursor });
    expect(
      Object.keys(
        SearchQuery.create({
          keyword: "fog",
          limit: 1,
          topicId: undefined,
          cursor: undefined,
        }),
      ),
    ).toEqual(["keyword", "limit"]);
  });

  it("refuses an empty or blank keyword", () => {
    expect(codeOf(() => SearchQuery.create({ keyword: "", limit: 20 }))).toBe(
      SearchErrorCode.EmptyKeyword,
    );
    expect(
      codeOf(() => SearchQuery.create({ keyword: "   ", limit: 20 })),
    ).toBe(SearchErrorCode.EmptyKeyword);
  });

  it("bounds the keyword at 500 code points, not UTF-16 units", () => {
    const max = "あ".repeat(SEARCH_KEYWORD_MAX_CODE_POINTS);
    expect(SearchQuery.create({ keyword: max, limit: 20 }).keyword).toBe(max);
    expect(
      codeOf(() => SearchQuery.create({ keyword: `${max}あ`, limit: 20 })),
    ).toBe(SearchErrorCode.KeywordTooLong);
    const emoji = "🔍".repeat(SEARCH_KEYWORD_MAX_CODE_POINTS);
    expect(emoji.length).toBe(SEARCH_KEYWORD_MAX_CODE_POINTS * 2);
    expect(SearchQuery.create({ keyword: emoji, limit: 20 }).keyword).toBe(
      emoji,
    );
  });

  it("does not judge the limit's range or the cursor's content", () => {
    expect(SearchQuery.create({ keyword: "fog", limit: 0 }).limit).toBe(0);
    expect(
      SearchQuery.create({
        keyword: "fog",
        limit: 1,
        cursor: SearchCursor.create("not-a-real-cursor"),
      }).cursor,
    ).toBe("not-a-real-cursor");
  });
});

describe("SearchCursor.create", () => {
  it("accepts any non-empty string and refuses the empty one", () => {
    expect(SearchCursor.create("x")).toBe("x");
    expect(codeOf(() => SearchCursor.create(""))).toBe(
      SearchErrorCode.InvalidCursor,
    );
  });
});
