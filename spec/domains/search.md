# Search

メモとドキュメントを横断する SQLite FTS5 全文検索の契約を定義する。検索は User Data Durable Object 内の派生データであり、ベクトル・埋め込み・外部検索サービスは使わない。更新は本体データと同じ SQLite トランザクションで同期する。

他ドメインの ID 型として `UserId`、`MemoId`、`DocumentId`、`TopicId` を参照する。検索ドメインはエンティティ本体を所有しない。

## ユビキタス言語

| 英語 | 日本語 | 定義 |
|---|---|---|
| Full-text Search | 全文検索 | User Data DO の SQLite FTS5 によるキーワード検索 |
| Search Query | 検索クエリ | キーワード、任意の単一トピック、ページングからなる入力 |
| Search Result Item | 検索結果項目 | メモまたはドキュメントの事実データと一致箇所の抜粋 |
| Search Projection | 検索射影 | 本体状態から同一 SQLite 内の FTS 表へ同期投影した派生データ |
| Semantic Commit | 意味的コミット | 本体変更と検索射影変更を単一の同期トランザクションとして確定する操作 |

## エンティティ

なし。検索射影は常に User Data DO の本体データから再構築可能であり、独立した集約ではない。

## 値オブジェクト

### SearchQuery

```ts
export type SearchQuery = Readonly<{
  keyword: string;
  topicId?: TopicId;
  pagination: Pagination;
}>;
```

- `keyword` は NFKC 正規化して trim する
- 空文字は `BusinessRuleError(SearchErrorCode.EmptyKeyword)`
- UTF-8 で 50 byte を超える入力は `BusinessRuleError(SearchErrorCode.KeywordTooLong)`
- `topicId` は optional かつ単一。複数指定はしない
- `userId` は公開入力に含めない。認証済み `userId` から選ばれた User Data DO が物理的な検索境界になる

### SearchResultItem

```ts
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
  title: string;
  snippet: string;
  timestamp: Date;
  topicId: TopicId;
  sourceMemoIds: readonly MemoId[];
}>;

export type SearchResultItem =
  | MemoSearchResultItem
  | DocumentSearchResultItem;
```

- `snippet` は FTS5 の一致位置に基づく原文抜粋であり、生成要約ではない
- source link は active な相手だけを含む
- ドキュメントは所属トピックが archived でも検索対象
- trashed または hard-deleted のメモ・ドキュメント、および trashed topic 配下のドキュメントは返さない

### SearchProjectionEntry

`SemanticCommitPort` の実装だけが構築・利用する typed projection DTO。

```ts
export type MemoSearchProjection = Readonly<{
  type: "memo";
  id: MemoId;
  body: string;
  timestamp: Date;
  sourceOfDocumentIds: readonly DocumentId[];
}>;

export type DocumentSearchProjection = Readonly<{
  type: "document";
  id: DocumentId;
  title: string;
  body: string;
  timestamp: Date;
  topicId: TopicId;
  sourceMemoIds: readonly MemoId[];
}>;

export type SearchProjectionEntry =
  | MemoSearchProjection
  | DocumentSearchProjection;
```

## 検索規則

1. 3 byte 以上の語は FTS5 trigram tokenizer で検索する
2. NFKC 後に UTF-8 で 1〜2 byte の短語は、FTS5 query syntax と wildcard を無効化して安全にエスケープした prefix/substring fallback を使う
3. 外部入力を SQL や FTS query string に連結せず、常に bound parameter と専用エスケープ関数を使う
4. 順位は `bm25` を主キーとし、同点を `timestamp DESC`, `type`, `id` で決定して安定させる
5. ページングは同一 snapshot の cursor を使い、ページ間で重複・欠落を生まない
6. `topicId` 指定時は、そのトピック配下のドキュメントと、その active source memo のみを対象にする
7. 人間 UI と AI の search は同じ `SearchIndexPort.query` を使い、ヒット範囲、順位、除外規則を一致させる

## ポート

### SearchIndexPort

通常の検索ユースケースに渡す read-only port。

```ts
export interface SearchIndexPort {
  query(
    query: SearchQuery,
  ): Promise<PaginationResult<SearchResultItem>>;
}
```

User Data DO 内でのみ実装し、別ユーザーの partition を指定する引数は持たない。

### SearchProjectionPort

本体 repository と同じ同期 SQLite transaction に束縛される capability。通常 DI、検索ユースケース、Worker entry へ単独公開しない。

```ts
export interface SearchProjectionPort {
  upsert(entry: SearchProjectionEntry): void;
  remove(type: "memo" | "document", id: MemoId | DocumentId): void;
}
```

### SemanticCommitPort

application の async prepare が作った typed command を、User Data DO 内で同期確定する。

```ts
export type SemanticCommand =
  | CreateMemoCommand
  | UpdateMemoCommand
  | RemoveMemoCommand
  | RestoreMemoCommand
  | CreateDocumentCommand
  | UpdateDocumentCommand
  | RemoveDocumentCommand
  | RestoreDocumentCommand;

export interface SemanticCommitPort {
  transactionSync<TResult>(
    command: SemanticCommand,
    commit: (
      repositories: TransactionScopedRepositories,
      projection: SearchProjectionPort,
    ) => TResult,
  ): TResult;
}
```

`commit` callback は同期処理だけを許可し、Promise、RPC、暗号、メール、外部 API を含めない。本体更新または射影更新のどちらかが失敗した場合は全変更を rollback する。

## 射影更新規則

| 本体操作 | 同一 transaction 内の射影操作 |
|---|---|
| memo create / edit / rollback / restore | memo entry を upsert。source links の相手側が変わる場合は影響する document entry も upsert |
| memo soft/hard delete | memo entry を remove。影響する active document entry を source link 確定後に upsert |
| document create / edit / rollback / restore | document entry を upsert。source links の相手側が変わる場合は影響する memo entry も upsert |
| document soft/hard delete | document entry を remove。影響する active memo entry を upsert |
| topic archive / unarchive | 射影を削除しない。結果 DTO の topic 状態を更新 |
| topic trash / restore / hard delete | 配下 document entry を remove / upsert / remove |

ドメインイベントを transport として検索射影へ配送しない。ドメインイベントを残す場合も監査または同一 transaction 内の業務反応に限定する。

## エラーコード

```ts
export const SearchErrorCode = {
  EmptyKeyword: "SEARCH_EMPTY_KEYWORD",
  KeywordTooLong: "SEARCH_KEYWORD_TOO_LONG",
  QueryTooComplex: "SEARCH_QUERY_TOO_COMPLEX",
} as const;
```

- SQLite/FTS 障害は adapter が共通 `SystemError(DatabaseError)` へ変換する
- 容量超過は `SystemError(StorageCapacityExceeded)` とし retryable にしない
- page/cursor 不正は presentation boundary の `ValidationError`

## ユースケース

- search — 人間 UI と AI が共有する全文検索
- semantic command harness — 後続の本番 usecase が同じ atomic contract を利用できるよう、memo/document の create/update/remove/restore を local workerd と local-only CLI で検証する
