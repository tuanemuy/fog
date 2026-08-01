# テストケース: listTrash

[usecases/trash.md](../../usecases/trash.md) の listTrash に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ゴミ箱にメモ・ドキュメント・トピックが混在する（計 5 件、`trashedAt` がそれぞれ異なる） | `page: 1, limit: 20` で一覧を取得する | 3 種別が横断された `TrashItemView[]` が削除日時の降順で返る。`totalCount: 5`。各項目に `trashedAt` と `expiresAt` が付与される | |
| ゴミ箱にメモが 1 件ある | 一覧を取得する | `kind: "memo"` の項目に `excerpt`（本文の先頭抜粋）が含まれる。`title` / `topicId` / `name` 等の他種別フィールドは含まれない | |
| 個別削除されたドキュメント（`trashedWith: null`）がゴミ箱にある | 一覧を取得する | `kind: "document"` の項目に `title`・削除時点の `topicId` が含まれ、`deletedWithTopic: false` | |
| トピックがセット削除され、トピックと配下ドキュメント 2 件がゴミ箱にある | 一覧を取得する | topic 項目に `name` と `setDocumentIds`（配下 2 件の ID）が含まれる。配下の document 項目は `deletedWithTopic: true` で、セット関係が識別できる | |
| セット削除された配下ドキュメントとは別に、同一トピックから個別削除済み（セット削除より前にゴミ箱入り）のドキュメントもある | 一覧を取得する | topic 項目の `setDocumentIds` にはセット削除分のみ含まれ、個別削除分の document 項目は `deletedWithTopic: false` で独立に並ぶ | |
| ゴミ箱に 25 件ある | `page: 2, limit: 10` で取得する | 11〜20 件目（削除日時降順）が返る。`totalCount: 25`、`page: 2`、`limit: 10` | |
| ゴミ箱に 25 件ある | `page: 4, limit: 10`（範囲を超えたページ）で取得する | `items` は空配列。`totalCount: 25`。エラーにならない | |
| ゴミ箱が空 | 一覧を取得する | `items: []`、`totalCount: 0`。エラーにならない（空状態の表示は UI の責務） | |
| ユーザーの `trashRetentionDays` が 30（既定） | `trashedAt` が既知の項目を含む一覧を取得する | 各項目の `expiresAt` にはソフトデリート時に保存された `purgeAfter`（= `trashedAt + 30日`。`RetentionPolicy.expiresAt` で算出したもの）がそのまま載る | |
| 項目がゴミ箱にある状態でユーザーが `trashRetentionDays` を 30 → 7 に短縮済み（境界値: 遡及適用） | 一覧を取得する | 既存項目の `expiresAt` も `trashedAt + 7日` になる。**根拠は照会時の再算出ではなく、変更と同一トランザクションでゴミ箱内全項目の `purge_after` が再計算され `purge-trash` の起床が張り直されたことである**（利用者から見た遡及適用の結果は変わらない） | |
| 項目がゴミ箱にある状態でユーザーが `trashRetentionDays` を 30 → 60 に延長済み | 一覧を取得する | 既存項目の `expiresAt` も `trashedAt + 60日` になる（同じく `purge_after` の一括再計算による） | |
| `trashRetentionDays: 1`（最小値）の項目がゴミ箱にある | 一覧を取得する | `expiresAt = trashedAt + 1日` となり、`expiresAt > trashedAt` を満たす | |
| 他ユーザーのゴミ箱に項目がある | 自ユーザーで一覧を取得する | 他ユーザーの項目は一切含まれない。保証は列条件ではなく到達可能性による — 自分の Durable Object の中に他ユーザーの行が原理的に存在しない | |
| — | `page: 0` で取得する | バリデーションエラー | |
| — | `page: 1.5`（非整数）で取得する | バリデーションエラー | |
| — | `limit: 0` で取得する | バリデーションエラー | |
| — | `limit: 101`（上限超過）で取得する | バリデーションエラー | |
| — | `limit: 1` / `limit: 100`（境界値）で取得する | 正常に処理される | |
| `userId` に対応する Durable Object が未初期化（ユーザー単位設定の行が無い） | 一覧を取得する | エラーにならず `items: []`、`totalCount: 0` が返る。**実在確認は行わない** — 保持日数を読まなくなったのでフローは Durable Object の選択と `TrashQueryPort` だけになり、未初期化の DO は空のゴミ箱として振る舞う | |
| `TrashQueryPort.listTrashItems` で DB 例外が発生する | 一覧を取得する | `SystemError(DatabaseError)` | |
