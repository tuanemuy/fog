# テストケース: approveAiClientAuthorization

[usecases/identity.md](../../usecases/identity.md) の approveAiClientAuthorization に対するテストケース。

認可リクエストの検証（改ざん・期限切れ・PKCE）はアダプターの責務であり、本ユースケースには到達しない前提。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ログイン済みユーザーが OAuth 認可画面で「許可する」を押した | `clientName: "Claude Desktop"` で承認を実行する | `ActiveAiClientConnection` が `status: "active"`, `lastUsedAt: null`, `version: 0`, `connectedAt: now` で作成され `connectionId` が返る。作成時点の `account.resetVersion` が `createdAtResetVersion` に写される（リセット完了時の自動失効の射程を決める材料） | |
| ログイン済みユーザー | 前後空白付きのクライアント名（`"  Claude  "`）で承認を実行する | trim 後の名前で接続が作成され、正常終了する | |
| ログイン済みユーザー | ちょうど100文字のクライアント名で承認を実行する | 正常に接続が作成される（境界値: 最大長ちょうどは許容） | |
| ログイン済みユーザー | 101文字のクライアント名で承認を実行する | `BusinessRuleError`（`ClientName` 生成時バリデーション）。接続は作成されない | |
| ログイン済みユーザー | 空文字・空白のみのクライアント名で承認を実行する | `BusinessRuleError`（trim 後に非空の違反）。接続は作成されない | |
| 同名クライアント（同じ `clientName`）の接続が既に存在する | 再度同名クライアントの認可を承認する | 新しい `connectionId` で別の接続が作成される（1回の許可＝1接続。一意制約なし） | |
| 同一クライアントの接続が失効済み（エッジケース: 失効後の再認可） | 新しい認可フローで承認を実行する | 新しい `ActiveAiClientConnection` が作成される。既存の revoked 接続は revoked のまま変化しない | |
| `AiClientConnectionRepository.insert` で DB 例外が発生する | 承認を実行する | `SystemError`。トランザクションはロールバックされ、接続は作成されない | |
