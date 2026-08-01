# Knowledge ドメイン

トピック・ドキュメント・出典リンクと、ドキュメントのリビジョン履歴を管理する。

- 上流: [requirements.md](../requirements.md) 2章 / 4.2 / 4.3、[scenario/document.md](../scenario/document.md)、[scenario/ai.md](../scenario/ai.md)、[scenario/trash.md](../scenario/trash.md)
- 関連 ADR: [ADR-001](../adr/001-restore-document-without-topic.md)（所属トピック消失時の復元）、[ADR-003](../adr/003-source-link-after-hard-delete.md)（ハードデリート後の出典リンク）、[ADR-004](../adr/004-domain-boundaries.md)（topic と document を同一ドメインに置く理由）、[.adr/003](../../.adr/003-sqlite-fts5-only-search.md)、[.adr/004](../../.adr/004-do-local-commit-and-alarm-jobs.md)（同一トランザクションでのインデックス更新。`spec/adr/005` は superseded）
- コード規約: [docs/backend_implementation_example.md](../../docs/backend_implementation_example.md) に従う（値オブジェクトは unique symbol ブランド型 + `create` ファクトリで `BusinessRuleError` を throw、エンティティは判別可能ユニオン + 純関数ファクトリ、`now: Date` と id は引数で受ける、状態遷移は次状態のエンティティだけを返す）

## ユビキタス言語

| 英語名 | 日本語名 | 定義 |
|---|---|---|
| Topic | トピック | ドキュメントを束ねるコンテナ。文脈の単位。名前と任意の短い説明文を持つ |
| Document | ドキュメント | 主題を持つ編集型の文書。構造化テキスト（Markdown/HTML 互換）。必ずいずれかのトピックに属する |
| DocumentRevision | ドキュメントリビジョン | ドキュメントの不変スナップショット。「誰が・いつ・なぜ」と全文を記録し、線形履歴を成す |
| SourceLink | 出典リンク | ドキュメントから出典メモへの参照。リビジョンではなくメモを指す |
| Source Memo | 出典メモ | ドキュメントの出典（引用元・参照先）となったメモ。knowledge からは `MemoId` の ID 参照のみ |
| Archive | アーカイブ（UI 用語は「完了」） | トピックを一覧の主要領域から退かせる可逆フラグ。検索には引き続きヒットする |
| Soft Delete | ソフトデリート | ゴミ箱行き。可逆。ゴミ箱内の項目は AI から見えない |
| Hard Delete | ハードデリート | リビジョン履歴・出典リンクごとの完全消去。不可逆。人間 UI 専用（trash ドメインのユースケース） |
| Set Deletion | セット削除 | トピックのソフトデリートに伴い配下ドキュメントも一括でソフトデリートすること。復元もセットで行う |
| Patch | パッチ | 本文中の該当箇所の置換指定による編集形式。AI の `edit_document` の原則形式（既定モード） |
| Replace All | 全文置換 | `edit_document` の例外モード。ユーザーが明示的に全面書き直しを求めた場合に限り使用する。空本文ドキュメントへの AI 編集経路を兼ねる |
| Change Reason | 変更理由 | リビジョンに必須の一行サマリ（「なぜ」） |
| Rollback | ロールバック | 過去リビジョンと同内容の新リビジョンを積む操作。履歴は削除しない |
| Actor | 操作主体 | 人間ユーザーまたは AI クライアント。identity ドメインが定義する型を利用する |
| TrashRetentionDays | ゴミ箱保持日数 | identity ドメインが定義する値オブジェクト。`purgeAfter` の一括再計算の入力として参照する（算出規則は trash の `RetentionPolicy`） |

## 他ドメインからの参照型

エンティティの直接参照はせず、型（ID・値オブジェクト）のみを参照する。

| 型 | 定義元 | 用途 |
|---|---|---|
| `UserId` | identity | 全エンティティの所有者。データは利用者個人に閉じる |
| `Actor` | identity | リビジョンの「誰が」。人間ユーザー / AI クライアント（トークン識別）の判別可能ユニオン |
| `MemoId` | memo | 出典リンクの参照先 |
| `TrashRetentionDays` | identity | `TopicRepository.recalculatePurgeAfter` / `DocumentRepository.recalculatePurgeAfter` の入力（`purgeAfter` の一括再計算。算出規則は trash の `RetentionPolicy`） |

## 値オブジェクト

いずれも unique symbol によるブランド型。`create` が唯一の生成経路で、違反時は `BusinessRuleError<KnowledgeErrorCode>` を throw する。等価性は特記なき限り内包する値の完全一致。

### TopicId / DocumentId / DocumentRevisionId

- フィールド: `string`（ブランド付き）
- バリデーション: trim 後非空。ID 形式（UUIDv7 等）の検証は `IdGenerator` 実装の責務であり、ドメインは不透明な非空文字列として扱う
- エラー: `InvalidTopicId` / `InvalidDocumentId` / `InvalidRevisionId`

### TopicName

- フィールド: `string`
- バリデーション: trim 後非空、改行を含まない、100 文字以内
- エラー: `EmptyTopicName` / `TopicNameMultiline` / `TopicNameTooLong`

### TopicDescription

- フィールド: `string`（プレーンテキスト数行）
- バリデーション: trim 後非空、500 文字以内。「説明なし」は値オブジェクトの空文字ではなくエンティティ側の `null` で表す（省略可能性を値の中に持ち込まない）
- エラー: `EmptyTopicDescription` / `TopicDescriptionTooLong`

### RevisionNumber

- フィールド: `number`（ブランド付き）
- バリデーション: 1 以上の整数でなければ `BusinessRuleError(KnowledgeErrorCode.InvalidRevisionNumber)`
- 補助ファクトリ: `RevisionNumber.first()`（= 1）、`RevisionNumber.next(n)`（= n + 1）
- 等価性: 数値の一致
- 補足: memo ドメインにも同名・同スタイルの `RevisionNumber` があるが、**各ドメインが自前で定義し、memo の型を import しない**（ドメイン間の型共有はせず、ブランドも別物。共通概念の偶然の一致であり依存を作らない）

### DocumentTitle

- フィールド: `string`
- バリデーション: trim 後非空、改行を含まない、200 文字以内
- エラー: `EmptyDocumentTitle` / `DocumentTitleMultiline` / `DocumentTitleTooLong`

### DocumentBody

