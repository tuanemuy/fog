# Knowledge ドメイン ユースケース設計

トピック・ドキュメント・出典リンクとドキュメントのリビジョン履歴に関するユースケースを定義する。

- 上流: [domains/knowledge.md](../domains/knowledge.md)、[scenario/document.md](../scenario/document.md)、[scenario/ai.md](../scenario/ai.md)
- 関連 ADR: [ADR-001](../adr/001-restore-document-without-topic.md)、[ADR-003](../adr/003-source-link-after-hard-delete.md)、[ADR-006](../adr/006-memo-fulltext-update.md)
- 復元・ハードデリート・保持期限の自動削除は trash ドメインのユースケース（`restoreTopic` / `restoreDocument` / `hardDeleteTrashItem` / `emptyTrash` 等）として定義し、本ファイルには含めない

## 共通事項

- **公開面**: 各ユースケースに「人間 UI ★（AI トークンのスコープに存在しない）/ AI API（MCP・REST）/ 両方」を明記する。★ 付きの排除は二層で保証する（domains/identity.md「TokenScope」）: `actor` を入力に持つ ★ ユースケース（editDocument / rollbackDocument）は `actor` の型を `UserActor` に限定して型エラーで排除し、`actor` を持たない ★ ユースケース（getTopic / listDocumentRevisions / diffDocumentRevisions 等）は AI 側 presentation（MCP / REST）に配線しないこと（配線分離）＋ AI トークンの認可ミドルウェアの許可ユースケース列挙に含めないことで排除する
- **テナント分離**: 外部入力の ID を受ける全ユースケースは、リポジトリの各メソッドに操作主体の `userId` を第一引数で渡す。他ユーザー所有の ID は「存在しない」（null / 空）となり NotFound で扱われるため、ユースケースごとの所有権チェックは記載しない（domains/index.md「テナント分離」）
- **NotFound 変換**: `findById` 系の `null` を `NotFoundError` に変換するのはユースケースの責務。AI 向けユースケースは `findById` / `listActiveByIds` 系（active / Live のみ返す）だけを使い、ゴミ箱内は構造的に「存在しない」扱いになる（S-AI-04）。`findByIdIncludingTrashed` / `listByIdsIncludingTrashed` を使えるのは人間 UI・trash 系ユースケースのみ
- **OCC**: 書き込みは UoW 内で `findById` 系が返した `ExpectedVersion` トークンを添えて `save` する。0 行更新は `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。汎用リトライは設けない
- **時刻・ID**: `now` は `container.clock.now()`、新規 ID は `container.idGenerator.next()` をユースケース冒頭で解決してドメインへ渡す
- **イベント**: ドメインの振る舞いが返す `EventDraft` を同一 UoW 内で `collectEvents` に渡す（Outbox 経由。ADR-005）
- **Actor**: リビジョンの「誰が」。人間 UI では認証済みユーザー、AI API ではトークン識別から presentation 層が解決し、入力 DTO の `actor` として渡す。人間 UI 専用（★）のユースケースは `actor` を `Actor` の `UserActor` バリアント（`{ kind: "user" }`）に狭めて受け、`AiClientActor` を渡すことは型エラーとする（AI 側の編集は別ユースケース editDocumentByAi）。両方公開のユースケース（createDocument 等）は `Actor` のまま受ける
- **DTO**: フィールドはプリミティブ型で表現する（ブランド VO を露出しない）。出力は `view.ts` のヘルパで射影する。**出力DTOの日時は `Date` で表現する**（memo / identity / search / trash と同一規約）。ISO 8601 文字列へのシリアライズは presentation 層の責務
- **AI 動詞 `get` / `delete` の種別ディスパッチ**: MCP / REST のツール入力スキーマに必須の種別フィールドを定める。`get` は `{ type: "memo" | "document"; id }`、`delete` は `{ type: "memo" | "document" | "topic"; id }`（`type` の語彙は search 結果の `type` と同じ）。presentation 層（MCP ツール / REST ハンドラ）が `type` で対応ユースケースへディスパッチする: `get` → memo の `get`（`type: "memo"`）/ `getDocument`（`type: "document"`）、`delete` → memo の `delete`（`type: "memo"`）/ `trashDocument`（`type: "document"`）/ `trashTopic`（`type: "topic"`）。ID は不透明文字列であり、`type` なしでのディスパッチは行わない
- **共通エラー**: DB 障害 → `SystemError(DatabaseError)`、値オブジェクト構築違反 → `BusinessRuleError<KnowledgeErrorCode>`。各ユースケースのエラーケースには固有のものだけを列挙する

### ユースケース一覧と公開面

| ユースケース | 公開面 | 対応 |
|---|---|---|
| createTopic | 両方（UI / MCP `create_topic`） | S-DT-01, S-AI-06 |
| updateTopic | 両方（UI / MCP `update_topic`） | S-DT-03, S-AI-06 |
| listTopics | 両方（UI / MCP `list_topics`） | S-DT-02, S-AI-02 |
| getTopic | 人間 UI ★ | S-DT-02 |
| trashTopic | 両方（UI / MCP `delete`） | S-DT-09, S-AI-05 |
| createDocument | 両方（UI / MCP `create_document`） | S-DT-04, S-AI-03 |
| editDocument | 人間 UI ★ | S-DT-05 |
| editDocumentByAi | AI API（MCP `edit_document`） | S-AI-04 |
| rollbackDocument | 人間 UI ★ | S-DT-06 |
| trashDocument | 両方（UI / MCP `delete`） | S-DT-08, S-AI-05 |
| getDocument | 両方（UI / MCP `get`） | S-DT-05, S-AI-02 |
| listDocumentRevisions | 人間 UI ★ | S-DT-06 |
| diffDocumentRevisions | 人間 UI ★ | S-DT-06 |
| listDocumentSourceMemos | 人間 UI ★ | S-DT-05, S-DT-07 |
| listDocumentsReferencingMemo | 人間 UI ★ | S-TL-07, S-DT-08 |

AI に公開するのは `createTopic` / `updateTopic` / `trashTopic` / `listTopics` / `createDocument` / `editDocumentByAi` / `trashDocument` / `getDocument` の 8 つのみで、requirements 4.5 の AI 公開動詞（`create_topic` / `update_topic` / `delete` / `list_topics` / `create_document` / `edit_document` / `get`）と 1:1 に対応する（`delete` はトピック / ドキュメントの各ソフトデリート）。

## createTopic

### 概要

トピックを作成する。名前は必須、説明文は任意（S-DT-01）。

公開面: 両方（人間 UI / MCP `create_topic`）。

### 入力DTO

`CreateTopicInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | 認証済み操作主体のユーザー ID |
| `name` | `string` | 必須 | `TopicName` の規則（trim 後非空、改行なし、100 文字以内）はドメインで検証 |
| `description` | `string \| null` | 任意（省略時 `null`） | 非 null 時は `TopicDescription` の規則（trim 後非空、500 文字以内）はドメインで検証 |

