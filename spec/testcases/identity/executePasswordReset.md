# テストケース: executePasswordReset

[usecases/identity.md](../../usecases/identity.md) の executePasswordReset に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| パスワードのクレデンシャルを持つアカウントが有効な未使用リセットトークンを保有 | トークンと新パスワード（8〜128文字）でリセットを実行する | トークンが消費され、認証情報側の検証材料が新パスワードのものへ差し替わる。そのクレデンシャル宛の未使用トークンはすべて無効化される。出力は `{ userId }` である | |
| 有効なトークンを保有 | 新パスワードちょうど8文字でリセットを実行する | 正常終了する（境界値: 最低長ちょうどは許容） | |
| 有効なトークンを保有 | 新パスワードちょうど128文字でリセットを実行する | 正常終了する（境界値: 最大長ちょうどは許容） | |
| 有効なトークンを保有 | 新パスワード7文字でリセットを実行する | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)`。トークンは消費されない（パスワード検証はトークン消費前に行う） | |
| 有効なトークンを保有 | 新パスワード129文字でリセットを実行する | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)`。トークンは消費されない | |
| パスワード要件違反で一度失敗した後、同じ有効トークンを保有 | 同じトークンと有効な新パスワードで再実行する | トークンは浪費されておらず、リセットが成功する | |
| — | 存在しない・改ざんされたトークンでリセットを実行する | `verifyAndConsume` が `null` を返し `ValidationError("RESET_TOKEN_INVALID")` | |
| 有効期限切れのトークンを保有 | そのトークンでリセットを実行する | `ValidationError("RESET_TOKEN_INVALID")`（UI は再送導線を示す） | |
| 一度リセットに成功し、トークンは消費済み | 同じトークンで再度リセットを実行する | `ValidationError("RESET_TOKEN_INVALID")`（使い捨て。期限切れ・改ざんと区別しない） | |
| 無効・期限切れ・使用済みの3ケース | それぞれの応答を比較する | すべて同一の `ValidationError("RESET_TOKEN_INVALID")` であり、原因を区別できない | |
| トークンは有効だが、指すユーザーが削除等で不在 | リセットを実行する | `NotFoundError("USER_NOT_FOUND")` | |
| トークンが指すクレデンシャルがパスワードの検証材料を持たない（エッジケース: 正常運用では到達しない防衛的分岐） | リセットを実行する | `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)`。パスワードは設定されない | |
| トークン検証後、書き込みまでの間に同一クレデンシャルが別経路から更新されている | リセットを実行する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` | |
| `PasswordHasher.hash` が失敗する | リセットを実行する | `SystemError` | |
| `PasswordResetTokenPort.verifyAndConsume` がストア障害で失敗する | リセットを実行する | `SystemError` | |
| 認証情報側の書き込みで DB 例外が発生する | リセットを実行する | `SystemError`。トランザクションはロールバックされ、検証材料は差し替わらない | |
| 認証情報側の差し替えは済んだが、ユーザー単位設定側の適用が未了（`changeState` が `null` でない中間状態） | 旧パスワード / 新パスワードのそれぞれでログインする | どちらも通らない（ダミー材料へ倒れ `ValidationError("INVALID_CREDENTIALS")` になる） | |
| リセットが完走した | 完了前に確立していた別セッションでリクエストを送る | `sessionEpoch` が前進しているため次のリクエストで失効する | |
| リセットが完走した | AI クライアント接続の一覧を確認する | `resetVersion` が前進し、前回のリセット完了以降に作られた接続だけが `revoked` になる（それより古い接続は `active` のまま残る） | |
| 中間状態のまま前進不能が確定した | 一様な終端に落ちる | 終端に至った事実は記録として残り、運用へエスカレーションされる。**終端の具体的な手順は #45 が定める** | |
| リセットが完走した | 新しいパスワードでログインする | ログインが通る。`CredentialLocatorStore.advanceCredentialVersion` が対象クレデンシャルの `credentialVersion` を進めており、認証情報側の値と一致するのでログインの到達性検査を通る（前進が漏れると値が食い違い、正しいパスワードでも `ValidationError("INVALID_CREDENTIALS")` になる） | |
| リセットが完走した | 完了画面（P-03）の必須導線から `getCurrentUser` / `listAiClientConnections` / `unlinkSsoCredential` / `revokeAllAiClientConnections` を実行する | 再ログインを挟まずに実行できる。出力の `userId` で presentation 層が**新しいセッションを確立**しており、完了画面は認証済みの画面だからである。確立は `sessionEpoch` の前進より後なので、この新しいセッションだけが生き残る | |
