# テストケース: pruneExpiredTrashItems

[usecases/trash.md](../../usecases/trash.md) の pruneExpiredTrashItems に対するテストケース。自分のユーザー単位 Durable Object の `purge-trash` ジョブから起動される。定期実行ワーカーもユーザー横断の抽出も存在しない。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| 期限切れ（`purgeAfter < now`）のメモ・ドキュメント・トピックが混在する | `purge-trash` ジョブが起床する | 各項目が `expandTargets` で展開され、項目ごとの UnitOfWork で影響先確定 → OCC 再取得 → ハードデリート → （メモは）`deleteSourceLinksByMemo` → projection 更新が実行される。`processedCount` に処理数が返る | |
| 期限切れのメモがドキュメントの出典である | `purge-trash` ジョブが起床する | 消去前に `listSourceLinksByMemo` で影響先が確定され、同一 UoW でリンクが消去される（ADR-003）。同じ `transactionSync` の中で当該メモのエントリが projection から除去され、影響先ドキュメントのエントリが作り直される（`sourceMemoIds` から ID が外れる） | |
| 期限切れのセット削除トピック（`setDocumentIds` に配下 2 件）がある | `purge-trash` ジョブが起床する | 追加のポート照会なしで `setDocumentIds` から展開され、配下ドキュメントごと消去される | |
| セット削除された配下ドキュメントがトピックより先に単独で期限切れ扱いになる（時計・保持日数のずれ） | `purge-trash` ジョブが起床する | 単品ハードデリートとして消去される（規則上問題ない） | |
| `purgeAfter` がちょうど `now` と一致する項目がある（境界値: `<` は厳密判定） | `purge-trash` ジョブが起床する | `purgeAfter < now` を満たさないため対象外。消去されない | |
| `purgeAfter` が `now` より 1ms 過去の項目がある（境界値） | `purge-trash` ジョブが起床する | 期限切れとして消去される | |
| 期限内の項目だけがゴミ箱にある | `purge-trash` ジョブが起床する | 自 DO の `purge_after` 索引が対象を返さず、`processedCount: 0`。期限内の項目には一切触れない（「期限内であればいつでも復元できる」の保証） | |
| ユーザーが `trashRetentionDays` を 30 → 7 に短縮し、`trashedAt` が 10 日前の既存項目がある（境界値: 遡及適用） | 変更と同一トランザクションで `purge_after` が再計算されたあと、`purge-trash` ジョブが起床する | 再計算後の `purgeAfter` で判定され、既存項目も期限切れとして消去される（S-TR-05） | |
| ユーザーが `trashRetentionDays` を 30 → 60 に延長し、`trashedAt` が 40 日前の項目がある | 同上 | 再計算フェーズが先に完走してから期限判定が行われ、期限内と判定されて消去されない（延長方向の変更で誤削除が起きない） | |
| 期限切れ項目が `chunkLimit` を超えて存在する（例: `chunkLimit` 10 に対し 25 件） | `purge-trash` ジョブが起床する | 1 回の起床では `chunkLimit` 件までで打ち切り、`hasMore: true` を返して残りを次回の起床に委ねる | |
| 前回の起床で全件消去済み | `purge-trash` ジョブが再び起床する | 消去済み項目は `purge_after` 索引の駆動源クエリに現れず、`processedCount: 0`。二重に起きても安全（冪等） | |
| 一部項目が emptyTrash / hardDeleteTrashItem と並行して既に消去済み（再取得で行不在） | `purge-trash` ジョブが起床する | 当該対象は no-op として続行する | |
| 一部項目で OCC 競合（並行する復元等）が発生する | `purge-trash` ジョブが起床する | 当該項目のみ記録（logger）して先送りし、次の項目へ進む。全体は中断せず `failedCount` に計上される | |
| 項目ごとの UnitOfWork で実行中、途中の項目が失敗する | `purge-trash` ジョブが起床する | 失敗項目のみロールバックされ、他の項目の消去は確定している | |
| 期限切れ項目の列挙自体が DB 例外で失敗する | `purge-trash` ジョブが起床する | `SystemError(DatabaseError)`。当該実行を終了し次回の起床に委ねる | |
| — | `chunkLimit: 0` または非整数で起動する | バリデーションエラー（1 以上の整数） | |