- フィールド: `string`（Markdown/HTML 互換の構造化テキスト。ドメインは構文解釈をせず全文文字列として扱い、整形表示・差分計算は presentation の責務）
- バリデーション: 空文字を許容（書きかけのドキュメントは正当な状態）、1,000,000 文字以内
- エラー: `DocumentBodyTooLong`

### ChangeReason

- フィールド: `string`（変更理由の一行サマリ）
- バリデーション: trim 後非空、改行を含まない、200 文字以内
- エラー: `EmptyChangeReason` / `ChangeReasonMultiline` / `ChangeReasonTooLong`
- 補足: **ドメインは常に非空を要求する。** 人間 UI で入力が省略された場合の既定値「手動編集」（ロールバック時は「リビジョン{n}の内容に戻す」、作成時は「作成」）を補うのは application 層のユースケースの責務。AI の `edit_document` は省略時に presentation/application 層でバリデーションエラーとし、既定値を補わない（4.5: 変更理由必須）

### DocumentPatch

パッチ編集（AI の `edit_document` の原則形式）の置換指定。

- フィールド: `hunks: readonly PatchHunk[]`、`PatchHunk = Readonly<{ oldText: string; newText: string }>`
- バリデーション: `hunks` は 1 件以上。各 `oldText` は非空（空文字はマッチ位置を特定できない）。`newText` は空文字可（= 該当箇所の削除）
- 等価性: hunks の順序を含む完全一致
- エラー: `EmptyPatch` / `EmptyPatchOldText`

適用規則（`DocumentPatch.apply`）:

```ts
export const DocumentPatch = {
  create: (hunks: readonly { oldText: string; newText: string }[]): DocumentPatch => { /* バリデーション */ },

  /** hunks を先頭から順に適用した本文を返す純関数 */
  apply: (body: DocumentBody, patch: DocumentPatch): DocumentBody => { /* ... */ },
};
```

- hunks を配列順に 1 件ずつ適用する。各 hunk の適用は「その時点の本文」に対して行う（前の hunk の置換結果を含む）
- 各 hunk の `oldText` は、その時点の本文中に**完全一致でちょうど 1 箇所**見つからなければならない
  - 0 箇所 → `PatchTargetNotFound` を throw（本文が既に変わっている等。S-AI-04 異常系。AI は `get` で最新を取り直して再試行する）
  - 2 箇所以上 → `PatchTargetAmbiguous` を throw（AI は周辺文脈を含めた一意な `oldText` で再試行する）
- いずれかの hunk が失敗した場合、パッチ全体が失敗しドキュメントは変更されない（部分適用しない）
- 適用結果は `DocumentBody.create` を通す（サイズ上限違反はここで検出される）

`edit_document` の入力形式（AI 編集経路）:

- MCP `edit_document` の入力は判別可能ユニオンとする: `{ mode: "patch"; patches: DocumentPatch } | { mode: "replaceAll"; body: string /* 適用後の全文（DocumentBody 相当） */ }`。既定（`mode` 省略時）は `patch`
- `replaceAll` は**ユーザーが明示的に全面書き直しを求めた場合に限る**（requirements 4.3「全文指定は新規作成・明示的な全面書き直しに限定」/ S-AI-04）。この制約はドメインで機械的に強制できないため、MCP ツール定義のガイダンスに明記して AI への指示で担保する
- いずれのモードでも `changeReason` は必須（4.5）
- ドメインの `Document.edit` は「適用後の全文」を受け取る現行設計のままでよい。パッチ適用（`DocumentPatch.apply`）と全文受領の差は application 層のユースケースが吸収し、どちらのモードも最終的に同じ `Document.edit` に到達する
- 空本文ドキュメントの編集経路: `oldText` 非空必須のためパッチは本文が空のドキュメントに適用できない。**本文が空のドキュメントへの AI 編集は `replaceAll` を使う**（人間 UI は通常の全文編集画面で編集できるため影響なし）

## エンティティ

### Topic

トピック集約のルート。

フィールド（`TopicBase`）:

| 名前 | 型 | 制約 |
|---|---|---|
| `id` | `TopicId` | required |
| `userId` | `UserId` | required。所有者。作成後不変。**値は所属する Durable Object の同一性そのものであり、行ごとの絞り込みには用いない**（domains/index.md「テナント分離」） |
| `name` | `TopicName` | required |
| `description` | `TopicDescription \| null` | optional。`null` = 説明なし |
| `version` | `number` | required。OCC 用。生成時 0、状態を変えるたびに +1 |
| `createdAt` / `updatedAt` | `Date` | required |

ライフサイクル（判別可能ユニオン）:

```ts
export type ActiveTopic = TopicBase & Readonly<{ status: "active" }>;
export type ArchivedTopic = TopicBase & Readonly<{ status: "archived" }>;
export type TrashedTopic = TopicBase &
  Readonly<{
    status: "trashed";
    trashedAt: Date;
    /** 保持期限。ゴミ箱にある間だけ意味を持つ */
    purgeAfter: Date;
    wasArchived: boolean;
  }>;
export type Topic = ActiveTopic | ArchivedTopic | TrashedTopic;

/** ゴミ箱行き前の生存状態。多くの操作の受け口 */
export type LiveTopic = ActiveTopic | ArchivedTopic;
```

- `active` → `archived`（archive）/ `archived` → `active`（unarchive）は可逆で AI にも許可される
- `active | archived` → `trashed`（softDelete）。`wasArchived` に削除時点のアーカイブ状態を保持し、復元時に元の状態へ戻す
- `trashed` → 元の状態（restore、`wasArchived` に従う）。ハードデリートはエンティティの消滅であり状態ではない
- `trashedAt` はゴミ箱の保持期限計算（trash ドメイン）の起点。算出結果は `purgeAfter` に保存し、復元で必ず落とす（trash.md「保持期限」）

振る舞い（すべて純関数。`Topic` オブジェクトの静的メソッドとして定義）:

