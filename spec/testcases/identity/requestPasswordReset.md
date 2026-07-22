# テストケース: requestPasswordReset

[usecases/identity.md](../../usecases/identity.md) の requestPasswordReset に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `PasswordUser` が登録済み | 登録済みメールでリセットを依頼する | `PasswordResetTokenPort.issue(user.id, now)` でトークンが発行され、`MailSender.sendPasswordResetMail` で同メール宛にリセットメールが送られる。正常終了（`void`） | |
| 該当メールのユーザーが未登録 | 未登録メールでリセットを依頼する | トークン発行・メール送信は行われず正常終了する。応答は登録済みの場合と同一（登録有無を明かさない） | |
| 同一メールの `SsoUser` が登録済み（エッジケース: SSO ユーザーのリセット要求） | そのメールでリセットを依頼する | トークン発行・メール送信は行われず正常終了する。応答は未登録メールの場合と同一（認証方式を明かさない） | |
| 登録済み / 未登録 / SSO ユーザーの3ケース | それぞれの応答を比較する | すべて同一の成功応答であり、登録有無・認証方式を区別できない | |
| — | メール形式不正な入力でリセットを依頼する | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` | |
| `PasswordUser` が登録済み（メールは小文字で保存） | 大文字混在の同一メールでリセットを依頼する | 正規化後の一致でトークンが発行され、メールが送られる | |
| `PasswordUser` が登録済み、`PasswordResetTokenPort.issue` がストア障害で失敗する | リセットを依頼する | `SystemError`（宛先の実在性に起因する失敗は応答に反映しない） | |
| `PasswordUser` が登録済み、`MailSender.sendPasswordResetMail` が送信基盤障害で失敗する | リセットを依頼する | `SystemError`（宛先の実在性に起因する失敗は応答に反映しない） | |
| `UserRepository.findByEmail` で DB 例外が発生する | リセットを依頼する | `SystemError` | |
| `PasswordUser` が登録済み | 同一メールで連続してリセットを依頼する | いずれも正常終了し、依頼ごとにトークンが発行される（トークンの有効期限・使い捨て管理は `PasswordResetTokenPort` の責務） | |
