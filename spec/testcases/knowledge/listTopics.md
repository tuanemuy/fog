# テストケース: listTopics

[usecases/knowledge.md](../../usecases/knowledge.md) の listTopics に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `active` トピック 2 件と各配下に active ドキュメントが存在する | `includeArchived: false` で一覧を取得する | active トピックのみが安定順序で返り、各トピックの `documents` に配下 active ドキュメント（`id` / `title` / `updatedAt`）がグルーピングされて含まれる | |
| `active` 2 件・`archived` 1 件のトピックが存在する | `includeArchived: true` で一覧を取得する | archived を含む 3 件が返る（人間 UI の「完了済み」セクション表示用） | |
| `active` 2 件・`archived` 1 件のトピックが存在する | `includeArchived: false` で一覧を取得する | active の 2 件のみ返り、archived は含まれない | |
| ゴミ箱内（`trashed`）トピックが存在する | `includeArchived: true` で一覧を取得する | trashed トピックは含まれない（`listByUser` はゴミ箱外のみ返す） | |
| トピックが 1 件も存在しない | 一覧を取得する | `topics: []`（空配列。エラーにしない） | |
| 配下ドキュメントが 0 件のトピックが存在する | 一覧を取得する | 当該トピックの `documents` は空配列（境界値: 0 件） | |
| トピック配下に active ドキュメントとゴミ箱内ドキュメントが混在する | 一覧を取得する | `documents` には active のみ含まれ、trashed（個別削除・セット削除とも）は含まれない | |
| トピックが複数件（例: 10 件）存在し各配下にドキュメントがある | 一覧を取得する | 配下ドキュメントは `listActiveByTopics` の 1 クエリで一括取得される（トピック件数分の N+1 照会にならない） | |
| 他ユーザーがトピック・ドキュメントを保有している | 自ユーザーで一覧を取得する | 他ユーザーのトピック・ドキュメントは一切含まれない（テナント分離） | |
| AI トークンで認証（MCP `list_topics`） | 一覧を取得する | 人間 UI と同一の結果（S-AI-02。ゴミ箱内は構造的に見えない） | |
| トピックが存在する | `TopicRepository.listByUser` で DB 例外が発生する | `SystemError(DatabaseError)` | |
