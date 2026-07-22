# Search

メモ・ドキュメントを横断するハイブリッド検索（キーワード + ベクトル）と、検索インデックスの維持を担うドメイン。エンティティは持たず、値オブジェクト・ポートが中心となる（[ADR-004](../adr/004-domain-boundaries.md)）。インデックス更新は Outbox 経由の consumer が非同期で行う（[ADR-005](../adr/005-search-index-via-outbox.md)）。

他ドメインの ID 型を参照する: `UserId`（identity）、`MemoId`（memo）、`DocumentId` / `TopicId`（knowledge）。エンティティ本体は参照せず、ID と読み取り専用の最新状態のみを扱う。

## ユビキタス言語

| 英語 | 日本語 | 定義 |
|---|---|---|
| Hybrid Search | ハイブリッド検索 | キーワード検索（全文一致）とベクトル検索（意味的類似）を統合して単一の結果を返す検索。方式の選択を利用者（人間・AI）に委ねない |
| Search Query | 検索クエリ | 検索の入力。キーワード・任意のトピック絞り込み・ユーザー・ページングからなる |
| Search Result Item | 検索結果項目 | 検索結果の1件。事実データのみで構成され、要約・再構成を含まない |
| Snippet | スニペット | 結果項目に含める原文の抜粋。全文は返さない（短いメモは実質全文になり得る）。切り詰め方式は実装詳細 |
| Index Entry | インデックスエントリ | 検索インデックスに登録する対象の最新状態のスナップショット。メモ用とドキュメント用がある |
| Index Maintenance | インデックス維持 | ドメインイベントを契機に、対象の最新状態を読み直してインデックスへ upsert / remove する冪等な処理 |
| Scope Filter | スコープ絞り込み | `TopicId` による検索範囲の限定。そのトピック配下のドキュメントと、その出典メモに絞る |

## エンティティ

なし。検索は memo / knowledge のエンティティに対する読み取り専用の横断ビューであり、このドメインが所有する状態はインデックス（アダプター内部の永続構造）のみ。インデックスは常に「対象の最新状態から再構築可能な派生データ」であり、集約として管理しない。

## 値オブジェクト

### SearchQuery

検索の入力。application 層のユースケースが生成し、`SearchIndexPort.query` に渡す。

| フィールド | 型 | 制約 |
|---|---|---|
| userId | `UserId` | required。検索範囲は常にこのユーザーのデータに閉じる |
| keyword | `string` | required。trim 後に非空であること |
| topicId | `TopicId` | optional。指定時はスコープ絞り込みを行う |
| pagination | `Pagination` | required。共通の `Pagination`（`domain/common/pagination.ts`）を用いる |

バリデーションルール:

- `keyword` は trim 後に空文字なら `BusinessRuleError(SearchErrorCode.EmptyKeyword)`（シナリオ S-SE-01: キーワード未入力の間は検索を実行しない、に対応する構造的な保証）
- `keyword` の最大長は 500 文字。超過は `BusinessRuleError(SearchErrorCode.KeywordTooLong)`

等価性: 全フィールドの値が等しいとき同一。

```ts
export type SearchQuery = Readonly<{
  userId: UserId;
  keyword: string;
  topicId?: TopicId;
  pagination: Pagination;
}>;

export const SearchQuery = {
  create: (params: {
    userId: UserId;
    keyword: string;
    topicId?: TopicId;
    pagination: Pagination;
  }): SearchQuery => { /* keyword を trim して検証 */ },
};
```

### SearchResultItem

検索結果の1件。種別（メモ / ドキュメント）の直和型として定義し、種別ごとに持ち得るフィールドだけを表現する（「メモに所属トピックがある」等のあり得ない組み合わせを型上排除する）。

