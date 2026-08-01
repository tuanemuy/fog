# ユースケース: search

メモ・ドキュメント横断の全文検索のユースケース。上流: [domains/search.md](../domains/search.md)、[.adr/003](../../.adr/003-sqlite-fts5-only-search.md)、[.adr/004](../../.adr/004-do-local-commit-and-alarm-jobs.md)（`spec/adr/005` は superseded）、シナリオ S-SE-01〜03 / S-AI-02。

ビジネスロジック（キーワード検証・検索の規則）はすべて search ドメインの値オブジェクトと `SearchIndexPort` の契約に置く。ユースケースは値オブジェクトの構築とポート呼び出しのオーケストレーションのみを行う。

## search（検索する）

### 概要

キーワード（と任意のトピック絞り込み）でユーザーのメモ・ドキュメントを横断する全文検索を実行する。人間 UI（検索画面）と AI クライアント（search API / MCP ツール）で共通の単一ユースケース。挙動（ヒット範囲・除外規則）は両者で完全に一致する（S-SE-03）。

索引の構成・トークナイズ・順位付けは `SearchIndexPort` のアダプターに隠蔽されており、ユースケース・利用者は関与しない。**単一の全文検索であり、方式を選ばせる入口を持たない**（要件 4.4）。

### 入力DTO

`SearchInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | `UserId.create` で検証（認証済みユーザー / トークンの所有ユーザーを渡す）。**対象 Durable Object の選択に使い、`SearchQuery` には渡さない** |
| keyword | `string` | required | `SearchQuery.create` に委譲: trim 後に非空、最大 500 文字 |
| topicId | `string` | optional | 指定時は `TopicId.create` で検証。スコープ絞り込みに用いる |
| cursor | `string` | optional | 続きを読むときに前のページが返した値をそのまま渡す。**未指定が先頭ページである**。不正・期限切れは `SearchQuery.create` が拒否する |
| limit | `number` | required | 1〜100 の整数（listTrash と同形式） |

入力DTOはプリミティブのみで構成する（DTO 規約）。**ページ番号を受け取る入口は持たない** — ページ間の変更で重複・欠落が出ないよう、続きの取得は不透明カーソルに一本化する（domains/search.md「検索の規則」）。

### 出力DTO

`SearchOutput` = `PaginationResult<SearchResultItemDto>` + カーソル1つ

| フィールド | 型 |
|---|---|
| items | `SearchResultItemDto[]` |
| count | `number`（総件数。`PaginationResult` の共通形に従う。カーソル方式でも固定した集合の件数として意味を保つ） |
| nextCursor | `string | undefined`（続きがなければ undefined。**不透明であり、利用者は中身を解釈せず次の要求へそのまま渡す**） |

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

1. `input.userId` から対象のユーザー単位 Durable Object を選ぶ（`UserId.create` で検証する。以降の処理はその中で走るので、`userId` を引数として持ち回らない）。指定があれば `TopicId.create(input.topicId)` で ID 値オブジェクトを構築する
2. `SearchQuery.create({ keyword, topicId, limit, cursor })` で検索クエリ値オブジェクトを構築する。keyword の trim・非空・最大長、`limit` の範囲、`cursor` の妥当性の検証はここ（ドメイン）で行われる
3. `SearchIndexPort.query(searchQuery)` を呼ぶ。ユーザー境界・ゴミ箱除外・アーカイブ込み・トピック絞り込み・安定順位・カーソルの契約はポートの契約（domains/search.md「検索の規則」）が担う
4. **所属トピック名の解決（結果整形）**: 結果内の `type: "document"` 項目の `topicId` を重複除去し、`TopicRepository.listByIds(topicIds)` で一括解決して（N+1 にしない）、各項目の出力DTOに `topicName` を含める（P-11 / S-SE-01 の「所属トピック」表示用）。AI 向け presentation の出力は従来どおり `topicId` のみで `topicName` は露出しない。名前解決は表示補助（ID → 名前の参照解決）であり、検索結果の要約・言い換え・再構成には当たらない — 「事実データのみ」の原則と矛盾しない
5. 結果を `SearchResultItemDto` へ射影し、ポートが返した `nextCursor` をそのまま添えて返す。上記トピック名の付与以外に、フィールドの追加・削除・加工は行わない

補足:

- 一致する結果がない場合は空の `PaginationResult` を返す（エラーではない。S-SE-01 エッジケース）
- **インデックスは本体更新と同一トランザクションで維持されるため、投稿・編集した項目は直後の検索から必ずヒットする。** 反映待ちは存在しない

### エラーケース

| 条件 | エラー |
|---|---|
| keyword が trim 後に空 | `BusinessRuleError(SearchErrorCode.EmptyKeyword)` |
| keyword が 500 文字を超える | `BusinessRuleError(SearchErrorCode.KeywordTooLong)` |
| userId / topicId が形式不正 | バリデーションエラー（各値オブジェクトの構築エラー） |
| `limit` が範囲外 | バリデーションエラー（`SearchQuery.create` の構築エラー） |
| `cursor` が不正、または有効期限を過ぎている | `BusinessRuleError(SearchErrorCode.InvalidCursor)`（利用者は先頭から検索し直す） |
| `topicId` が未知、またはゴミ箱内のトピックを指している | `NotFoundError(TOPIC_NOT_FOUND)` |
| インデックスストアへの接続失敗・タイムアウト | `SystemError(SearchIndexUnavailable)`（retryable。利用者にエラーが返る） |
