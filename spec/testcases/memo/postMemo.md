# テストケース: postMemo

[usecases/memo.md](../../usecases/memo.md) の postMemo に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| 認証済みユーザー（人間UI） | `body: "今日の気づき"` で投稿する | `MemoView`（`id` / `body` / `postedAt` / `updatedAt` / `latestRevisionNumber: 1` / `version: 0`）が返る。`postedAt` は `clock.now()` の値（S-TL-01） | |
| 認証済みユーザー | 投稿する | 初版リビジョン（`revisionNumber: 1`、`actor` = 人間ユーザー、`body` = メモ本文、`createdAt = now`）が同一 UoW で必ず記録される（メモは初版リビジョンを伴って生まれる） | |
| 認証済みユーザー | 投稿する | `memo.created` イベント（ペイロードは `memoId` のみ）が同一 UoW で Outbox に記録される | |
| 認証済みユーザー | `body: "  前後空白あり  "` で投稿する | trim 後非空のため正常に作成される。保存される本文は trim されず入力そのまま（trim は空判定のみに使う） | |
| 認証済みユーザー | `body` に改行・Markdown 記法を含めて投稿する | 非構造プレーンテキストとしてそのまま保存される（構造の解釈はしない） | |
| 認証済みユーザー | `body` を 1 文字で投稿する | 正常に作成される（境界値: 最小長） | |
| 認証済みユーザー | `body` をちょうど 10,000 文字（Unicode コードポイント数）で投稿する | 正常に作成される（境界値: 上限ちょうどは許容） | |
| 認証済みユーザー | `body` を 10,001 文字で投稿する | `BusinessRuleError(BodyTooLong)`。メモは作成されない | |
| 認証済みユーザー | `body` を空文字で投稿する | `BusinessRuleError(EmptyBody)`。メモは作成されない | |
| 認証済みユーザー | `body` を空白のみ（`"   "` / 改行のみ）で投稿する | trim 後空のため `BusinessRuleError(EmptyBody)` | |
| 認証済みユーザー | サロゲートペア（絵文字等）を含む本文をコードポイント数 10,000 ちょうどで投稿する | 正常に作成される（上限は Unicode コードポイント数で判定。UTF-16 コード単位数ではない） | |
| 認証済みユーザー | 同一本文のメモを連続で 2 回投稿する | 2 件の独立したメモが作成される（重複制約はない。同一本文で積まない規則は同一メモの編集にのみ適用） | |
| 認証済みユーザー | `MemoRepository.insert` / `insertRevision` で DB 例外が発生する | `SystemError(DatabaseError)`。トランザクションはロールバックされ、メモ・リビジョン・イベントのいずれも記録されない | |
