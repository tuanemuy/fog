# テストケース: delete（AI API・メモ対象）

[usecases/memo.md](../../usecases/memo.md) の delete に対するテストケース。`{ type: "memo", id }` が presentation 層で本ユースケース（softDeleteMemo 相当）へルーティングされる。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active なメモが存在する | `type: "memo"` と `id` を指定して削除する | メモが `status: "trashed"`・`trashedAt = now` になる（ソフトデリートのみ。ハードデリートの API は存在しない。S-AI-05）。戻り値は void | |
| 削除が成功した | インデックスを確認する | 同じ `transactionSync` の中で当該メモのエントリが `search_entries` / `search_fts` から除去される（ゴミ箱内は検索にヒットしない） | |
| AI が削除したメモがある | 人間 UI のゴミ箱を確認する | ゴミ箱に現れ、人間が復元できる（復元は trash ドメイン。AI にゴミ箱操作の API は存在しない） | |
| リビジョンを持つメモを削除した | データを確認する | 本文・全リビジョン・`postedAt` は保持される（可逆） | |
| 削除したメモがある | AI から `get` / `recent_memos` で参照する | `NotFoundError` / 一覧に含まれない（ゴミ箱は AI から「存在しない」世界） | |
| メモが存在しない | 架空の `id` で削除する | `NotFoundError` | |
| 対象メモが既に trashed | もう一度削除する | `NotFoundError`。不在との区別がつかない応答であること（「ゴミ箱の中身は見えない」を貫く。エッジケース: 二重削除） | |
| 対象メモが他ユーザー所有 | 実在する他ユーザーのメモ ID で削除する | `NotFoundError`（テナント分離。不在と区別しない） | |
| — | `memoId` を空文字で削除する | バリデーションエラー（`MemoId.create` の非空制約） | |
| 読み取り後、save までの間に他書き込みが割り込む | 削除する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。AI クライアントは再試行する | |
| 失効・スコープ外の AI トークン | 削除を試みる | identity / プレゼンテーション境界で認可エラー。本ユースケースには到達しない | |
| — | `save` で DB 例外が発生する | `SystemError(DatabaseError)`。ロールバックされ状態遷移・インデックスエントリの除去のいずれも起きない | |
| `trashRetentionDays: 30` のユーザーの active なメモが存在する | `type: "memo"` と `id` を指定して削除する | 人間 UI と同じく `purgeAfter` に `RetentionPolicy.expiresAt(now, 30)` の算出結果が保存される（不変条件 8。trash.md「保持期限」） | |
