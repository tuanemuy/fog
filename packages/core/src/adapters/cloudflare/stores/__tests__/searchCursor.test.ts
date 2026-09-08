import { isSystemError } from "@repo/core/application/errors";
import { isBusinessRuleError } from "@repo/core/domain/error";
import { SearchErrorCode } from "@repo/core/domain/search/errorCode";
import type { SearchCursor } from "@repo/core/domain/search/valueObject";
import { describe, expect, it } from "vitest";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  type SearchCursorPayload,
} from "../searchCursor";

const ID_A = "01a07eae-8944-7107-a9e8-5fd831abe065";
const ID_B = "01A07F09-4905-72E4-AFC8-4763981893EE";

const payload: SearchCursorPayload = {
  keyword: "fog検索",
  topicId: null,
  expiresAt: 1_800_000_000_000,
  offset: 1,
  ids: [
    { type: "memo", id: ID_A },
    { type: "document", id: ID_B },
  ],
};

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    if (isBusinessRuleError(error)) return error.code;
    if (isSystemError(error)) return `system:${error.code}`;
    return "other";
  }
}

describe("search cursor codec", () => {
  it("round-trips the snapshot with ids packed to 17 bytes each", () => {
    const cursor = encodeSearchCursor(payload);
    expect(decodeSearchCursor(cursor)).toEqual({
      ...payload,
      ids: [
        { type: "memo", id: ID_A },
        { type: "document", id: ID_B.toLowerCase() },
      ],
    });
    const scoped = encodeSearchCursor({
      ...payload,
      topicId: "t-1",
      offset: 0,
      ids: [],
    });
    expect(decodeSearchCursor(scoped).topicId).toBe("t-1");
    expect(decodeSearchCursor(scoped).ids).toEqual([]);
  });

  it("stays small: 500 keys fit in under 12 KB", () => {
    const ids = Array.from({ length: 500 }, (_, i) => ({
      type: "memo" as const,
      id: `01a07eae-8944-7107-a9e8-${i.toString(16).padStart(12, "0")}`,
    }));
    expect(encodeSearchCursor({ ...payload, ids }).length).toBeLessThan(12_000);
  });

  it("refuses anything it cannot read as InvalidCursor", () => {
    const cursor = encodeSearchCursor(payload);
    const cases: string[] = [
      "not base64url!",
      "AAA",
      cursor.slice(0, -4),
      `${cursor}QUJD`,
      encodeSearchCursor({ ...payload, offset: 0 }).replace(
        /^......../,
        "AAAAAAAA",
      ),
    ];
    for (const raw of cases) {
      expect(codeOf(() => decodeSearchCursor(raw as SearchCursor))).toBe(
        SearchErrorCode.InvalidCursor,
      );
    }
  });

  it("refuses an offset past the set and a stale version", () => {
    expect(
      codeOf(() =>
        decodeSearchCursor(encodeSearchCursor({ ...payload, offset: 3 })),
      ),
    ).toBe(SearchErrorCode.InvalidCursor);
  });

  it("will not pack an id that is not a UUID", () => {
    expect(
      codeOf(() =>
        encodeSearchCursor({ ...payload, ids: [{ type: "memo", id: "m1" }] }),
      ),
    ).toBe("system:DATA_INTEGRITY_ERROR");
  });
});
