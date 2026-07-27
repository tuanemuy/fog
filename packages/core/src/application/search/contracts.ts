export type SearchContentKind = "memo" | "document";

export type SearchSourceLink = Readonly<{
  memoId: string;
  label: string;
}>;

export type SearchProjectionEntry = Readonly<{
  id: string;
  kind: SearchContentKind;
  title: string;
  body: string;
  topicId?: string;
  topicArchived: boolean;
  sourceLinks: readonly SearchSourceLink[];
  trashedAt?: number;
  updatedAt: number;
}>;

export type SearchProjectionOperation =
  | Readonly<{ type: "upsert"; entry: SearchProjectionEntry }>
  | Readonly<{ type: "remove"; id: string }>;

export type SearchQuery = Readonly<{
  text: string;
  topicId?: string;
  includeTrash?: boolean;
  limit?: number;
  offset?: number;
}>;

export type SearchResult = Readonly<{
  id: string;
  kind: SearchContentKind;
  title: string;
  snippet: string;
  score: number;
  topicId?: string;
  topicArchived: boolean;
  sourceLinks: readonly SearchSourceLink[];
}>;

export type SearchPage = Readonly<{
  items: readonly SearchResult[];
  nextOffset?: number;
}>;

export interface SearchIndexPort {
  search(query: SearchQuery): SearchPage;
}

export interface SearchProjectionPort {
  apply(operation: SearchProjectionOperation): void;
}

export type SemanticCommand =
  | Readonly<{
      type: "upsert-content";
      operationId: string;
      entry: SearchProjectionEntry;
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

export interface SemanticCommitPort {
  commit(command: SemanticCommand): void;
}
