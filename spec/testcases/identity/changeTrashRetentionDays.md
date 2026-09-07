# テストケース: changeTrashRetentionDays

[usecases/identity.md](../../usecases/identity.md) の changeTrashRetentionDays に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ログイン済みユーザー（既定値30日） | `retentionDays: 7` に変更する | `trashRetentionDays` が 7 に更新され `version` が +1 される。正常終了（`void`） | |
| ログイン済みユーザー | `retentionDays: 1` に変更する | 正常に更新される（境界値: 最小値ちょうどは許容） | |
| ログイン済みユーザー | `retentionDays: 0` に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)`。設定は変更されない（境界値: 最小値未満） | |
| ログイン済みユーザー | `retentionDays: -1` に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` | |
| ログイン済みユーザー | `retentionDays: 1.5`（非整数）に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` | |
| ログイン済みユーザー | `retentionDays: NaN` / `Infinity` に変更する | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` | |
| ログイン済みユーザー（現在値30） | `retentionDays: 30`（現在と同じ値）に変更する | 正常終了する（同一値の禁止規則は存在しない） | |
| ログイン済みの SSO 専用アカウント | 保持日数を変更する | 認証方式に関わらず正常に更新される（`changeTrashRetentionDays` は User 全体で可能） | |
| ゴミ箱に既存のソフトデリート項目があるユーザー | 保持日数を変更する | 変更後の値が既存のゴミ箱項目と以後のソフトデリート項目の両方に適用される（利用者から見た遡及適用の結果は変わらない） | |
| セッションの `userId` に対応するユーザーが不在 | 保持日数を変更する | `NotFoundError("USER_NOT_FOUND")` | |
| 取得後、save までの間に同一ユーザーが別セッションで更新され version が進んでいる | 保持日数を変更する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` | |
| `UserSettingsRepository.save` で DB 例外が発生する | 保持日数を変更する | `SystemError`。トランザクションはロールバックされ、保持日数も `purge_after` の再計算も反映されない | |
| ゴミ箱に既存項目が 3 件あるユーザー（現在値30） | `retentionDays: 7` に変更する | 変更と同一トランザクションで 3 件すべての `purgeAfter` が再計算され、新しい最も早い期限で `purge-trash` の起床が張り直される | |
| ゴミ箱の項目数が 1 トランザクションで再計算しきれないほど大きい | 保持日数を変更する | 再計算はチャンクに分けて進められ、残件がある間は `purge-trash` が再計算フェーズを先に完走させてから期限判定へ進む（延長方向の変更で誤削除が起きない） | |
