# テストケース: hardDeleteTrashItem

[usecases/trash.md](../../usecases/trash.md) の hardDeleteTrashItem に対するテストケース。ADR-003（出典リンクの同期消去）を含む。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| メモがゴミ箱にあり、どのドキュメントの出典でもない | `kind: "memo"` でハードデリートを実行する | メモ本体と全リビジョンが消去される（`MemoRepository.hardDelete`）。`memo.hardDeleted` が収集され、`sourceLinksChanged` は発行されない | |
| メモがゴミ箱にあり、ドキュメント 2 件の出典である | `kind: "memo"` でハードデリートを実行する | 消去前に `listSourceLinksByMemo` で影響ドキュメントが確定され、同一 UoW で `deleteSourceLinksByMemo` により出典リンクが消去される（ADR-003: 相手側に「削除済み」表示も残さない）。`memo.hardDeleted` + 影響ドキュメント 2 件への `document.sourceLinksChanged` が収集される | |
| 個別削除されたドキュメント（`trashedWith: null`）がゴミ箱にあり、出典メモが 2 件ある | `kind: "document"` でハードデリートを実行する | 消去前に `listSourceLinksByDocument` で出典メモが確定され、`DocumentRepository.delete` が全リビジョンと documentId 側の出典リンクを同一バッチで消去する。`document.hardDeleted` + 出典メモ 2 件への `memo.sourceLinksChanged` が収集される | |
| セット削除された配下ドキュメントを単独でゴミ箱項目として指定する | `kind: "document"` でハードデリートを実行する | 当該ドキュメントのみ消去される（トピックや他の配下には波及しない） | |
| セット削除されたトピック（`setDocumentIds` に配下 2 件）がゴミ箱にある | `kind: "topic"` でハードデリートを実行する | `HardDeletePolicy.expandTargets` により配下 2 件も対象に展開され（セット展開）、配下ドキュメントの消去後にトピックが消去される。`document.hardDeleted` × 2 + `topic.hardDeleted` が収集される | |
| セット削除されたトピックの配下ドキュメントが他メモを出典に持つ | `kind: "topic"` でハードデリートを実行する | 展開された各ドキュメントについても消去前に出典メモが確定され、`memo.sourceLinksChanged` が発行される | |
| トピックがゴミ箱にあり、同一トピックから個別削除されたドキュメント（`trashedWith: null`）もゴミ箱にある | `kind: "topic"` でハードデリートを実行する | 個別削除分は `setDocumentIds` に含まれず消去対象外。ゴミ箱に残る（ADR-001 却下代替案: ユーザーが明示していない不可逆削除を作らない） | |
| 配下ドキュメントを持たないトピックがゴミ箱にある | `kind: "topic"` でハードデリートを実行する | `documentIds: []` に展開され、トピックのみ消去される | |
| 出典が全てハードデリートされたドキュメントが残る | メモをハードデリート後、ドキュメントを閲覧する | 「元になったメモ」一覧は空になり得るが、ドキュメント自体の内容には影響しない（ADR-003 影響） | |
| 保持期限間近（`expiresAt` 直前）の項目 | ハードデリートを実行する | 期限内でもユーザーの明示操作として消去される | |
| 展開後の一部対象が UoW 内の再取得時に不在（並行する emptyTrash / pruner が先に消去済み） | `kind: "topic"` でハードデリートを実行する | 不在の対象は no-op として続行し、残りの対象は消去される | |
| — | `kind` に列挙外の値（例: "user"）を渡す | バリデーションエラー | |
| — | `id` に空文字（形式不正）を渡す | バリデーションエラー | |
| `userId` に対応するユーザーが存在しない | ハードデリートを実行する | `NotFoundError` | |
| 指定 ID の項目が存在しない | ハードデリートを実行する | `NotFoundError` | |
| 指定 ID の項目が通常状態（ゴミ箱にない） | ハードデリートを実行する | `NotFoundError`（ゴミ箱外の項目を直接ハードデリートする経路は存在しない） | |
| 指定 ID の項目が他ユーザー所有でゴミ箱にある | ハードデリートを実行する | `NotFoundError` | |
| 再取得後 delete までの間に並行する復元が version を進める | ハードデリートを実行する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。UoW はロールバックされ、リンク消去・イベントも取り消される | |
| リポジトリで DB 例外が発生する | ハードデリートを実行する | `SystemError(DatabaseError)`。トランザクションはロールバックされる | |
