# テストケース: changeTrashRetentionDays

[usecases/identity.md](../../usecases/identity.md) の changeTrashRetentionDays に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ログイン済みユーザー（既定値30日） | `retentionDays: 7` に変更する | `trashRetentionDays` が 7 に更新され `version` が +1 される。`identity.trashRetentionChanged`（`retentionDays: 7`）イベントが記録される。正常終了（`void`） | |
| ログイン済みユーザー | `retentionDays: 1` に変更する | 正常に更新される（境界値: 最小値ちょうどは許容） | |
| ログイン済みユーザー | `retentionDays: 0` に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)`。設定は変更されない（境界値: 最小値未満） | |
| ログイン済みユーザー | `retentionDays: -1` に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` | |
| ログイン済みユーザー | `retentionDays: 1.5`（非整数）に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` | |
| ログイン済みユーザー | `retentionDays: NaN` / `Infinity` に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` | |
| ログイン済みユーザー（現在値30） | `retentionDays: 30`（現在と同じ値）に変更する | 正常終了する（同一値の禁止規則は存在しない） | |
| ログイン済みの `SsoUser` | 保持日数を変更する | 認証方式に関わらず正常に更新される（`changeTrashRetentionDays` は User 全体で可能） | |
| ゴミ箱に既存のソフトデリート項目があるユーザー | 保持日数を変更する | 変更後の値が既存のゴミ箱項目と以後のソフトデリート項目の両方の保持期限計算に適用される（trash ドメインが本設定を参照） | |
| セッションの `userId` に対応するユーザーが不在 | 保持日数を変更する | `NotFoundError("USER_NOT_FOUND")` | |
| 取得後、save までの間に同一ユーザーが別セッションで更新され version が進んでいる | 保持日数を変更する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` | |
| `UserRepository.save` で DB 例外が発生する | 保持日数を変更する | `SystemError`。トランザクションはロールバックされ、イベントも記録されない | |