| メソッド | シグネチャ | 処理内容 | インデックスへの影響 |
|---|---|---|---|
| `create` | `(params: { id: string; userId: UserId; name: string; description: string \| null }, now: Date) => ActiveTopic` | 値オブジェクトを構築し `active` なトピックを生成する（`version: 0`）。`description` が `null` ならそのまま `null` | なし（トピックはエントリを持たない） |
| `rename` | `<T extends LiveTopic>(topic: T, name: string, now: Date) => T` | `TopicName.create` を通して名前を変更。`version + 1`、`updatedAt` 更新。status は保存する | なし（検索結果のトピックは join で解決するため、リネームは即座に反映される） |
| `changeDescription` | `<T extends LiveTopic>(topic: T, description: string \| null, now: Date) => T` | 説明文を変更（`null` で削除）。`version + 1` | なし |
| `archive` | `(topic: ActiveTopic, now: Date) => ArchivedTopic` | `archived` へ遷移。`version + 1` | なし（アーカイブ済みトピックの内容も検索にヒットするので、配下ドキュメントのエントリを除去してはならない） |
| `unarchive` | `(topic: ArchivedTopic, now: Date) => ActiveTopic` | `active` へ遷移。`version + 1` | なし |
| `softDelete` | `(topic: LiveTopic, purgeAfter: Date, now: Date) => TrashedTopic` | `trashed` へ遷移。`trashedAt: now`、`wasArchived: topic.status === "archived"`、`version + 1`。**単独では呼ばず、必ず `TopicTrashService.trashTopicSet` 経由で配下ドキュメントとセットで使う** | 配下ドキュメントのエントリを同一トランザクションで除去し、**除去した各ドキュメントの出典メモのエントリも同じトランザクションで作り直す**（`Document.softDelete` と同じファンアウト。作り直さないと出典メモ側にゴミ箱内ドキュメントの ID が残る。search.md「インデックスの維持」）。トピック自体のエントリは無い |
| `restore` | `(topic: TrashedTopic, now: Date) => LiveTopic` | `wasArchived` が true なら `archived`、false なら `active` へ戻す。`trashedAt` / `purgeAfter` / `wasArchived` を落とす（`trashed` であることと `purgeAfter` を持つことは同値である。trash.md「保持期限」）。`version + 1`。**必ず `TopicTrashService.restoreTopicSet` 経由で使う** | 復元した配下ドキュメントのエントリを同一トランザクションで作り直し、**その各ドキュメントの出典メモのエントリも同じトランザクションで作り直す**（`Document.restore` と同じファンアウト。search.md「インデックスの維持」） |

不正な遷移（`trashed` の rename、`archived` の archive 等）は引数型で表現不能にする。ハードデリートは後続エンティティが存在しないためドメインに関数を置かず、trash ドメインのユースケースがポートで直接消去する（実装規約に従う）。

### Document

ドキュメント集約のルート。DocumentRevision と SourceLink はこの集約に属する。

フィールド（`DocumentBase`）:

| 名前 | 型 | 制約 |
|---|---|---|
| `id` | `DocumentId` | required |
| `userId` | `UserId` | required。作成後不変。**値は所属する Durable Object の同一性そのものであり、行ごとの絞り込みには用いない**（domains/index.md「テナント分離」） |
| `topicId` | `TopicId` | required。**ドキュメントは必ずいずれかのトピックに属する。** 変更は `moveToTopic` のみ（ADR-001 の復元先選択用） |
| `title` | `DocumentTitle` | required |
| `body` | `DocumentBody` | required（空文字は可） |
| `latestRevision` | `RevisionNumber` | required。最新リビジョン番号（knowledge の `RevisionNumber` VO。1 始まり）。編集のたびに `RevisionNumber.next` で +1。OCC 用 `version` とは独立（softDelete 等はリビジョンを積まずに `version` だけ進むため） |
| `version` | `number` | required。OCC 用。生成時 0、状態を変えるたびに +1。人間 UI の編集競合警告（S-DT-05）もこの値の比較で実現する |
| `createdAt` / `updatedAt` | `Date` | required |

ライフサイクル（判別可能ユニオン）:

```ts
export type ActiveDocument = DocumentBase & Readonly<{ status: "active" }>;
export type TrashedDocument = DocumentBase &
  Readonly<{
    status: "trashed";
    trashedAt: Date;
    /** 保持期限。ゴミ箱にある間だけ意味を持つ */
    purgeAfter: Date;
    /** セット削除なら削除元トピックの ID、個別削除なら null */
    trashedWith: TopicId | null;
  }>;
export type Document = ActiveDocument | TrashedDocument;
```

- `trashedWith` がセット削除の識別子。トピックのソフトデリートに巻き込まれたドキュメントは `trashedWith = topic.id` を持ち、トピックのセット復元の対象になる。個別に削除したドキュメント（`trashedWith: null`）はトピックが復元されてもゴミ箱に残る（S-TR-02）
- ドキュメントにアーカイブ状態はない（アーカイブはトピックの属性）

振る舞いの戻り値に使う型:

```ts
export type DocumentWithRevision = Readonly<{
  document: ActiveDocument;
  revision: DocumentRevision;
}>;

export type DocumentEditOutcome =
  | Readonly<{ kind: "unchanged"; document: ActiveDocument }>
  | (Readonly<{ kind: "edited" }> & DocumentWithRevision);
```

振る舞い:

