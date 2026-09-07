# テストケース: getTopicName

[usecases/knowledge.md](../../usecases/knowledge.md) の getTopicName に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active トピックが存在する | トピック名を取得する | `{ topicId, name }` が返る。`description` / `status` / `version` / `createdAt` / `updatedAt` は含まれない（射影読みが選択していない） | |
| アーカイブ済み（完了済み）トピックが存在する | トピック名を取得する | ゴミ箱外なので名前が返る（読みは Live 限定であって active 限定ではない） | |
| トピックが存在しない ID | トピック名を取得する | `NotFoundError` | |
| トピックがゴミ箱内 | トピック名を取得する | `listSummariesByIds` が Live のみ返すため `NotFoundError`（不在と区別しない） | |
| 他ユーザー所有のトピック ID | トピック名を取得する | 到達可能性により `NotFoundError`（自分の Durable Object の中に他ユーザーの行が存在せず、存在の有無も漏らさない） | |
| — | `topicId` に空文字を渡す | `BusinessRuleError(InvalidTopicId)` | |
