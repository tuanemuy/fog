export const SEARCH_RPC_VERSION = 1 as const;

export const SearchErrorCode = {
  EmptyKeyword: "SEARCH_EMPTY_KEYWORD",
  KeywordTooLong: "SEARCH_KEYWORD_TOO_LONG",
  QueryTooComplex: "SEARCH_QUERY_TOO_COMPLEX",
  TopicNotFound: "TOPIC_NOT_FOUND",
  InvalidPagination: "SEARCH_INVALID_PAGINATION",
  InvalidCursor: "SEARCH_INVALID_CURSOR",
  IdempotencyConflict: "IDEMPOTENCY_CONFLICT",
  ContentNotFound: "CONTENT_NOT_FOUND",
  ContentAlreadyExists: "CONTENT_ALREADY_EXISTS",
  ContentKindConflict: "CONTENT_KIND_CONFLICT",
  TopicRequired: "DOCUMENT_TOPIC_REQUIRED",
  SourceNotFound: "SOURCE_MEMO_NOT_FOUND",
  SourceLimitExceeded: "SOURCE_LIMIT_EXCEEDED",
  ContentLimitExceeded: "CONTENT_LIMIT_EXCEEDED",
  JobIdempotencyConflict: "JOB_IDEMPOTENCY_CONFLICT",
} as const;

export type SearchContentKind = "memo" | "document";

export type MemoWriteDto = Readonly<{
  id: string;
  body: string;
  timestamp: number;
}>;

export type DocumentWriteDto = Readonly<{
  id: string;
  title: string;
  body: string;
  timestamp: number;
  topicId: string;
  sourceMemoIds: readonly string[];
}>;

export type TopicWriteDto = Readonly<{
  id: string;
  name: string;
  sourceMemoId?: string;
  timestamp: number;
}>;

export type MemoSearchProjection = Readonly<{
  type: "memo";
  id: string;
  body: string;
  timestamp: number;
  sourceOfDocumentIds: readonly string[];
}>;

export type DocumentSearchProjection = Readonly<{
  type: "document";
  id: string;
  title: string;
  body: string;
  timestamp: number;
  topicId: string;
  sourceMemoIds: readonly string[];
}>;

export type SearchProjectionEntry =
  | MemoSearchProjection
  | DocumentSearchProjection;

export type SearchProjectionOperation =
  | Readonly<{ type: "upsert"; entry: SearchProjectionEntry }>
  | Readonly<{ type: "remove"; entityType: SearchContentKind; id: string }>;

export type SearchQuery = Readonly<{
  keyword: string;
  topicId?: string;
  page?: number;
  limit?: number;
  cursor?: string;
}>;

export type MemoSearchResultItem = Readonly<{
  type: "memo";
  id: string;
  snippet: string;
  timestamp: string;
  sourceOfDocumentIds: readonly string[];
}>;

export type DocumentSearchResultItem = Readonly<{
  type: "document";
  id: string;
  title: string;
  snippet: string;
  timestamp: string;
  topic: Readonly<{ id: string; name: string; archived: boolean }>;
  sourceMemoIds: readonly string[];
}>;

export type SearchResultItem = MemoSearchResultItem | DocumentSearchResultItem;

export type SearchPage = Readonly<{
  items: readonly SearchResultItem[];
  page: number;
  limit: number;
  totalCount: number;
  nextCursor: string | null;
}>;

export interface SearchIndexPort {
  query(query: SearchQuery): SearchPage;
}

export interface SearchProjectionPort {
  apply(operation: SearchProjectionOperation): void;
}

type SemanticCommandBase = Readonly<{
  version?: typeof SEARCH_RPC_VERSION;
  operationId: string;
}>;

export type SemanticCommand =
  | (SemanticCommandBase &
      Readonly<{ type: "create-memo"; memo: MemoWriteDto }>)
  | (SemanticCommandBase &
      Readonly<{ type: "update-memo"; memo: MemoWriteDto }>)
  | (SemanticCommandBase &
      Readonly<{ type: "trash-memo"; memoId: string; trashedAt: number }>)
  | (SemanticCommandBase &
      Readonly<{ type: "restore-memo"; memo: MemoWriteDto }>)
  | (SemanticCommandBase &
      Readonly<{ type: "remove-memo"; memoId: string; removedAt: number }>)
  | (SemanticCommandBase &
      Readonly<{ type: "create-document"; document: DocumentWriteDto }>)
  | (SemanticCommandBase &
      Readonly<{ type: "update-document"; document: DocumentWriteDto }>)
  | (SemanticCommandBase &
      Readonly<{
        type: "trash-document";
        documentId: string;
        trashedAt: number;
      }>)
  | (SemanticCommandBase &
      Readonly<{ type: "restore-document"; document: DocumentWriteDto }>)
  | (SemanticCommandBase &
      Readonly<{
        type: "remove-document";
        documentId: string;
        removedAt: number;
      }>)
  | (SemanticCommandBase &
      Readonly<{ type: "create-topic"; topic: TopicWriteDto }>)
  | (SemanticCommandBase &
      Readonly<{
        type: "set-topic-archived";
        topicId: string;
        archivedAt: number | null;
        updatedAt: number;
      }>)
  | (SemanticCommandBase &
      Readonly<{ type: "trash-topic"; topicId: string; trashedAt: number }>)
  | (SemanticCommandBase &
      Readonly<{ type: "restore-topic"; topicId: string; restoredAt: number }>)
  | (SemanticCommandBase &
      Readonly<{ type: "remove-topic"; topicId: string; removedAt: number }>)
  | LegacySemanticCommand;

export type LegacySearchProjectionEntry = Readonly<{
  id: string;
  kind: SearchContentKind;
  title: string;
  body: string;
  topicId?: string;
  topicArchived: boolean;
  sourceLinks: readonly Readonly<{ memoId: string; label: string }>[];
  trashedAt?: number;
  updatedAt: number;
}>;

type LegacySemanticCommand =
  | Readonly<{
      type: "upsert-content";
      operationId: string;
      entry: LegacySearchProjectionEntry;
    }>
  | Readonly<{
      type: "trash-content";
      operationId: string;
      id: string;
      trashedAt: number;
    }>
  | Readonly<{
      type: "restore-content";
      operationId: string;
      id: string;
      restoredAt: number;
    }>
  | Readonly<{
      type: "remove-content";
      operationId: string;
      id: string;
    }>;

export type SemanticCommitResult = Readonly<{
  operationId: string;
  replayed: boolean;
}>;

export interface SemanticCommitPort {
  commit(command: SemanticCommand): SemanticCommitResult;
}

export type LegacySearchQuery = Readonly<{
  text: string;
  topicId?: string;
  limit?: number;
  offset?: number;
}>;

export type LegacySearchResult = Readonly<{
  id: string;
  kind: SearchContentKind;
  title: string;
  snippet: string;
  score: number;
  topicId?: string;
  topicArchived: boolean;
  sourceLinks: readonly Readonly<{ memoId: string; label: string }>[];
}>;

export type LegacySearchPage = Readonly<{
  items: readonly LegacySearchResult[];
  nextOffset?: number;
}>;
