# Trash ユースケース設計

trash ドメインのユースケース定義。上流: [domains/trash.md](../domains/trash.md)、[scenario/trash.md](../scenario/trash.md)、[ADR-001](../adr/001-restore-document-without-topic.md)、[ADR-003](../adr/003-source-link-after-hard-delete.md)。

## 共通事項

- **すべて人間 UI 専用（★）**。AI クライアント向けインターフェース（MCP / REST）には存在しない。本ドメインのユースケースは `actor` を入力に持たないため型による強制は主張せず、AI 側 presentation（MCP / REST）に配線しないこと（application 層の公開範囲 = 配線分離）で構造的に排除する。加えて AI トークンの認可ミドルウェアは、AiScope の許可ユースケース列挙（許可リスト方式）に本ドメインのユースケースを含めない（domains/identity.md「TokenScope」の二層防壁、domains/index.md「権限の非対称性」、domains/trash.md「AI非公開」）。唯一の例外は pruneExpiredTrashItems で、これはユーザー操作を伴わないワーカー実行であり、いかなる外部インターフェースにも公開しない
- `userId` はセッション由来の信頼済み値として入力 DTO に含める（外部入力ではない）。対象 ID の所有権はリポジトリ / ポートの userId スコープにより構造的に保証され、他ユーザー所有の ID は NotFound となる（domains/index.md「テナント分離」）。ユースケースごとの所有権チェックは記載しない
- `now` / 新規 ID はユースケース冒頭で `container.clock.now()` / `container.idGenerator.next()` により解決する。外部入力の ID は冒頭で VO（`MemoId.create` 等）を構築し、形式違反は `BusinessRuleError`（presentation 境界で `ValidationError` に変換）
- 保持日数は identity の `UserId` スコープで取得する: `UserRepository.findById(userId)` → `user.trashRetentionDays`（`TrashRetentionDays`）。`TrashQueryPort.listTrashItems` / `findTrashItem` に渡し、`expiresAt` はポート実装が `RetentionPolicy.expiresAt` で算出する
- trash は書き込みポートを持たない。書き込みはすべて memo / knowledge の Repository（UnitOfWork 経由）で行い、ビジネスロジックはドメインサービス（`RestorePolicy` / `HardDeletePolicy` / `RetentionPolicy` / `TopicTrashService`）とエンティティの振る舞い（`Memo.restore` / `Document.restore` / `Document.moveToTopic` / `Topic.create`）に置く。ユースケースはそれらのオーケストレーションのみを担う
- 「見つからない」（不在 / ゴミ箱にない / 他ユーザー所有）は各ポートが null / 空で返し、`NotFoundError` への変換はユースケースの責務

## listTrash ★

### 概要

ゴミ箱一覧（メモ / ドキュメント / トピックを横断した `TrashItem` の射影）を削除日時の降順・ページング付きで取得する。各項目の保持期限（`expiresAt`）とセット関係（トピックとセット削除されたドキュメントの識別）を含む（S-TR-01）。

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | セッション由来。`UserId.create` で VO 構築 |
| page | number | 必須 | 1 以上の整数 |
| limit | number | 必須 | 1〜100 の整数 |

### 出力DTO

| フィールド | 型 |
|---|---|
| items | TrashItemView[] |
| totalCount | number（ゴミ箱の総件数。「空にする」確認の件数表示にも用いる） |
| page / limit | number |

TrashItemView（`kind` による直和）:

| フィールド | 型 |
|---|---|
| kind | "memo" \| "document" \| "topic" |
| id | string |
| excerpt | string（memo のみ。本文の先頭抜粋） |
| title | string（document のみ） |
| topicId | string（document のみ。削除時点の所属トピック） |
| deletedWithTopic | boolean（document のみ。セット削除フラグ。S-TR-01 のセット関係表示に使う） |
| name | string（topic のみ） |
| setDocumentIds | string[]（topic のみ。セット削除された配下ドキュメント ID 群） |
| trashedAt | Date |
| expiresAt | Date（照会時に `RetentionPolicy.expiresAt` で算出。保持期限変更は遡及適用される） |

### 処理フロー

