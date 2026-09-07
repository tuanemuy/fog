# テストケース: revokeAiClientConnection

[usecases/identity.md](../../usecases/identity.md) の revokeAiClientConnection に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ユーザーが active な接続を保有 | その `connectionId` で失効を実行する | `RevokedAiClientConnection`（`status: "revoked"`, `revokedAt: now`）に遷移し `version` が +1 される。正常終了（`void`） | |
| 該当 `connectionId` の接続が存在しない | 失効を実行する | `NotFoundError("CONNECTION_NOT_FOUND")` | |
| 接続はユーザー B の所有（エッジケース: 他ユーザーの接続 ID を指定） | ユーザー A の `userId` でその `connectionId` の失効を実行する | `findById(connectionId)` はユーザー A の Durable Object の中だけを引くので null を返し `NotFoundError("CONNECTION_NOT_FOUND")`（不在と区別せず、存在の有無も漏らさない）。ユーザー B の接続は変化しない | |
| — | `connectionId` に空文字・空白のみを指定して失効を実行する | `BusinessRuleError`（`AiClientConnectionId` 生成時バリデーション） | |
| 接続が既に `status: "revoked"`（エッジケース: 再失効の冪等性） | 同じ `connectionId` で再度失効を実行する | 何も変更せず正常終了する（冪等）。`version` は進まず、`revokedAt` も変わらない | |
| active な接続に対し、一覧画面の二重表示等から同時に2つの失効リクエストが実行される（OCC 競合） | 両方の失効を実行する | 先勝ちの1件が成功し、後発は `ConflictError("OPTIMISTIC_LOCK_FAILURE")`（リトライすれば revoked 済みとして冪等に正常終了する） | |
| 失効済みの接続を保有 | 同一クライアントを再利用したい | 失効は不可逆であり再有効化はできない。新しい認可フロー（approveAiClientAuthorization）で新しい接続を作る必要がある | |
| `AiClientConnectionRepository.save` で DB 例外が発生する | 失効を実行する | `SystemError`。トランザクションはロールバックされ、接続は active のまま | |
| 接続を `status: "revoked"` にした直後 | そのクライアントのトークンで次のリクエストを送る | 対象 Durable Object 内のガードが `ai_client_connections.status` を直読みして拒否する（認可エラー）。失効を別ストアへ伝播させる経路は存在せず、`status` そのものが失効の権威である | |
