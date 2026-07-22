# テストケース: search

[usecases/search.md](../../usecases/search.md) の search に対するテストケース。検索の規則は [domains/search.md](../../domains/search.md)「検索の規則」に基づく。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ユーザーのメモ・ドキュメントがインデックス済みで、キーワードに一致するメモ1件・ドキュメント1件がある | `keyword` のみ指定（`topicId` なし）、`page: 1`, `limit: 20` で検索する | `PaginationResult<SearchResultItemDto>` が返る。メモ項目は `type: "memo"` / `id` / `snippet` / `timestamp` / `sourceOfDocumentIds`、ドキュメント項目は `type: "document"` / `id` / `snippet` / `timestamp` / `topicId` / `topicName` / `sourceMemoIds` を持つ。`count` は総件数 | |
| 一致するドキュメントが複数トピックにまたがってヒットする | 検索する | 各ドキュメント項目に所属トピックの `topicName` が付与される。トピック名の解決は `topicId` を重複除去したうえで `TopicRepository.listByIds` の一括呼び出し1回で行われる（N+1 にしない） | |
| キーワードに一致するメモがあり、そのメモを出典とする active なドキュメントが2件ある | 検索する | メモ項目の `sourceOfDocumentIds` に active なドキュメント2件の ID が含まれる | |
| キーワードに一致するドキュメントがあり、出典メモが active で存在する | 検索する | ドキュメント項目の `sourceMemoIds` に active な出典メモの ID が含まれる | |
| 出典リンクを持たないメモ・ドキュメントがヒットする | 検索する | `sourceOfDocumentIds` / `sourceMemoIds` は空配列（null や欠落ではない） | |
| 同一項目がキーワード検索・ベクトル検索の双方にヒットする | 検索する | 結果は統合済みの単一リストで、同一 `type` + `id` の項目は1件に統合される（重複しない） | |
| 長い本文のメモ・ドキュメントがヒットする | 検索する | `snippet` は原文の抜粋（非空）であり、全文は返さない。要約・言い換え・再構成は行われない | |
| トピック T の配下にヒットするドキュメントとその出典メモがあり、トピック T 外にも同キーワードに一致するメモ・ドキュメントがある | `topicId: T` を指定して検索する | 結果はトピック T 配下のドキュメントと、その出典になっているメモのみに絞られる。T 外の一致項目は含まれない（S-SE-02） | |
| トピック T の配下にキーワードへの一致項目がない | `topicId: T` を指定して検索する | 空の `PaginationResult`（`items: []`）が返る。エラーにならない | |
| アーカイブ済みトピック配下にキーワードに一致するドキュメントとその出典メモがある | 検索する | アーカイブ済みトピック配下のドキュメントとその出典メモがヒットする（要件 4.2 / 4.4。アーカイブは検索から除外されない） | |
| キーワードに一致するメモ・ドキュメントがゴミ箱内（ソフトデリート済み）にある | 検索する | ゴミ箱内の項目はヒットしない（インデックスから remove 済み） | |
| ヒットするメモを出典とするドキュメントのうち1件がゴミ箱内にある | 検索する | メモ項目の `sourceOfDocumentIds` にゴミ箱内ドキュメントの ID は含まれない（active な相手のみ。ゴミ箱内項目の ID・存在の事実を露出させない） | |
| ヒットするドキュメントの出典メモのうち1件がゴミ箱内にある | 検索する | ドキュメント項目の `sourceMemoIds` にゴミ箱内メモの ID は含まれない | |
| 別ユーザー B のデータにのみキーワードに一致する項目がある | ユーザー A として検索する | ユーザー A の結果は空。検索範囲は常に `userId` のユーザーのデータに閉じる（要件 5.1） | |
| どの項目にも一致しないキーワード | 検索する | 空の `PaginationResult` が返る（`items: []`, `count: 0`）。エラーではない（S-SE-01 エッジケース） | |
| キーワードの前後に空白がある（`"  fog  "` 等） | 検索する | trim されたキーワードで検索が実行され、正常終了する | |
| — | trim 後ちょうど 500 文字のキーワードで検索する | 正常に検索される（境界値: 最大長ちょうどは許容） | |
| 一致項目が 5 件ある | `page: 1`, `limit: 2` → `page: 2`, `limit: 2` と続けて検索する | 各ページ 2 件ずつ関連度順で返り、`count` は常に 5。ページ間で項目は重複しない | |
| 一致項目が 3 件ある | `page: 1`, `limit: 1`（limit 最小値）で検索する | 1 件のみ返り、`count: 3`（境界値: limit 下限） | |
| — | `limit: 100`（上限ちょうど）で検索する | 正常に検索される（境界値: limit 上限は許容） | |
| 一致項目が 2 件ある | `page: 5`, `limit: 20`（総件数を超えるページ）で検索する | `items: []` の空ページが返り、`count: 2`。エラーにならない | |
| メモを書き込んだ直後で、インデックス更新（非同期 consumer）が未完了 | 直後に該当キーワードで検索する | 書き込み直後の項目はヒットしない場合がある（ADR-005。エラーではなく、その時点のインデックス内容で結果が返る） | |
| — | `keyword: ""`（空文字）で検索する | `BusinessRuleError(SearchErrorCode.EmptyKeyword)`。検索は実行されない | |
| — | `keyword: "   "`（空白のみ。trim 後に空）で検索する | `BusinessRuleError(SearchErrorCode.EmptyKeyword)` | |
| — | trim 後 501 文字のキーワードで検索する | `BusinessRuleError(SearchErrorCode.KeywordTooLong)` | |
| — | `userId` が形式不正（`UserId.create` が失敗する値）で検索する | バリデーションエラー（値オブジェクト構築エラー）。`SearchIndexPort.query` は呼ばれない | |
| — | `topicId` が形式不正（`TopicId.create` が失敗する値）で検索する | バリデーションエラー。`SearchIndexPort.query` は呼ばれない | |
| — | `page: 0` で検索する | バリデーションエラー（`Pagination` 構築エラー。page は 1 以上） | |
| — | `page: 1.5`（非整数）で検索する | バリデーションエラー（`Pagination` 構築エラー） | |
| — | `limit: 0` で検索する | バリデーションエラー（`Pagination` 構築エラー。limit は 1 以上） | |
| — | `limit: 101` で検索する | バリデーションエラー（`Pagination` 構築エラー。limit は 100 以下） | |
| インデックスストアが接続失敗またはタイムアウトする | 有効な入力で検索する | `SystemError(SearchIndexUnavailable)`（retryable）が利用者に返る | |
