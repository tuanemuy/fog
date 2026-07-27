# ユースケース: search

User Data Durable Object 内の SQLite FTS5 を利用する、人間 UI / AI 共通の全文検索を定義する。検索射影は各 memo/document command の `SemanticCommitPort` が本体変更と同じ transaction で更新する。

## search（検索する）

### 概要

認証済みユーザーの User Data DO 内でメモ・ドキュメントを横断検索する。presentation は外部入力から DO ID、partition key、`userId` の上書きを受け取らない。

### 入力DTO

```ts
type SearchInput = Readonly<{
  keyword: string;
  topicId?: string;
  page?: number;
  limit?: number;
  cursor?: string;
}>;
```

- `keyword` は NFKC、trim 後に非空、UTF-8 50 byte 以下
- `topicId` は optional 単一指定
- `page` / `limit` / `cursor` は transport boundary で検証する

### 出力DTO

```ts
type SearchOutput = Readonly<{
  items: readonly (
    | {
        type: "memo";
        id: string;
        snippet: string;
        timestamp: string;
        sourceOfDocumentIds: readonly string[];
      }
    | {
        type: "document";
        id: string;
        title: string;
        snippet: string;
        timestamp: string;
        topic: { id: string; name: string; archived: boolean };
        sourceMemoIds: readonly string[];
      }
  )[];
  page: number;
  limit: number;
  totalCount: number;
  nextCursor: string | null;
}>;
```

### 処理フロー

1. request Worker が session/token を検証して canonical `userId` を得る
2. `AuthenticatedUserDataRouter` がその `userId` だけから User Data DO stub を選ぶ
3. DO 内で `SearchQuery` を構築する
4. `SearchIndexPort.query` を1回呼び、同一 snapshot から結果と cursor を得る
5. document の topic 表示名・archived 状態を同じ DO 内で一括解決する
6. 人間 UI と AI の両方へ同じ結果集合・順位・除外規則で射影する

### エラーケース

| 条件 | 結果 |
|---|---|
| keyword が空 | `BusinessRuleError(SEARCH_EMPTY_KEYWORD)` |
| NFKC 後の keyword が UTF-8 50 byte 超 | `BusinessRuleError(SEARCH_KEYWORD_TOO_LONG)` |
| cursor / page / limit が不正 | `ValidationError` |
| topicId が不在・別ユーザー由来 | `NotFoundError(TOPIC_NOT_FOUND)` |
| SQLite/FTS が利用不能 | retryable な `SystemError(DatabaseError)` |
| SQLite 容量超過 | non-retryable な `SystemError(StorageCapacityExceeded)` |
| 0件 | `items: []` の正常応答 |

## semantic command harness（同期検索射影）

### 概要

後続 Issue の完成 usecase/UIより先に、memo/document の create/update/remove/restore と検索射影の atomicity を固定する内部 command harness。local workerd test と local-only CLI からだけ呼べ、本番 route/artifactには公開しない。

### 入力DTO

`operationId` と command payload だけを持つ versioned primitive envelope を使う。

```ts
type SemanticCommandEnvelope = Readonly<{
  version: 1;
  operationId: string;
  command:
    | { kind: "createMemo"; memo: MemoWriteDto }
    | { kind: "updateMemo"; memo: MemoWriteDto }
    | { kind: "removeMemo"; memoId: string }
    | { kind: "restoreMemo"; memo: MemoWriteDto }
    | { kind: "createDocument"; document: DocumentWriteDto }
    | { kind: "updateDocument"; document: DocumentWriteDto }
    | { kind: "removeDocument"; documentId: string }
    | { kind: "restoreDocument"; document: DocumentWriteDto };
}>;
```

partition/user ID は envelope に含めない。呼び出し先 DO の identity が境界である。

### 処理フロー

1. DO input gate が schema migration と未設定 Alarm の再計算を完了する
2. idempotency table で `operationId` の既存結果を確認し、存在すれば同じ結果を返す
3. application が外部 I/O を必要とする準備を transaction の外で完了し、typed command を作る
4. `SemanticCommitPort.transactionSync` 内で本体 repository を更新する
5. 同じ callback にだけ渡された `SearchProjectionPort` で FTS entry、topic/source join を upsert/remove する
6. operation result と idempotency record を同じ transaction で保存する
7. commit 後に結果を返す

本体更新失敗、射影更新失敗、idempotency 保存失敗のいずれでも全変更を rollback する。検索射影だけが遅延する状態は存在しない。

### 検証対象

- memo/document create/update/remove/restore の直後に同じ DO の検索結果が更新済みである
- 本体失敗時と FTS projection 失敗時の双方で rollback する
- source link の追加・削除が memo/document 双方の result DTO に反映される
- archived topic 配下は検索でき、trashed topic 配下は検索できない
- NFKC、日本語3文字以上、1〜2文字短語、FTS特殊文字、順位、snippet、pagination
- 人間 UI と AI が同じ query semantics を使う

## 非同期処理との境界

検索射影は Alarm job に載せない。Alarm は retention、メール、外部 provider I/O など transaction 外でしか行えない処理だけに使う。永続 job は `leaseUntil`、`ownerToken`、`attempt`、`nextRunAt`、provider idempotency key、poison reason を持ち、at-least-once を前提にする。
