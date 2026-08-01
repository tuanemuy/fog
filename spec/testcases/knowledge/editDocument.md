# テストケース: editDocument

[usecases/knowledge.md](../../usecases/knowledge.md) の editDocument に対するテストケース（人間 UI ★。AI の編集経路は editDocumentByAi のみ）。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active ドキュメント（`version: 3`, `latestRevision: 2`）が存在する | `expectedVersion: 3` で `title` / `body` を変更し `changeReason: "構成を見直し"` で保存する | `result: "saved"`。`latestRevision: 3` の新リビジョン（全文スナップショット・人間 actor・指定の変更理由）が積まれ、`version: 4`。同じ `transactionSync` の中で当該ドキュメントのエントリが `search_entries` / `search_fts` に作り直される | |
| active ドキュメントが存在する | `changeReason` を省略して保存する | 「手動編集」が補完され、新リビジョンの `changeReason` は「手動編集」になる（エッジケース: 既定値補完。AI に配線しない理由となる経路） | |
| active ドキュメントが存在する | `changeReason` に空白のみ（trim 後空）を渡して保存する | 「手動編集」が補完され `result: "saved"` | |
| active ドキュメントが存在する | 現在値と同一の `title` / `body` で保存する | `result: "unchanged"`。リビジョンは積まれず、`save` もインデックスエントリの作り直しも行われない（不変条件 5） | |
| active ドキュメントが存在する | `title` のみ変更（`body` は同一）で保存する | 差分ありとして `result: "saved"`、新リビジョンが積まれる | |
| active ドキュメント（`version: 5`）。編集開始後に AI クライアントが介在編集し現在 `version: 6`（エッジケース: 編集競合） | `expectedVersion: 5` で保存する | **エラーではなく正常応答** `result: "conflict"`。何も書き込まれず、`conflict.currentTitle` / `currentBody`（他者編集後の現在値）、`conflict.currentVersion: 6`、`conflict.latestRevision`（AI クライアント名・変更理由・日時を含むメタデータ）が返る（S-DT-05 異常系。警告表示用） | |
| 上記 conflict 応答を受けて警告表示し、ユーザーが「そのまま保存」を確認した | `expectedVersion = conflict.currentVersion` で同じ内容を再度保存する | `result: "saved"`。自分の内容が最新に対する新リビジョンとして積まれ、介在した AI の編集もリビジョン履歴に残る（失われない） | |
| active ドキュメントが存在する | `title` を空文字で保存する | `BusinessRuleError(EmptyDocumentTitle)`（空タイトル保存不可）。リビジョンは積まれない | |
| active ドキュメントが存在する | `title` を改行入り / 201 文字で保存する | `BusinessRuleError`（`DocumentTitleMultiline` / `DocumentTitleTooLong`） | |
| active ドキュメントが存在する | `title` をちょうど 200 文字で保存する | 正常に保存される（境界値） | |
| 本文非空の active ドキュメントが存在する | `body: ""`（空文字）で保存する | 正常に保存される（空本文は正当な状態。境界値） | |
| active ドキュメントが存在する | `body` をちょうど 1,000,000 文字 / 1,000,001 文字で保存する | 前者は正常、後者は `BusinessRuleError(DocumentBodyTooLong)`（境界値） | |
| active ドキュメントが存在する | `changeReason` を改行入り / 201 文字で指定して保存する | `BusinessRuleError`（`ChangeReasonMultiline` / `ChangeReasonTooLong`） | |
| ドキュメントが存在しない ID | 保存する | `NotFoundError` | |
| ドキュメントがゴミ箱内 | 保存する | `findById` が active のみ返すため `NotFoundError`（不変条件 6） | |
| 他ユーザー所有のドキュメント ID | 保存する | userId スコープにより `NotFoundError` | |
| — | `documentId` に空文字を渡す | `BusinessRuleError(InvalidDocumentId)` | |
| 手順 3 の version 判定は通過したが、`save` までの間に別の編集がコミットされた（レア） | 保存を実行する | `save` の 0 行更新または `insertRevision` の `(documentId, revisionNumber)` 一意制約違反により `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。UI は再取得して再試行 | |
| active ドキュメントが存在する | `insertRevision` で DB 例外が発生する | `SystemError(DatabaseError)`。UoW 全体がロールバックされる | |
