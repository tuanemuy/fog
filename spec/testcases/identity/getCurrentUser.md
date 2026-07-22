# テストケース: getCurrentUser

[usecases/identity.md](../../usecases/identity.md) の getCurrentUser に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ログイン済みの `PasswordUser` | 現在のユーザー情報を取得する | `userId` / `email` / `authMethod: "password"` / `trashRetentionDays` が返る | |
| ログイン済みの `SsoUser` | 現在のユーザー情報を取得する | `authMethod: "sso"` が返る（UI はこれを用いてパスワード変更 UI を非表示にする） | |
| ログイン済みの `PasswordUser` | 出力 DTO の内容を検証する | `passwordHash` 等の資格情報が含まれない | |
| ログイン済みの `SsoUser` | 出力 DTO の内容を検証する | `provider` / `providerSubject`（SSO 主体 ID）が含まれない | |
| 登録直後（設定未変更）のユーザー | 現在のユーザー情報を取得する | `trashRetentionDays: 30`（既定値）が返る | |
| 保持日数を 1 に変更済みのユーザー | 現在のユーザー情報を取得する | `trashRetentionDays: 1` が返る（変更が反映される） | |
| セッションは有効だが対応するユーザーが不在（エッジケース: セッションはあるがユーザーが消えている） | 現在のユーザー情報を取得する | `NotFoundError("USER_NOT_FOUND")` | |
| — | `userId` に空文字・空白のみを指定して取得する | `BusinessRuleError`（`UserId` 生成時バリデーション） | |
| `UserRepository.findById` で DB 例外が発生する | 現在のユーザー情報を取得する | `SystemError` | |
