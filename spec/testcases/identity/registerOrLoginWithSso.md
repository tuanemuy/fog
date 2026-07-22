# テストケース: registerOrLoginWithSso

[usecases/identity.md](../../usecases/identity.md) の registerOrLoginWithSso に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `(provider: "google", providerSubject)` に一致するユーザーが未登録、メールも未登録 | 初回 SSO サインインを実行する | `SsoUser` が `version: 0` で作成され `userId` と `isNewUser: true` が返る。`identity.userRegistered`（`authMethod: "sso"`）イベントが記録される | |
| `provider: "apple"` の主体が未登録、メールも未登録 | 初回 SSO サインインを実行する | Apple プロバイダでも同様に登録され `isNewUser: true` が返る | |
| 同一 `(provider, providerSubject)` の `SsoUser` が登録済み | 2回目の SSO サインインを実行する | 既存の `userId` と `isNewUser: false` が返る。書き込み・イベント発行は発生しない | |
| 同一 `(provider, providerSubject)` の `SsoUser` が登録済みで、IdP 側のメールが登録時と異なる | SSO サインインを実行する | SSO 主体一致が優先され、既存 `userId` と `isNewUser: false` が返る（ログイン扱い） | |
| 未対応プロバイダ | `provider: "github"` 等でサインインを実行する | `BusinessRuleError(IdentityErrorCode.UnsupportedSsoProvider)` | |
| — | メール形式不正（IdP 由来だが不正な値）でサインインを実行する | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` | |
| SSO 主体は未登録だが、IdP のメールと同一メールの `PasswordUser` が登録済み（エッジケース: SSO×既存メール衝突） | 初回 SSO サインインを実行する | `ConflictError("EMAIL_ALREADY_REGISTERED")`。自動リンクは行われず、SsoUser も作成されない（UI はパスワードログインへの導線を示す） | |
| SSO 主体は未登録だが、同一メールの別 `SsoUser`（別プロバイダ）が登録済み | 初回 SSO サインインを実行する | メール一意性は認証方式をまたいで適用され `ConflictError("EMAIL_ALREADY_REGISTERED")` | |
| 事前検証時点では未登録だが、insert までの間に同一 `(provider, providerSubject)` で別リクエストが登録完了（同時初回サインインのレース） | サインインを実行する | DB の (provider, providerSubject) 一意制約違反が捕捉され `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")` | |
| `UserRepository` で DB 例外が発生する | サインインを実行する | `SystemError`。トランザクションはロールバックされる | |
