# テストケース: restoreTopic

[usecases/trash.md](../../usecases/trash.md) の restoreTopic に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| セット削除されたトピック（配下ドキュメント 2 件が `trashedWith: topicId`）がゴミ箱にある | 復元を実行する | トピックと配下 2 件が同一 UoW でセット復元される。`topicId` と `restoredDocumentIds`（2 件）が返る。配下 2 件のエントリは同じトランザクションで projection に作り直される | |
| `wasArchived: false` のトピックがゴミ箱にある | 復元を実行する | トピックは active 状態に戻る | |
| `wasArchived: true` のトピックがゴミ箱にある | 復元を実行する | トピックは archived 状態に戻る | |
| 配下ドキュメントを持たないトピック（セット削除対象 0 件）がゴミ箱にある | 復元を実行する | トピックのみ復元され `restoredDocumentIds: []`。トピックはエントリを持たないので projection の更新は発生しない | |
| セット削除分（`trashedWith: topicId`）と個別削除分（`trashedWith: null`）が同一トピック配下でゴミ箱に混在する | 復元を実行する | セット削除分のみ復元され、個別削除分は `skippedDocuments` としてゴミ箱に残る。`restoredDocumentIds` にはセット削除分のみ含まれる | |
| 保持期限間近（`expiresAt` 直前）のトピック（境界値: 期限内はいつでも復元可能） | 復元を実行する | 期限内であれば通常どおりセット復元される | |
| — | `topicId` に空文字（形式不正）を渡す | バリデーションエラー | |
| 指定 ID のトピックが存在しない | 復元を実行する | `NotFoundError` | |
| 指定 ID のトピックが `status: "active"` / archived（ゴミ箱にない） | 復元を実行する | `NotFoundError` | |
| 指定 ID のトピックが他ユーザー所有でゴミ箱にある | 復元を実行する | `NotFoundError` | |
| `DocumentRepository.listTrashedByTopic` の結果に topicId 不一致のドキュメントが混入（防衛的） | 復元を実行する | `BusinessRuleError(TrashedWithMismatch)` | |
| 取得後 save までの間に並行操作（ハードデリート・`purge-trash` ジョブ・別の復元）がトピックまたは配下ドキュメントの version を進める | 復元を実行する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。UoW 全体がロールバックされ、部分復元は発生しない | |
| リポジトリで DB 例外が発生する | 復元を実行する | `SystemError(DatabaseError)`。トランザクションはロールバックされる | |
| セット削除されたトピックと配下ドキュメントが `purgeAfter` を保持している | 復元を実行する | トピック・配下ドキュメントとも `purgeAfter` が落ちる。落とし忘れると `purge-trash` の起床が止まらなくなる（trash.md「保持期限」） | |
