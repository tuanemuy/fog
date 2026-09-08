import { codePointLength } from "@repo/core/domain/common/text";
import { BusinessRuleError } from "@repo/core/domain/error";
import type {
  DocumentId,
  TopicId,
} from "@repo/core/domain/knowledge/valueObject";
import type { MemoId } from "@repo/core/domain/memo/valueObject";
import { SearchErrorCode } from "./errorCode";

declare const searchCursorBrand: unique symbol;

/**
 * A transport-boundary bound against oversized input, not a property of the
 * index: `instr()` has no pattern-length cap, so nothing in the mechanism
 * would move this number (`spec/domains/search.md`).
 */
export const SEARCH_KEYWORD_MAX_CODE_POINTS = 500;

/**
 * Opaque paging token. Only its form (non-empty) is checked here; whether
 * it decodes and is still within its lifetime is the index adapter's
 * verdict, which reports the same `InvalidCursor`.
 */
export type SearchCursor = string & { readonly [searchCursorBrand]: true };
export const SearchCursor = {
  create: (raw: string): SearchCursor => {
    if (raw.length === 0) {
      throw new BusinessRuleError<SearchErrorCode>(
        SearchErrorCode.InvalidCursor,
        "Search cursor must not be empty",
      );
    }
    return raw as SearchCursor;
  },
};

export type SearchQuery = Readonly<{
  keyword: string;
  topicId?: TopicId;
  limit: number;
  cursor?: SearchCursor;
}>;

/**
 * The trimmed, bounded keyword with the optional scope and cursor. `limit`
 * is taken as given: its integer range is a shape check the usecase makes
 * before the value object exists.
 */
export const SearchQuery = {
  create: (params: {
    keyword: string;
    topicId?: TopicId | undefined;
    limit: number;
    cursor?: SearchCursor | undefined;
  }): SearchQuery => {
    const keyword = params.keyword.trim();
    if (keyword.length === 0) {
      throw new BusinessRuleError<SearchErrorCode>(
        SearchErrorCode.EmptyKeyword,
        "Search keyword must not be empty",
      );
    }
    if (codePointLength(keyword) > SEARCH_KEYWORD_MAX_CODE_POINTS) {
      throw new BusinessRuleError<SearchErrorCode>(
        SearchErrorCode.KeywordTooLong,
        `Search keyword must be at most ${SEARCH_KEYWORD_MAX_CODE_POINTS} characters`,
      );
    }
    return {
      keyword,
      limit: params.limit,
      ...(params.topicId === undefined ? {} : { topicId: params.topicId }),
      ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
    };
  },
};

export type MemoSearchResultItem = Readonly<{
  type: "memo";
  id: MemoId;
  snippet: string;
  timestamp: Date;
  sourceOfDocumentIds: readonly DocumentId[];
}>;

export type DocumentSearchResultItem = Readonly<{
  type: "document";
  id: DocumentId;
  snippet: string;
  timestamp: Date;
  topicId: TopicId;
  sourceMemoIds: readonly MemoId[];
}>;

export type SearchResultItem = MemoSearchResultItem | DocumentSearchResultItem;

/**
 * One page of a snapshot. `count` is the size of the set the first query
 * froze, so it keeps its meaning across pages.
 */
export type SearchPage = Readonly<{
  items: readonly SearchResultItem[];
  count: number;
  nextCursor?: SearchCursor;
}>;

export type MemoIndexEntry = Readonly<{
  type: "memo";
  memoId: MemoId;
  content: string;
  timestamp: Date;
  sourceOfDocumentIds: readonly DocumentId[];
}>;

export type DocumentIndexEntry = Readonly<{
  type: "document";
  documentId: DocumentId;
  topicId: TopicId;
  title: string;
  content: string;
  timestamp: Date;
  sourceMemoIds: readonly MemoId[];
}>;

export type IndexEntry = MemoIndexEntry | DocumentIndexEntry;