1. `UserId.create(input.userId)` で VO を構築する
2. `UserRepository.findById(userId)` でユーザーを取得し、`trashRetentionDays` を得る（不在は `NotFoundError`）
3. `TrashQueryPort.listTrashItems(userId, retentionDays, pagination)` で `TrashItem` のページを取得する（削除日時の降順。`expiresAt` はポート実装が付与）
4. `PaginationResult` を view に射影して返す。0 件は空配列（S-TR-01 エッジケース「ゴミ箱が空」の表示は UI の責務）

### エラーケース

| 条件 | 種類 |
|---|---|
| page / limit が範囲外 | バリデーションエラー |
| ユーザー不在 | NotFoundError |
| DB 障害 | SystemError(DatabaseError) |

## restoreMemo ★

### 概要

ゴミ箱内のメモを復元する。`postedAt` は不変のため、タイムラインの元の位置に戻る（S-TR-02）。復元後は当該メモを出典とするドキュメント側の「削除済み」表示が解消される（リンクはソフトデリート中も保持されているため、trash 側の追加操作は不要）。

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | `UserId.create` |
| memoId | string | 必須 | `MemoId.create`（trim 後非空） |

### 出力DTO

| フィールド | 型 |
|---|---|
| memoId | string |

### 処理フロー

1. `UserId.create` / `MemoId.create` で VO を構築する
2. UnitOfWork 内で実行する:
   1. `MemoRepository.findByIdIncludingTrashed(userId, memoId)` で OCC トークン付きの対象を取得する。null、または `status` が `"trashed"` でない場合は `NotFoundError`（ゴミ箱にない）
   2. `Memo.restore(trashedMemo, now)` で `ActiveMemo` とイベントドラフト（`memo.restored`）を得る
   3. `MemoRepository.save(restored, expectedVersion)` で永続化する
   4. `collectEvents(eventDrafts)`（search consumer がインデックスへ再登録し、出典先ドキュメントのエントリも再 upsert する）

### エラーケース

| 条件 | 種類 |
|---|---|
| memoId 形式不正 | バリデーションエラー |
| 対象が不在 / ゴミ箱にない / 他ユーザー所有 | NotFoundError |
| OCC 競合（並行する復元・ハードデリート） | ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DB 障害 | SystemError(DatabaseError) |

## restoreDocument ★

### 概要

ゴミ箱内のドキュメントを復元する。所属トピックの現況に応じた分岐は `RestorePolicy.decideDocumentRestore` が返す `DocumentRestorePlan` で表現する（S-TR-02、ADR-001）:

- `restoreAlone` — トピックが存命（アーカイブ済み含む）。そのまま単独復元する
- `restoreWithTopic` — トピックもゴミ箱内。トピックごとセット復元される旨の確認を経て `TopicTrashService.restoreTopicSet` を実行する。復元要求対象のドキュメント自身が個別削除（`trashedWith: null`）のため `skippedDocuments` に分類された場合は、同一 UoW 内で当該ドキュメントを追加で `Document.restore` する（「復元を要求した当のドキュメントは必ず復元される」の保証）
- `selectDestination` — トピックはハードデリート済み。復元先トピックの選択（既存 / 新規作成）を受けて `Document.moveToTopic` → `Document.restore` する

確認・選択が未提供の場合は書き込みを行わず、必要な応答（確認要求 / 選択要求）を返す。確認後の再呼び出しでも現況から plan を再判定し、入力の確認・選択は再判定した plan と一致する分岐でのみ使用する（確認中に状況が変わっても不整合な復元をしない）。

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | `UserId.create` |
| documentId | string | 必須 | `DocumentId.create` |
| confirmSetRestore | boolean | 任意 | `restoreWithTopic` 分岐の確認済みフラグ。省略時 false |
| destination | object | 任意 | `selectDestination` 分岐の復元先。下記いずれか |

destination（直和）:

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| kind | "existing" \| "new" | 必須 | — |
| topicId | string | kind: "existing" で必須 | `TopicId.create` |
| name | string | kind: "new" で必須 | `TopicName` の規則（非空・改行なし・100文字以内） |
| description | string \| null | 任意 | `TopicDescription` の規則（非空・500文字以内。省略は null） |

### 出力DTO

`result` による直和:

| フィールド | 型 |
|---|---|
| result | "restored" \| "setRestoreConfirmationRequired" \| "destinationSelectionRequired" |
| documentId | string |
| restoredTopicId | string \| null（"restored" 時。セット復元 / 復元先選択で復元・作成されたトピック ID。単独復元時は null） |
| topicId | string（"setRestoreConfirmationRequired" 時。一緒に復元されるトピック） |
| topicName | string（同上。確認ダイアログの表示用） |

