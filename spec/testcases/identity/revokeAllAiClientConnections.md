# テストケース: revokeAllAiClientConnections

[usecases/identity.md](../../usecases/identity.md) の revokeAllAiClientConnections に対するテストケース。リセット完了画面（P-03）の必須導線であり、部分失敗を持つので `emptyTrash` と同じ構成で検証する。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active な接続を3件保有 | すべて失効させる | 3件すべてが `status: "revoked"` になり `revokedAt` が入る。`revokedCount: 3` / `failedCount: 0` が返る | |
| リセット完了直後で、自動失効の対象外だった古い接続（`createdAtResetVersion` が前進前の値より小さい）と、対象だった接続が混在する | リセット完了画面から「すべて失効」を実行する | 自動失効が切らなかった古い接続も含め、active な接続がすべて `revoked` になる（自動失効の射程は `createdAtResetVersion` で決まるが、この操作は射程に依らず active な全件を対象にする） | |
| active 2件と revoked 1件を保有 | すべて失効させる | active 2件だけが失効する。既に `revoked` の接続は no-op として扱い数に含めない（`revokedCount: 2`。冪等） | |
| 接続を1件も持たない | すべて失効させる | `revokedCount: 0` / `failedCount: 0` が返る。エラーではない | |
| active 3件のうち1件が、`save` の直前に別セッションからの個別失効で version が進んでいる | すべて失効させる | 当該1件は `ConflictError` を記録（logger）して次へ進み、残り2件は失効する。全体は中断せず `revokedCount: 2` / `failedCount: 1` が返る | |
| 前回の実行で `failedCount: 1` が返っている | もう一度すべて失効させる | 既に失効した接続は対象に現れず、残件だけが消化される（再実行で収束する） | |
| `AiClientConnectionRepository.listByUserId` で DB 例外が発生する | すべて失効させる | `SystemError`。一覧が取れないので1件も失効しない | |
| — | `userId` に空文字・空白のみを指定して実行する | `BusinessRuleError`（`UserId.create` 生成時バリデーション）。接続は失効しない | |