```ts
export type MemoSearchResultItem = Readonly<{
  type: "memo";
  id: MemoId;
  snippet: string;
  timestamp: Date;                      // メモの投稿日時
  sourceOfDocumentIds: readonly DocumentId[]; // このメモを出典とするドキュメントのID群（なければ空配列）
}>;

export type DocumentSearchResultItem = Readonly<{
  type: "document";
  id: DocumentId;
  snippet: string;
  timestamp: Date;                      // ドキュメントの最終更新日時
  topicId: TopicId;                     // 所属トピック（ドキュメントは必ずトピックに属する）
  sourceMemoIds: readonly MemoId[];     // 出典メモのID群（なければ空配列）
}>;

export type SearchResultItem = MemoSearchResultItem | DocumentSearchResultItem;
```

バリデーションルール:

- `snippet` は非空。切り詰め方式（文字数・一致箇所周辺の抽出・ハイライト等）は実装詳細であり、要件・ドメインでは規定しない（要件 4.4）
- 検索結果は事実データのみで構成する。要約・言い換え・再構成をこのドメイン（およびアダプター）で行うことは禁止。加工は AI クライアントの責務

等価性: `type` と `id` が等しいとき同一項目とみなす（同一検索結果内で `id` は重複しない。キーワード側・ベクトル側の双方にヒットしても1件に統合される）。

### IndexEntry

インデックスに登録する対象の最新状態。consumer が対象を読み直して構築し、`SearchIndexPort` の upsert に渡す。種別の直和型とする。

```ts
export type MemoIndexEntry = Readonly<{
  type: "memo";
  memoId: MemoId;
  userId: UserId;
  content: string;                      // メモ本文（最新リビジョンの全文）
  timestamp: Date;                      // 投稿日時
  sourceOfDocumentIds: readonly DocumentId[];
}>;

export type DocumentIndexEntry = Readonly<{
  type: "document";
  documentId: DocumentId;
  userId: UserId;
  topicId: TopicId;
  title: string;
  content: string;                      // ドキュメント本文（最新リビジョンの全文）
  timestamp: Date;                      // 最終更新日時
  sourceMemoIds: readonly MemoId[];
}>;

export type IndexEntry = MemoIndexEntry | DocumentIndexEntry;
```

バリデーションルール:

- `content` はインデックス対象として空を許容する（空本文のエンティティは存在しない前提だが、エントリ構築時に再検証はしない。真正性は memo / knowledge の不変条件が保証する）
- ソフトデリート済み・ハードデリート済みの対象から `IndexEntry` を構築してはならない。それらは upsert ではなく remove の対象（後述のインデックス更新フロー）
- **`sourceOfDocumentIds` / `sourceMemoIds` には、出典リンクの相手側が active なものの ID のみを含める**。ゴミ箱内（ソフトデリート済み）・ハードデリート済みの相手の ID は含めない。含めると AI が検索結果経由でゴミ箱内項目の ID（存在の事実）を観測できてしまい、「ゴミ箱の中身は AI から見えない世界」（requirements 4.5 / trash.md）に反する。consumer はエントリ構築時に出典リンクの相手側の現在状態を確認して active のみを採用する（この規則を相手側の削除・復元にわたって維持するためのファンアウトは後述のインデックス更新フロー）

等価性: `type` と対象 ID（`memoId` / `documentId`）が等しいとき同一対象のエントリとみなす。upsert はこの同一性キーで冪等に上書きする。

## ドメインサービス

なし。

- ハイブリッド検索の統合方式（RRF 等のスコアリング・マージ規則）は仕様レベルの規則を持たない実装詳細とし、`SearchIndexPort` アダプターの責務とする。ドメインが保証するのは「単一のクエリで単一の統合された結果が返ること」（要件 4.4: 検索方式の選択を AI に委ねない）のみで、順位付けの具体則には関与しない
- 検索対象の除外規則（ゴミ箱・アーカイブ）は後述の「検索の規則」としてポートの契約に含め、サービスとしては切り出さない

## 検索の規則

