# テストケース: updateTopic

[usecases/knowledge.md](../../usecases/knowledge.md) の updateTopic に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `active` なトピック（`version: 0`）が存在する | `name: "新しい名前"` のみ指定して更新する | 名前が変更され `version: 1`、`updatedAt` 更新。`topic.updated` イベントが記録される。`status` は `"active"` のまま | |
| `active` なトピックが存在する | `description: "新しい説明"` のみ指定して更新する | 説明文が変更され `version + 1`。`topic.updated` が記録される | |
| `description` 非 null のトピックが存在する | `description: null` を明示指定して更新する | 説明文が削除され `description: null` になる（省略と `null` 指定の区別） | |
| `active` なトピックが存在する | `archived: true` で更新する | `status: "archived"` へ遷移し `version + 1`。`topic.archived` イベントが記録される（UI 用語は「完了」） | |
| `archived` なトピックが存在する | `archived: false` で更新する | `status: "active"` へ遷移。`topic.unarchived` イベントが記録される | |
| `active` なトピックが存在する | `archived: true` で更新後、同トピックを `archived: false` で更新する | アーカイブ → 完了解除の状態往復が成立し、最終状態は `active`。`version` は 2 回分進み、`topic.archived` / `topic.unarchived` が各 1 件記録される（エッジケース: 状態往復） | |
| `active` なトピックが存在する | `archived: false` で更新する | 現状態と同じ指定のため何もしない（冪等）。イベントは発行されず、`save` により `version` のみ規約どおり進む | |
| `archived` なトピックが存在する | `archived: true` で更新する | 現状態と同じ指定のため何もしない（冪等）。イベントは発行されない | |
| `active` なトピックが存在する | `name` と `archived: true` を同時指定して更新する | rename と archive が順に適用され、`topic.updated` と `topic.archived` の両イベントが記録される | |
| `archived` なトピックが存在する | `name` のみ指定して更新する | `LiveTopic` への rename として成功し、`status: "archived"` は維持される | |
| トピックが存在する | `name` / `description` / `archived` をすべて省略して呼ぶ | presentation 層（スキーマ）で `ValidationError` | |
| トピックが存在しない ID | 任意の内容で更新する | `NotFoundError` | |
| トピックがゴミ箱内（`trashed`） | 任意の内容で更新する | `findById` が Live のみ返すため `NotFoundError`（不変条件 6。ゴミ箱内は編集不可） | |
| 他ユーザー所有のトピック ID | 任意の内容で更新する | userId スコープにより `NotFoundError`（存在の有無も漏らさない） | |
| トピックが存在する | `topicId` に空文字を渡す | `BusinessRuleError(InvalidTopicId)` | |
| トピックが存在する | `name` を空文字 / 改行入り / 101 文字で更新する | それぞれ `BusinessRuleError`（`EmptyTopicName` / `TopicNameMultiline` / `TopicNameTooLong`）。トピックは変更されない | |
| トピックが存在する | `name` をちょうど 100 文字で更新する | 正常に更新される（境界値） | |
| トピックが存在する | `description` を空文字 / 501 文字で更新する | それぞれ `BusinessRuleError`（`EmptyTopicDescription` / `TopicDescriptionTooLong`） | |
| トピックが存在する | `description` をちょうど 500 文字で更新する | 正常に更新される（境界値） | |
| 同一トピックに対する並行更新があり、`findById` 後に他方が先に `save` 済み | 更新を実行する | `save` が 0 行更新となり `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。変更は保存されない | |
| AI トークンで認証（MCP `update_topic`） | `archived: true` で更新する | 人間 UI と同一の振る舞い（アーカイブ切替は AI にも許可。S-AI-06） | |
| トピックが存在する | `TopicRepository.save` で DB 例外が発生する | `SystemError(DatabaseError)`。ロールバックされイベントも記録されない | |
