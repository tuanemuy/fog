# テストケース: restoreMemo

[usecases/trash.md](../../usecases/trash.md) の restoreMemo に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| メモが `status: "trashed"` でゴミ箱にある | 復元を実行する | `Memo.restore` により `ActiveMemo` となり `MemoRepository.save` で永続化される。`memoId` が返り、`memo.restored` イベントが収集される | |
| `postedAt` が過去日時のメモがゴミ箱にある | 復元を実行する | `postedAt` は変更されず、タイムラインの元の位置に戻る | |
| ゴミ箱内のメモが復元前にドキュメントの出典（「削除済み」表示中）である | 復元を実行する | 出典リンクを保持し、memo射影と出典先document射影が復元本体と同じtransactionで再upsertされる | |
| 保持期限間近（`expiresAt` 直前）のメモがゴミ箱にある（境界値: 期限内はいつでも復元可能） | 復元を実行する | 期限内であれば通常どおり復元される | |
| — | `memoId` に空文字（trim 後非空違反）を渡す | バリデーションエラー（`MemoId.create` の形式違反） | |
| 指定 ID のメモが存在しない | 復元を実行する | `NotFoundError` | |
| 指定 ID のメモが `status: "active"`（ゴミ箱にない） | 復元を実行する | `NotFoundError` | |
| 指定 ID のメモが他ユーザー所有でゴミ箱にある | 復元を実行する | `NotFoundError`（userId スコープにより不在扱い） | |
| 指定 ID のメモがハードデリート済み（行不在） | 復元を実行する | `NotFoundError` | |
| 取得後 save までの間に並行リクエスト（別の復元またはハードデリート）が version を進める | 復元を実行する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。トランザクションはロールバックされ、イベントも発行されない | |
| `MemoRepository` で DB 例外が発生する | 復元を実行する | `SystemError(DatabaseError)`。トランザクションはロールバックされる | |