| メソッド | シグネチャ | 処理内容 | インデックスへの影響 |
|---|---|---|---|
| `create` | `(params: { id: string; revisionId: string; userId: UserId; topicId: TopicId; title: string; body: string; actor: Actor; changeReason: string; sourceMemoIds: readonly MemoId[] }, now: Date) => { document: ActiveDocument; revision: DocumentRevision; sourceLinks: readonly SourceLink[] }` | 値オブジェクトを構築し `active` なドキュメント（`version: 0`, `latestRevision: 1`）、リビジョン #1（全文スナップショット）、`sourceMemoIds` を重複除去した SourceLink 群を生成する。`sourceMemoIds` は空配列可（出典なし作成。S-DT-04）。**`topicId` の実在・非ゴミ箱と `sourceMemoIds` の実在・非ゴミ箱の検証は application 層の責務**（S-AI-03 異常系: 1 件でも不正なら全体を失敗させ、部分的に壊れた状態を作らない） | 永続化と同一トランザクションで当該ドキュメントのエントリを作り、出典メモのエントリも作り直す |
| `edit` | `(document: ActiveDocument, params: { revisionId: string; title: string; body: string; actor: Actor; changeReason: string }, now: Date) => DocumentEditOutcome` | パッチ適用後（または人間 UI の全文編集後）の**全文**を受け取り、値オブジェクト構築後に現在値と比較する。タイトル・本文とも同一なら `unchanged` を返し、リビジョンを積まない（S-DT-05 異常系）。差分があれば `title` / `body` を差し替え、`latestRevision + 1`、`version + 1`、新リビジョン（全文スナップショット）を生成する。パッチ形式の編集は application 層が `DocumentPatch.apply(document.body, patch)` で全文を得てから本メソッドを呼び、全文置換（`edit_document` の replaceAll）は受領した全文をそのまま渡す。**パッチ適用・全文受領の差はユースケース層で吸収され、本メソッドは常に適用後の全文を受ける** | 変更があった場合のみ、永続化と同一トランザクションでエントリを作り直す |
| `rollback` | `(document: ActiveDocument, target: DocumentRevision, params: { revisionId: string; actor: Actor; changeReason: string }, now: Date) => DocumentEditOutcome` | `target.documentId !== document.id` なら `RevisionDocumentMismatch` を throw。target のタイトル・本文で `edit` と同じ手順を実行する（過去リビジョンと同内容の**新リビジョン**を積む方式。履歴は削除しない）。現在の内容と同一なら `unchanged` | `edit` と同じ |
| `softDelete` | `(document: ActiveDocument, trashedWith: TopicId \| null, purgeAfter: Date, now: Date) => TrashedDocument` | `trashed` へ遷移。`trashedAt: now`。`trashedWith` が非 null の場合 `document.topicId` と一致しなければ `TrashedWithMismatch` を throw（セット削除は所属トピック経由でのみ起こり得る）。個別削除のユースケースは `null` を渡し、セット削除は `TopicTrashService` が `topic.id` を渡す。`purgeAfter` は `RetentionPolicy.expiresAt` の算出結果を application 層が渡す。`version + 1` | 永続化と同一トランザクションでエントリを除去し、出典メモのエントリを作り直す |
| `restore` | `(document: TrashedDocument, now: Date) => ActiveDocument` | `active` へ戻す。`trashedAt` / `purgeAfter` / `trashedWith` を落とす（`trashed` であることと `purgeAfter` を持つことは同値である。trash.md「保持期限」）。`version + 1`。**復元先トピック（`document.topicId`）が存在しゴミ箱内でないことの保証は呼び出し側（trash ドメインのユースケース / `TopicTrashService.restoreTopicSet`）の責務**。所属トピックがゴミ箱内ならトピックごとセット復元、ハードデリート済みなら `moveToTopic` で復元先を差し替えてから復元する（ADR-001） | 永続化と同一トランザクションでエントリを作り直し、出典メモのエントリも作り直す |
| `moveToTopic` | `(document: TrashedDocument, destinationTopicId: TopicId, now: Date) => TrashedDocument` | 復元先トピックの差し替え（ADR-001: 所属トピックがハードデリート済みのドキュメントの復元時に、ユーザーが選択した既存 or 新規トピックを設定する）。`topicId` を差し替え、`trashedWith` を `null` にする（元トピックとのセット関係は消滅している）。`version + 1`。ゴミ箱内の移動であり、ゴミ箱内の項目はインデックスに載っていないので影響しない。直後に `restore` を呼ぶ前提の中間状態 | なし |

`create` の第一リビジョンにも `changeReason` を記録する（「なぜ」が空のリビジョンを存在させない。既定値「作成」の補完は application 層）。

### DocumentRevision

不変のスナップショット。Document 集約内の子エンティティで、生成後は一切変更されない（`version` / `updatedAt` を持たない）。

フィールド:

| 名前 | 型 | 制約 |
|---|---|---|
| `id` | `DocumentRevisionId` | required |
| `documentId` | `DocumentId` | required |
| `revisionNumber` | `RevisionNumber` | required。1 始まりの連番（knowledge の `RevisionNumber` VO）。`(documentId, revisionNumber)` は一意 |
| `title` | `DocumentTitle` | required。当時のタイトル全文 |
| `body` | `DocumentBody` | required。当時の本文の**全文スナップショット**（差分は表示時に presentation が計算する） |
| `actor` | `Actor` | required。誰が（人間 / どの AI クライアントか） |
| `changeReason` | `ChangeReason` | required。なぜ（一行サマリ）。空のリビジョンは存在しない |
| `createdAt` | `Date` | required。いつ |

振る舞い: 生成は `Document.create` / `edit` / `rollback` の内部でのみ行う（`DocumentRevision.create` は内部ファクトリ）。単独での公開ファクトリ・更新メソッドは持たない。

### SourceLink

ドキュメントから出典メモへの参照。Document 集約内の子。**リビジョンではなくメモを指す**（元メモが編集されたら最新版が見え、当時の内容はメモの履歴で辿れる。4.1）。

フィールド:

| 名前 | 型 | 制約 |
|---|---|---|
| `documentId` | `DocumentId` | required |
| `memoId` | `MemoId` | required |
| `createdAt` | `Date` | required。紐付け日時（= ドキュメント作成日時） |

- 同一性: `(documentId, memoId)` の複合。同じ組は 1 つしか存在しない（`Document.create` が重複除去する）。サロゲートキーが必要かはアダプター（DB スキーマ）の実装詳細
- 生成はドキュメント**作成時**のみ（要件 2章「出典は、ドキュメント作成時に紐付けられる」）。後からの追加・削除の操作は提供しない
- 参照先メモのソフトデリートではリンクは残る（「削除済みのメモ」として表示。表示制御は読み取り側の責務）。参照先メモの**ハードデリートではリンクごと消える**（ADR-003。trash ドメインのユースケースが `MemoRepository.hardDelete` と**同一 UnitOfWork 内**で `DocumentRepository.deleteSourceLinksByMemo` を呼ぶ同期方式。非同期に消すのではなく、オーケストレーションは trash のユースケースの責務）。ドキュメント自身のハードデリートでもそのドキュメントのリンクは全て消える
- 振る舞いは持たない（生成と消滅のみの純粋な関連）

## 不変条件

