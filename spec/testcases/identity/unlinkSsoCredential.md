# テストケース: unlinkSsoCredential

[usecases/identity.md](../../usecases/identity.md) の unlinkSsoCredential に対するテストケース。書き込みはユーザー単位設定側（User Data DO）と認証情報側（Identity Directory）の2つの物理境界にまたがるので、順序と中間状態で利用者に何が観測されるかも対象に含める。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `kind: "sso"` と `kind: "email"`（`usableForLogin: true`）の2件を持つアカウント | SSO の `credentialId` を指定して解除する | `User.credentials` から当該要素が消えて `version` が +1 され、`CredentialLocatorStore.deleteByCredentialId` で逆引きが消え、`AccountStore.advanceSessionEpoch` が呼ばれる。認証情報側では写像行とそのクレデンシャル宛のリセットトークン行が消える。正常終了（`void`） | |
| SSO 連携を解除した | 同じ SSO 主体でログインを試みる | ログインできない（写像が消えており、残っていても到達性検査が拒否する） | |
| SSO 連携を解除した | 解除前に確立していた別セッションでリクエストを送る | `sessionEpoch` が前進しているため次のリクエストで失効する | |
| ユーザー単位設定側の手順は完了したが、認証情報側の `deleteMapping` が未了（中間状態） | 同じ SSO 主体でログインを試みる | ログインできない。逆引きが先に消えているので到達性検査が拒否する（「解除したのにログインできる」は起きない。壊れる向きは片方向に固定されている） | |
| 認証情報側の `deleteMapping` が一度成功したあと、同じ手続きが再実行される | 解除を再実行する | 「無ければ成功」の冪等操作として正常終了する | |
| `kind: "sso"` を2件と `kind: "email"`（`usableForLogin: true`）を持つアカウント | 片方の SSO を解除する | 解除に成功する（`usableForLogin` が真の要素が残るため） | |
| `kind: "email"` の `credentialId` を指定する | 解除する | `BusinessRuleError`（`User.removeCredential` は `kind: "sso"` しか受けない）。メールクレデンシャルの解除経路は存在しない | |
| `kind: "sso"`（`usableForLogin: true`）1件と `kind: "email"`（`usableForLogin: false`。一意性の予約としてだけ置かれた要素）を持つ SSO 専用アカウント | SSO を解除する | `BusinessRuleError(LastCredentialRemoval)`。数えるのは要素数ではなく `usableForLogin` が真である要素の `credentialId` の異なり数なので、メール要素は残るログイン手段として数えない | |
| ログイン済みユーザー | クレデンシャル集合に存在しない `credentialId` を指定して解除する | `NotFoundError("CREDENTIAL_NOT_FOUND")` | |
| セッションの `userId` に対応するユーザーが不在 | 解除する | `NotFoundError("USER_NOT_FOUND")` | |
| 取得後 `save` までの間に同一ユーザーが別セッションで更新され version が進んでいる | 解除する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。クレデンシャルは解除されない | |
| — | `credentialId` に空文字・空白のみを指定して解除する | `BusinessRuleError`（`CredentialId.create` 生成時バリデーション） | |
| `UserSettingsRepository.save` で DB 例外が発生する | 解除する | `SystemError`。トランザクションはロールバックされ、逆引きも写像も消えない | |
| 中間状態のまま前進不能が確定した | 一様な終端に落ちる | 終端に至った事実は記録として残り、運用へエスカレーションされる。**終端の具体的な手順は #45 が定める** | |