### 出力DTO

`CreateTopicOutput`

| フィールド | 型 |
|---|---|
| `id` | `string` |
| `name` | `string` |
| `description` | `string \| null` |
| `status` | `"active"` |
| `version` | `number` |
| `createdAt` / `updatedAt` | `Date` |

### 処理フロー

1. `now` と新規トピック ID を解決する
2. `Topic.create({ id, userId, name, description }, now)` で `ActiveTopic` と `topic.created` のイベントドラフトを得る（値オブジェクト構築・検証はドメイン内）
3. UoW 内で `TopicRepository.insert(topic)`、`collectEvents(drafts)`
4. トピックのビューを返す

### エラーケース

| 条件 | エラー |
|---|---|
| 名前・説明文が値オブジェクトの規則に違反 | `BusinessRuleError`（`EmptyTopicName` / `TopicNameMultiline` / `TopicNameTooLong` / `EmptyTopicDescription` / `TopicDescriptionTooLong`） |

## updateTopic

### 概要

トピックの名前・説明文の変更とアーカイブ切替（UI 用語は「完了」）を行う（S-DT-03, S-AI-06）。入力に応じて `Topic.rename` / `changeDescription` / `archive` / `unarchive` を合成する。

公開面: 両方（人間 UI / MCP `update_topic`）。

### 入力DTO

`UpdateTopicInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `topicId` | `string` | 必須 | `TopicId.create` で検証 |
| `name` | `string` | 任意 | 省略時は変更しない。指定時は `TopicName` の規則 |
| `description` | `string \| null` | 任意 | 省略時は変更しない。`null` で説明文を削除。非 null 時は `TopicDescription` の規則 |
| `archived` | `boolean` | 任意 | 省略時は変更しない。`true` = アーカイブ、`false` = アーカイブ解除 |

`name` / `description` / `archived` がすべて省略の場合は presentation 層（スキーマ）で `ValidationError`。

### 出力DTO

`UpdateTopicOutput` — `CreateTopicOutput` と同形（`status` は `"active" \| "archived"`）。

### 処理フロー

1. `now` を解決し、`TopicId.create(input.topicId)` で検索キーを構築する
2. UoW 内で `TopicRepository.findById(userId, topicId)`（Live のみ）。`null` なら `NotFoundError`（ゴミ箱内・他ユーザー所有・不存在を区別しない）
3. 入力に応じてドメインの振る舞いを順に適用し、イベントドラフトを蓄積する:
   - `name` 指定時: `Topic.rename(topic, name, now)`
   - `description` 指定時: `Topic.changeDescription(topic, description, now)`
   - `archived: true` かつ現状態 `active`: `Topic.archive(topic, now)` / `archived: false` かつ現状態 `archived`: `Topic.unarchive(topic, now)`。現状態と同じ指定は何もしない（冪等）
4. `TopicRepository.save(topic, expectedVersion)`、`collectEvents(drafts)`
5. トピックのビューを返す

### エラーケース

| 条件 | エラー |
|---|---|
| トピックが不存在・ゴミ箱内・他ユーザー所有 | `NotFoundError` |
| 名前・説明文が値オブジェクトの規則に違反 | `BusinessRuleError`（TopicName / TopicDescription 系） |
| 並行更新で `save` が 0 行更新 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |

## listTopics

### 概要

ゴミ箱外のトピックと配下 active ドキュメントの一覧を返す（S-DT-02, S-AI-02）。人間 UI ではアーカイブ済みを含めて取得し「完了済み」セクションに畳んで表示する。AI（`list_topics`）はトピック構成の把握に使う。

公開面: 両方（人間 UI / MCP `list_topics`）。

### 入力DTO

`ListTopicsInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `includeArchived` | `boolean` | 必須 | `false` なら active のみ |

presentation ごとの `includeArchived` の指定:

- **AI（MCP / REST）presentation は `includeArchived: true` を固定で渡す**（ツール入力としては公開しない）。アーカイブは「一覧の主要領域から退く」だけの状態であり AI から不可視にする要件はなく、S-AI-06 のアーカイブ解除（`update_topic` の `archived: false`）の前提として、アーカイブ済みトピックの ID を `list_topics` で発見可能にしておく必要があるため
- 人間 UI は P-06 の表示要件に応じて指定する（アーカイブ済みを含めて取得し「完了済み」セクションに畳む等）

### 出力DTO

`ListTopicsOutput`

