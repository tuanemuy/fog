# テストケース: rollbackDocument

[usecases/knowledge.md](../../usecases/knowledge.md) の rollbackDocument に対するテストケース（人間 UI ★）。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| リビジョン 1〜3 を持つ active ドキュメント（`latestRevision: 3`。#1 と #3 は内容が異なる） | `revisionNumber: 1`, `changeReason: "AI の編集を取り消す"` でロールバックする | リビジョン #1 と同内容（タイトル・本文）の**新リビジョン #4** が積まれ `changed: true`, `latestRevision: 4`。既存リビジョン #1〜#3 は削除されない（履歴は線形のまま）。`document.edited` イベントが記録される | |
| リビジョン 1〜3 を持つ active ドキュメント | `changeReason` を省略して `revisionNumber: 2` へロールバックする | 「リビジョン2の内容に戻す」が補完され、新リビジョンの `changeReason` になる | |
| リビジョン 1〜3 を持つ active ドキュメント | `changeReason` に空白のみ（trim 後空）を渡す | 既定値が補完され正常にロールバックされる | |
| 現在の内容がリビジョン #2 と同一の active ドキュメント | `revisionNumber: 2` へロールバックする | `changed: false`。リビジョンは積まれずイベントも発行されない（不変条件 5） | |
| `latestRevision: 3` の active ドキュメント | `revisionNumber: 3`（最新自身）へロールバックする | 現在の内容と同一のため `changed: false`（エッジケース: 最新への戻し） | |
| リビジョン 1 のみの active ドキュメント | `revisionNumber: 1` へロールバックする | 現在の内容と同一のため `changed: false`（境界値: 最初のリビジョン） | |
| AI クライアントの編集でリビジョン #2 が積まれた active ドキュメント | 人間ユーザーが `revisionNumber: 1` へロールバックする | 新リビジョンの `actor` は人間ユーザーとして記録される（「AI が何をしても人間が復元できる」S-DT-06） | |
| `latestRevision: 3` の active ドキュメント | `revisionNumber: 4`（存在しない）へロールバックする | `findRevision` が `null` を返し `NotFoundError` | |
| active ドキュメントが存在する | `revisionNumber: 0` を指定する | `BusinessRuleError(InvalidRevisionNumber)`（境界値: 1 未満） | |
| active ドキュメントが存在する | `revisionNumber: 1.5`（非整数）/ 負数を指定する | `BusinessRuleError(InvalidRevisionNumber)` | |
| active ドキュメントが存在する | `changeReason` を改行入り / 201 文字で指定する | `BusinessRuleError`（`ChangeReasonMultiline` / `ChangeReasonTooLong`） | |
| ドキュメントが存在しない ID | ロールバックする | `NotFoundError` | |
| ドキュメントがゴミ箱内 | ロールバックする | `findById` が active のみ返すため `NotFoundError` | |
| 他ユーザー所有のドキュメント ID | ロールバックする | userId スコープにより `NotFoundError` | |
| （防衛線）`Document.rollback` に別ドキュメントのリビジョンが渡った | ロールバックを実行する | `BusinessRuleError(RevisionDocumentMismatch)`（通常は手順 3 の検索キーにより到達しない） | |
| `findById` 後、並行編集が先にコミットした | ロールバックを実行する | `save` の 0 行更新または `insertRevision` の一意制約違反により `ConflictError` | |
| active ドキュメントが存在する | `insertRevision` で DB 例外が発生する | `SystemError(DatabaseError)`。UoW 全体がロールバックされる | |
