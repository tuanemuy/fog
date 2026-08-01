# テストケース: registerWithPassword

[usecases/identity.md](../../usecases/identity.md) の registerWithPassword に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| メール `user@example.com` は未登録 | `email: "user@example.com"`, `password: "password123"`（8〜128文字）で登録する | 認証情報側でメールの予約を獲得したうえで、ユーザー単位設定側に `User` が `version: 0` で作成される（クレデンシャル集合は `kind: "email"` の1件）。`userId` が返る | |
| メール未登録 | `email: "  User@Example.COM  "`（前後空白・大文字混在）で登録する | trim・小文字化の正規化後 `user@example.com` として登録され、正常終了する | |
| メール未登録 | メール形式不正（`@` なし、`local@` のみ等）で登録する | `BusinessRuleError(IdentityErrorCode.InvalidEmail)`。ユーザーは作成されない | |
| メール未登録 | 正規化後321文字のメールアドレスで登録する | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` | |
| メール未登録 | 正規化後ちょうど320文字の有効なメールアドレスで登録する | 正常に登録される（境界値: 最大長ちょうどは許容） | |
| メール未登録 | パスワード7文字で登録する | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)`。ユーザーは作成されない | |
| メール未登録 | パスワードちょうど8文字で登録する | 正常に登録される（境界値: 最低長ちょうどは許容） | |
| メール未登録 | パスワードちょうど128文字で登録する | 正常に登録される（境界値: 最大長ちょうどは許容） | |
| メール未登録 | パスワード129文字で登録する | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` | |
| メール未登録 | パスワード空文字で登録する | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` | |
| 同一メールのクレデンシャルが登録済み | 同じメールアドレスで登録する | 事前検証（`CredentialMappingRepository.findByEmail`）で `ConflictError("EMAIL_ALREADY_REGISTERED")`。ユーザーは作成されない | |
| 同一メールのクレデンシャルを SSO 登録のアカウントが持っている（エッジケース: 認証方式をまたぐ重複） | 同じメールアドレスでパスワード登録する | `ConflictError("EMAIL_ALREADY_REGISTERED")`。自動リンクは行われない | |
| 大文字表記のメールで既存ユーザーが登録済み（正規化後一致） | 小文字表記の同一メールで登録する | 正規化後の比較で重複検出され `ConflictError("EMAIL_ALREADY_REGISTERED")` | |
| 事前検証時点では未登録だが、予約の獲得までの間に同一メールで別リクエストが先に予約を取った（同時登録レース） | 登録を実行する | 認証情報側の予約獲得に敗北し `ConflictError("EMAIL_ALREADY_REGISTERED")`。ユーザー単位設定側の初期化は行われない | |
| `PasswordHasher.hash` が失敗する（リソース不足等） | 登録を実行する | `SystemError`。ユーザーは作成されない | |
| `UserSettingsRepository.insert` で DB 例外が発生する | 登録を実行する | `SystemError`。ユーザー単位設定側のトランザクションはロールバックされユーザーは作成されないが、**認証情報側で獲得済みのメール予約は別の物理境界にあるため巻き戻らない**。利用者から観測できるのは「そのメールで登録もログインもできない」ことだけである | |