| フィールド | 型 |
|---|---|
| `topics` | `readonly TopicWithDocumentsView[]` |

`TopicWithDocumentsView`

| フィールド | 型 |
|---|---|
| `id` / `name` | `string` |
| `description` | `string \| null` |
| `status` | `"active" \| "archived"` |
| `createdAt` / `updatedAt` | `Date` |
| `documents` | `readonly { id: string; title: string; updatedAt: Date }[]` |

### 処理フロー

1. `TopicRepository.listByUser(userId, { includeArchived })` でトピック一覧を取得する（安定順序）
2. トピック ID 群を `DocumentRepository.listActiveByTopics(userId, topicIds)` に渡し、配下 active ドキュメントを 1 クエリで一括取得する（N+1 にしない）
3. ドキュメントを `topicId` でグルーピングし、ビューに射影して返す。0 件は空配列（エラーにしない）

### エラーケース

固有のエラーなし（共通のみ）。

## getTopic ★

### 概要

トピック詳細を返す: トピック本体 + 配下 active ドキュメント一覧 + 関連メモ（配下ドキュメントの出典リンク集約。S-DT-02）。関連メモの「削除済み」表示のため IncludingTrashed 読み取りを含み、AI には配線しない（AI は `list_topics` のみ）。

公開面: 人間 UI ★。

### 入力DTO

`GetTopicInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `topicId` | `string` | 必須 | `TopicId.create` で検証 |

### 出力DTO

`GetTopicOutput`

| フィールド | 型 |
|---|---|
| `topic` | `TopicView`（`id` / `name` / `description` / `status: "active" \| "archived"` / `version` / `createdAt` / `updatedAt`） |
| `documents` | `readonly { id: string; title: string; updatedAt: Date }[]` |
| `relatedMemos` | `readonly RelatedMemoView[]` |

`RelatedMemoView`

| フィールド | 型 |
|---|---|
| `memoId` | `string` |
| `snippet` | `string`（本文抜粋） |
| `postedAt` | `Date` |
| `deleted` | `boolean`（ソフトデリート済みなら true。「削除済みのメモ」表示・遷移不可の判定用） |

### 処理フロー

1. `TopicId.create(input.topicId)` で検索キーを構築する
2. `TopicRepository.findById(userId, topicId)`（Live のみ。ゴミ箱内トピックの詳細は trash ドメインの責務）。`null` なら `NotFoundError`
3. `DocumentRepository.listActiveByTopic(userId, topicId)` で配下 active ドキュメントを取得する
4. 配下ドキュメント ID 群を `DocumentRepository.listSourceLinksByDocuments(userId, documentIds)` に渡し、出典リンクを 1 クエリで一括逆引きする（N+1 にしない）
5. リンクの `memoId` を重複除去し、`MemoRepository.listByIdsIncludingTrashed(userId, memoIds)` で本文・投稿日時・削除状態を取得する。ハードデリート済みメモは結果に含まれない = 表示されない（ADR-003）
6. ビューに射影して返す（配下ドキュメント 0 件・関連メモ 0 件は空配列）

### エラーケース

| 条件 | エラー |
|---|---|
| トピックが不存在・ゴミ箱内・他ユーザー所有 | `NotFoundError` |

## trashTopic

### 概要

トピックのソフトデリート。その時点で active な配下ドキュメントを `TopicTrashService.trashTopicSet` でセット削除する（S-DT-09, S-AI-05。不変条件 7）。個別削除済み（`trashedWith: null`）のドキュメントはセットに含めない。

公開面: 両方（人間 UI / MCP `delete`）。

種別ディスパッチ: AI の `delete` ツール入力は `{ type: "memo" | "document" | "topic"; id }`。presentation 層が `type: "topic"` を本ユースケースへルーティングする（共通事項「AI 動詞 `get` / `delete` の種別ディスパッチ」）。

### 入力DTO

`TrashTopicInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `topicId` | `string` | 必須 | `TopicId.create` で検証 |

### 出力DTO

`TrashTopicOutput`

| フィールド | 型 |
|---|---|
| `topicId` | `string` |
| `trashedDocumentIds` | `readonly string[]`（セット削除された配下ドキュメント ID） |

### 処理フロー

1. `now` を解決し、`TopicId.create(input.topicId)` で検索キーを構築する
2. UoW 内で `TopicRepository.findById(userId, topicId)`（Live のみ）。`null` なら `NotFoundError`
3. `DocumentRepository.listActiveByTopic(userId, topicId)` で配下 active ドキュメント全件を OCC トークン付きで取得する
4. `TopicTrashService.trashTopicSet(topic, documents, now)` で `TrashedTopic`・`TrashedDocument[]`（各 `trashedWith = topic.id`）と、`topic.trashed` 1 件 + `document.trashed` ドキュメント数分のイベントドラフトを得る
5. 同一 UoW 内で `TopicRepository.save(trashedTopic, expectedVersion)`、各ドキュメントを `DocumentRepository.save(trashedDocument, expectedVersion)`、`collectEvents(drafts)`
6. 削除結果のビューを返す

### エラーケース

| 条件 | エラー |
|---|---|
| トピックが不存在・ゴミ箱内・他ユーザー所有 | `NotFoundError`（ゴミ箱内への `delete` は AI から「存在しない」扱い。S-AI-04） |
| 並行更新で `save` が 0 行更新 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |

## createDocument

### 概要

ドキュメントを作成する（S-DT-04, S-AI-03）。第一リビジョン（全文スナップショット）と出典リンク群を同時に生成する。出典メモは任意（空配列可）。作成先トピックと出典メモ全件の実在・非ゴミ箱を検証してから `Document.create` を呼び、1 件でも不正なら全体を失敗させる（部分的に壊れた状態を作らない）。