1. ドキュメントは必ずいずれかのトピックに属する（`topicId` は非 null）。トピックの実在・非ゴミ箱の検証は作成・復元・移動のユースケースが行う（ADR-001 の分岐を含む）
2. トピック名・ドキュメントタイトルは非空（値オブジェクトで強制）
3. リビジョン履歴は線形。`revisionNumber` は 1 から欠番なく単調増加し、`document.latestRevision` と常に一致する。リビジョンは不変で、削除されるのはドキュメントのハードデリート時のみ（履歴ごと完全消去）
4. すべてのリビジョンは `actor`（誰が）・`createdAt`（いつ）・`changeReason`（なぜ、非空一行）を持つ
5. 内容が変わらない保存はリビジョンを積まない（`edit` / `rollback` の unchanged 判定）
6. `trashed` 状態のトピック・ドキュメントは編集・アーカイブ操作できない（引数型 `ActiveDocument` / `LiveTopic` で表現。ゴミ箱内項目への AI 操作が「存在しない」扱い（`NotFoundError`）になるのは、リポジトリの `findById` が active（トピックは Live）のみを返すことで memo と同様に構造的に実現される。trashed を扱えるのは `findByIdIncludingTrashed` を使う人間 UI・trash 系ユースケースのみ）
7. トピックのソフトデリートは、その時点で `active` な配下ドキュメントのセット削除を伴う（`TopicTrashService` 経由でのみ実行）。セット削除されたドキュメントは `trashedWith = topicId` を持ち、トピックのセット復元で一緒に戻る。個別削除済み（`trashedWith: null`）のドキュメントはセットに含まれない
8. `trashedWith` が非 null なら `topicId` と一致する
9. 出典リンクの参照先メモがハードデリートされたら、リンクごと消える。壊れたリンクや「完全に削除されたメモ」の痕跡を残さない（ADR-003）
10. 全エンティティは単一の `userId` に属し、他ユーザーからは一切見えない。この分離は物理境界で構造的に強制する: 全エンティティはそのユーザーの Durable Object の中にしか存在せず、他ユーザーの Durable Object へ到達する経路が無い。他ユーザーの ID を渡しても「存在しない」（null / 空）となり、ユースケース層の追加検証に依存しない（domains/index.md「テナント分離」、requirements 5.1）

## ドメインサービス

### TopicTrashService

- 責務: トピックと配下ドキュメントのセット削除・セット復元の整合を守る（不変条件 7）
- 依存するポート: なし（純関数。エンティティの取得・永続化は application 層のユースケースが同一 UoW 内で行う）

```ts
export const TopicTrashService = {
  /**
   * トピックと、その時点で active な配下ドキュメントをセットでソフトデリートする。
   * documents は topic 配下の ActiveDocument 全件（取得はユースケースの責務）。
   * 各ドキュメントは Document.softDelete(doc, topic.id, purgeAfter, now) で trashedWith が付く。
   * 個別削除済み（既に trashed）のドキュメントは documents に含めない。
   * purgeAfter はトピックと配下ドキュメントで同一の値を用いる。
   */
  trashTopicSet: (
    topic: LiveTopic,
    documents: readonly ActiveDocument[],
    purgeAfter: Date,
    now: Date,
  ) => Readonly<{ topic: TrashedTopic; documents: readonly TrashedDocument[] }>,

  /**
   * トピックをセットで復元する。documents は topic 配下（topicId 一致）の
   * TrashedDocument 全件。trashedWith === topic.id のものだけ restore し、
   * 個別削除（trashedWith: null）のものは skipped に返してゴミ箱に残す。
   * topicId が topic.id と一致しないドキュメントが混ざっていたら
   * BusinessRuleError(TrashedWithMismatch) を throw。
   */
  restoreTopicSet: (
    topic: TrashedTopic,
    documents: readonly TrashedDocument[],
    now: Date,
  ) => Readonly<{
    topic: LiveTopic; // wasArchived に従い active / archived へ
    restoredDocuments: readonly ActiveDocument[];
    skippedDocuments: readonly TrashedDocument[]; // 個別削除分。ゴミ箱に残す
  }>,
};
```

補足:

- 呼び出し元は trash ドメインのユースケース（トピックの復元）と knowledge のユースケース（トピックの削除）。どちらも同一 UoW 内でトピック・全ドキュメントを保存し、配下ドキュメントの検索インデックスエントリも同じトランザクションで更新する
- 「ドキュメント個別復元時に所属トピックもゴミ箱内だった」ケース（S-TR-02）は、確認のうえトピックごとセット復元する仕様のため、`restoreTopicSet` をそのまま使う（シグネチャは変えず、対象ドキュメントだけを引き抜く復元経路は設けない）。ただし復元要求対象のドキュメント自身が個別削除（`trashedWith: null`）のため `skippedDocuments` に分類された場合は、trash の restoreDocument ユースケースが**同一 UoW 内で当該ドキュメントを追加で `Document.restore` する**（トピックは直前に復元済みのため不変条件 1 を満たす）。復元を要求した当のドキュメントがゴミ箱に残る結果を作らない
- トピックのハードデリート時のセット対象は「`trashedWith === topic.id` のゴミ箱内ドキュメント」（個別削除分は対象外。ADR-001 の却下代替案参照）。後続エンティティがないためサービスは設けず、trash ドメインのユースケースがポートで直接消去する

## エラーコード

`KnowledgeErrorCode`（`BusinessRuleError<KnowledgeErrorCode>` で throw）:

```ts
export const KnowledgeErrorCode = {
  InvalidTopicId: "INVALID_TOPIC_ID",
  InvalidDocumentId: "INVALID_DOCUMENT_ID",
  InvalidRevisionId: "INVALID_REVISION_ID",
  InvalidRevisionNumber: "INVALID_REVISION_NUMBER",
  EmptyTopicName: "EMPTY_TOPIC_NAME",
  TopicNameMultiline: "TOPIC_NAME_MULTILINE",
  TopicNameTooLong: "TOPIC_NAME_TOO_LONG",
  EmptyTopicDescription: "EMPTY_TOPIC_DESCRIPTION",
  TopicDescriptionTooLong: "TOPIC_DESCRIPTION_TOO_LONG",
  EmptyDocumentTitle: "EMPTY_DOCUMENT_TITLE",
  DocumentTitleMultiline: "DOCUMENT_TITLE_MULTILINE",
  DocumentTitleTooLong: "DOCUMENT_TITLE_TOO_LONG",
  DocumentBodyTooLong: "DOCUMENT_BODY_TOO_LONG",
  EmptyChangeReason: "EMPTY_CHANGE_REASON",
  ChangeReasonMultiline: "CHANGE_REASON_MULTILINE",
  ChangeReasonTooLong: "CHANGE_REASON_TOO_LONG",
  EmptyPatch: "EMPTY_PATCH",
  EmptyPatchOldText: "EMPTY_PATCH_OLD_TEXT",
  PatchTargetNotFound: "PATCH_TARGET_NOT_FOUND",
  PatchTargetAmbiguous: "PATCH_TARGET_AMBIGUOUS",
  RevisionDocumentMismatch: "REVISION_DOCUMENT_MISMATCH",
  TrashedWithMismatch: "TRASHED_WITH_MISMATCH",
} as const;
```

