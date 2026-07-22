# テストケース: jumpToDate

[usecases/memo.md](../../usecases/memo.md) の jumpToDate に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| 指定日にメモが存在する | `date` を指定してジャンプする | 指定日を含む前後のメモが `postedAt` 降順で返り、`olderCursor` / `newerCursor` の両方向カーソルが返る（S-TL-03） | |
| ジャンプ結果のカーソルを保持している | `olderCursor` から `getTimeline(direction: "older")`、`newerCursor` から `getTimeline(direction: "newer")` で継続する | ジャンプ位置から両方向へ重複・欠落なく無限スクロールが継続できる | |
| 指定日にメモが 1 件もない（前後の日にはある） | `date` を指定してジャンプする | 前後で最も近いメモの位置を初期ページとして返す（S-TL-03 エッジケース。空にしない） | |
| 全メモより過去の日付を指定する | ジャンプする | 最も近いメモ（最古付近）の位置が返る（境界値: 範囲外・過去側） | |
| 全メモより未来の日付を指定する | ジャンプする | 最も近いメモ（最新付近）の位置が返る（境界値: 範囲外・未来側） | |
| メモが 1 件も存在しない | ジャンプする | `items: []`・`olderCursor: null`・`newerCursor: null`（エラーにしない） | |
| keyword 絞り込み中 | `keyword` を指定してジャンプする | 絞り込み対象内でアンカー前後のメモが返る（絞り込み継続中のジャンプ。S-TL-03） | |
| keyword 絞り込みで一致が 0 件 | `keyword` を指定してジャンプする | `items: []`・両カーソル `null` | |
| メモがドキュメントの出典になっている | ジャンプする | `TimelineItemView.sourceDocuments` に出典導線が付与される（trashed ドキュメントは `isTrashed: true`。getTimeline と同一射影） | |
| trashed のメモが指定日に存在する | ジャンプする | trashed のメモは `items` に含まれない | |
| 他ユーザーのメモのみが指定日に存在する | ジャンプする | 他ユーザーのメモは含まれず、自分のメモで最も近い位置が返る（テナント分離） | |
| メモが存在する | `limit: 1` で取得する | 1 件だけ返る（境界値: 下限） | |
| メモが存在する | `limit: 100` で取得する | 最大 100 件返る（境界値: 上限） | |
| — | `limit: 0` / `limit: 101` で取得する | `ValidationError`（境界値: 範囲外） | |
| — | `date` に不正な値（Invalid Date）を指定する | `ValidationError` | |
| — | `findTimelineAround` で DB 例外が発生する | `SystemError(DatabaseError)` | |