`SearchIndexPort.query` の実装（アダプター）とインデックス維持が共同で守るべきドメインルール。人間 UI と AI クライアント（search API）で挙動は完全に一致する（シナリオ S-SE-03）。

- 検索範囲は `SearchQuery.userId` のユーザーのデータに常に閉じる（マルチテナントでもデータは個人に閉じる。要件 5.1）
- ゴミ箱内（ソフトデリート済み）の項目は検索にヒットしない。インデックス維持がソフトデリートイベントで remove することにより保証する
  - 「ゴミ箱内の項目は get でも取得できない」は AI スコープの規則であり、memo / knowledge のユースケース公開範囲と identity のトークンスコープが担う。search ドメインの責務ではない（ここではヒットしないことのみ保証する）
  - ゴミ箱内項目の **ID も検索結果に露出させない**: 結果項目の `sourceOfDocumentIds` / `sourceMemoIds` は active な相手のみを含む（IndexEntry の構築規則と、相手側削除・復元時のファンアウト upsert で保証する）
- アーカイブ（完了）済みトピック配下のドキュメントとその出典メモは検索にヒットする（要件 4.2 / 4.4）。トピックのアーカイブフラグ変更はインデックス更新の契機にならない
- 検索結果は事実データのみ（ID・種別・スニペット・タイムスタンプ・所属トピック・出典リンク先 ID）を返し、一切加工しない。要約・再構成は AI クライアントの責務
- 全文は返さない。切り詰め方式は実装詳細。原文の完全性が必要な場合は memo / knowledge の単体取得（get）を使う
- `topicId` 指定時は、そのトピック配下のドキュメントと、その出典になっているメモに結果を絞る（シナリオ S-SE-02）
- 一致する結果がない場合は空の結果を返す（エラーではない）
- インデックス更新は非同期のため、書き込み直後の項目は検索にヒットしない場合がある（ADR-005。直近の文脈把握は memo の recent_memos が補う）

## ポート

### SearchIndexPort

- 目的: ハイブリッド検索インデックスへの問い合わせと維持。キーワードインデックス・ベクトルインデックスの構成、埋め込み生成、スコアリング・マージ（RRF 等）はすべてこのポートの実装に隠蔽する
- 配置: `packages/core/src/domain/search/ports/searchIndexPort.ts`

```ts
export interface SearchIndexPort {
  query(query: SearchQuery): Promise<PaginationResult<SearchResultItem>>;
  upsertMemo(entry: MemoIndexEntry): Promise<void>;
  upsertDocument(entry: DocumentIndexEntry): Promise<void>;
  removeMemo(memoId: MemoId): Promise<void>;
  removeDocument(documentId: DocumentId): Promise<void>;
}
```

メソッド:

- `query(query: SearchQuery): Promise<PaginationResult<SearchResultItem>>` — キーワード検索とベクトル検索を実行し、統合済みの単一結果を関連度順で返す。検索の規則（ユーザー境界・除外規則・スコープ絞り込み・事実データのみ）を満たすこと。結果0件は空の `PaginationResult`
- `upsertMemo(entry: MemoIndexEntry): Promise<void>` — メモをインデックスへ登録・上書きする（埋め込み再生成を含む）。冪等: 同一エントリで何度呼んでも結果は同じ
- `upsertDocument(entry: DocumentIndexEntry): Promise<void>` — ドキュメントについて同上
- `removeMemo(memoId: MemoId): Promise<void>` — メモをインデックスから除去する。冪等: 存在しない ID に対してもエラーにせず成功する
- `removeDocument(documentId: DocumentId): Promise<void>` — ドキュメントについて同上

remove を種別ごとに分けるのは、`MemoId` / `DocumentId` がブランド型で互換がなく、直和の `type` と対で扱うほうが取り違えを型エラーにできるため。

エラーケース:

