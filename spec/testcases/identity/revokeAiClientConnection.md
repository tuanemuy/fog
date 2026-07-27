# テストケース: revokeAiClientConnection

[usecases/identity.md](../../usecases/identity.md) の revokeAiClientConnection に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ユーザーが active な接続を保有 | その `connectionId` で失効を実行する | `RevokedAiClientConnection`（`status: "revoked"`, `revokedAt: now`）に遷移し `version` が +1 される。`identity.aiClientRevoked` イベントが記録される。正常終了（`void`） | |
| 失効実行後 | 外部token削除jobを確認する | connection stateとprovider idempotency key付きAlarm jobが同じtransactionで保存され、job完了後はAPIが認可エラーになる | |
| 該当 `connectionId` の接続が存在しない | 失効を実行する | `NotFoundError("CONNECTION_NOT_FOUND")` | |
| 接続はユーザー B の所有（エッジケース: 他ユーザーの接続 ID を指定） | ユーザー A の `userId` でその `connectionId` の失効を実行する | `findById(userId, connectionId)` が null を返し `NotFoundError("CONNECTION_NOT_FOUND")`（不在と区別せず、存在の有無も漏らさない）。ユーザー B の接続は変化しない | |
| — | `connectionId` に空文字・空白のみを指定して失効を実行する | `BusinessRuleError`（`AiClientConnectionId` 生成時バリデーション） | |
| 接続が既に `status: "revoked"`（エッジケース: 再失効の冪等性） | 同じ `connectionId` で再度失効を実行する | 何も変更せず正常終了する（冪等）。`version` は進まず、`revokedAt` も変わらず、`identity.aiClientRevoked` イベントは再発行されない | |
| active な接続に対し、一覧画面の二重表示等から同時に2つの失効リクエストが実行される（OCC 競合） | 両方の失効を実行する | 先勝ちの1件が成功し、後発は `ConflictError("OPTIMISTIC_LOCK_FAILURE")`（リトライすれば revoked 済みとして冪等に正常終了する） | |
| 失効済みの接続を保有 | 同一クライアントを再利用したい | 失効は不可逆であり再有効化はできない。新しい認可フロー（approveAiClientAuthorization）で新しい接続を作る必要がある | |
| `AiClientConnectionRepository.save` で DB 例外が発生する | 失効を実行する | `SystemError`。トランザクションはロールバックされ、接続は active のまま、イベントも記録されない | |