存在しないトピック / メモ / ドキュメントの参照はドメインエラーではなく application 層の `NotFoundError`、OCC 衝突は `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。

## ポート

いずれも `domain/knowledge/ports/` に置き、ドメイン型を受け渡す。外部データのデコード（検証・ブランド再構築）はアダプター境界の責務。OCC はテンプレートの `TransactionalRepository<TEntity, TId>` と同じ規約（`insert` / `save` / `delete` + `ExpectedVersion` トークン、「読まずに書く」を型エラーにする）に従う。**全メソッドは同期契約であり `Promise` を返さない**（domains/index.md「ポートの同期契約」）。

共通エラーケース:

- `save` / `delete`: 0 行更新 → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`
- すべてのメソッド: DB 例外 → `SystemError(DatabaseError)`（`mapDbError`）
- 「見つからない」は `findById` 系が `null` を返し、`NotFoundError` への変換はユースケースの責務

**テナント分離（domains/index.md「テナント分離」）**: `userId` はユーザー単位 Durable Object の選択で消費済みなので、どのメソッドも引数に取らない。DO の中に他ユーザーの行が原理的に存在しないため、他ユーザーの ID を渡しても結果は「存在しない」（null / 空配列）になる（存在の有無も漏らさない）。所有権検証は到達可能性により構造的に保証され、ユースケース層の追加検証（取得後の `entity.userId` 照合）に依存しない。

### TopicRepository

- 目的: Topic 集約の永続化と読み取り

```ts
export interface TopicRepository {
  // --- 書き込み（TransactionalRepository と同じ OCC 規約） ---
  insert(topic: ActiveTopic): void;
  save(topic: Topic, expectedVersion: ExpectedVersion<Topic>): void;
  /** ハードデリート（アダプターが同一トランザクションで行を消す） */
  delete(id: TopicId, expectedVersion: ExpectedVersion<Topic>): void;

  /** ゴミ箱外（LiveTopic）のみ返す。trashed は null */
  findById(id: TopicId): Versioned<LiveTopic> | null;

  /** ゴミ箱内も含む全状態の取得。人間 UI の読み取り経路と trash 系ユースケースで使用可。AI 向けユースケースでは使用しない */
  findByIdIncludingTrashed(id: TopicId): Versioned<Topic> | null;

  /**
   * ゴミ箱外トピック一覧（トピック一覧画面・list_topics 用）。
   * includeArchived: false なら active のみ。名前順等の安定順序で返す。
   */
  listByUser(options: Readonly<{ includeArchived: boolean }>): readonly LiveTopic[];

  /** ゴミ箱内トピック一覧。trash の TrashQueryPort アダプターの内部実装（UNION 枝）専用であり、application 層のユースケースから直接呼ばない（ゴミ箱一覧の読み取り契約は TrashQueryPort に一本化。本メソッドはその実装素材で、読み取り契約の二重定義ではない） */
  listTrashedByUser(): readonly Versioned<TrashedTopic>[];

  /**
   * 指定 ID 群のトピックを一括取得する（表示用の名前解決）。
   * 検索結果（人間 UI）の「所属トピック名」表示が結果件数分の N+1 照会にならず 1 クエリで成立する
   * （search ユースケースが結果整形時に利用する。usecases/search.md）。
   * 存在しない（ハードデリート済み）ID は結果に含めない。
   */
  listByIds(ids: readonly TopicId[]): readonly Versioned<Topic>[];

  // --- 保持日数変更に伴う purgeAfter の一括再計算（trash.md「保持期限」） ---
  recalculatePurgeAfter(
    retentionDays: TrashRetentionDays,
    limit: number,
  ): Readonly<{ updatedCount: number; hasMore: boolean }>;
}
```

- `findById` は **ゴミ箱外（`LiveTopic`）のみ**返す。trashed は `null`（memo と同じ規約。AI からゴミ箱が「存在しない」扱いになる土台。S-AI-04）。trashed も必要な読み取り（復元・ハードデリート・ゴミ箱表示等）は `findByIdIncludingTrashed` を使う（人間 UI の読み取り経路と trash 系ユースケースで使用可。AI 向けユースケースでは使用しない）。`delete` はハードデリート（アダプターが同一トランザクションで行を消す）
- 保持期限切れ項目の**列挙**は本ポートに置かない。各項目の `purgeAfter` を索引で引くのは trash の `TrashQueryPort.listItemsToPurge` であり、それを呼ぶのは自分の Durable Object の Alarm ジョブである（trash.md「保持期限」）
- `recalculatePurgeAfter` は保持日数変更に伴う一括更新の書き込み口である。ゴミ箱内のトピックのうち `purgeAfter` が `retentionDays` から算出される値と一致しない行を `limit` 件まで更新し、残件の有無を返す。**OCC トークンを取らず `version` も進めない**（派生値の追随であって業務上の変更ではない）。進捗はカーソルではなく作業述語が表す
- エラーケース: 共通のみ

### DocumentRepository

- 目的: Document 集約（リビジョン・出典リンク含む）の永続化と読み取り

