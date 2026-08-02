import { describe, expect, it } from "vitest";
import { normalizeForIndex } from "../normalize";

describe("normalizeForIndex", () => {
  it("folds full-width forms to half-width via NFKC", () => {
    expect(normalizeForIndex("ＡＢＣ１２３")).toBe("ABC123");
    expect(normalizeForIndex("ｶﾀｶﾅ")).toBe("カタカナ");
  });

  it("folds decomposed sequences to their composed form", () => {
    expect(normalizeForIndex("が")).toBe("が");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeForIndex("  東京駅  ")).toBe("東京駅");
    expect(normalizeForIndex("\n\t東京駅\n")).toBe("東京駅");
  });

  it("leaves interior whitespace alone", () => {
    expect(normalizeForIndex("東京 駅")).toBe("東京 駅");
  });

  it("is idempotent", () => {
    const once = normalizeForIndex(" Ｔｏｋｙｏ 駅 ");
    expect(normalizeForIndex(once)).toBe(once);
  });
});
