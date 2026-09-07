import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { MemoErrorCode } from "../errorCode";
import {
  MEMO_BODY_MAX_CODE_POINTS,
  MemoBody,
  MemoId,
  RevisionNumber,
  TimelineCursor,
} from "../valueObject";

const EMOJI = "🙂";

function businessCodeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (isBusinessRuleError(error)) return error.code;
    throw error;
  }
  return null;
}

describe("MemoBody", () => {
  it.each([
    ["an empty string", ""],
    ["spaces only", "   "],
    ["newlines only", "\n\n"],
  ])("rejects %s", (_label, raw) => {
    expect(businessCodeOf(() => MemoBody.create(raw))).toBe(
      MemoErrorCode.EmptyBody,
    );
  });

  it("keeps surrounding whitespace — trim decides emptiness only", () => {
    expect(MemoBody.create("  padded  ")).toBe("  padded  ");
  });

  it("accepts exactly 10,000 code points", () => {
    const body = "あ".repeat(MEMO_BODY_MAX_CODE_POINTS);
    expect(MemoBody.create(body)).toBe(body);
  });

  it("rejects 10,001 code points", () => {
    expect(
      businessCodeOf(() =>
        MemoBody.create("あ".repeat(MEMO_BODY_MAX_CODE_POINTS + 1)),
      ),
    ).toBe(MemoErrorCode.BodyTooLong);
  });

  // 10,000 emoji are 20,000 UTF-16 units; the bound is code points.
  it("counts surrogate pairs as one code point", () => {
    const body = EMOJI.repeat(MEMO_BODY_MAX_CODE_POINTS);
    expect(body.length).toBe(MEMO_BODY_MAX_CODE_POINTS * 2);
    expect(MemoBody.create(body)).toBe(body);
    expect(
      businessCodeOf(() =>
        MemoBody.create(EMOJI.repeat(MEMO_BODY_MAX_CODE_POINTS + 1)),
      ),
    ).toBe(MemoErrorCode.BodyTooLong);
  });

  it("compares by exact string equality", () => {
    expect(MemoBody.equals(MemoBody.create("a"), MemoBody.create("a"))).toBe(
      true,
    );
    expect(MemoBody.equals(MemoBody.create("a"), MemoBody.create("a "))).toBe(
      false,
    );
  });
});

describe("MemoId", () => {
  it("trims and refuses blanks", () => {
    expect(MemoId.create(" m1 ")).toBe("m1");
    expect(businessCodeOf(() => MemoId.create("  "))).toBe(
      MemoErrorCode.InvalidId,
    );
  });
});

describe("RevisionNumber", () => {
  it.each([0, -1, 1.5, Number.NaN])("rejects %s", (raw) => {
    expect(businessCodeOf(() => RevisionNumber.create(raw))).toBe(
      MemoErrorCode.InvalidRevisionNumber,
    );
  });

  it("accepts 1 and counts upward", () => {
    expect(RevisionNumber.create(1)).toBe(1);
    expect(RevisionNumber.first()).toBe(1);
    expect(RevisionNumber.next(RevisionNumber.first())).toBe(2);
  });
});

describe("TimelineCursor", () => {
  it("rejects an empty cursor", () => {
    expect(businessCodeOf(() => TimelineCursor.create(""))).toBe(
      MemoErrorCode.InvalidCursor,
    );
  });

  it("keeps any non-empty value opaque", () => {
    expect(TimelineCursor.create(" x ")).toBe(" x ");
  });
});
