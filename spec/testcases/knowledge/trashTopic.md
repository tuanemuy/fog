# テストケース: trashTopic

[usecases/knowledge.md](../../usecases/knowledge.md) の trashTopic に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `active` トピックの配下に active ドキュメント 2 件が存在する | トピックを削除する | トピックは `status: "trashed"`（`trashedAt: now`, `wasArchived: false`）、配下 2 件は `TrashedDocument`（各 `trashedWith = topic.id`）になる。配下 2 件のエントリが同一 `transactionSync` の中で `search_entries` / `search_fts` から除去され、`trashedDocumentIds` に 2 件の ID が返る（トピック自体はエントリを持たない） | |
| `archived` トピックが存在する | トピックを削除する | `wasArchived: true` で trashed になる（復元時にアーカイブ状態へ戻すための保持） | |
| 配下ドキュメント 0 件のトピックが存在する | トピックを削除する | トピックのみ trashed になり `trashedDocumentIds: []`。`document.trashed` は発行されない（境界値: セット 0 件） | |
| 配下に active 2 件と、個別削除済み（`trashedWith: null`）のゴミ箱内ドキュメント 1 件が存在する | トピックを削除する | セット削除対象は active の 2 件のみ（各 `trashedWith = topic.id`）。個別削除済みの 1 件は `trashedWith: null` のまま変更されない（エッジケース: trashedWith の区別。不変条件 7。S-TR-02 のセット復元対象を分ける根拠） | |
| セット削除されたトピックとドキュメントが存在する | ゴミ箱内の各ドキュメントの `trashedWith` を確認する | すべて `topic.id` と一致する（不変条件 8。トピックのセット復元で一緒に戻る識別子） | |
| トピックが存在しない ID | 削除する | `NotFoundError` | |
| トピックが既にゴミ箱内 | 再度削除する | `findById` が Live のみ返すため `NotFoundError`（冪等な二重削除にはしない。AI からは「存在しない」扱い。S-AI-04） | |
| 他ユーザー所有のトピック ID | 削除する | userId スコープにより `NotFoundError` | |
| — | `topicId` に空文字を渡す | `BusinessRuleError(InvalidTopicId)` | |
| トピック取得後、並行する `updateTopic` / `createDocument`（トピック touch）が先に `save` 済み | 削除を実行する | トピックの `save` が 0 行更新となり `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。トピック・ドキュメントとも変更されない（createDocument の touch との直列化により「trashed トピック配下に active ドキュメントが生まれる」レースが排除される） | |
| 配下ドキュメントの取得後、並行する `editDocument` 等が先に当該ドキュメントを `save` 済み | 削除を実行する | ドキュメントの `save` が 0 行更新となり `ConflictError`。UoW 全体がロールバックされ、部分的なセット削除は残らない | |
| AI トークンで認証（MCP `delete`、`type: "topic"`） | トピックを削除する | presentation 層が本ユースケースへディスパッチし、人間 UI と同一のセット削除が行われる（S-AI-05） | |
| トピックが存在する | `DocumentRepository.save` で DB 例外が発生する | `SystemError(DatabaseError)`。ロールバックされ、状態遷移もインデックスエントリの除去も起きない | |
