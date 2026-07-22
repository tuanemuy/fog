# テストケース: restoreDocument

[usecases/trash.md](../../usecases/trash.md) の restoreDocument に対するテストケース。ADR-001 の 3 分岐（restoreAlone / restoreWithTopic / selectDestination）を網羅する。

## restoreAlone（所属トピックが存命）

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ドキュメントがゴミ箱にあり、所属トピックは active で存命 | 復元を実行する | `plan: restoreAlone` と判定され、復元先トピックの touch（内容不変の `TopicRepository.save` で version インクリメント、イベントなし）→ `Document.restore` → save が同一 UoW で実行される。`result: "restored"`、`restoredTopicId: null`。`document.restored` イベントが収集される | |
| ドキュメントがゴミ箱にあり、所属トピックはアーカイブ済みで存命 | 復元を実行する | アーカイブ済みも `active` 扱いで `restoreAlone` となり、単独復元される | |
| ゴミ箱内のドキュメントが復元前にメモ側で「削除済み」出典表示中 | 復元を実行する | リンクは保持されているため追加操作なしで復元され、「削除済み」表示が解消される（S-TR-02 エッジケース） | |
| plan 判定時はトピック存命だったが、UoW 内の `findById` 再取得時にトピックが trashed に変化（確認中の状況変化） | 復元を実行する | 書き込みせず現況から再判定した扱いとなり、`result: "setRestoreConfirmationRequired"` を返す | |
| plan 判定時はトピック存命だったが、UoW 内の再取得時にトピックがハードデリート済みに変化 | 復元を実行する | 書き込みせず `result: "destinationSelectionRequired"` を返す | |
| 復元と並行して `trashTopic`（または `updateTopic`）が同一トピックの version を進める | 復元を実行する | 復元先トピックの touch（`save`）が 0 行更新となり `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。ドキュメントは復元されない（「trashed トピック配下に active ドキュメント」のレースを構造的に排除）。利用者は再試行 | |
| UoW 内の `findByIdIncludingTrashed` 再取得でドキュメントが不在（並行ハードデリート）または active（並行復元済み） | 復元を実行する | `NotFoundError` | |

## restoreWithTopic（所属トピックもゴミ箱内・セット復元）

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| セット削除されたドキュメント（`trashedWith: topicId`）とトピックがともにゴミ箱にある | `confirmSetRestore` を省略（または false）で復元を実行する | 書き込みは一切行われず `result: "setRestoreConfirmationRequired"` が返る。`topicId`・`topicName`（確認ダイアログ表示用）が含まれる（セット復元の確認） | |
| 同上 | `confirmSetRestore: true` で復元を実行する | `TopicTrashService.restoreTopicSet` によりトピックと `trashedWith === topic.id` の配下ドキュメント全件が同一 UoW で復元される。`result: "restored"`、`restoredTopicId: トピックID`。`topic.restored` 1 件 + 復元数分の `document.restored` が収集される | |
| トピックが `wasArchived: true` でゴミ箱にある | `confirmSetRestore: true` で復元を実行する | トピックは archived 状態へ戻り、セット復元も実行される | |
| 復元要求対象のドキュメントが個別削除（`trashedWith: null`）で、所属トピックもゴミ箱にある | `confirmSetRestore: true` で復元を実行する | `restoreTopicSet` では `skippedDocuments` に分類されるが、同一 UoW 内で追加の `Document.restore` により当該ドキュメントも復元される（「復元を要求した当のドキュメントは必ず復元される」）。その `document.restored` も収集される | |
| 上記に加え、他にも個別削除（`trashedWith: null`）のドキュメントが同一トピック配下でゴミ箱にある | `confirmSetRestore: true` で復元を実行する | 復元要求対象以外の `skippedDocuments` はゴミ箱に残る | |
| 確認要求後、再呼び出しまでの間にトピックが別操作で復元され存命になった（確認中の状況変化） | `confirmSetRestore: true` で復元を実行する | 現況から plan を再判定し restoreAlone 相当で処理される（不整合なセット復元をしない） | |
| 確認要求後、再呼び出しまでの間にトピックがハードデリートされた | `confirmSetRestore: true` で復元を実行する | 現況から再判定され `result: "destinationSelectionRequired"` を返す | |
| `DocumentRepository.listTrashedByTopic` の結果に topicId 不一致のドキュメントが混入（防衛的） | `confirmSetRestore: true` で復元を実行する | `BusinessRuleError(TrashedWithMismatch)` | |
| セット復元と並行して同一トピック / 配下ドキュメントの version が進む | `confirmSetRestore: true` で復元を実行する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。UoW 全体がロールバックされる | |

## selectDestination（所属トピックがハードデリート済み・ADR-001）

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| ドキュメントがゴミ箱にあり、削除時点の所属トピックはハードデリート済み（不在） | `destination` を省略して復元を実行する | 書き込みは一切行われず `result: "destinationSelectionRequired"` が返る | |
| 同上。復元先として存命の既存トピックがある | `destination: { kind: "existing", topicId }` で復元を実行する | 復元先トピックの touch（version インクリメント、イベントなし）→ `Document.moveToTopic`（`trashedWith` は null になる）→ `Document.restore` → save が同一 UoW で実行される。`result: "restored"`、`restoredTopicId: 選択トピックID`。`document.restored` が収集される | |
| 同上 | `destination: { kind: "new", name: "新トピック" }` で復元を実行する | `Topic.create` → `TopicRepository.insert` で新規トピックが作成され（touch は不要）、そこへ moveToTopic → restore される。`result: "restored"`、`restoredTopicId: 新規トピックID`。`topic.created` + `document.restored` が収集される | |
| 同上 | `destination: { kind: "new", name, description: null }`（description 省略）で復元を実行する | description は null として新規トピックが作成され、復元される | |
| 復元先の既存トピックが不在 / ゴミ箱内 / 他ユーザー所有 | `kind: "existing"` で復元を実行する | `NotFoundError`（ゴミ箱内・不在のトピックは復元先にできない） | |
| 復元先の既存トピックへの touch と並行して `trashTopic` / `updateTopic` が version を進める | `kind: "existing"` で復元を実行する | touch の `save` が 0 行更新となり `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。ドキュメントは復元されない | |
| — | `destination.topicId` の形式不正（`kind: "existing"`）で復元を実行する | バリデーションエラー | |
| — | `kind: "new"` で `name` が空文字 / 改行を含む / 101 文字で復元を実行する | バリデーションエラー（`TopicName` の規則違反） | |
| — | `kind: "new"` で `name` がちょうど 100 文字（境界値）で復元を実行する | 正常に復元される | |
| — | `kind: "new"` で `description` が 501 文字で復元を実行する | バリデーションエラー（`TopicDescription` の規則違反） | |
| — | `kind: "new"` で `description` がちょうど 500 文字（境界値）で復元を実行する | 正常に復元される | |

## 共通・異常系

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| — | `documentId` に空文字（形式不正）を渡す | バリデーションエラー | |
| `userId` に対応するユーザーが存在しない | 復元を実行する | `NotFoundError` | |
| 指定 ID のドキュメントが存在しない / active（ゴミ箱にない） / 他ユーザー所有 | 復元を実行する | `NotFoundError`（`TrashQueryPort.findTrashItem` が null） | |
| 保持期限間近（`expiresAt` 直前）のドキュメント（境界値: 期限内はいつでも復元可能） | 復元を実行する | 期限内であれば通常どおり復元される | |
| pruner / ハードデリートとの並行実行で UoW 内の再取得・save が競合する | 復元を実行する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` | |
| リポジトリ / ポートで DB 例外が発生する | 復元を実行する | `SystemError(DatabaseError)`。トランザクションはロールバックされる | |
