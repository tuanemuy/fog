import { describe, expect, it } from "vitest";
import { keywordLikePattern } from "../stores/memoRepository";

describe("keywordLikePattern", () => {
  it("wraps the keyword in % and escapes the three LIKE metacharacters", () => {
    expect(keywordLikePattern("買い物")).toBe("%買い物%");
    expect(keywordLikePattern("100%")).toBe("%100\\%%");
    expect(keywordLikePattern("a_b")).toBe("%a\\_b%");
    expect(keywordLikePattern("a\\b")).toBe("%a\\\\b%");
    expect(keywordLikePattern("%_\\")).toBe("%\\%\\_\\\\%");
  });

  it("changes nothing else — case and width are left to the database", () => {
    expect(keywordLikePattern("Hello ｶﾀｶﾅ")).toBe("%Hello ｶﾀｶﾅ%");
  });
});
