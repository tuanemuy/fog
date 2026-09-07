# テストケース: get（AI API・メモ対象）

[usecases/memo.md](../../usecases/memo.md) の get に対するテストケース。`{ type: "memo", id }` が presentation 層で本ユースケースへルーティングされる（`type: "document"` は knowledge の getDocument）。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active なメモが存在する | `type: "memo"` と `id` を指定して取得する | `{ id, body, postedAt, updatedAt, latestRevisionNumber }` の全文が返る（S-AI-02。検索スニペットからの全文取得・update_memo の前提操作） | |
| 編集済みのメモが存在する | 取得する | `body` は最新リビジョンの本文と一致し、`latestRevisionNumber` は現在の最新番号を返す | |
| 本文がちょうど 10,000 文字のメモが存在する | 取得する | 全文が切り詰めなしで返る（境界値: 上限長の本文） | |
| メモが存在しない（ハードデリート済み含む） | 架空の `id` で取得する | `NotFoundError` | |
| 対象メモが trashed | 取得する | `NotFoundError`。不在との区別がつかない応答であること（ゴミ箱内は「取得できない」= 存在しない扱い。存在事実も漏らさない。S-AI-02 エッジケース） | |
| 対象メモが他ユーザー所有 | 実在する他ユーザーのメモ ID で取得する | `NotFoundError`（テナント分離。不在と区別しない） | |
| ドキュメント ID を誤って `type: "memo"` で指定する | 取得する | `NotFoundError`（ID は不透明文字列であり、メモとして見つからないだけ。エッジケース: 種別ディスパッチの取り違え） | |
| — | `memoId` を空文字で取得する | バリデーションエラー（`MemoId.create` の非空制約） | |
| 失効・スコープ外の AI トークン | 取得を試みる | identity / プレゼンテーション境界で認可エラー。本ユースケースには到達しない | |
| — | `findById` で DB 例外が発生する | `SystemError(DatabaseError)` | |
