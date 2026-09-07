export const MemoErrorCode = {
  InvalidId: "INVALID_MEMO_ID",
  EmptyBody: "EMPTY_BODY",
  BodyTooLong: "BODY_TOO_LONG",
  InvalidRevisionNumber: "INVALID_REVISION_NUMBER",
  InvalidCursor: "INVALID_CURSOR",
  RevisionMismatch: "REVISION_MISMATCH",
} as const;

export type MemoErrorCode = (typeof MemoErrorCode)[keyof typeof MemoErrorCode];
