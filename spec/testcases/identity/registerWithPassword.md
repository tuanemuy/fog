# テストケース: registerWithPassword

[usecases/identity.md](../../usecases/identity.md) の registerWithPassword に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| メール `user@example.com` は未登録 | stable operationIdで登録する | Directory mapping、Account Home auth summary、User Data Profile/Settingsがsagaで確定し、`userId`が返る |
| signupの各phase後にfaultを注入 | 同じoperationIdで再送する | 保存済みphaseから再開し、credential mappingとuserIdは一意でorphanを残さない |
| メール未登録 | `email: "  User@Example.COM  "`（前後空白・大文字混在）で登録する | trim・小文字化の正規化後 `user@example.com` として登録され、正常終了する | |
| メール未登録 | メール形式不正（`@` なし、`local@` のみ等）で登録する | `BusinessRuleError(IdentityErrorCode.InvalidEmail)`。ユーザーは作成されない | |
| メール未登録 | 正規化後321文字のメールアドレスで登録する | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` | |
| メール未登録 | 正規化後ちょうど320文字の有効なメールアドレスで登録する | 正常に登録される（境界値: 最大長ちょうどは許容） | |
| メール未登録 | パスワード7文字で登録する | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)`。ユーザーは作成されない | |
| メール未登録 | パスワードちょうど8文字で登録する | 正常に登録される（境界値: 最低長ちょうどは許容） | |
| メール未登録 | パスワードちょうど128文字で登録する | 正常に登録される（境界値: 最大長ちょうどは許容） | |
| メール未登録 | パスワード129文字で登録する | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` | |
| メール未登録 | パスワード空文字で登録する | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` | |
| 同一email credentialが登録済み | 同じメールアドレスで登録する | Directory lookup/reservationで`ConflictError("EMAIL_ALREADY_REGISTERED")`。accountは作成されない | |
| 同一メールのSSO-only accountが登録済み | 同じメールアドレスでパスワード登録する | `ConflictError("EMAIL_ALREADY_REGISTERED")`。自動リンクは行われない | |
| 大文字表記のメールで既存ユーザーが登録済み（正規化後一致） | 小文字表記の同一メールで登録する | 正規化後の比較で重複検出され `ConflictError("EMAIL_ALREADY_REGISTERED")` | |
| lookup時点では未登録だが、reservationまでに別operationが同一emailを予約 | 登録する | 決定的競合解決で1つのmappingだけがactiveになり、敗者は`EMAIL_ALREADY_REGISTERED` | |
| `PasswordHasher.hash` が失敗する（リソース不足等） | 登録を実行する | `SystemError`。ユーザーは作成されない | |
| Directory/Account Home/User Dataの任意phaseで基盤例外 | 登録を実行する | retryable `SystemError`。operation stateを保持し、同じoperationIdで再開できる | |