- `SystemError(SearchIndexUnavailable)` — インデックスストアへの接続失敗・タイムアウト。retryable。query では利用者にエラーが返り、upsert / remove では consumer のリトライ（Outbox の backoff）に乗る
- `SystemError(EmbeddingFailed)` — 埋め込み生成（外部 API）の失敗。upsert 系のみで発生。retryable。consumer のリトライに乗る
- upsert / remove は「対象が見つからない」ことをエラーにしない（冪等性の要件。at-least-once・順序保証なしの配信で二重処理・逆順到達が起こるため。ADR-005）

### IndexerReadPort

- 目的: Outbox 経由の**信頼済みドメインイベント**を契機とする再インデックスのための読み取り。インデックス更新 consumer（maintainSearchIndex）が、対象の読み直し（upsert / remove の判断）と出典リンクのファンアウト逆引きを**対象 ID のみ**で行う
- **userId スコープなし**: イベントペイロードには `userId` が含まれず（ADR-005: 対象 ID のみ）、扱う ID はすべて Outbox 由来の信頼済み内部 ID である。テナント分離の契約（domains/index.md「テナント分離」）は**外部入力 ID** に対する保証であり、外部入力 ID を扱わないこの内部経路はその対象外。**application 層のユースケースには配線しない**（indexer 専用の拡張ワーカーコンテナにのみ DI で与える）
- 配置: `packages/core/src/domain/search/ports/indexerReadPort.ts`

```ts
export interface IndexerReadPort {
  findMemoById(memoId: MemoId): Promise<ActiveMemo | null>;
  findDocumentById(documentId: DocumentId): Promise<ActiveDocument | null>;
  listSourceLinksByMemo(memoId: MemoId): Promise<readonly SourceLink[]>;
  listSourceLinksByDocument(documentId: DocumentId): Promise<readonly SourceLink[]>;
}
```

メソッド:

- `findMemoById(memoId: MemoId): Promise<ActiveMemo | null>` — 対象メモの最新状態を **active のみ**返す。trashed（ソフトデリート済み）・不在（ハードデリート済み）はいずれも null。**null はインデックスからの remove 判断に使う**（consumer は null なら `removeMemo` に正規化する）。`ActiveMemo`（memo ドメイン）は `MemoIndexEntry` の構築に必要なフィールド（`userId` / `body` / `postedAt`）をすべて含む
- `findDocumentById(documentId: DocumentId): Promise<ActiveDocument | null>` — 対象ドキュメントについて同上。`ActiveDocument`（knowledge ドメイン）は `topicId` を必須フィールドとして含む（ドキュメントは必ずトピックに属する）ため、`DocumentIndexEntry` の構築（`userId` / `topicId` / `title` / `body` / `updatedAt`）に追加の読み取りは不要
- `listSourceLinksByMemo(memoId: MemoId): Promise<readonly SourceLink[]>` — このメモを出典とする出典リンク（`SourceLink`。knowledge ドメイン）を返す。ファンアウト逆引き（相手ドキュメントの再 upsert）用。なければ空配列
- `listSourceLinksByDocument(documentId: DocumentId): Promise<readonly SourceLink[]>` — このドキュメントの出典リンクを返す。ファンアウト逆引き（出典メモの再 upsert）用。なければ空配列

`IndexEntry` の「active な相手のみの出典 ID 群」の判定材料もこの 4 メソッドで足りる: `listSourceLinks*` で得たリンクの相手 ID を `findMemoById` / `findDocumentById` で読み直し、非 null（= active）のもののみを `sourceOfDocumentIds` / `sourceMemoIds` に採用する（`IndexEntry.userId` には読み直した対象自身の `userId` を採用する）。

エラーケース:

- DB 例外 → `SystemError(DatabaseError)`（アダプターが変換する）
- 「対象が見つからない」はエラーではない（`findMemoById` / `findDocumentById` は null、`listSourceLinks*` は空配列を返す）

### EmbeddingPort について