公開面: 両方（人間 UI / MCP `create_document`）。

### 入力DTO

`CreateDocumentInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `actor` | `Actor` | 必須 | presentation 層が解決（人間ユーザー / AI クライアント） |
| `topicId` | `string` | 必須 | `TopicId.create` で検証 |
| `title` | `string` | 必須 | `DocumentTitle` の規則（trim 後非空、改行なし、200 文字以内）はドメインで検証 |
| `body` | `string` | 必須 | `DocumentBody` の規則（空文字可、1,000,000 文字以内）はドメインで検証 |
| `sourceMemoIds` | `readonly string[]` | 必須（空配列可） | 各要素は `MemoId.create` で検証 |
| `changeReason` | `string` | 任意 | 省略・空なら application 層が既定値「作成」を補完する（人間 UI / AI 共通。「なぜ」が空のリビジョンを存在させない）。指定時は `ChangeReason` の規則 |

### 出力DTO

`CreateDocumentOutput`

| フィールド | 型 |
|---|---|
| `id` | `string` |
| `topicId` | `string` |
| `title` / `body` | `string` |
| `latestRevision` | `number`（= 1） |
| `version` | `number`（= 0） |
| `sourceMemoIds` | `readonly string[]`（重複除去後） |
| `createdAt` / `updatedAt` | `Date` |

### 処理フロー

1. `now`、新規ドキュメント ID・リビジョン ID を解決し、`TopicId.create` / `MemoId.create` で検索キーを構築する
2. UoW 内で `TopicRepository.findById(userId, topicId)`（Live のみ）を **OCC トークン付き**で取得する。`null` なら `NotFoundError`（不存在・ゴミ箱内・他ユーザー所有を区別しない。S-AI-03 異常系）
3. `sourceMemoIds` を重複除去し、非空なら `MemoRepository.listActiveByIds(userId, memoIds)` で検証する。**要求 ID のうち結果に含まれないものが 1 件でもあれば `NotFoundError` で全体を失敗させる**（存在しない / ゴミ箱内 / 他ユーザー所有はいずれも「結果に含まれない」として一律 NotFound。AI にゴミ箱内の存在事実も漏らさない。`listByIdsIncludingTrashed` は本検証に使わない）
4. `changeReason` が省略・trim 後空なら「作成」を補完する
5. `Document.create({ id, revisionId, userId, topicId, title, body, actor, changeReason, sourceMemoIds }, now)` で `ActiveDocument`・リビジョン #1・SourceLink 群（重複除去済み）と `document.created` のイベントドラフトを得る
6. **作成先トピックを touch する（設計判断: `trashTopic` / `archiveTopic` とのレース排除）**: 同一 UoW 内で、手順 2 で読んだトピックを `TopicRepository.save(topic, expectedVersion)` で保存し `version` をインクリメントする（内容は変更しない。イベントも発行しない）。これによりドキュメント作成が並行する `trashTopic`（`listActiveByTopic` によるセット削除対象の確定）や `updateTopic` のアーカイブ切替と OCC で直列化され、どちらかが `ConflictError` になる。「ソフトデリート済みトピック配下に active ドキュメントが生まれる」レースを構造的に排除する
7. 同一 UoW 内で `DocumentRepository.insert(document)`、`insertRevision(revision)`、`insertSourceLinks(links)`、`collectEvents(drafts)`
8. ドキュメントのビューを返す

### エラーケース

| 条件 | エラー |
|---|---|
| 作成先トピックが不存在・ゴミ箱内・他ユーザー所有 | `NotFoundError` |
| 出典メモ ID に 1 件でも不存在・ゴミ箱内・他ユーザー所有が含まれる | `NotFoundError`（ドキュメントは作成されない） |
| タイトル・本文・変更理由が値オブジェクトの規則に違反 | `BusinessRuleError`（DocumentTitle / DocumentBody / ChangeReason 系） |
| 作成先トピックの touch（`save`）が並行する `trashTopic` / `updateTopic` と競合し 0 行更新 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`（ドキュメントは作成されない。利用者は再試行） |

## editDocument ★

### 概要

人間 UI からの全文形式の編集（S-DT-05）。タイトル・本文を差し替え、新リビジョンを積む。変更理由省略時は「手動編集」を application 層が補完する（この補完経路があるため AI には配線しない。AI の編集経路は `editDocumentByAi` のみ）。

編集競合の扱いは memo の `editMemo` と同方式: 編集開始時点の `version` を `expectedVersion` として受け、不一致（他者 = AI クライアントの介在編集）は**正常応答** `result: "conflict"` + `ConflictView` で返す（競合は業務上の正常フローであり、警告表示に必要な情報を一往復で返す）。

公開面: 人間 UI ★。

### 入力DTO

`EditDocumentInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `actor` | `UserActor` | 必須 | 人間ユーザー。`AiClientActor` を渡すことは型エラー（AI 側は editDocumentByAi） |
| `documentId` | `string` | 必須 | `DocumentId.create` で検証 |
| `title` | `string` | 必須 | `DocumentTitle` の規則はドメインで検証（空タイトル保存不可） |
| `body` | `string` | 必須 | `DocumentBody` の規則はドメインで検証 |
| `changeReason` | `string` | 任意 | 省略・空なら「手動編集」を補完。指定時は `ChangeReason` の規則 |
| `expectedVersion` | `number` | 必須 | 編集を開いた時点のドキュメント `version`（`getDocument` の出力から引き回す）。0 以上の整数（memo の `editMemo` と同名・同意味） |

### 出力DTO

`EditDocumentOutput`

| フィールド | 型 |
|---|---|
| `result` | `"saved" \| "unchanged" \| "conflict"` |
| `latestRevision` | `number`（現在の最新リビジョン番号） |
| `version` | `number`（現在の値。継続編集の次回 `expectedVersion` に使う） |
| `updatedAt` | `Date` |
| `conflict` | `ConflictView \| null`（`"conflict"` のときのみ非 null） |

`ConflictView`（警告表示用）:

| フィールド | 型 |
|---|---|
| `currentTitle` / `currentBody` | `string`（他者編集後の現在値。突き合わせ表示用） |
| `currentVersion` | `number`（「そのまま保存」時に `expectedVersion` として渡し直す値） |
| `latestRevision` | `{ revisionNumber: number; actor: { kind: "user" } \| { kind: "aiClient"; clientName: string }; changeReason: string; createdAt: Date }`（誰が・いつ・なぜ編集したか。Actor 表示名の解決込み） |

- 「そのまま保存」は、UI が警告表示後にユーザー確認のうえ本ユースケースを `expectedVersion = conflict.currentVersion` で再度呼ぶことで実現する（自分の内容が最新に対する新リビジョンとして積まれる。介在した編集もリビジョン履歴に残っており失われない。S-DT-05 異常系）

### 処理フロー

1. `now`、新規リビジョン ID を解決し、`DocumentId.create(input.documentId)` で検索キーを構築する
2. UoW 内で `DocumentRepository.findById(userId, documentId)`（active のみ）を OCC トークン付きで取得する。`null` なら `NotFoundError`
3. **編集競合検知（S-DT-05 異常系）**: 現在の `document.version !== input.expectedVersion` なら、**何も書かずに** `result: "conflict"` を組み立てて返す。`conflict.latestRevision` は `DocumentRepository.findRevision(userId, documentId, document.latestRevision)` で取得する（editMemo と同構造）
4. `changeReason` が省略・trim 後空なら「手動編集」を補完する
5. `Document.edit(document, { revisionId, title, body, actor, changeReason }, now)` を呼ぶ。タイトル・本文とも現在値と同一なら `unchanged` — リビジョンを積まず保存もせず `result: "unchanged"` で返す
6. `edited` なら同一 UoW 内で `DocumentRepository.save(document, expectedVersion)`、`insertRevision(revision)`、`collectEvents(drafts)` を行い `result: "saved"`
7. 結果のビューを返す

### エラーケース

| 条件 | エラー |
|---|---|
| ドキュメントが不存在・ゴミ箱内・他ユーザー所有 | `NotFoundError` |
| `expectedVersion` が現在の `version` と不一致（介在編集あり） | エラーにしない（`result: "conflict"` の正常応答。警告表示のため） |
| タイトル・本文・変更理由が値オブジェクトの規則に違反 | `BusinessRuleError`（DocumentTitle / DocumentBody / ChangeReason 系） |
| 手順 3 の判定通過後、save までの間に競合（レア）・`insertRevision` の `(documentId, revisionNumber)` 一意制約違反 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。UI は再取得して再試行 |

## editDocumentByAi

### 概要

AI からの編集（MCP `edit_document`。S-AI-04）。入力は判別可能ユニオン `{ mode: "patch"; patches } | { mode: "replaceAll"; body }` で、既定（`mode` 省略時）は `patch`。patch は `DocumentPatch.apply` で適用後の全文を得てから、replaceAll は受領した全文をそのまま `Document.edit` に渡す（どちらのモードも同じ `Document.edit` に到達する）。**いずれのモードでも `changeReason` は必須**（requirements 4.5。省略時はバリデーションエラーとし、既定値を補わない）。タイトルは変更しない（現行タイトルを維持して `Document.edit` に渡す）。

`replaceAll` はユーザーが明示的に全面書き直しを求めた場合に限る（requirements 4.3）。この制約はドメインで機械的に強制できないため、MCP ツール定義のガイダンスに明記して担保する。本文が空のドキュメントは `oldText` 非空必須のためパッチを適用できず、`replaceAll` が唯一の AI 編集経路となる。

公開面: AI API（MCP `edit_document`）。

### 入力DTO

`EditDocumentByAiInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | トークンから解決 |
| `actor` | `Actor` | 必須 | AI クライアント（トークン識別） |
| `documentId` | `string` | 必須 | `DocumentId.create` で検証 |
| `edit` | `{ mode: "patch"; patches: readonly { oldText: string; newText: string }[] } \| { mode: "replaceAll"; body: string }` | 必須 | `mode` 省略時は `patch`。patch の規則（1 件以上、`oldText` 非空、`newText` 空文字可）は `DocumentPatch.create` で検証。replaceAll の `body` は `DocumentBody` の規則 |
| `changeReason` | `string` | 必須 | **省略・trim 後空は presentation/application 層で `ValidationError`（既定値を補わない）**。`ChangeReason` の規則はドメインで検証 |

### 出力DTO

`EditDocumentByAiOutput`

| フィールド | 型 |
|---|---|
| `changed` | `boolean`（適用結果が現在値と同一なら false） |
| `latestRevision` | `number` |
| `updatedAt` | `Date` |

### 処理フロー

1. `changeReason` の必須検証（省略・空 → `ValidationError`。補完しない）
2. `now`、新規リビジョン ID を解決し、`DocumentId.create(input.documentId)` で検索キーを構築する
3. UoW 内で `DocumentRepository.findById(userId, documentId)`（active のみ）。`null` なら `NotFoundError`（ゴミ箱内は AI から「存在しない」扱い。S-AI-04）
4. モードごとに適用後の全文を得る（モード差はここで吸収する）:
   - `patch`: `DocumentPatch.create(patches)` → `DocumentPatch.apply(document.body, patch)`。各 hunk の `oldText` がその時点の本文中に完全一致でちょうど 1 箇所見つからなければ失敗（0 箇所 → `PatchTargetNotFound`、2 箇所以上 → `PatchTargetAmbiguous`）。いずれかの hunk が失敗したらパッチ全体が失敗し、ドキュメントは変更されない（部分適用しない）
   - `replaceAll`: 受領した `body` をそのまま適用後の全文とする
