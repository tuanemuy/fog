# テストケース: getTopic

[usecases/knowledge.md](../../usecases/knowledge.md) の getTopic に対するテストケース（人間 UI ★。AI には配線しない）。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `active` トピックの配下に active ドキュメント 2 件があり、各ドキュメントに出典メモが紐付く | トピック詳細を取得する | `topic`（`id` / `name` / `description` / `status` / `version` / 日時）、`documents` 2 件、`relatedMemos`（配下ドキュメントの出典リンク集約）が返る | |
| `archived` トピックが存在する | トピック詳細を取得する | `status: "archived"` として正常に返る（Live のため取得可） | |
| 配下ドキュメント 0 件のトピックが存在する | トピック詳細を取得する | `documents: []`、`relatedMemos: []`（空配列。エラーにしない） | |
| 配下ドキュメントはあるが出典リンクが 0 件 | トピック詳細を取得する | `relatedMemos: []` | |
| 複数の配下ドキュメントが同一メモを出典に持つ | トピック詳細を取得する | `relatedMemos` では `memoId` が重複除去され、同一メモは 1 件だけ現れる | |
| 出典メモの一部がソフトデリート済み | トピック詳細を取得する | 当該メモは `deleted: true` の `RelatedMemoView` として返る（「削除済みのメモ」表示・遷移不可の判定用） | |
| 出典メモの一部がハードデリート済み（リンクは消去済み） | トピック詳細を取得する | 当該メモは `relatedMemos` に一切現れない（ADR-003。痕跡を残さない） | |
| 配下ドキュメントが複数件（例: 10 件）あり各々に出典リンクがある | トピック詳細を取得する | 出典リンクは `listSourceLinksByDocuments`、メモ本文は `listByIdsIncludingTrashed` の各 1 クエリで一括取得される（N+1 にならない） | |
| トピック配下にゴミ箱内ドキュメントが存在する | トピック詳細を取得する | `documents` には active のみ含まれる（`listActiveByTopic`） | |
| トピックが存在しない ID | トピック詳細を取得する | `NotFoundError` | |
| トピックがゴミ箱内（`trashed`） | トピック詳細を取得する | `NotFoundError`（ゴミ箱内トピックの詳細は trash ドメインの責務） | |
| 他ユーザー所有のトピック ID | トピック詳細を取得する | userId スコープにより `NotFoundError` | |
| — | `topicId` に空文字を渡す | `BusinessRuleError(InvalidTopicId)` | |
| トピックが存在する | `MemoRepository.listByIdsIncludingTrashed` で DB 例外が発生する | `SystemError(DatabaseError)` | |