独立したポートとしては定義しない。埋め込み生成（テキスト → ベクトル）はハイブリッドインデックス維持の内部工程であり、ドメイン・application 層がベクトル値を扱う場面がないため、`SearchIndexPort` のアダプター内部に隠蔽する。埋め込みモデルの選定・次元数・バッチ化はアダプターの実装詳細。埋め込み生成の失敗は上記 `SystemError(EmbeddingFailed)` としてポート境界に現れ、consumer のリトライで回復する。将来、埋め込みの独立利用（類似メモ提案等）が必要になった時点で切り出しを検討する。

## エラーコード

```ts
export const SearchErrorCode = {
  EmptyKeyword: "EMPTY_KEYWORD",
  KeywordTooLong: "KEYWORD_TOO_LONG",
} as const;
```

`SearchIndexUnavailable` / `EmbeddingFailed` はドメインエラーではなく application 層の `SystemError` のコードとして扱う。

## インデックス更新フロー

ADR-005 の方式。search ドメイン自身はイベントを発行せず、memo / knowledge のドメインイベントの consumer 側に立つ。

1. memo / knowledge の書き込みユースケースが、エンティティ永続化とドメインイベント登録を同一トランザクションで行う（Outbox）
2. relay worker が Outbox のイベントを consumer へ配信する（at-least-once・順序保証なし）
3. consumer はイベントペイロードから対象 ID のみを取り出し、**対象の最新状態を読み直して**処理を決める。イベントペイロードの本文は使わない（古いペイロードによる巻き戻り防止）
   - 対象が存在し、ソフトデリートされていない → `IndexEntry` を構築して `upsertMemo` / `upsertDocument`（`sourceOfDocumentIds` / `sourceMemoIds` は出典リンクの相手側の現在状態を確認し、active のもののみ含める）
   - 対象が存在しない（ハードデリート済み）またはソフトデリート済み → `removeMemo` / `removeDocument`
4. upsert / remove は冪等なので、同一イベントの重複配信・逆順到達でも最終状態は最新状態に収束する

契機となるイベント（イベント定義は memo / knowledge 側に属する):

| イベント | consumer の処理 |
|---|---|
| `memo.created` / `memo.edited` | 最新状態を読み直して upsertMemo |
| `memo.restored` | 最新状態を読み直して upsertMemo。加えて、consumer は `listSourceLinksByMemo` でこのメモを出典とするドキュメントを逆引きし、各ドキュメントのエントリも再 upsertDocument する（`sourceMemoIds` にこのメモの ID が戻る。ファンアウト） |
| `memo.trashed` | removeMemo。加えて、`listSourceLinksByMemo` でこのメモを出典とするドキュメントを逆引きし、各ドキュメントのエントリも再 upsertDocument する（`sourceMemoIds` からこのメモの ID が外れ、ゴミ箱内の ID が検索結果に露出しない。ファンアウト） |
| `memo.hardDeleted` | removeMemo（出典リンク側の再構築は同一 UoW で発行される `document.sourceLinksChanged` が担う） |
| `memo.sourceLinksChanged` | 対象メモを読み直して upsertMemo（`sourceOfDocumentIds` の反映。参照先ドキュメントのハードデリートでリンクが消えたとき、trash のユースケースがリンク消去と同一 UoW で発行する） |
| `document.created` | 最新状態を読み直して upsertDocument。加えて、consumer は `listSourceLinksByDocument` で出典メモを逆引きし、出典メモ各件も upsertMemo する（`sourceOfDocumentIds` の反映。ファンアウト） |
| `document.edited` | 最新状態を読み直して upsertDocument |
| `document.restored` | 最新状態を読み直して upsertDocument。加えて、`listSourceLinksByDocument` で出典メモを逆引きし、出典メモ各件のエントリも再 upsertMemo する（`sourceOfDocumentIds` にこのドキュメントの ID が戻る。ファンアウト） |
| `document.trashed` | removeDocument。加えて、`listSourceLinksByDocument` で出典メモを逆引きし、出典メモ各件のエントリも再 upsertMemo する（`sourceOfDocumentIds` からこのドキュメントの ID が外れ、ゴミ箱内の ID が検索結果に露出しない。ファンアウト） |
| `document.hardDeleted` | removeDocument（出典リンク側の再構築は同一 UoW で発行される `memo.sourceLinksChanged` が担う） |
| `document.sourceLinksChanged` | 対象ドキュメントを読み直して upsertDocument（`sourceMemoIds` の反映。出典メモのハードデリートでリンクが消えたとき、trash のユースケースがリンク消去と同一 UoW で発行する） |
| `topic.created` / `topic.updated` | 何もしない（トピック名は index に持たず、検索結果のトピック名は query 側でトピックを参照して解決するため。インデックス更新の契機ではない） |
| `topic.trashed` / `topic.restored` | 配下ドキュメントのカスケードは knowledge がドキュメント単位のイベント（`document.trashed` / `document.restored`）として発行するため、search はそちらで受ける（トピックイベント自体には反応しない） |
| `topic.archived` / `topic.unarchived` | 何もしない（アーカイブ済みもヒットするため） |