### 処理フロー

1. `UserId.create` / `DocumentId.create` で VO を構築する（destination があれば `TopicId.create` も）
2. `UserRepository.findById(userId)` で `trashRetentionDays` を得る
3. `TrashQueryPort.findTrashItem(userId, { kind: "document", id }, retentionDays)` で対象の `TrashedDocumentItem` を取得する。null は `NotFoundError`
4. `TopicRepository.findByIdIncludingTrashed(userId, item.topicId)` で所属トピックの現況を調べ、`TopicStatusForRestore` に写像する（`LiveTopic` → `active`、`TrashedTopic` → `trashed`、null → `hardDeleted`）
5. `plan = RestorePolicy.decideDocumentRestore(item, topicStatus)` で分岐を判定する
6. `plan.kind` ごとに実行する:
   - **restoreAlone**: UnitOfWork 内で:
     1. `TopicRepository.findById(userId, item.topicId)` で復元先トピックを OCC トークン付きで再取得する（Live のみ返る。null は確認中に現況が変わったとみなし、手順 4 から再判定した扱いで処理: trashed なら restoreWithTopic の確認要求、ハードデリート済みなら selectDestination の選択要求を返す）
     2. **復元先トピックを touch する（createDocument と同方式のレース排除）**: `TopicRepository.save(topic, expectedVersion)` で内容を変えず `version` をインクリメントする（イベントも発行しない）。これにより復元が並行する `trashTopic`（`listActiveByTopic` によるセット削除対象の確定）と OCC で直列化され、どちらかが `ConflictError` になる。「trashed トピック配下に active ドキュメント」が復元経由で生まれるレースを構造的に排除する
     3. `DocumentRepository.findByIdIncludingTrashed(userId, documentId)` により OCC トークン付きの `TrashedDocument` を再取得（null / active は `NotFoundError`）→ `Document.restore(doc, now)` → `DocumentRepository.save` → `collectEvents`（`document.restored`）。`result: "restored"` を返す
   - **restoreWithTopic**: `input.confirmSetRestore` が true でなければ書き込みせず `result: "setRestoreConfirmationRequired"`（`topicId`・`topicName` は手順 4 の `TrashedTopic` から）を返す。確認済みなら UnitOfWork 内で:
     1. `TopicRepository.findByIdIncludingTrashed(userId, plan.topicId)` で OCC トークン付き `TrashedTopic` を取得（trashed でなければ現況が変わったとみなし手順 4 から再判定した扱いで処理: 存命なら restoreAlone 相当、不在なら selectDestination 要求）
     2. `DocumentRepository.listTrashedByTopic(userId, plan.topicId)` でトピック配下のゴミ箱内ドキュメント全件（`Versioned<TrashedDocument>[]`）を取得する
     3. `TopicTrashService.restoreTopicSet(topic, documents, now)` を実行する（`trashedWith === topic.id` のみ restore され、個別削除分は `skippedDocuments` に返る。`topic.restored` + 復元数分の `document.restored` のイベントドラフト）
     4. `TopicRepository.save`（復元後トピック）と、`restoredDocuments` 各件の `DocumentRepository.save` を行う（OCC トークンは手順 1〜2 の読み取りが発行済み）
     5. 復元要求対象のドキュメントが `skippedDocuments` に含まれる場合、同一 UoW 内で追加に `Document.restore(そのドキュメント, now)` → `DocumentRepository.save` → その `document.restored` も収集する（トピックは直前に復元済みのため「必ずトピックに属する」不変条件を満たす）。それ以外の `skippedDocuments` はゴミ箱に残す
     6. `collectEvents(全イベントドラフト)`
   - **selectDestination**: `input.destination` がなければ書き込みせず `result: "destinationSelectionRequired"` を返す。指定済みなら UnitOfWork 内で:
     1. 復元先の確定: `kind: "existing"` なら `TopicRepository.findById(userId, destination.topicId)` で OCC トークン付きで取得（Live のみ返る。null は `NotFoundError` — ゴミ箱内・不在のトピックは復元先にできない）し、続けて **復元先トピックを touch する**: `TopicRepository.save(topic, expectedVersion)` で内容を変えず `version` をインクリメントする（イベントなし。restoreAlone と同じく並行する `trashTopic` と OCC で直列化するレース排除）。`kind: "new"` なら `Topic.create({ id: idGenerator.next(), userId, name, description }, now)` → `TopicRepository.insert` し、`topic.created` を収集する（新規作成トピックは並行 `trashTopic` の対象になり得ないため touch は不要）
     2. `DocumentRepository.findByIdIncludingTrashed(userId, documentId)` で OCC トークン付き `TrashedDocument` を再取得する
     3. `Document.moveToTopic(doc, destinationTopicId, now)` で復元先を差し替える（`trashedWith` は null になる。イベントなし）→ 続けて `Document.restore(moved, now)`
     4. `DocumentRepository.save` → `collectEvents`（`document.restored`）

