# テストケース: changePassword

[usecases/identity.md](../../usecases/identity.md) の changePassword に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ログイン済みの `PasswordUser` | 正しい現在パスワードと有効な新パスワード（8〜128文字）で変更する | `passwordHash` が新パスワードのハッシュに置換され、`version` が +1 される。`identity.passwordChanged` イベントが記録される。正常終了（`void`） | |
| ログイン済みの `PasswordUser` | 新パスワードちょうど8文字で変更する | 正常終了する（境界値: 最低長ちょうどは許容） | |
| ログイン済みの `PasswordUser` | 新パスワードちょうど128文字で変更する | 正常終了する（境界値: 最大長ちょうどは許容） | |
| ログイン済みの `PasswordUser` | 新パスワード7文字で変更する | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)`。パスワードは変更されない | |
| ログイン済みの `PasswordUser` | 新パスワード129文字で変更する | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` | |
| ログイン済みの `PasswordUser` | 誤った現在パスワードで変更する | `ValidationError("CURRENT_PASSWORD_MISMATCH")`。パスワードは変更されない | |
| ログイン済みの `PasswordUser` | 現在パスワードと同じ値を新パスワードとして変更する | 正常終了する（同一値の禁止規則は存在しない） | |
| セッションの `userId` に対応するユーザーが不在 | パスワード変更を実行する | `NotFoundError("USER_NOT_FOUND")` | |
| ログイン済みの `SsoUser`（エッジケース: UI 上は項目非表示だが防衛的に検証） | パスワード変更を実行する | `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)` | |
| `PasswordUser`。照合成功後、save までの間に同一ユーザーが別セッションで更新され version が進んでいる（二重変更の競合） | パスワード変更を実行する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` | |
| `PasswordHasher.verify` の照合計算が失敗する | パスワード変更を実行する | `SystemError` | |
| `PasswordHasher.hash` が失敗する | パスワード変更を実行する | `SystemError` | |
| `UserRepository.save` で DB 例外が発生する | パスワード変更を実行する | `SystemError`。トランザクションはロールバックされ、イベントも記録されない | |
