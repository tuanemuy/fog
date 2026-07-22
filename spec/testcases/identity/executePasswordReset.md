# テストケース: executePasswordReset

[usecases/identity.md](../../usecases/identity.md) の executePasswordReset に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `PasswordUser` が登録済みで有効な未使用リセットトークンを保有 | トークンと新パスワード（8〜128文字）でリセットを実行する | トークンが消費され、`passwordHash` が新パスワードのハッシュに置換される。`version` が +1 され `identity.passwordChanged` イベントが記録される。正常終了（`void`） | |
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
| トークンが指すユーザーが `SsoUser`（エッジケース: 正常運用では到達しない防衛的分岐） | リセットを実行する | `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)`。パスワードは設定されない | |
| トークン検証後、save までの間に同一ユーザーが別経路で更新され version が進んでいる | リセットを実行する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` | |
| `PasswordHasher.hash` が失敗する | リセットを実行する | `SystemError` | |
| `PasswordResetTokenPort.verifyAndConsume` がストア障害で失敗する | リセットを実行する | `SystemError` | |
| `UserRepository.save` で DB 例外が発生する | リセットを実行する | `SystemError`。トランザクションはロールバックされ、イベントも記録されない | |