復元後、当該ドキュメントの出典リンクの「削除済み」表示は解消される（リンクは保持されているため追加操作なし。S-TR-02 エッジケース）。

### エラーケース

| 条件 | 種類 |
|---|---|
| documentId / destination の形式不正（新規トピック名の規則違反含む） | バリデーションエラー |
| 対象が不在 / ゴミ箱にない / 他ユーザー所有 | NotFoundError |
| 復元先の既存トピックが不在・ゴミ箱内・他ユーザー所有 | NotFoundError |
| `restoreTopicSet` に topicId 不一致のドキュメントが混入（防衛的） | BusinessRuleError(TrashedWithMismatch) |
| 復元先トピックの touch（`save`）が並行する `trashTopic` / `updateTopic` と競合し 0 行更新 | ConflictError("OPTIMISTIC_LOCK_FAILURE")（ドキュメントは復元されない。利用者は再試行） |
| OCC 競合（並行する復元・ハードデリート・pruner） | ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DB 障害 | SystemError(DatabaseError) |

## restoreTopic ★

### 概要

ゴミ箱内のトピックを、セット削除された配下ドキュメント（`trashedWith === topic.id`）ごとセット復元する（S-TR-02）。トピックは `wasArchived` に従い active / archived へ戻る。個別に削除されたドキュメント（`trashedWith: null`）はゴミ箱に残る。

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | `UserId.create` |
| topicId | string | 必須 | `TopicId.create` |

### 出力DTO

| フィールド | 型 |
|---|---|
| topicId | string |
| restoredDocumentIds | string[]（セット復元されたドキュメント） |

### 処理フロー

1. `UserId.create` / `TopicId.create` で VO を構築する
2. UnitOfWork 内で実行する:
   1. `TopicRepository.findByIdIncludingTrashed(userId, topicId)` で OCC トークン付きの対象を取得する。null、または `status` が `"trashed"` でない場合は `NotFoundError`
   2. `DocumentRepository.listTrashedByTopic(userId, topicId)` でトピック配下のゴミ箱内ドキュメント全件（`Versioned<TrashedDocument>[]`）を取得する
   3. `TopicTrashService.restoreTopicSet(topic, documents, now)` を実行する（`topic.restored` 1件 + 復元数分の `document.restored`。個別削除分は `skippedDocuments` としてゴミ箱に残す）
   4. `TopicRepository.save`（復元後トピック）、`restoredDocuments` 各件の `DocumentRepository.save` を行う
   5. `collectEvents(eventDrafts)`

### エラーケース

| 条件 | 種類 |
|---|---|
| topicId 形式不正 | バリデーションエラー |
| 対象が不在 / ゴミ箱にない / 他ユーザー所有 | NotFoundError |
| 配下に topicId 不一致のドキュメントが混入（防衛的） | BusinessRuleError(TrashedWithMismatch) |
| OCC 競合 | ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DB 障害 | SystemError(DatabaseError) |

## hardDeleteTrashItem ★

### 概要

ゴミ箱項目（メモ / ドキュメント / トピック）を、リビジョン履歴・出典リンクごと完全消去する（S-TR-03、ADR-003）。対象範囲は `HardDeletePolicy.expandTargets` が定める: トピックはセット削除された配下ドキュメント（`setDocumentIds`）も対象に含み、個別に削除されたドキュメントは含めない（ADR-001 の却下代替案参照）。「元に戻せない」旨の確認表示は UI の責務。

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | `UserId.create` |
| kind | "memo" \| "document" \| "topic" | 必須 | 列挙値 |
| id | string | 必須 | kind に応じ `MemoId.create` / `DocumentId.create` / `TopicId.create` |

