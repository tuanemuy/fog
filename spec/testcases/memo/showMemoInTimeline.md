# テストケース: showMemoInTimeline

[usecases/memo.md](../../usecases/memo.md) の showMemoInTimeline に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active な対象メモが存在する | `memoId` を指定して表示する | `targetState: "found"`、`items` に対象メモを含む前後ページ（`postedAt` 降順）、`olderCursor` / `newerCursor` が返る。`targetMemoId` は指定 ID（P-04 のスクロール＋ハイライト用） | |
| 対象メモが最新のメモである | 表示する | `targetState: "found"` で対象を含むページが返る。`newerCursor: null`（境界値: タイムライン先頭） | |
| 対象メモが最古のメモである | 表示する | `targetState: "found"` で対象を含むページが返る。`olderCursor: null`（境界値: タイムライン末尾） | |
| 対象メモが唯一のメモである | 表示する | `items` は対象メモ 1 件、両カーソル `null` | |
| 表示結果のカーソルを保持している | `olderCursor` / `newerCursor` から `getTimeline` で継続する | 対象位置から両方向へ重複・欠落なく閲覧が継続できる | |
| ページ内のメモがドキュメントの出典になっている | 表示する | `sourceDocuments` に出典導線が付与される（trashed ドキュメントは `isTrashed: true`。getTimeline と同一射影） | |
| 対象メモが trashed | 表示する | `targetState: "trashed"`・`items: []`・両カーソル `null`。エラーにしない（「ゴミ箱にあります」等の案内表示は presentation の責務） | |
| 対象メモが存在しない（ハードデリート済み含む） | 表示する | `targetState: "notFound"`・`items: []`・両カーソル `null`。エラーにしない | |
| 対象メモが他ユーザー所有 | 実在する他ユーザーのメモ ID を指定して表示する | `targetState: "notFound"`（テナント分離: 所有の事実も漏らさない） | |
| メモが存在する | `limit: 1` / `limit: 100` で表示する | 正常に返る（境界値: limit の下限・上限） | |
| — | `limit: 0` / `limit: 101` で表示する | `ValidationError`（境界値: 範囲外） | |
| — | `memoId` を空文字で表示する | バリデーションエラー（`MemoId.create` の非空制約） | |
| — | DB 例外が発生する | `SystemError(DatabaseError)` | |