```ts
export interface DocumentRepository {
  // --- 書き込み（TransactionalRepository と同じ OCC 規約。extends はしない） ---
  insert(document: ActiveDocument): void;
  save(document: Document, expectedVersion: ExpectedVersion<Document>): void;
  /** ハードデリート（アダプターが同一トランザクションで全リビジョン・全出典リンクも消去する） */
  delete(id: DocumentId, expectedVersion: ExpectedVersion<Document>): void;

  /** active のみ返す。trashed は null */
  findById(id: DocumentId): Versioned<ActiveDocument> | null;

  /** ゴミ箱内も含む全状態の取得。人間 UI の読み取り経路（出典リンクの「削除済み」表示・履歴等）と trash 系ユースケースで使用可。AI 向けユースケースでは使用しない */
  findByIdIncludingTrashed(id: DocumentId): Versioned<Document> | null;

  /**
   * 指定 ID 群のドキュメントを trashed 含め一括取得する（出典表示用）。
   * メモの「→ ドキュメントX（削除済み）」表示（S-TL-07。タイトル＋削除済みフラグ）が 1 クエリで成立する。
   * 存在しない（ハードデリート済み）ID は結果に含めない。使用範囲は findByIdIncludingTrashed と同じ。
   */
  listByIdsIncludingTrashed(ids: readonly DocumentId[]): readonly Document[];

  /** トピック配下の active なドキュメント一覧（トピック詳細画面・セット削除の対象取得用） */
  listActiveByTopic(topicId: TopicId): readonly Versioned<ActiveDocument>[];

  /**
   * 複数トピック配下の active なドキュメントを一括取得する（`listTopics` の「トピックと配下ドキュメントの一覧」用）。
   * トピック一覧の表示がトピック件数分の N+1 照会にならず 1 クエリで成立する。
   */
  listActiveByTopics(topicIds: readonly TopicId[]): readonly Versioned<ActiveDocument>[];

  /** トピック配下のゴミ箱内ドキュメント一覧（セット復元・トピックハードデリートの対象取得用） */
  listTrashedByTopic(topicId: TopicId): readonly Versioned<TrashedDocument>[];

  /** ゴミ箱内ドキュメント一覧。trash の TrashQueryPort アダプターの内部実装（UNION 枝）専用であり、application 層のユースケースから直接呼ばない（ゴミ箱一覧の読み取り契約は TrashQueryPort に一本化。本メソッドはその実装素材で、読み取り契約の二重定義ではない） */
  listTrashedByUser(): readonly Versioned<TrashedDocument>[];

  /** リビジョンの追記（edit / rollback / create と同一 UoW で呼ぶ。不変・追記のみ） */
  insertRevision(revision: DocumentRevision): void;

  /** リビジョン履歴（revisionNumber 昇順。履歴一覧・差分表示用） */
  listRevisions(documentId: DocumentId): readonly DocumentRevision[];

  /** 特定リビジョンの取得（ロールバック・差分表示用） */
  findRevision(
    documentId: DocumentId,
    revisionNumber: RevisionNumber,
  ): DocumentRevision | null;

  /** 出典リンクの一括登録（Document.create と同一 UoW で呼ぶ） */
  insertSourceLinks(links: readonly SourceLink[]): void;

  /** ドキュメント ID → 出典メモ一覧（「元になったメモ」領域・関連メモ・検索結果の出典リンク先 ID 用） */
  listSourceLinksByDocument(documentId: DocumentId): readonly SourceLink[];

  /**
   * ドキュメント ID 群 → 出典リンクの一括逆引き。
   * トピック詳細（getTopic。P-07 / S-DT-02）の「関連メモ = 配下ドキュメントの出典リンク集約」が
   * 配下ドキュメント数分の N+1 照会にならず 1 クエリで成立する
   * （`listSourceLinksByMemos` / `listByIdsIncludingTrashed` と同水準の一括読み取り）。
   */
  listSourceLinksByDocuments(documentIds: readonly DocumentId[]): readonly SourceLink[];

  /** メモ ID → 参照元ドキュメント一覧（メモ側の「→ ドキュメントX」導線用） */
  listSourceLinksByMemo(memoId: MemoId): readonly SourceLink[];

  /**
   * メモ ID 群 → 参照元ドキュメント一覧の一括逆引き。
   * タイムライン1ページ分（最大100件）の「→ ドキュメントX」導線が 1 クエリで成立する
   * （memo の getTimeline が併用する。`listByIdsIncludingTrashed` と同水準の一括読み取り）。
   */
  listSourceLinksByMemos(memoIds: readonly MemoId[]): readonly SourceLink[];

  /**
   * 参照先メモのハードデリートに伴うリンク消去（ADR-003）。
   * memo ハードデリートのユースケース（trash ドメイン）が同一 UoW で呼ぶ。冪等。
   */
  deleteSourceLinksByMemo(memoId: MemoId): void;

  // --- 保持日数変更に伴う purgeAfter の一括再計算（trash.md「保持期限」） ---
  recalculatePurgeAfter(
    retentionDays: TrashRetentionDays,
    limit: number,
  ): Readonly<{ updatedCount: number; hasMore: boolean }>;
}
```

- `findById` は **active のみ**返す。trashed は `null`（memo と同じ規約。AI からゴミ箱が「存在しない」扱いになる土台。S-AI-04）。trashed も必要な読み取り（復元・ハードデリート・ゴミ箱表示のほか、出典リンクの「削除済み」表示等の人間 UI の読み取り経路）は `findByIdIncludingTrashed` / `listByIdsIncludingTrashed` を使う（AI 向けユースケースでは使用しない）。`delete` はハードデリートで、**アダプターは同一トランザクションで当該ドキュメントの全リビジョンと全出典リンク（documentId 側）も消去する**（4.3「履歴ごとの完全消去」+ ADR-003）
- 保持期限切れ項目の**列挙**は本ポートに置かない。各項目の `purgeAfter` を索引で引くのは trash の `TrashQueryPort.listItemsToPurge` であり、それを呼ぶのは自分の Durable Object の Alarm ジョブである（trash.md「保持期限」）
- `recalculatePurgeAfter` は保持日数変更に伴う一括更新の書き込み口である。契約は `TopicRepository` の同名メソッドと同じ（`purgeAfter` が算出値と一致しないゴミ箱内ドキュメントを `limit` 件まで更新し、残件の有無を返す。OCC トークンを取らず `version` も進めない）
- 一覧系のうち書き込み（save / delete）に接続するもの（`listActiveByTopic` / `listTrashedByTopic` / `listTrashedByUser`）は `Versioned<...>` で OCC トークンを伴って返す（memo 側の `listTrashed` と同規約。セット削除・セット復元・トピックハードデリートのフローが読み直しなしで書き込める）
- 出典メモの表示情報（本文スニペット・投稿日時・削除済みか）は memo ドメインの読み取りポートから取得する。本ポートはリンク（ID の組）だけを返す
- エラーケース: 共通に加え、`insertRevision` の `(documentId, revisionNumber)` 一意制約違反 → `ConflictError`（同時編集の競合として扱う）

## ユースケース（概要）

詳細は Phase 4 で定義。★ = 人間 UI 専用（AI トークンのスコープに存在しない）。

外部入力の ID を受ける全ユースケース（get / 編集 / 削除 / 復元系）に共通: 対象の所有権は到達可能性（ユーザー単位 Durable Object の中に他ユーザーの行が存在しないこと）により構造的に保証され、他ユーザーの ID は NotFound となる。ユースケースごとの所有権チェックは列挙しない。

knowledge ドメインの application 層:

