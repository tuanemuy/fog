# テストケース: pruneExpiredTrashItems

[usecases/trash.md](../../usecases/trash.md) の pruneExpiredTrashItems に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| 期限切れ（`trashedAt + retentionDays < now`）のメモ・ドキュメント・トピックが混在する | pruner を実行する | 各項目が `expandTargets` で展開され、項目ごとの UnitOfWork で影響先確定 → OCC 再取得 → ハードデリート → （メモは）`deleteSourceLinksByMemo` → イベント発行が実行される。`processedCount` に処理数が返る | |
| 期限切れのメモがドキュメントの出典である | Alarm jobを実行する | 消去前に影響先を確定し、本体/revision/link消去、memo射影remove、active document射影upsertを同じtransactionで確定する | |
| 期限切れのセット削除トピック（`setDocumentIds` に配下 2 件）がある | pruner を実行する | 追加のポート照会なしで `setDocumentIds` から展開され、配下ドキュメントごと消去される | |
| セット削除された配下ドキュメントがトピックより先に単独で期限切れ扱いになる（時計・保持日数のずれ） | pruner を実行する | 単品ハードデリートとして消去される（規則上問題ない） | |
| `expiresAt` がちょうど `now` と一致する項目がある（境界値: `<` は厳密判定） | pruner を実行する | `trashedAt + retentionDays < now` を満たさないため対象外。消去されない | |
| `expiresAt` が `now` より 1ms 過去の項目がある（境界値） | pruner を実行する | 期限切れとして消去される | |
| 期限内の項目だけがゴミ箱にある | pruner を実行する | `listExpiredItems` が空を返し、`processedCount: 0`。期限内の項目には一切触れない（「期限内であればいつでも復元できる」の保証） | |
| ユーザーが `trashRetentionDays` を 30 → 7 に短縮し、`trashedAt` が 10 日前の既存項目がある（境界値: 遡及適用） | pruner を実行する | 新しい保持日数で判定され、既存項目も期限切れとして消去される（S-TR-05） | |
| ユーザーが `trashRetentionDays` を 30 → 60 に延長し、`trashedAt` が 40 日前の項目がある | pruner を実行する | 期限内と判定され、消去されない | |
| 保持日数の異なる複数ユーザーに期限切れ項目がある | pruner を実行する | `listExpiredItems` がユーザー横断で各ユーザーの `TrashRetentionDays` を適用して抽出し、各項目は `ExpiredTrashItem.userId` スコープで消去される。他ユーザーのデータに影響しない | |
| 期限切れ項目が `batchSize` を超えて存在する（例: batchSize 10 に対し 25 件） | pruner を実行する | 1 実行では `batchSize` 件までで打ち切り、残りは次回実行に委ねる | |
| 前回実行で全件消去済み | pruner を再実行する | 消去済み項目は `listExpiredItems` に現れず、`processedCount: 0`。二重実行しても安全（冪等） | |
| 一部項目が emptyTrash / hardDeleteTrashItem と並行して既に消去済み（再取得で行不在） | pruner を実行する | 当該対象は no-op として続行する | |
| 一部項目で OCC 競合（並行する復元等）が発生する | pruner を実行する | 当該項目のみ記録（logger）して先送りし、次の項目へ進む。全体は中断せず `failedCount` に計上される | |
| 項目ごとの UnitOfWork で実行中、途中の項目が失敗する | pruner を実行する | 失敗項目のみロールバックされ、他の項目の消去は確定している | |
| `listExpiredItems` 自体が DB 例外で失敗する | pruner を実行する | `SystemError(DatabaseError)`。当該実行を終了し次回に委ねる | |
| — | `batchSize: 0` または非整数で起動する | バリデーションエラー（1 以上の整数） | |
