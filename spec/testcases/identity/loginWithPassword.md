# テストケース: loginWithPassword

[usecases/identity.md](../../usecases/identity.md) の loginWithPassword に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `PasswordUser` が登録済み | 正しいメールアドレスとパスワードでログインする | `userId` が返る（セッション確立は presentation 層） | |
| `PasswordUser` が登録済み（メールは小文字で保存） | 大文字混在・前後空白付きの同一メールでログインする | 正規化後の一致でログイン成功し `userId` が返る | |
| 該当メールのユーザーが未登録 | 未登録メールでログインする | `ValidationError("INVALID_CREDENTIALS")` | |
| `PasswordUser` が登録済み | 正しいメール・誤ったパスワードでログインする | `ValidationError("INVALID_CREDENTIALS")` | |
| 同一メールの `SsoUser` が登録済み（エッジケース: SSO ユーザーへのパスワードログイン試行） | そのメールと任意のパスワードでログインする | `ValidationError("INVALID_CREDENTIALS")`（SSO ユーザーであることを明かさない） | |
| — | メール形式不正な入力でログインする | `BusinessRuleError(InvalidEmail)` ではなく `ValidationError("INVALID_CREDENTIALS")` に変換される（登録有無の推測材料を与えない） | |
| — | パスワード7文字（`PlainPassword` 要件違反）でログインする | `PasswordTooWeak` ではなく `ValidationError("INVALID_CREDENTIALS")` に変換される | |
| 上記の各失敗ケース | 未登録メール / パスワード不一致 / SSO ユーザー / 形式不正の応答を比較する | すべて同一のエラー種別・メッセージであり、どれが原因かを区別できない | |
| `PasswordUser` が登録済み、パスワードは8文字ちょうどで登録されている | その8文字パスワードでログインする | ログイン成功（境界値: 最低長パスワードでの照合） | |
| `UserRepository.findByEmail` で DB 例外が発生する | ログインを実行する | `SystemError` | |
| `PasswordHasher.verify` の照合計算が失敗する | ログインを実行する | `SystemError`（不一致の `false` とは区別される） | |