- `createTopic` — トピック作成（UI / MCP `create_topic`）
- `updateTopic` — 名前・説明文の変更、アーカイブ切替（UI / MCP `update_topic`。`rename` / `changeDescription` / `archive` / `unarchive` を入力に応じて合成）
- `trashTopic` — トピックのソフトデリート。`TopicTrashService.trashTopicSet` で配下 active ドキュメントとセット削除（UI / MCP `delete`）
- `listTopics` — トピックと配下ドキュメントの一覧（UI / MCP `list_topics`。配下ドキュメントは `listActiveByTopics` で一括取得する）
- `getTopic` ★ — トピック詳細（配下ドキュメント一覧 + 関連メモ = 配下ドキュメントの出典リンク集約。出典リンクは配下ドキュメント ID 群から `listSourceLinksByDocuments` で一括逆引きし、N+1 照会にしない。関連メモの本文・削除済み表示は `MemoRepository.listByIdsIncludingTrashed` で取得。AI には `list_topics` のみで、IncludingTrashed 読み取りを含む本ユースケースは AI に配線しない）
- `createDocument` — ドキュメント作成。出典メモ ID 群の実在・非ゴミ箱、作成先トピックの実在・非ゴミ箱を検証してから `Document.create`（UI / MCP `create_document`）。出典メモの検証は `MemoRepository.listActiveByIds`（active のみ返す。AI 経路で使用可）で行い、要求 ID のうち結果に含まれないものが 1 件でもあれば全体を失敗させる（存在しない / ゴミ箱内はいずれも「結果に含まれない」として一律 NotFound で扱い、AI にゴミ箱内の存在事実も漏らさない。S-AI-03 異常系。`listByIdsIncludingTrashed` は人間 UI の表示用のままで、本検証には使わない）。所有権は到達可能性により構造的に保証される（他ユーザーの ID は「実在しない」= NotFound として検出される。ユースケース側での `entity.userId` 照合は不要）。**並行する `trashTopic` / アーカイブ切替とのレース排除（設計判断）**: 同一 UoW 内で作成先トピックを OCC トークン付きで読み、トピックを touch（内容不変のまま `version` をインクリメントする `TopicRepository.save`）してからドキュメントを insert する。これにより並行する `trashTopic`（セット削除対象の確定）等と OCC で直列化され、「ソフトデリート済みトピック配下に active ドキュメントが生まれる」レースを構造的に排除する（usecases/knowledge.md の createDocument 処理フロー）
- `editDocument` ★ — 全文形式の編集（人間 UI。変更理由省略時は「手動編集」を補完する経路のため、AI に配線すると「変更理由必須」（4.5）が骨抜きになる。編集競合は memo の editMemo と同方式: 入力 `expectedVersion` との不一致を正常応答 `result: "conflict"` + ConflictView で返し、UI が警告 → ユーザー確認のうえ最新 version で再実行する。AI の編集経路は `editDocumentByAi` のみ）
- `editDocumentByAi` — AI からの編集（MCP `edit_document`。入力は `{ mode: "patch"; patches: DocumentPatch } | { mode: "replaceAll"; body: 全文 }` の判別可能ユニオンで、既定は patch。patch は `DocumentPatch.apply` → `Document.edit`、replaceAll は受領した全文で直接 `Document.edit`。replaceAll はユーザーが明示的に全面書き直しを求めた場合に限る旨をツール定義のガイダンスに明記する。空本文ドキュメントへの編集は replaceAll のみ可。いずれも変更理由必須）
- `rollbackDocument` ★ — 過去リビジョンの内容で新リビジョンを積む
- `trashDocument` — ドキュメントの個別ソフトデリート（`trashedWith: null`。UI / MCP `delete`）
- `getDocument` — 全文取得（UI / MCP `get`。`findById` が active のみ返すため、ゴミ箱内は NotFound になる）
- `listDocumentRevisions` ★ — 履歴一覧（メタデータのみ: revisionNumber・誰が・いつ・なぜ。全文は含めない）
- `diffDocumentRevisions` ★ — 二点のリビジョンの全文 + メタデータを返す（差分の計算・整形は presentation の責務。memo の `diffMemoRevisions` と同じ分割）
- `listDocumentSourceMemos` ★ — ドキュメントの「元になったメモ」一覧（IncludingTrashed 読み取りで「削除済み」表示を組み立てる人間 UI 向けの読み取り）
- `listDocumentsReferencingMemo` ★ — メモの「→ ドキュメントX」導線（同上。人間 UI 向けの読み取り）

AI に公開する knowledge のユースケースは `createTopic` / `updateTopic` / `trashTopic` / `listTopics` / `createDocument` / `editDocumentByAi` / `trashDocument` / `getDocument` の 8 つのみであり、requirements 4.5 の AI 公開動詞（`create_topic` / `update_topic` / `delete` / `list_topics` / `create_document` / `edit_document` / `get`）と 1:1 に対応する（`delete` はトピック / ドキュメントの各ソフトデリートに対応）。上記以外（★ 付き）は AI 側 presentation に配線しない。

trash ドメイン側（knowledge のサービス・ポートを利用）:

- `restoreTopic` ★ — `TopicTrashService.restoreTopicSet` でセット復元
- `restoreDocument` ★ — 個別復元。所属トピックが (a) 存命 → そのまま復元、(b) ゴミ箱内 → 確認のうえ `restoreTopicSet` でトピックごとセット復元し、復元要求対象が `skippedDocuments`（個別削除分）に含まれた場合は同一 UoW 内で追加で `Document.restore`、(c) ハードデリート済み → 復元先選択（既存 / 新規）を受けて `moveToTopic` → `restore`（ADR-001）
- `hardDeleteTopic` ★ / `hardDeleteDocument` ★ / `emptyTrash` ★ / 保持期限による自動ハードデリート — リビジョン・出典リンクごとの完全消去。消去と同一トランザクションで対象のインデックスエントリを除去する。メモのハードデリート時は、消去前に `listSourceLinksByMemo` で影響ドキュメント ID を確定したうえで `deleteSourceLinksByMemo` を同一 UoW で実行し（ADR-003 の同期方式）、各影響ドキュメントのエントリを同じトランザクションで作り直す。ドキュメントのハードデリート時も同様に、消去前に `listSourceLinksByDocument` で出典メモ ID を確定し、各影響メモのエントリを同一 UoW で作り直す（出典関連フィールドの再構築）