### 出力DTO

なし（void）。

### 処理フロー

1. VO を構築し、`TrashItemRef` を組み立てる
2. `UserRepository.findById(userId)` で `trashRetentionDays` を得る
3. `TrashQueryPort.findTrashItem(userId, ref, retentionDays)` で対象の `TrashItem` を取得する。null は `NotFoundError`（ゴミ箱外の項目を直接ハードデリートする経路は存在しない）。topic 項目の `setDocumentIds` はポートが射影時に埋めるため追加照会は不要
4. `plan = HardDeletePolicy.expandTargets(item)` で消去対象の `HardDeletePlan`（`memoIds` / `documentIds` / `topicIds`）に展開する
5. UnitOfWork 内で plan を実行する（並行実行で既に消えている対象は no-op として続行する）:
   - `memoIds` の各件:
     1. 消去前に `DocumentRepository.listSourceLinksByMemo(userId, memoId)` で当該メモを出典とする影響ドキュメント ID 群を確定する
     2. `MemoRepository.findByIdIncludingTrashed(userId, memoId)` で OCC トークン付きの対象を再取得する（不在なら no-op）
     3. `MemoRepository.hardDelete(memoId, expectedVersion)` でメモ本体と全リビジョンを消去する
     4. 同一 UoW で `DocumentRepository.deleteSourceLinksByMemo(userId, memoId)` により出典リンクを消去する（ADR-003 の同期方式）
     5. `MemoEvents.hardDeleted(memoId, now)` と、手順 1 の各影響ドキュメントへの `document.sourceLinksChanged` を発行（`collectEvents`）する
   - `documentIds` の各件:
     1. 消去前に `DocumentRepository.listSourceLinksByDocument(userId, documentId)` で出典メモ ID 群を確定する
     2. `DocumentRepository.findByIdIncludingTrashed(userId, documentId)` で OCC トークン付きの対象を再取得する（不在なら no-op）
     3. `DocumentRepository.delete(documentId, expectedVersion)` を実行する（アダプターが同一バッチで全リビジョンと documentId 側の出典リンクも消去する契約）
     4. `document.hardDeleted` と、手順 1 の各出典メモへの `memo.sourceLinksChanged` を発行する
   - `topicIds` の各件（配下ドキュメントの消去後に実行する）:
     1. `TopicRepository.findByIdIncludingTrashed(userId, topicId)` で OCC トークン付きの対象を再取得する（不在なら no-op）
     2. `TopicRepository.delete(topicId, expectedVersion)` を実行する
     3. `topic.hardDeleted` を発行する
6. 検索インデックスからの除去・影響先の再構築は、発行したイベントを outbox 経由で受けた search consumer が行う（ADR-005）

### エラーケース

| 条件 | 種類 |
|---|---|
| kind / id の形式不正 | バリデーションエラー |
| 対象がゴミ箱にない（不在 / 通常状態 / 他ユーザー所有） | NotFoundError |
| OCC 競合（並行する復元・pruner との衝突） | ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DB 障害 | SystemError(DatabaseError) |

## emptyTrash ★

### 概要

ゴミ箱内の全項目を一括ハードデリートする（S-TR-04）。実行前の件数表示付き確認は UI の責務（件数は listTrash の `totalCount`、または `TrashQueryPort.countTrashItems` で取得する）。ゴミ箱一覧にはセット削除トピックとその配下ドキュメントが両方項目として現れるため、全件に `HardDeletePolicy.expandTargets` を適用すると配下ドキュメントが「トピックの展開結果」と「単独のゴミ箱項目」で二重に消去対象になり得る。消去対象 ID 集合を種別ごとに和集合（重複除去）してから実行する。

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | `UserId.create` |

### 出力DTO

| フィールド | 型 |
|---|---|
| deletedCount | number（ハードデリートしたゴミ箱項目数） |

### 処理フロー

