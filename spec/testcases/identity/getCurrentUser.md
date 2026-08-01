# テストケース: getCurrentUser

[usecases/identity.md](../../usecases/identity.md) の getCurrentUser に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ログイン済みで、クレデンシャル集合が `kind: "email"` の1件だけのアカウント | 現在のユーザー情報を取得する | `userId` / `email` / `credentials` / `trashRetentionDays` が返る。`credentials` は `{ credentialId, kind, label }` の3つ組の配列で、`kind: "email"` の要素を1件持つ（`label` は空文字） | |
| ログイン済みで、クレデンシャル集合が `kind: "sso"` と `kind: "email"` の2件のアカウント | 現在のユーザー情報を取得する | `credentials` に2件が返り、`kind: "sso"` の要素の `label` は provider 名である。`kind: "email"` にログイン手段が無ければ UI はパスワード変更フォームを表示しない | |
| ログイン済みユーザー | 出力 DTO の内容を検証する | 検証材料（パスワードのハッシュ等）は含まれない。`credentialId` は含まれる — **解除操作の対象指定に使うので、DTO から落とすと解除が書けなくなる** | |
| SSO 連携を持つログイン済みユーザー | 出力 DTO の内容を検証する | `provider` / `providerSubject`（SSO 主体 ID）は含まれない。`label` は provider 名までで subject を含まない | |
| 登録直後（設定未変更）のユーザー | 現在のユーザー情報を取得する | `trashRetentionDays: 30`（既定値）が返る | |
| 保持日数を 1 に変更済みのユーザー | 現在のユーザー情報を取得する | `trashRetentionDays: 1` が返る（変更が反映される） | |
| セッションは有効だが対応するユーザーが不在（エッジケース: セッションはあるがユーザーが消えている） | 現在のユーザー情報を取得する | `NotFoundError("USER_NOT_FOUND")` | |
| — | `userId` に空文字・空白のみを指定して取得する | `BusinessRuleError`（`UserId` 生成時バリデーション） | |
| `UserSettingsRepository.find` で DB 例外が発生する | 現在のユーザー情報を取得する | `SystemError` | |
| `kind: "sso"` と `kind: "email"` の2件を持つアカウント | UI の解除操作の出し分けを検証する | **一覧には `kind: "email"` の要素も出すが、解除操作を出してよいのは `kind: "sso"` の要素だけである。** 権威はドメイン側にあり `kind: "email"` の unlink は `BusinessRuleError` で拒否される（UI の出し分けは二重の防波堤） | |
| ログイン済みユーザー | 返る `email` の出どころを検証する | メールアドレスの原本は認証情報側にしか無く、**認証済み本人の自己参照として1件だけ復号される**（一覧のために複数件をまとめて復号する経路は開かない） | |