5. `Document.edit(document, { revisionId, title: 現行タイトル, body: 適用後の全文, actor, changeReason }, now)` を呼ぶ。現在値と同一なら `unchanged` — リビジョンを積まず `changed: false` で返す
6. `edited` なら同一 UoW 内で `DocumentRepository.save(document, expectedVersion)`、`insertRevision(revision)`、`collectEvents(drafts)`
7. 結果のビューを返す

### エラーケース

| 条件 | エラー |
|---|---|
| `changeReason` の省略・空 | `ValidationError`（S-AI-04 異常系） |
| ドキュメントが不存在・ゴミ箱内・他ユーザー所有 | `NotFoundError`（ゴミ箱内の存在事実を漏らさない） |
| パッチの `oldText` が本文中に見つからない（本文が既に変わっている等） | `BusinessRuleError(PatchTargetNotFound)` — AI は `get` で最新を取り直して再試行する |
| パッチの `oldText` が本文中に 2 箇所以上一致 | `BusinessRuleError(PatchTargetAmbiguous)` — AI は周辺文脈を含めた一意な `oldText` で再試行する |
| パッチが空・`oldText` が空文字 | `BusinessRuleError`（`EmptyPatch` / `EmptyPatchOldText`） |
| 適用結果・変更理由が値オブジェクトの規則に違反 | `BusinessRuleError`（`DocumentBodyTooLong` / ChangeReason 系） |
| 並行更新で `save` が 0 行更新・`insertRevision` の一意制約違反 | `ConflictError` |

## rollbackDocument ★

### 概要

過去リビジョンのタイトル・本文と同内容の**新リビジョン**を積む（S-DT-06。履歴は削除しない）。変更理由省略時は「リビジョン{n}の内容に戻す」を application 層が補完する。「AI が何をしても人間が復元できる」体験の中心となる操作。

公開面: 人間 UI ★（履歴閲覧・ロールバックは AI トークンのスコープに存在しない）。

### 入力DTO

`RollbackDocumentInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `actor` | `UserActor` | 必須 | 人間ユーザー。`AiClientActor` を渡すことは型エラー（ロールバックは AI トークンのスコープに存在しない） |
| `documentId` | `string` | 必須 | `DocumentId.create` で検証 |
| `revisionNumber` | `number` | 必須 | 戻し先。`RevisionNumber.create`（1 以上の整数）で検証 |
| `changeReason` | `string` | 任意 | 省略・空なら「リビジョン{n}の内容に戻す」を補完。指定時は `ChangeReason` の規則 |

### 出力DTO

`RollbackDocumentOutput`

| フィールド | 型 |
|---|---|
| `changed` | `boolean`（現在の内容と同一なら false） |
| `latestRevision` | `number` |
| `version` | `number` |
| `updatedAt` | `Date` |

### 処理フロー

1. `now`、新規リビジョン ID を解決し、`DocumentId.create` / `RevisionNumber.create` で検索キーを構築する
2. UoW 内で `DocumentRepository.findById(userId, documentId)`（active のみ）。`null` なら `NotFoundError`
3. `DocumentRepository.findRevision(userId, documentId, revisionNumber)` で戻し先リビジョンを取得する。`null` なら `NotFoundError`
4. `changeReason` が省略・trim 後空なら「リビジョン{n}の内容に戻す」を補完する
5. `Document.rollback(document, target, { revisionId, actor, changeReason }, now)` を呼ぶ。現在の内容と同一なら `unchanged` — リビジョンを積まず `changed: false` で返す
6. `edited` なら同一 UoW 内で `DocumentRepository.save(document, expectedVersion)`、`insertRevision(revision)`、`collectEvents(drafts)`（`document.edited` を発行。ロールバックも編集の一種）
7. 結果のビューを返す

### エラーケース

| 条件 | エラー |
|---|---|
| ドキュメントが不存在・ゴミ箱内・他ユーザー所有 | `NotFoundError` |
| 指定リビジョンが不存在 | `NotFoundError` |
| 対象リビジョンのドキュメント不一致 | `BusinessRuleError(RevisionDocumentMismatch)`（`Document.rollback` 内。通常は手順 3 の検索キーにより到達しない防衛線） |
| `revisionNumber` が 1 未満・非整数 | `BusinessRuleError(InvalidRevisionNumber)` |
| 変更理由が値オブジェクトの規則に違反 | `BusinessRuleError`（ChangeReason 系） |
| 並行更新で `save` が 0 行更新・`insertRevision` の一意制約違反 | `ConflictError` |

## trashDocument

### 概要

ドキュメントの個別ソフトデリート（S-DT-08, S-AI-05）。`trashedWith: null` でゴミ箱へ移す（セット削除は `trashTopic` 経由のみ）。

公開面: 両方（人間 UI / MCP `delete`）。

種別ディスパッチ: AI の `delete` ツール入力は `{ type: "memo" | "document" | "topic"; id }`。presentation 層が `type: "document"` を本ユースケースへ、`type: "memo"` を memo の `delete`、`type: "topic"` を `trashTopic` へルーティングする（共通事項「AI 動詞 `get` / `delete` の種別ディスパッチ」）。

### 入力DTO

`TrashDocumentInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `documentId` | `string` | 必須 | `DocumentId.create` で検証 |

### 出力DTO

なし（`void`）。

### 処理フロー

