# テストケース: trashDocument

[usecases/knowledge.md](../../usecases/knowledge.md) の trashDocument に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active ドキュメントが存在する | ドキュメントを削除する | `status: "trashed"`, `trashedAt: now`, **`trashedWith: null`**（個別削除。セット削除と区別される）になり `version + 1`。同じ `transactionSync` の中で当該ドキュメントのエントリが `search_entries` / `search_fts` から除去され、出典メモのエントリが作り直される | |
| 個別削除されたドキュメントのトピックが後から `trashTopic` → セット復元される | セット復元後にゴミ箱を確認する | 個別削除分（`trashedWith: null`）はセット復元の対象外としてゴミ箱に残る（trashedWith の区別が効くことの確認。S-TR-02。復元自体は trash ドメインのテスト範囲） | |
| ドキュメントの出典リンク・リビジョン履歴が存在する | ドキュメントを削除する | 出典リンク・リビジョンは消えない（ソフトデリートは可逆。メモ側では「削除済みのドキュメント」表示になる。S-DT-08） | |
| ドキュメントが存在しない ID | 削除する | `NotFoundError` | |
| ドキュメントが既にゴミ箱内 | 再度削除する | `findById` が active のみ返すため `NotFoundError`（エッジケース: 二重削除。AI からゴミ箱内への `delete` は「存在しない」扱い。S-AI-04） | |
| 他ユーザー所有のドキュメント ID | 削除する | 到達可能性により `NotFoundError`（自分の Durable Object の中に他ユーザーの行が存在しない） | |
| — | `documentId` に空文字を渡す | `BusinessRuleError(InvalidDocumentId)` | |
| `findById` 後、並行する編集 / `trashTopic` のセット削除が先に `save` 済み | 削除を実行する | `save` が 0 行更新となり `ConflictError("OPTIMISTIC_LOCK_FAILURE")` | |
| AI トークンで認証（MCP `delete`、`type: "document"`） | ドキュメントを削除する | presentation 層が本ユースケースへディスパッチし、人間 UI と同一の振る舞い（S-AI-05） | |
| active ドキュメントが存在する | `DocumentRepository.save` で DB 例外が発生する | `SystemError(DatabaseError)`。ロールバックされ、状態遷移もインデックスエントリの除去も起きない | |
| `trashRetentionDays: 30` のユーザーの active ドキュメントが存在する | ドキュメントを削除する | `purgeAfter` に `RetentionPolicy.expiresAt(now, 30)` の算出結果が保存される。`trashed` であることと `purgeAfter` を持つことは同値である（trash.md「保持期限」） | |
| ゴミ箱が空で `purge-trash` が待機状態にある | ドキュメントを削除する | `save` と projection 更新と同じ `transactionSync` の中で `TrashQueryPort.findEarliestPurgeAfter()` が読まれ、現在予定されている起床より早ければ `purge-trash` の起床が張られる（**投入は早める方向にのみ効く**）。ここが5つの投入点の1つであり、書き落とすと以後の自動ハードデリート（S-TR-05）が走らない | |
