# テストケース: changeTrashRetentionDays

[usecases/identity.md](../../usecases/identity.md) の changeTrashRetentionDays に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ログイン済みユーザー（既定値30日） | `retentionDays: 7` に変更する | User Data DOのSettingsが7へ更新され、最早retention job時刻が同じtransactionで再計算される | |
| ログイン済みユーザー | `retentionDays: 1` に変更する | 正常に更新される（境界値: 最小値ちょうどは許容） | |
| ログイン済みユーザー | `retentionDays: 0` に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)`。設定は変更されない（境界値: 最小値未満） | |
| ログイン済みユーザー | `retentionDays: -1` に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` | |
| ログイン済みユーザー | `retentionDays: 1.5`（非整数）に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` | |
| ログイン済みユーザー | `retentionDays: NaN` / `Infinity` に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` | |
| ログイン済みユーザー（現在値30） | `retentionDays: 30`（現在と同じ値）に変更する | 正常終了する（同一値の禁止規則は存在しない） | |
| SSO-only account | 保持日数を変更する | 認証方式に関わらず同じUser Data DOのSettingsを更新する | |
| ゴミ箱に既存のソフトデリート項目があるユーザー | 保持日数を変更する | 変更後の値が既存のゴミ箱項目と以後のソフトデリート項目の両方の保持期限計算に適用される（trash ドメインが本設定を参照） | |
| セッションの `userId` に対応するユーザーが不在 | 保持日数を変更する | `NotFoundError("USER_NOT_FOUND")` | |
| 取得後、save までの間に同一ユーザーが別セッションで更新され version が進んでいる | 保持日数を変更する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` | |
| Settings保存またはjob時刻再計算でDB例外 | 保持日数を変更する | `SystemError`。Settings/job変更は全てrollbackする | |
