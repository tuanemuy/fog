import { codePointLength } from "@repo/core/domain/common/text";
import { BusinessRuleError } from "@repo/core/domain/error";
import { MemoErrorCode } from "./errorCode";

declare const memoIdBrand: unique symbol;
declare const memoBodyBrand: unique symbol;
declare const revisionNumberBrand: unique symbol;
declare const timelineCursorBrand: unique symbol;

export type MemoId = string & { readonly [memoIdBrand]: true };
export const MemoId = {
  create: (raw: string): MemoId => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new BusinessRuleError(MemoErrorCode.InvalidId, "Invalid memo id");
    }
    return trimmed as MemoId;
  },
};

export const MEMO_BODY_MAX_CODE_POINTS = 10_000;

/**
 * Plain text. Stored as typed — `trim` decides emptiness only — and bounded in
 * Unicode code points, a product-level bound rather than a row-size one.
 */
export type MemoBody = string & { readonly [memoBodyBrand]: true };
export const MemoBody = {
  create: (raw: string): MemoBody => {
    if (raw.trim().length === 0) {
      throw new BusinessRuleError(
        MemoErrorCode.EmptyBody,
        "Memo body must not be empty",
      );
    }
    if (codePointLength(raw) > MEMO_BODY_MAX_CODE_POINTS) {
      throw new BusinessRuleError(
        MemoErrorCode.BodyTooLong,
        `Memo body must be at most ${MEMO_BODY_MAX_CODE_POINTS} characters`,
      );
    }
    return raw as MemoBody;
  },
  equals: (a: MemoBody, b: MemoBody): boolean => a === b,
};

export type RevisionNumber = number & { readonly [revisionNumberBrand]: true };
export const RevisionNumber = {
  create: (raw: number): RevisionNumber => {
    if (!Number.isInteger(raw) || raw < 1) {
      throw new BusinessRuleError(
        MemoErrorCode.InvalidRevisionNumber,
        `Invalid revision number: ${raw}`,
      );
    }
    return raw as RevisionNumber;
  },
  first: (): RevisionNumber => 1 as RevisionNumber,
  next: (n: RevisionNumber): RevisionNumber =>
    ((n as number) + 1) as RevisionNumber,
};

/**
 * Opaque paging token naming a position (never a direction). Its encoding is
 * the adapter's; an undecodable value is the adapter's `ValidationError`.
 */
export type TimelineCursor = string & { readonly [timelineCursorBrand]: true };
export const TimelineCursor = {
  create: (raw: string): TimelineCursor => {
    if (raw.length === 0) {
      throw new BusinessRuleError(
        MemoErrorCode.InvalidCursor,
        "Timeline cursor must not be empty",
      );
    }
    return raw as TimelineCursor;
  },
};
