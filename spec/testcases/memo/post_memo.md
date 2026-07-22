# テストケース: post_memo（AI API）

[usecases/memo.md](../../usecases/memo.md) の post_memo に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| 有効な AI トークン | `body` を指定して投稿する | `{ id, body, postedAt }` が返る。`postedAt` は自動付与（`clock.now()`。S-AI-01） | |
| 有効な AI トークン | 投稿する | 初版リビジョン（`revisionNumber: 1`、`actor: { kind: "aiClient", clientName }` = トークンから解決した AI クライアント）が同一 UoW で記録される（S-TL-05 でクライアント名を区別可能にする） | |
| 有効な AI トークン | 投稿する | `memo.created` イベントが同一 UoW で Outbox に記録される（search consumer が upsert） | |
| 有効な AI トークン | `body` をちょうど 10,000 文字で投稿する | 正常に作成される（境界値: 上限ちょうどは許容） | |
| 有効な AI トークン | `body` を 10,001 文字で投稿する | `BusinessRuleError(BodyTooLong)`。メモは作成されない（S-AI-01 異常系） | |
| 有効な AI トークン | `body` を空文字で投稿する | `BusinessRuleError(EmptyBody)`。メモは作成されない（S-AI-01 異常系） | |
| 有効な AI トークン | `body` を空白のみで投稿する | trim 後空のため `BusinessRuleError(EmptyBody)` | |
| 有効な AI トークン | `body` を 1 文字で投稿する | 正常に作成される（境界値: 最小長） | |
| 有効な AI トークン | 改行・Markdown 記法を含む本文を投稿する | 非構造プレーンテキストとしてそのまま保存される | |
| 失効・スコープ外の AI トークン | 投稿を試みる | identity / プレゼンテーション境界で認可エラー。本ユースケースには到達しない | |
| 有効な AI トークン | `insert` / `insertRevision` で DB 例外が発生する | `SystemError(DatabaseError)`。ロールバックされ何も記録されない | |
