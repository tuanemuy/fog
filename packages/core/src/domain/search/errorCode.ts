export const SearchErrorCode = {
  EmptyKeyword: "EMPTY_KEYWORD",
  KeywordTooLong: "KEYWORD_TOO_LONG",
  InvalidCursor: "INVALID_CURSOR",
} as const;

export type SearchErrorCode =
  (typeof SearchErrorCode)[keyof typeof SearchErrorCode];