1. `UserId.create` で VO を構築し、`UserRepository.findById(userId)` で `trashRetentionDays` を得る
2. `TrashQueryPort.listTrashItems(userId, retentionDays, pagination)` をページ送りで繰り返し、ゴミ箱の全 `TrashItem` を取得する
3. 全項目に `HardDeletePolicy.expandTargets(item)` を適用し、結果を種別（memo / document / topic）ごとの ID 集合に**和集合（重複除去）**してまとめる
4. 集合内の各 ID について、hardDeleteTrashItem の手順 5 と同一の消去手順（影響先確定 → OCC トークン付き再取得 → ハードデリート → リンク消去 → `*.hardDeleted` / `*.sourceLinksChanged` の発行）を項目ごとの UnitOfWork で実行する。既にハードデリート済みの対象（再取得で不在）は **no-op として続行する**（pruner と同じ規約。重複除去後もなお並行実行と重なり得るため）
5. 1 件の失敗（OCC 競合等）は記録（logger）して次の項目へ進む。残件は再実行で消化できる（既に消えた項目は一覧に現れず、冪等）

### エラーケース

| 条件 | 種類 |
|---|---|
| ユーザー不在 | NotFoundError |
| 個別項目の OCC 競合 | ConflictError（記録して続行。全体は中断しない） |
| DB 障害 | SystemError(DatabaseError) |

ゴミ箱が空の場合はエラーにせず `deletedCount: 0` を返す。

## pruneExpiredTrashItems

### 概要

保持期限切れ（`trashedAt + retentionDays < now`）のゴミ箱項目を自動でハードデリートする（S-TR-05）。pruner ワーカー（Cloudflare Cron Trigger 等から起動）専用で、ユーザー操作はなく、いかなる外部インターフェースにも公開しない。依存（UnitOfWork・`TrashQueryPort`・memo / knowledge の各リポジトリ）はテンプレート既定の `WorkerContainer` では賄えないため、pruner 専用の拡張ワーカーコンテナを DI で組む。期限内の項目には一切触れない（「期限内であればいつでも復元できる」の保証）。

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| batchSize | number | 必須 | 1 以上の整数（ワーカー設定由来。1 実行の処理上限） |

ユーザー由来の入力はない。

### 出力DTO

| フィールド | 型 |
|---|---|
| processedCount | number（ハードデリートを実行した項目数） |
| failedCount | number（記録して先送りした項目数） |

### 処理フロー

1. `now = clock.now()` を取得する
2. `TrashQueryPort.listExpiredItems(now, batchSize)` で期限切れ項目（`ExpiredTrashItem = TrashItem & { userId }`）をバッチ取得する（ユーザー横断。各ユーザーの `TrashRetentionDays` 適用済み。期限切れ列挙はこの経路に一本化されており、`RetentionPolicy.isExpired` との一致はアダプターの契約）
3. 各項目を `HardDeletePolicy.expandTargets(item)` で `HardDeletePlan` に展開する（期限切れトピックは自身の `setDocumentIds` から展開され、配下ドキュメントごと消去される。追加のポート照会は不要）
4. 項目ごとに UnitOfWork 内で実行する（userId は `ExpiredTrashItem.userId` を各リポジトリメソッドの第一引数に渡す）:
   1. 消去前に影響先を確定する: メモは `DocumentRepository.listSourceLinksByMemo`、ドキュメントは `DocumentRepository.listSourceLinksByDocument`
   2. `findByIdIncludingTrashed`（memo / knowledge の各リポジトリ）で対象を OCC トークン付きで個別再取得し、`MemoRepository.hardDelete` / `DocumentRepository.delete` / `TopicRepository.delete` を実行する。メモの場合は同一 UoW で `DocumentRepository.deleteSourceLinksByMemo` も呼ぶ（ADR-003 の同期方式）
   3. `memo.hardDeleted` / `document.hardDeleted` / `topic.hardDeleted`、および影響先への `document.sourceLinksChanged` / `memo.sourceLinksChanged` を `collectEvents` で発行する。検索インデックスの除去・再構築は outbox 経由の consumer が行う
5. 1 件の失敗は記録（logger）して次の項目へ進む。バッチを使い切ったら残りは次回実行に委ねる（1 実行で全件を消化しようとしない）

冪等性: 既にハードデリート済みの項目は `listExpiredItems` に現れず、二重実行しても安全。同一項目への並行実行（emptyTrash / hardDeleteTrashItem との競合を含む）は OCC / 行不在の検出で片方が no-op になる。

### エラーケース

| 条件 | 種類 |
|---|---|
| 個別項目の OCC 競合・行不在 | no-op / 記録して続行（全体は中断しない） |
| DB 障害（列挙自体の失敗） | SystemError(DatabaseError)（当該実行を終了し次回に委ねる） |