1. `now` を解決し、`DocumentId.create(input.documentId)` で検索キーを構築する
2. UoW 内で `DocumentRepository.findById(userId, documentId)`（active のみ）。`null` なら `NotFoundError`
3. `Document.softDelete(document, null, now)` で `TrashedDocument`（`trashedWith: null`）と `document.trashed` のイベントドラフトを得る
4. `DocumentRepository.save(trashedDocument, expectedVersion)`、`collectEvents(drafts)`

### エラーケース

| 条件 | エラー |
|---|---|
| ドキュメントが不存在・ゴミ箱内・他ユーザー所有 | `NotFoundError`（ゴミ箱内への `delete` は AI から「存在しない」扱い。S-AI-04） |
| 並行更新で `save` が 0 行更新 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |

## getDocument

### 概要

ドキュメントの全文取得（S-DT-05 の表示、S-AI-02 の `get`）。`findById` が active のみ返すため、ゴミ箱内は NotFound になる（AI からゴミ箱の中身は見えない世界を貫く）。出典メモ一覧は本ユースケースに含めない（人間 UI は `listDocumentSourceMemos` を併用する）。

公開面: 両方（人間 UI / MCP `get`）。

種別ディスパッチ: AI の `get` ツール入力は `{ type: "memo" | "document"; id }`。presentation 層（MCP / REST）が `type: "document"` を本ユースケースへ、`type: "memo"` を memo の `get` へルーティングする（共通事項「AI 動詞 `get` / `delete` の種別ディスパッチ」）。

### 入力DTO

`GetDocumentInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `documentId` | `string` | 必須 | `DocumentId.create` で検証 |

### 出力DTO

`GetDocumentOutput`

| フィールド | 型 |
|---|---|
| `id` | `string` |
| `topicId` | `string` |
| `title` / `body` | `string`（整形表示・レンダリングは presentation の責務） |
| `latestRevision` | `number` |
| `version` | `number`（人間 UI の編集開始時 `expectedVersion` に使う） |
| `createdAt` / `updatedAt` | `Date` |

### 処理フロー

1. `DocumentId.create(input.documentId)` で検索キーを構築する
2. `DocumentRepository.findById(userId, documentId)`（active のみ）。`null` なら `NotFoundError`
3. ドキュメントのビューを返す

### エラーケース

| 条件 | エラー |
|---|---|
| ドキュメントが不存在・ゴミ箱内・他ユーザー所有 | `NotFoundError` |

## listDocumentRevisions ★

### 概要

ドキュメントのリビジョン履歴一覧（誰が・いつ・なぜ。S-DT-06）。AI クライアントの編集はクライアント名と変更理由で確認できる。**一覧はメタデータのみで全文スナップショットを含めない**（`DocumentBody` は最大 1,000,000 文字であり、リビジョン数 × 全文の一覧応答は現実的でない）。全文が要るのは差分表示（`diffDocumentRevisions`）とロールバック確認であり、それぞれのユースケースで取得する。memo 側の `listMemoRevisions` / `diffMemoRevisions` と同じ分割・同じ責務配置。

公開面: 人間 UI ★（履歴閲覧は AI トークンのスコープに存在しない）。

### 入力DTO

`ListDocumentRevisionsInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `documentId` | `string` | 必須 | `DocumentId.create` で検証 |

### 出力DTO

`ListDocumentRevisionsOutput`

| フィールド | 型 |
|---|---|
| `documentId` | `string` |
| `latestRevision` | `number` |
| `revisions` | `readonly DocumentRevisionMetaView[]`（`revisionNumber` 昇順） |

`DocumentRevisionMetaView`（メタデータのみ。全文は含めない）

| フィールド | 型 |
|---|---|
| `revisionNumber` | `number` |
| `actor` | `{ kind: "user" } \| { kind: "aiClient"; clientName: string }`（identity の `Actor` の射影） |
| `changeReason` | `string` |
| `createdAt` | `Date` |

- リビジョンが 1 件のみの場合に差分・ロールバック操作を出さない制御は presentation の責務

### 処理フロー

1. `DocumentId.create(input.documentId)` で検索キーを構築する
2. `DocumentRepository.findByIdIncludingTrashed(userId, documentId)` で存在確認する（人間 UI の読み取り経路。ゴミ箱内ドキュメントの履歴も閲覧可）。`null` なら `NotFoundError`
3. `DocumentRepository.listRevisions(userId, documentId)` で全リビジョンを `revisionNumber` 昇順で取得する（ドキュメントが存在すれば必ず 1 件以上）
4. メタデータのみをビューに射影して返す

### エラーケース

| 条件 | エラー |
|---|---|
| ドキュメントが不存在（ハードデリート済み含む）・他ユーザー所有 | `NotFoundError` |

## diffDocumentRevisions ★

### 概要

任意二点のリビジョンの全文を取得する（S-DT-06）。リビジョンは全文スナップショットであり差分は保存されていないため、**差分の計算・整形は presentation 層の責務**とし、本ユースケースは二点の全文とメタデータを返すだけに留める（memo の `diffMemoRevisions` と同じ分割・同じ責務配置）。

公開面: 人間 UI ★（履歴閲覧は AI トークンのスコープに存在しない）。

### 入力DTO

`DiffDocumentRevisionsInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `documentId` | `string` | 必須 | `DocumentId.create` で検証 |
| `baseRevisionNumber` | `number` | 必須 | 1 以上の整数（`RevisionNumber.create`） |
| `targetRevisionNumber` | `number` | 必須 | 1 以上の整数。`baseRevisionNumber` と異なること |

### 出力DTO

`DiffDocumentRevisionsOutput`

| フィールド | 型 |
|---|---|
| `base` | `DocumentRevisionView` |
| `target` | `DocumentRevisionView` |

`DocumentRevisionView`

| フィールド | 型 |
|---|---|
| `revisionNumber` | `number` |
| `title` / `body` | `string`（当時の全文スナップショット。差分は表示時に presentation が計算する） |
| `actor` | `{ kind: "user" } \| { kind: "aiClient"; clientName: string }`（identity の `Actor` の射影） |
| `changeReason` | `string` |
| `createdAt` | `Date` |

### 処理フロー

1. `DocumentId.create` / `RevisionNumber.create` で検索キーを構築する
2. `DocumentRepository.findRevision(userId, documentId, baseRevisionNumber)` と `DocumentRepository.findRevision(userId, documentId, targetRevisionNumber)` で二点を取得する。いずれかが `null` なら `NotFoundError`
3. それぞれを `DocumentRevisionView` に射影して返す（差分計算はしない）

### エラーケース

| 条件 | エラー |
|---|---|
| `baseRevisionNumber` と `targetRevisionNumber` が同一 | `ValidationError` |
| いずれかのリビジョンが不在（ドキュメント不在・他ユーザー所有含む） | `NotFoundError` |
| リビジョン番号が 1 未満・非整数 | `BusinessRuleError(InvalidRevisionNumber)` |

## listDocumentSourceMemos ★

### 概要

ドキュメントの「元になったメモ」一覧（S-DT-05, S-DT-07）。出典リンクの参照先メモの本文抜粋・投稿日時を返し、ソフトデリート済みメモは「削除済みのメモ」として残す（遷移不可の判定用フラグ付き）。ハードデリート済みメモはリンクごと消えているため現れない（ADR-003）。IncludingTrashed 読み取りを含むため AI には配線しない。

公開面: 人間 UI ★。

### 入力DTO

`ListDocumentSourceMemosInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `documentId` | `string` | 必須 | `DocumentId.create` で検証 |

### 出力DTO

`ListDocumentSourceMemosOutput`

| フィールド | 型 |
|---|---|
| `sourceMemos` | `readonly SourceMemoView[]` |

`SourceMemoView`

| フィールド | 型 |
|---|---|
| `memoId` | `string` |
| `snippet` | `string`（本文抜粋。編集済みなら最新の内容。当時の内容はメモの履歴で辿れる） |
| `postedAt` | `Date` |
| `deleted` | `boolean`（ソフトデリート済みなら true。「削除済みのメモ」表示・タイムライン遷移不可の判定用） |
| `linkedAt` | `Date`（紐付け日時 = ドキュメント作成日時） |

### 処理フロー

1. `DocumentId.create(input.documentId)` で検索キーを構築する
2. `DocumentRepository.findByIdIncludingTrashed(userId, documentId)` で存在確認する（人間 UI の読み取り経路）。`null` なら `NotFoundError`
3. `DocumentRepository.listSourceLinksByDocument(userId, documentId)` で出典リンク（ID の組）を取得する
4. リンクの `memoId` 群を `MemoRepository.listByIdsIncludingTrashed(userId, memoIds)` に渡し、本文・投稿日時・削除状態を 1 クエリで取得する（S-DT-07 の表示が 1 クエリで成立する）。結果に含まれない ID（ハードデリート済み）は一覧に載せない（ADR-003）
5. ビューに射影して返す（出典 0 件は空配列。出典が全てハードデリートされた場合も空になり得る）

### エラーケース

| 条件 | エラー |
|---|---|
| ドキュメントが不存在（ハードデリート済み含む）・他ユーザー所有 | `NotFoundError` |

## listDocumentsReferencingMemo ★

### 概要

メモを出典とするドキュメントの一覧（メモ側の「→ ドキュメントX」導線。S-TL-07）。参照元ドキュメントがソフトデリート済みなら「削除済みのドキュメント」として表示する（S-DT-08）。ハードデリート済みドキュメントはリンクごと消えているため現れない。IncludingTrashed 読み取りを含むため AI には配線しない。

タイムライン 1 ページ分の一括逆引きは memo の `getTimeline` が `listSourceLinksByMemos` で行う。本ユースケースは単一メモを対象とする読み取り。

公開面: 人間 UI ★。

### 入力DTO

`ListDocumentsReferencingMemoInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| `userId` | `string` | 必須 | |
| `memoId` | `string` | 必須 | `MemoId.create` で検証 |

### 出力DTO

`ListDocumentsReferencingMemoOutput`

| フィールド | 型 |
|---|---|
| `documents` | `readonly ReferencingDocumentView[]` |

`ReferencingDocumentView`

| フィールド | 型 |
|---|---|
| `documentId` | `string` |
| `title` | `string` |
| `topicId` | `string` |
| `deleted` | `boolean`（ソフトデリート済みなら true。「削除済みのドキュメント」表示・遷移不可の判定用） |
| `linkedAt` | `Date`（紐付け日時） |

### 処理フロー

1. `MemoId.create(input.memoId)` で検索キーを構築する
2. `MemoRepository.findByIdIncludingTrashed(userId, memoId)` で存在確認する（人間 UI の読み取り経路）。`null` なら `NotFoundError`
3. `DocumentRepository.listSourceLinksByMemo(userId, memoId)` で参照元リンク（ID の組）を取得する
4. リンクの `documentId` 群を `DocumentRepository.listByIdsIncludingTrashed(userId, documentIds)` に渡し、タイトル・削除状態を 1 クエリで取得する（S-TL-07 の表示が 1 クエリで成立する）。結果に含まれない ID（ハードデリート済み）は一覧に載せない（ADR-003）
5. ビューに射影して返す（参照元 0 件は空配列）

### エラーケース

| 条件 | エラー |
|---|---|
| メモが不存在（ハードデリート済み含む）・他ユーザー所有 | `NotFoundError` |
