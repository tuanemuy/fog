# ユースケース: search

メモ・ドキュメント横断のハイブリッド検索と、検索インデックスの維持（consumer）のユースケース。上流: [domains/search.md](../domains/search.md)、[ADR-005](../adr/005-search-index-via-outbox.md)、シナリオ S-SE-01〜03 / S-AI-02。

ビジネスロジック（キーワード検証・検索の規則・インデックス維持の規則）はすべて search ドメインの値オブジェクトと `SearchIndexPort` の契約に置く。ユースケースは値オブジェクトの構築とポート呼び出しのオーケストレーションのみを行う。

## search（検索する）

### 概要

キーワード（と任意のトピック絞り込み）でユーザーのメモ・ドキュメントを横断するハイブリッド検索を実行する。人間 UI（検索画面）と AI クライアント（search API / MCP ツール）で共通の単一ユースケース。挙動（ヒット範囲・除外規則）は両者で完全に一致する（S-SE-03）。

検索方式（キーワード / ベクトル）の選択・統合は `SearchIndexPort` のアダプターに隠蔽されており、ユースケース・利用者は関与しない。

### 入力DTO

`SearchInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | `UserId.create` で検証（認証済みユーザー / トークンの所有ユーザーを渡す） |
| keyword | `string` | required | `SearchQuery.create` に委譲: trim 後に非空、最大 500 文字 |
| topicId | `string` | optional | 指定時は `TopicId.create` で検証。スコープ絞り込みに用いる |
| page | `number` | required | 1 以上の整数（listTrash と同形式） |
| limit | `number` | required | 1〜100 の整数（listTrash と同形式） |

入力DTOはプリミティブのみで構成する（DTO 規約）。ドメイン型 `Pagination`（`domain/common/pagination.ts`）への変換は処理フロー内の VO 構築で行う。

### 出力DTO

`SearchOutput` = `PaginationResult<SearchResultItemDto>`

| フィールド | 型 |
|---|---|
| items | `SearchResultItemDto[]` |
| count | `number`（総件数。`PaginationResult` の共通形に従う） |

`SearchResultItemDto` はドメインの `SearchResultItem`（直和）をプリミティブに射影したもの。事実データのみで構成し、要約・言い換え・再構成・並べ替えを行わない。

メモの場合（`type: "memo"`）:

| フィールド | 型 |
|---|---|
| type | `"memo"` |
| id | `string`（MemoId） |
| snippet | `string`（原文の抜粋。全文は返さない） |
| timestamp | `Date`（メモの投稿日時） |
| sourceOfDocumentIds | `string[]`（このメモを出典とする active なドキュメントの ID 群。なければ空配列） |

ドキュメントの場合（`type: "document"`）:

| フィールド | 型 |
|---|---|
| type | `"document"` |
| id | `string`（DocumentId） |
| snippet | `string`（原文の抜粋。全文は返さない） |
| timestamp | `Date`（ドキュメントの最終更新日時） |
| topicId | `string`（所属トピック。ドキュメントは必ずトピックに属する） |
| topicName | `string`（所属トピックの名前。人間 UI の結果表示用。下記「所属トピック名の解決」参照） |
| sourceMemoIds | `string[]`（出典になっている active なメモの ID 群。なければ空配列） |

### 処理フロー

1. `UserId.create(input.userId)`、指定があれば `TopicId.create(input.topicId)` で ID 値オブジェクトを構築する。あわせて `input.page` / `input.limit` から共通の `Pagination`（`domain/common/pagination.ts`）を構築する（範囲違反はここで検出）
2. `SearchQuery.create({ userId, keyword, topicId, pagination })` で検索クエリ値オブジェクトを構築する。keyword の trim・非空・最大長の検証はここ（ドメイン）で行われる
3. `SearchIndexPort.query(searchQuery)` を呼ぶ。ユーザー境界・ゴミ箱除外・アーカイブ込み・トピック絞り込み・統合済み単一結果の保証はポートの契約（domains/search.md「検索の規則」）が担う
4. **所属トピック名の解決（結果整形）**: 結果内の `type: "document"` 項目の `topicId` を重複除去し、`TopicRepository.listByIds(userId, topicIds)` で一括解決して（N+1 にしない）、各項目の出力DTOに `topicName` を含める（P-11 / S-SE-01 の「所属トピック」表示用）。AI 向け presentation の出力は従来どおり `topicId` のみで `topicName` は露出しない。名前解決は表示補助（ID → 名前の参照解決）であり、検索結果の要約・言い換え・再構成には当たらない — 「事実データのみ」の原則と矛盾しない
5. `PaginationResult<SearchResultItem>` を `SearchResultItemDto` へ射影して返す。上記トピック名の付与以外に、フィールドの追加・削除・加工は行わない

補足:

- 一致する結果がない場合は空の `PaginationResult` を返す（エラーではない。S-SE-01 エッジケース）
- インデックス更新は非同期のため、書き込み直後の項目はヒットしない場合がある（ADR-005。直近の文脈把握は memo の recent_memos が補う）

### エラーケース

| 条件 | エラー |
|---|---|
| keyword が trim 後に空 | `BusinessRuleError(SearchErrorCode.EmptyKeyword)` |
| keyword が 500 文字を超える | `BusinessRuleError(SearchErrorCode.KeywordTooLong)` |
| userId / topicId が形式不正 | バリデーションエラー（各値オブジェクトの構築エラー） |
| page / limit が範囲外（`Pagination` 構築エラー） | バリデーションエラー |
| インデックスストアへの接続失敗・タイムアウト | `SystemError(SearchIndexUnavailable)`（retryable。利用者にエラーが返る） |

## maintainSearchIndex（検索インデックスを更新する）

### 概要

memo / knowledge のドメインイベントを Outbox 経由で受け、対象の最新状態を読み直して検索インデックスを upsert / remove する consumer 側ユースケース（ADR-005）。worker 内部の処理であり、人間 UI・AI のいずれの presentation にも公開しない。

配信は at-least-once・順序保証なしのため、処理全体を「対象 ID の現在の可視状態を確認して upsert または remove する」単一の冪等な正規形として設計する。同一イベントの重複配信・逆順到達でも、インデックスの最終状態は対象の最新状態に収束する。

依存（コンテナ）: テンプレート既定の `WorkerContainer`（`outboxRepository` + `idempotencyStore`）では賄えないため、次を追加した indexer 専用の拡張ワーカーコンテナを DI で組んで動かす（「スコープごとに独立したコンテナ型」の方針に従う）。

- `SearchIndexPort` — upsert / remove の実行先
- `IndexerReadPort`（[domains/search.md](../domains/search.md) 定義）— 対象の読み直し（`findMemoById` / `findDocumentById`）と出典リンクの逆引き（`listSourceLinksByMemo` / `listSourceLinksByDocument`）を対象 ID のみで行う indexer 専用読み取りポート。Outbox 経由の信頼済み内部イベントはペイロードに `userId` を含まないため、application 向けリポジトリの userId スコープ付きメソッドは使わない（テナント分離の契約は外部入力 ID に対する保証であり、この内部経路は対象外。domains/index.md「テナント分離」）。application 層のユースケースには配線しない

### 入力DTO

`MaintainSearchIndexInput`（relay worker がデコード済みのドメインイベントとして渡す。ペイロードは対象 ID のみを運び、本文は含まない）

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| eventId | `string`（EventId） | required | 冪等処理のデデュープキー（`IdempotencyStore`） |
| eventType | `string` | required | 原則として下表の契機イベントのいずれか。イベント定義・デコーダーは memo / knowledge 側に属する。**表にない / 未知のイベント種別は no-op として ack する**（デコード失敗として隔離（quarantine）に落とさない。購読チャネルへ流れ得るイベント集合の変化に対して consumer を頑健に保つ） |
| targetId | `string`（MemoId / DocumentId / TopicId。eventType により決まる） | required | イベントデコーダーで検証済み。topic 系イベント（`topic.created` / `topic.updated` / `topic.trashed` / `topic.restored` / `topic.archived` / `topic.unarchived`）は TopicId を運ぶが、処理は何もしない（下表。domains/search.md「インデックス更新フロー」の表に一致） |
| occurredAt | `Date` | required | イベント発生時刻（処理判断には使わない。判断は常に読み直した最新状態に基づく） |

### 出力DTO

なし（`void`）。処理結果はインデックスの状態としてのみ現れる。

### 処理フロー

1. `idempotencyStore` で `eventId` が処理済みかを確認する。処理済みなら何もせず ack して終了する（重複配信のスキップ）
2. `eventType` に応じて下表の処理を実行する。どの分岐でも判断は「イベントペイロードの本文」ではなく「`IndexerReadPort` で読み直した最新状態」だけに基づく（古いペイロードによる巻き戻り防止。ADR-005）
3. upsert の場合: 対象を読み直し、存在してソフトデリートされていなければ `IndexEntry` を構築して `SearchIndexPort.upsertMemo` / `upsertDocument` を呼ぶ。`sourceOfDocumentIds` / `sourceMemoIds` には出典リンクの相手側の現在状態を確認して active なものの ID のみを含める（ゴミ箱内項目の ID を検索結果に露出させない）。`IndexEntry.userId` には読み直した対象自身の `userId` を採用する（インデックスのユーザー境界はこれで維持される）
4. 対象が存在しない（ハードデリート済み）またはソフトデリート済みの場合: `SearchIndexPort.removeMemo` / `removeDocument` を呼ぶ（存在しない ID でも冪等に成功する）
5. ファンアウトが必要なイベント（下表）では、出典リンクを逆引きして得た各相手 ID に対して同じ冪等処理（読み直し → upsert）を適用する。新しいイベント種別は導入しない
6. 手順 2〜5 のハンドラー処理が**すべて成功した後に** `idempotencyStore.markProcessed(eventId)` で処理済みスタンプを行い、ack する（**stamp-after-success**）。処理が途中で失敗した場合は markProcessed せずに throw し、Outbox の再配信リトライに乗る（at-least-once）。ハンドラーは冪等な upsert / remove のため、スタンプ前に成功済みだった部分処理が再配信で再実行されても結果は不変であり、手順 1 の処理済みチェックはスタンプ完了後の重複配信だけをスキップする

契機イベントと処理の対応（domains/search.md「インデックス更新フロー」に忠実):

| イベント | 処理 |
|---|---|
| `memo.created` / `memo.edited` | 最新状態を読み直して upsertMemo |
| `memo.restored` | 最新状態を読み直して upsertMemo。加えて `IndexerReadPort.listSourceLinksByMemo` の逆引きでこのメモを出典とするドキュメントを列挙し、各ドキュメントを再 upsertDocument（`sourceMemoIds` にこのメモの ID が戻る。ファンアウト） |
| `memo.trashed` | removeMemo。加えて逆引きでこのメモを出典とするドキュメントを列挙し、各ドキュメントを再 upsertDocument（`sourceMemoIds` からこのメモの ID が外れる。ファンアウト） |
| `memo.hardDeleted` | removeMemo（出典リンク側の再構築は同一 UoW で発行される `document.sourceLinksChanged` が担う） |
| `memo.sourceLinksChanged` | 対象メモを読み直して upsertMemo（`sourceOfDocumentIds` の反映） |
| `document.created` | 最新状態を読み直して upsertDocument。加えて `IndexerReadPort.listSourceLinksByDocument` の逆引きで出典メモを列挙し、各メモを upsertMemo（`sourceOfDocumentIds` の反映。ファンアウト） |
| `document.edited` | 最新状態を読み直して upsertDocument |
| `document.restored` | 最新状態を読み直して upsertDocument。加えて逆引きで出典メモを列挙し、各メモを再 upsertMemo（`sourceOfDocumentIds` にこのドキュメントの ID が戻る。ファンアウト） |
| `document.trashed` | removeDocument。加えて逆引きで出典メモを列挙し、各メモを再 upsertMemo（`sourceOfDocumentIds` からこのドキュメントの ID が外れる。ファンアウト） |
| `document.hardDeleted` | removeDocument（出典リンク側の再構築は同一 UoW で発行される `memo.sourceLinksChanged` が担う） |
| `document.sourceLinksChanged` | 対象ドキュメントを読み直して upsertDocument（`sourceMemoIds` の反映） |
| `topic.created` / `topic.updated` | 何もしない（トピック名は index に持たず、検索結果のトピック名は search ユースケースが query 時に `TopicRepository.listByIds` で解決するため。インデックス更新の契機ではない） |
| `topic.trashed` / `topic.restored` | 何もしない（配下ドキュメントのカスケードは knowledge が `document.trashed` / `document.restored` として発行するため、そちらで受ける） |
| `topic.archived` / `topic.unarchived` | 何もしない（アーカイブ済みもヒットするため。インデックス更新の契機ではない） |

上表にないイベント種別（将来追加されるものを含む）が購読チャネルに流れてきた場合は **no-op として ack する**（markProcessed して終了）。イベントペイロードの構造自体が壊れていて対象 ID を取り出せない場合のみ「デコード失敗」としてリトライ → 隔離の経路に乗せる（下表）。

### エラーケース

| 条件 | エラー / 挙動 |
|---|---|
| インデックスストアへの接続失敗・タイムアウト | `SystemError(SearchIndexUnavailable)`。retryable。markProcessed 前に throw するため Outbox のリトライ（backoff + jitter）で確実に再処理される |
| 埋め込み生成（外部 API）の失敗 | `SystemError(EmbeddingFailed)`。upsert 系のみで発生。retryable。markProcessed 前に throw するため Outbox のリトライで確実に再処理される |
| イベントペイロードのデコード失敗 | リトライ経路に乗り、`maxAttempts` 到達で隔離（quarantine）。スキーマ修正後の再キックで再配信される |
| 対象が見つからない（ハードデリート済み・逆順到達） | エラーにしない。remove（冪等）に正規化して成功させる |
| 同一イベントの重複配信 | エラーにしない。`IdempotencyStore` によるスキップ、または冪等 upsert / remove の再実行で結果不変 |
