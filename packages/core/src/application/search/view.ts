export type MemoSearchResultView = Readonly<{
  type: "memo";
  id: string;
  snippet: string;
  timestamp: Date;
  sourceOfDocumentIds: readonly string[];
}>;

export type DocumentSearchResultView = Readonly<{
  type: "document";
  id: string;
  snippet: string;
  timestamp: Date;
  topicId: string;
  topicName: string;
  sourceMemoIds: readonly string[];
}>;

export type SearchResultItemView =
  | MemoSearchResultView
  | DocumentSearchResultView;

/** One page; `count` is the frozen set's size, `nextCursor` null once read out. */
export type SearchOutputView = Readonly<{
  items: readonly SearchResultItemView[];
  count: number;
  nextCursor: string | null;
}>;
