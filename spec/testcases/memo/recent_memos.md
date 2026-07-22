# テストケース: recent_memos（AI API）

[usecases/memo.md](../../usecases/memo.md) の recent_memos に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active なメモが 30 件存在する | `limit` を省略して取得する | 直近 20 件（既定値）が `postedAt` 降順の `{ id, body, postedAt }[]` で返る（S-AI-02。直近の文脈把握用） | |
| active なメモが存在する | 取得する | 出典導線（sourceDocuments）・カーソルは含まれない（ページング・絞り込みは公開しない。過去の探索は search の責務） | |
| メモが 1 件も存在しない | 取得する | 空配列を返す（エラーにしない） | |
| trashed のメモが存在する | 取得する | trashed のメモは含まれない（ゴミ箱は AI から見えない。S-AI-04） | |
| 直近のメモがすべて trashed | 取得する | それらを飛ばして active のメモのみが返る | |
| 他ユーザーのメモが存在する | 取得する | 他ユーザーのメモは含まれない（テナント分離） | |
| メモが limit 件未満しかない | `limit: 100` で取得する | 存在する全 active メモが返る（不足分はそのまま） | |
| メモが複数存在する | `limit: 1` で取得する | 最新の 1 件のみ返る（境界値: 下限） | |
| メモが複数存在する | `limit: 100` で取得する | 最大 100 件返る（境界値: 上限） | |
| — | `limit: 0` で取得する | `ValidationError`（境界値: 下限未満） | |
| — | `limit: 101` で取得する | `ValidationError`（境界値: 上限超過） | |
| — | `limit` に非整数を指定する | `ValidationError` | |
| 失効・スコープ外の AI トークン | 取得を試みる | identity / プレゼンテーション境界で認可エラー。本ユースケースには到達しない | |
| — | `findTimelinePage` で DB 例外が発生する | `SystemError(DatabaseError)` | |