上表にない / 未知のイベント種別が購読チャネルに流れてきた場合、consumer は no-op として ack する（デコード失敗として隔離に落とさない）。

処理はどの分岐でも「読み直した最新状態」だけに基づくため、consumer は出典の相互反映（上記のファンアウト）を除き、イベント種別ごとの分岐を厳密に持つ必要はなく、「対象 ID の現在の可視状態を確認して upsert または remove」という単一の冪等処理に正規化してよい。ファンアウトも「逆引きで得た各相手 ID に対して同じ冪等処理を適用する」だけであり、新しいイベント種別は導入しない（ソフトデリート・復元の相手側再インデックスは consumer 側のファンアウトで実現する）。ファンアウトの逆引きは `IndexerReadPort.listSourceLinksByMemo` / `listSourceLinksByDocument`（上記「ポート」の定義）で行う。

読み直しの userId スコープについて: memo / knowledge のリポジトリの外部入力 ID を受けるメソッドは `userId` を第一引数に取る契約（domains/index.md「テナント分離」）だが、本 consumer が扱う ID は Outbox 経由の**信頼済み内部イベント**由来であり、ペイロードには `userId` が含まれない（ADR-005: 対象 ID のみ）。したがって consumer の読み直し・逆引きには application 向けリポジトリの userId スコープ付きメソッドではなく、対象 ID のみで読む **`IndexerReadPort`**（上記「ポート」で定義。アダプター実装を拡張ワーカーコンテナに DI で与える）を用いる。テナント分離の契約は「外部入力 ID」に対する保証であり、この内部経路はその対象外。`IndexEntry` の `userId` には読み直した対象自身の `userId` を採用し、インデックスのユーザー境界（検索の規則）はこれにより維持される。

なお、本 consumer の依存（`IndexerReadPort`・`SearchIndexPort`）はテンプレート既定の `WorkerContainer`（`outboxRepository` + `idempotencyStore`）では賄えないため、これらを追加した indexer 専用の拡張ワーカーコンテナを DI で組んで動かす（テンプレートの「スコープごとに独立したコンテナ型」の方針に従う）。

## ユースケース（概要）

詳細はユースケース設計フェーズで定義する。

- 検索する（search）— `SearchQuery` を構築して `SearchIndexPort.query` を呼ぶ。人間 UI（検索画面）と AI クライアント（search API / MCP ツール）で共通の単一ユースケース
- 検索インデックスを更新する（インデックス更新 consumer）— memo / knowledge のドメインイベントを受け、対象の最新状態を読み直して upsert / remove する worker 側ユースケース（内部処理。人間 UI・AI のいずれの presentation にも公開しない）
