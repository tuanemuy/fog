# テストケース: linkSsoCredential

[usecases/identity.md](../../usecases/identity.md) の linkSsoCredential に対するテストケース。書き込みはユーザー単位設定側（User Data DO）と認証情報側（Identity Directory）の2つの物理境界にまたがるので、順序と中間状態で利用者に何が観測されるかも対象に含める。**本ユースケースは `unlinkSsoCredential` が解除する対象を作る唯一の経路**なので、解除側の前提が到達可能であることもここで担保する。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ログイン済みで、`kind: "email"`（`usableForLogin: true`）1件だけを持つアカウント | 未連携の SSO 主体（`provider` / `providerSubject`）で連携を追加する | `User.credentials` に `kind: "sso"`・`usableForLogin: true`・`label` が provider 名の要素が加わって `version` が +1 され、`CredentialLocatorStore.record` で逆引きが記録される。採番済みの `credentialId` が返る | |
| 連携が完了した | 連携した SSO でログインする | ログインできる（逆引きの記録が済んでいるのでログインの到達性検査を通る） | |
| 連携が完了した | 既存のパスワードでログインする | 従来どおりログインできる（既存クレデンシャルの `credentialVersion` には触れないので、連携が他の認証手段を巻き添えにしない） | |
| 連携が完了した | 連携前に確立していた別セッションでリクエストを送る | 失効しない（`sessionEpoch` は進めない。連携は認証手段を1つ増やすだけで既存セッションの信頼性を下げない） | |
| 連携が完了した | 設定画面（P-13）から当該 SSO を解除する | `unlinkSsoCredential` の正常系として解除できる（`kind: "email"` のログイン手段が残るため。本ユースケースが解除対象を作る唯一の経路である） | |
| IdP から見えるメールアドレスが、連携先アカウントの登録メールとも別アカウントの登録メールとも異なる | 連携を追加する | 連携は成立する。**メールアドレスは入力に無く、連携が確保するのは SSO 主体の一意性だけ**である（メールの一意性に触れると連携先アカウント自身のメール予約と衝突する） | |
| 手続きの記録は済んだが、逆引きの記録（手順5-2）が未了の中間状態 | 連携した SSO でログインを試みる | ログインできない。到達性検査が `CredentialLocatorStore` を読むためで、**利用者から観測できるのは「連携が完了するまでその SSO ではログインできない」ことだけ**である | |
| 手続きの記録（`recordOperation`）が行われる | 連携を開始する | 同じトランザクションで `resume-link` が投入される。**これが前進の唯一の投入点**であり、投入が無いと途中で落ちた手続きを前進させる契機が失われる | |
| 別のアカウントが同じ SSO 主体を既に連携している | 連携を追加する | 認証情報側の予約を獲得できず `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")`。クレデンシャル集合は変わらない | |
| 自分のアカウントが同じ SSO 主体を既に連携している | もう一度同じ SSO 主体で連携する | 同じく `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")`。**自分のアカウントで連携済みの場合も重複として拒否する**（冪等な no-op にはしない） | |
| — | `SsoProvider` に無い provider を指定して連携する | `BusinessRuleError(IdentityErrorCode.UnsupportedSsoProvider)`。連携は成立しない | |
| — | `providerSubject` に空文字・空白のみを指定して連携する | `BusinessRuleError`（非空制約）。連携は成立しない | |
| セッションの `userId` に対応するユーザーが不在 | 連携を追加する | `NotFoundError("USER_NOT_FOUND")` | |
| `User` の取得後 `save` までの間に同一ユーザーが別セッションで更新され version が進んでいる | 連携を追加する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。クレデンシャルは追加されない | |
| `UserSettingsRepository.save` で DB 例外が発生する | 連携を追加する | `SystemError`。ユーザー単位設定側のトランザクションはロールバックされるが、認証情報側で獲得済みの予約は別の物理境界にあるため巻き戻らず中間状態として残る（観測できるのは「その SSO ではまだログインできない」ことだけ） | |
| 中間状態のまま前進不能が確定した | 一様な終端に落ちる | 終端に至った事実は記録として残り、運用へエスカレーションされる。**終端の具体的な手順は #45 が定める** | |
