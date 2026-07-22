# テストケース: softDeleteMemo

[usecases/memo.md](../../usecases/memo.md) の softDeleteMemo に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active なメモが存在する | ソフトデリートする | メモが `status: "trashed"`・`trashedAt = now`・`version` +1・`updatedAt = now` になる。戻り値は void（S-TL-06） | |
| ソフトデリートが成功した | イベントを確認する | `memo.trashed` イベント（ペイロードは `memoId` のみ）が同一 UoW で Outbox に記録される（search consumer がインデックスから除去し、出典先ドキュメントのエントリを再 upsert する） | |
| ソフトデリートしたメモがある | タイムライン（getTimeline）を取得する | 当該メモは含まれない（trashed は active のみのタイムラインに現れない） | |
| リビジョンを複数持つメモをソフトデリートした | データを確認する | 本文・全リビジョン・`postedAt` は保持される（可逆。復元は trash ドメインの restoreMemo で行い、元の位置に戻る） | |
| ドキュメントの出典になっているメモをソフトデリートした | 出典リンクを確認する | 出典リンクは消えずに残る。参照元ドキュメント側では「削除済みのメモ」として表示される（S-DT-07。表示は knowledge 側の読み取りユースケースの責務） | |
| メモが存在しない | 架空の `memoId` でソフトデリートする | `NotFoundError` | |
| 対象メモが既に trashed | もう一度ソフトデリートする | `NotFoundError`（`findById` が active のみ返すため、二重削除は不在と同じ扱い。エッジケース） | |
| 対象メモが他ユーザー所有 | 実在する他ユーザーのメモ ID でソフトデリートする | `NotFoundError`（テナント分離） | |
| — | `memoId` を空文字でソフトデリートする | バリデーションエラー（`MemoId.create` の非空制約） | |
| 読み取り後、save までの間に他書き込み（AI の編集等）が割り込む | ソフトデリートする | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。UI は再試行する | |
| — | `save` で DB 例外が発生する | `SystemError(DatabaseError)`。ロールバックされ状態遷移・イベントのいずれも記録されない | |
