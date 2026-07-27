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
  EmptyMemoBody: "EMPTY_MEMO_BODY",
  MemoBodyTooLong: "MEMO_BODY_TOO_LONG",
  EmptyDocumentTitle: "EMPTY_DOCUMENT_TITLE",
  DocumentTitleMultiline: "DOCUMENT_TITLE_MULTILINE",
  DocumentTitleTooLong: "DOCUMENT_TITLE_TOO_LONG",
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

export type SearchPagination = Readonly<{
  page?: number;
  limit?: number;
  cursor?: string;
}>;

/** Application capability input. Transport versioning belongs at the RPC edge. */
export type SearchQuery = Readonly<{
  keyword: string;
  topicId?: string;
  pagination?: SearchPagination;
}>;

export type SearchRpcQuery = Readonly<{
  version: typeof SEARCH_RPC_VERSION;
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
  query(query: SearchQuery): Promise<SearchPage>;
}

export interface SearchProjectionPort {
  upsert(entry: SearchProjectionEntry): void;
  remove(entityType: SearchContentKind, id: string): void;
}

type SemanticRpcCommandBase = Readonly<{
  version: typeof SEARCH_RPC_VERSION;
  operationId: string;
  actorId?: string;
}>;

export type SemanticRpcCommand =
  | (SemanticRpcCommandBase &
      Readonly<{ type: "create-memo"; memo: MemoWriteDto }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "update-memo";
        memo: MemoWriteDto;
        expectedVersion?: number;
        changeReason?: string;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "trash-memo";
        memoId: string;
        trashedAt: number;
        expectedVersion?: number;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "restore-memo";
        memoId: string;
        restoredAt: number;
        expectedVersion?: number;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "remove-memo";
        memoId: string;
        removedAt: number;
        expectedVersion?: number;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{ type: "create-document"; document: DocumentWriteDto }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "update-document";
        document: DocumentWriteDto;
        expectedVersion?: number;
        changeReason: string;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "trash-document";
        documentId: string;
        trashedAt: number;
        expectedVersion?: number;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "restore-document";
        documentId: string;
        restoredAt: number;
        expectedVersion?: number;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "remove-document";
        documentId: string;
        removedAt: number;
        expectedVersion?: number;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{ type: "create-topic"; topic: TopicWriteDto }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "set-topic-archived";
        topicId: string;
        archivedAt: number | null;
        updatedAt: number;
        expectedVersion?: number;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "trash-topic";
        topicId: string;
        trashedAt: number;
        expectedVersion?: number;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "restore-topic";
        topicId: string;
        restoredAt: number;
        expectedVersion?: number;
      }>)
  | (SemanticRpcCommandBase &
      Readonly<{
        type: "remove-topic";
        topicId: string;
        removedAt: number;
        expectedVersion?: number;
      }>);

type WithoutRpcVersion<T> = T extends unknown ? Omit<T, "version"> : never;

/** Prepared application command after the RPC version gate has succeeded. */
export type SemanticCommand = WithoutRpcVersion<SemanticRpcCommand>;

export type SemanticCommitResult = Readonly<{
  operationId: string;
  replayed: boolean;
}>;

export interface SemanticCommitPort {
  transactionSync(
    command: SemanticCommand,
    callback?: (
      repositories: Readonly<{ storage: "user-data" }>,
      projection: SearchProjectionPort,
    ) => void,
  ): SemanticCommitResult;
}
