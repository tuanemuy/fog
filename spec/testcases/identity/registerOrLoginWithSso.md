# テストケース: registerOrLoginWithSso

[usecases/identity.md](../../usecases/identity.md) の registerOrLoginWithSso に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `(provider: "google", providerSubject)` に一致するユーザーが未登録、メールも未登録 | 初回 SSO サインインを実行する | 認証情報側で SSO 主体とメールの予約を**2本とも獲得してから**、ユーザー単位設定側の `User` が `version: 0` で作成される（クレデンシャル集合は `kind: "sso"` と `kind: "email"` の2件）。`userId` と `isNewUser: true` が返る | |
| `provider: "apple"` の主体が未登録、メールも未登録 | 初回 SSO サインインを実行する | Apple プロバイダでも同様に登録され `isNewUser: true` が返る | |
| 同一 `(provider, providerSubject)` のクレデンシャルが登録済み | 2回目の SSO サインインを実行する | 既存の `userId` と `isNewUser: false` が返る。書き込みは発生しない（認証情報側の読み取りだけで完了する） | |
| 同一 `(provider, providerSubject)` のクレデンシャルが登録済みで、IdP 側のメールが登録時と異なる | SSO サインインを実行する | SSO 主体一致が優先され、既存 `userId` と `isNewUser: false` が返る（ログイン扱い） | |
| 未対応プロバイダ | `provider: "github"` 等でサインインを実行する | `BusinessRuleError(IdentityErrorCode.UnsupportedSsoProvider)` | |
| — | メール形式不正（IdP 由来だが不正な値）でサインインを実行する | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` | |
| SSO 主体は未登録だが、IdP のメールと同一メールのクレデンシャルをパスワード登録のアカウントが持っている（エッジケース: SSO×既存メール衝突） | 初回 SSO サインインを実行する | `ConflictError("EMAIL_ALREADY_REGISTERED")`。自動リンクは行われず、ユーザーも作成されない（UI はパスワードログインへの導線を示す） | |
| SSO 主体は未登録だが、同一メールのクレデンシャルを別プロバイダの SSO 登録アカウントが持っている | 初回 SSO サインインを実行する | メール一意性は認証方式をまたいで適用され `ConflictError("EMAIL_ALREADY_REGISTERED")` | |
| 事前検証時点では未登録だが、予約の獲得までの間に同一 `(provider, providerSubject)` で別リクエストが先に予約を取った（同時初回サインインのレース） | サインインを実行する | 認証情報側の予約獲得に敗北し `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")` | |
| リポジトリで DB 例外が発生する | サインインを実行する | `SystemError`。トランザクションはロールバックされる | |
| SSO 主体の予約は取れるが、メールの予約に敗北する（予約は2本走る） | 初回 SSO サインインを実行する | `ConflictError("EMAIL_ALREADY_REGISTERED")`。**両方の予約に勝った場合だけ**ユーザー単位設定側の初期化へ進むので、`User` は作成されず SSO 主体側の予約も確定しない | |
| 予約を2本とも獲得したが、ユーザー単位設定側の初期化が完了する前に処理が中断する（中間状態） | 同じメール / 同じ SSO 主体で登録・ログインを試みる | 中間状態のあいだはどちらでも登録もログインもできない。前進不能が確定した場合は一様な終端に落ちて記録が残り、**そのうえで後始末がアカウント候補を放棄し、2本の予約と孤児写像を解放するので、同じメール / 同じ SSO 主体で登録をやり直せる**。**後始末が完走すればジョブは `done` に落ち、operator の受け口には現れない** — 運用へエスカレーションされるのは後始末が焼き切れるか材料を見失った場合だけである（[recovery/index.md](../../recovery/index.md) 段 S1〜S4） | |
| SSO 登録の2つの canonical（メールと SSO 主体）が同じ bucket に落ちた登録 saga が終端した | 後始末を観測する | **同じ bucket に同居した2行の両方が解放される。** 除外の述語は `credentialId` の一致であって bucket の一致ではなく、最終段まで残るのはコーディネーターの予約行だけである。**bucket 単位で除外する実装は同居した2行目を取り残し、その canonical を恒久的に再登録不能にするのでこのケースで落ちる**（[recovery/index.md](../../recovery/index.md) 段 S3） | |
