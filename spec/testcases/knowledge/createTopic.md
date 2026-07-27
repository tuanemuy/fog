# テストケース: createTopic

[usecases/knowledge.md](../../usecases/knowledge.md) の createTopic に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| 認証済みユーザー | `name: "読書メモ"`, `description: "本の要約置き場"` で作成する | `status: "active"`, `version: 0` のトピックがUser Data DOの同期transactionで作成され、`id` / `name` / `description` / `createdAt` / `updatedAt` を含むビューが返る | |
| 認証済みユーザー | `description` を省略（`null`）して作成する | `description: null` のトピックが正常に作成される（説明文は任意。S-DT-01） | |
| 認証済みユーザー | `name: "  読書メモ  "`（前後空白付き）で作成する | trim 後非空のため正常に作成される | |
| 認証済みユーザー | `name` を空文字で作成する | `BusinessRuleError(EmptyTopicName)`。トピックは作成されない | |
| 認証済みユーザー | `name` を空白のみ（`"   "`）で作成する | trim 後空のため `BusinessRuleError(EmptyTopicName)` | |
| 認証済みユーザー | `name` に改行を含めて作成する | `BusinessRuleError(TopicNameMultiline)` | |
| 認証済みユーザー | `name` をちょうど 100 文字で作成する | 正常に作成される（境界値: 最大長ちょうどは許容） | |
| 認証済みユーザー | `name` を 101 文字で作成する | `BusinessRuleError(TopicNameTooLong)` | |
| 認証済みユーザー | `description` を空文字で作成する | `BusinessRuleError(EmptyTopicDescription)`（「説明なし」は空文字ではなく `null` で表す） | |
| 認証済みユーザー | `description` をちょうど 500 文字で作成する | 正常に作成される（境界値: 最大長ちょうどは許容） | |
| 認証済みユーザー | `description` を 501 文字で作成する | `BusinessRuleError(TopicDescriptionTooLong)` | |
| 同名トピック `"読書メモ"` が既に存在する | 同じ `name: "読書メモ"` で作成する | 正常に作成される（トピック名の一意制約は定義されていない。エッジケース: 重複名の許容確認） | |
| AI トークンで認証（MCP `create_topic`） | `name` を指定して作成する | 人間 UI と同一の振る舞いで作成される（公開面: 両方。S-AI-06） | |
| 認証済みユーザー | `TopicRepository.insert` で DB 例外が発生する | `SystemError(DatabaseError)`。トランザクションはロールバックされ、イベントも記録されない | |
