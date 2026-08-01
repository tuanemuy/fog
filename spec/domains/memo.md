# Memo ドメイン

タイムラインに積まれるメモとそのリビジョン履歴を管理する。

- 上流: [requirements.md](../requirements.md) 2章・4.1・4.3、[シナリオ: タイムライン](../scenario/timeline.md)、[シナリオ: AI連携](../scenario/ai.md)、[シナリオ: ゴミ箱](../scenario/trash.md)
- 関連 ADR: [ADR-003](../adr/003-source-link-after-hard-delete.md)、[ADR-004](../adr/004-domain-boundaries.md)、[.adr/003](../../.adr/003-sqlite-fts5-only-search.md)、[.adr/004](../../.adr/004-do-local-commit-and-alarm-jobs.md)（`spec/adr/005` は superseded。根拠側は `.adr/003`、方式側は `.adr/004`）

## ドメイン境界に関する前提

- `Actor`（操作主体: 人間ユーザー / AIクライアント）は identity ドメインが定義する型を参照する（詳細は identity.md）。memo は Actor を不透明な値として保持するのみで、その内部構造に依存しない
- `UserId` も identity ドメインの型を参照する（ID参照のみ）
- **出典リンクは knowledge ドメインが保持する**（ADR-004）。memo は自分がどのドキュメントの出典になっているかを知らない。タイムライン上の「→ ドキュメントX」導線は、表示時に knowledge 側へ `MemoId` で照会（メモ群を出典とする出典リンクの逆引き）して実現する。同様に、メモのハードデリート時の出典リンク消去（ADR-003）は**同期方式**で行う: trash ドメインのユースケースが同一 UnitOfWork 内で `MemoRepository.hardDelete`（メモ本体とリビジョンの消去）と knowledge の `DocumentRepository.deleteSourceLinksByMemo`（出典リンクの消去）を呼ぶオーケストレーション責務を負う。memo ドメイン自身は出典リンクに関知しない
- **差分は保存しない**。リビジョンは毎回全文スナップショットであり、任意二点間の差分は表示時（presentation 層）に計算する
- 検索インデックスの更新は、メモ本体を書くのと**同一のトランザクションの中の projection 処理**として行う（`.adr/004`。詳細は search.md「インデックスの維持」）。別ストアへ配送する経路は持たない

## ユビキタス言語

| 英語名 | 日本語名 | 定義 |
|---|---|---|
| Memo | メモ | タイムラインに積まれるタイムスタンプ付きの最小単位。時系列・追記型・非構造のプレーンテキスト。アドレス可能なアトムであり内部構造を持たない |
| Timeline | タイムライン | ユーザーのメモを投稿日時の新しい順に並べた列。日付見出しのグルーピングは UI の表示上の概念で、ドメインモデルには存在しない |
| MemoBody | 本文 | メモのプレーンテキスト本文。Markdown 軽装飾は表示上の解釈であり、データモデル上は非構造テキスト |
| PostedAt | 投稿日時 | メモが最初に投稿された日時。タイムライン上の位置を決める。編集しても変わらない |
| MemoRevision | リビジョン | 編集のたびに積まれる不変の全文スナップショット。「誰が（Actor）・いつ」を記録する。メモのリビジョンは変更理由（ドキュメントにはある）を持たない |
| RevisionNumber | リビジョン番号 | 1 から始まる連番。履歴は線形（欠番・分岐なし） |
| Rollback | ロールバック | 過去リビジョンと同内容の**新しい**リビジョンを積む操作。履歴は消えない |
| SoftDelete | ソフトデリート | メモをゴミ箱に移す可逆な削除。trashed 状態への遷移 |
| Restore | 復元 | trashed 状態から active 状態へ戻す操作。タイムラインの元の位置（postedAt）に戻る |
| HardDelete | ハードデリート | リビジョン履歴ごとの完全消去。人間の UI 操作専用（AI には API が存在しない）。不可逆 |

## エンティティ

### Memo（集約ルート）

ライフサイクル状態は判別可能なユニオンで表現する。`trashedAt` / `purgeAfter` は trashed 状態にのみ存在し、あり得ない組み合わせ（active なのに trashedAt がある等）を型上表現できない。

```ts
type MemoBase = Readonly<{
  id: MemoId;
  userId: UserId;            // identity ドメインの型（ID参照）
  body: MemoBody;            // 現在の本文（= 最新リビジョンの本文と常に一致）
  latestRevisionNumber: RevisionNumber; // 最新リビジョンの番号（線形性の担保）
  postedAt: Date;            // 投稿日時。以後不変
  version: number;           // OCC 用。0 始まり、書き込みごとに +1
  updatedAt: Date;
}>;

export type ActiveMemo  = MemoBase & Readonly<{ status: "active" }>;
export type TrashedMemo = MemoBase & Readonly<{
  status: "trashed";
  trashedAt: Date;
  purgeAfter: Date;          // 保持期限。ゴミ箱にある間だけ意味を持つ
}>;
export type Memo = ActiveMemo | TrashedMemo;
```

| フィールド | 型 | 制約 |
|---|---|---|
| id | MemoId | required。不変 |
| userId | UserId | required。不変。メモは所有ユーザーに閉じる。**値は所属する Durable Object の同一性そのものであり、行ごとの絞り込みには用いない**（domains/index.md「テナント分離」） |
| body | MemoBody | required。非空。最新リビジョンの本文と常に一致 |
| latestRevisionNumber | RevisionNumber | required。1 以上。リビジョン追加時のみ +1 |
| postedAt | Date | required。create 時に確定し以後不変（編集してもタイムライン上の位置は変わらない） |
| version | number | required。0 始まり。OCC トークンの元 |
| status / trashedAt / purgeAfter | 直和型 | active には trashedAt / purgeAfter が存在しない |

#### 不変条件

1. 本文は常に非空（空文字への編集は不可。MemoBody の生成時制約で担保）
2. リビジョン履歴は線形: リビジョン番号は 1 から始まる連番で欠番・分岐がない。`latestRevisionNumber` は常に存在する最大のリビジョン番号と一致する
3. `body` は常にリビジョン `latestRevisionNumber` の `body` と一致する（現在本文 = 最新スナップショット）
4. trashed 状態では編集・ロールバックできない（`edit` / `rollback` が `ActiveMemo` のみを受けることで型レベルで担保）
5. `postedAt`・`userId`・`id` は生成後変更されない
6. 本文が変わらない操作ではリビジョンを積まない（同一本文の連続リビジョンは存在しない）
7. リビジョンはメモと同一の集約に属し、メモがハードデリートされるとき全リビジョンも同時に消去される
8. `trashed` であることと `purgeAfter` を持つことは同値。ソフトデリートで設定し、復元で必ず落とす（trash.md「保持期限」）

#### 振る舞い

コード規約は `docs/backend_implementation_example.md` に従う: 純関数ファクトリ、`now: Date` と `id` は引数で受ける（ドメインは `new Date()` / ID生成をしない）、状態遷移は次状態のエンティティだけを返す。VO 構築はファクトリ内に集約し、application 層は生文字列を渡す。

```ts
export const Memo = {
  create: (
    params: { id: string; userId: string; body: string; actor: Actor },
    now: Date,
  ): { memo: ActiveMemo; initialRevision: MemoRevision } => { /* ... */ },

  edit: (
    memo: ActiveMemo,
    params: { body: string; actor: Actor },
    now: Date,
  ): { memo: ActiveMemo; newRevision: MemoRevision | null } => { /* ... */ },

  rollback: (
    memo: ActiveMemo,
    params: { targetRevision: MemoRevision; actor: Actor },
    now: Date,
  ): { memo: ActiveMemo; newRevision: MemoRevision | null } => { /* ... */ },

  softDelete: (
    memo: ActiveMemo,
    purgeAfter: Date,
    now: Date,
  ): TrashedMemo => { /* ... */ },

  restore: (
    memo: TrashedMemo,
    now: Date,
  ): ActiveMemo => { /* ... */ },
};
```

##### create

- 引数: `params { id: string; userId: string; body: string; actor: Actor }`, `now: Date`
- 戻り値: `{ memo: ActiveMemo; initialRevision: MemoRevision }`
- 処理:
  1. `MemoId.create(params.id)`・`UserId.create(params.userId)`・`MemoBody.create(params.body)` で VO を構築（本文が空なら `BusinessRuleError(MemoErrorCode.EmptyBody)` が throw される）
  2. `postedAt = now`、`version = 0`、`latestRevisionNumber = RevisionNumber.first()`（= 1）の `ActiveMemo` を組み立てる
  3. 初版リビジョン `MemoRevision`（`revisionNumber = 1`、`actor = params.actor`、`body` = メモ本文、`createdAt = now`）を同時に生成する。**メモは必ず初版リビジョンを伴って生まれる**
- インデックス: 永続化と同一トランザクションで対象メモのエントリを作る（search.md「インデックスの維持」）

##### edit

- 引数: `memo: ActiveMemo`, `params { body: string; actor: Actor }`, `now: Date`
- 戻り値: `{ memo: ActiveMemo; newRevision: MemoRevision | null }`
- 処理:
  1. `MemoBody.create(params.body)` で新本文を構築（空なら throw）
  2. **新本文が現在の `memo.body` と等価（`MemoBody.equals`）なら何もしない**: `memo` をそのまま、`newRevision: null` を返す（version も上げない。S-TL-04「変更せずに保存した場合、新しいリビジョンは積まれない」）
  3. 異なる場合: `body` を差し替え、`latestRevisionNumber` を `RevisionNumber.next()` で +1、`version + 1`、`updatedAt = now` の次状態を作り、新リビジョン（`revisionNumber = 新しい latestRevisionNumber`、`actor`、新本文の全文スナップショット、`createdAt = now`）を生成する
  4. `postedAt` は変更しない
- インデックス: 本文が変わった場合のみ、永続化と同一トランザクションでエントリを作り直す
- 補足: 編集競合（人間が編集画面を開いている間に AI が編集したケース、S-TL-04）は OCC（`version`）で検出する。警告後の「そのまま保存」は、application 層が最新を読み直して本 `edit` を再適用することで新リビジョンとして積む（AI の編集も履歴に残る）

##### rollback

- 引数: `memo: ActiveMemo`, `params { targetRevision: MemoRevision; actor: Actor }`, `now: Date`
- 戻り値: `{ memo: ActiveMemo; newRevision: MemoRevision | null }`
- 処理:
  1. `targetRevision.memoId` が `memo.id` と一致しなければ `BusinessRuleError(MemoErrorCode.RevisionMismatch)` を throw
  2. 過去リビジョンの本文を新本文として `edit` と同じ手順を適用する。すなわち**過去リビジョンと同内容の新しいリビジョンを積む**（履歴の巻き戻し・削除はしない）
  3. 現在本文と対象リビジョンの本文が同一なら何もしない（`newRevision: null`）
- インデックス: `edit` と同じ（ロールバックは「過去と同内容の編集」であり、別扱いをしない）

##### softDelete

- 引数: `memo: ActiveMemo`, `purgeAfter: Date`, `now: Date`
- 戻り値: `TrashedMemo`
- 処理: `status: "trashed"`、`trashedAt: now`、`purgeAfter`、`version + 1`、`updatedAt = now` の `TrashedMemo` を返す。本文・リビジョン・`postedAt` は保持される。`purgeAfter` は `RetentionPolicy.expiresAt` の算出結果を application 層が渡す（trash.md）
- インデックス: 永続化と同一トランザクションで対象メモのエントリを除去し、あわせてこのメモを出典とするドキュメントのエントリを作り直す（ゴミ箱内は検索にヒットせず、ID も露出しない）

##### restore

- 引数: `memo: TrashedMemo`, `now: Date`
- 戻り値: `ActiveMemo`
- 処理: `status: "active"` に戻し `trashedAt` と `purgeAfter` を落とす。`version + 1`、`updatedAt = now`。`postedAt` は不変のため、タイムラインの元の位置に戻る（S-TR-02）
- インデックス: 永続化と同一トランザクションで対象メモのエントリを作り直し、あわせてこのメモを出典とするドキュメントのエントリも作り直す

##### hardDelete について

ハードデリートは後続エンティティが存在しない操作のため、規約どおり**ドメインにメソッドを置かない**。application 層（trash ドメインのユースケース）が同一 UnitOfWork 内で次をオーケストレーションする:

1. knowledge の `DocumentRepository.listSourceLinksByMemo(memoId)` で当該メモを出典とするドキュメント ID 群を確定する（消去前に取得する）
2. `MemoRepository.hardDelete` でメモ本体と全リビジョンを消去する
3. knowledge の `DocumentRepository.deleteSourceLinksByMemo(memoId)` で出典リンクを消去する（ADR-003。同期方式）
4. 同じトランザクションの中で、当該メモのインデックスエントリを除去し、手順 1 で確定した各ドキュメントのエントリを作り直す（`sourceMemoIds` からこのメモの ID が外れる）

人間の UI 専用であり、AI 向けユースケースには存在しない。

#### ライフサイクル

```
（なし） --create--> active --softDelete--> trashed --restore--> active
                                  trashed --hardDelete--> （消滅。リビジョンごと）
```

- trashed からの `edit` / `rollback` / `softDelete` は型エラー（メソッドが `ActiveMemo` のみ受ける）
- trashed のメモに対する AI からの操作は application 層で「存在しない」扱い（`NotFoundError`）にする（S-AI-04。`findById` が active のみ返すことで自然に実現される）

### MemoRevision

不変のスナップショット。生成後、いかなる変更・削除もされない（例外はメモ本体のハードデリートによる一括消去のみ）。

```ts
export type MemoRevision = Readonly<{
  memoId: MemoId;
  revisionNumber: RevisionNumber; // (memoId, revisionNumber) が識別子
  actor: Actor;                   // 誰が（identity ドメインの Actor: 人間 / どのAIクライアントか）
  body: MemoBody;                 // 全文スナップショット
  createdAt: Date;                // いつ
}>;
```

| フィールド | 型 | 制約 |
|---|---|---|
| memoId | MemoId | required。所属メモ |
| revisionNumber | RevisionNumber | required。メモ内で一意・線形 |
| actor | Actor | required。identity の Actor を参照 |
| body | MemoBody | required。全文スナップショット（差分ではない） |
| createdAt | Date | required |

- **識別子**: `(memoId, revisionNumber)` の複合キー。独立した ID は持たない
- **変更理由は持たない**（requirements 4.3。ドキュメントのリビジョンとの明確な差異）
- **振る舞い**: なし（不変値）。生成は `Memo.create` / `Memo.edit` / `Memo.rollback` の内部でのみ行われ、単独のファクトリを公開しない
- 差分表示（S-TL-05）は任意の 2 リビジョンの `body` から表示時に計算する。ドメインは差分を保持・計算しない

## 値オブジェクト

コード規約: `unique symbol` によるブランド型 + `create` ファクトリのみを生成経路とし、違反時は `BusinessRuleError<MemoErrorCode>` を throw する。

### MemoId

- フィールド: `string`（ブランド付き）
- バリデーション: trim 後に空なら `BusinessRuleError(MemoErrorCode.InvalidId)`。形式（UUIDv7 等）は `IdGenerator` ポートの責務であり、ドメインは不透明な非空文字列として扱う
- 等価性: 文字列値の一致

### MemoBody

- フィールド: `string`（ブランド付き）。プレーンテキスト。Markdown 軽装飾は表示上の解釈であり、ドメインは構造を解釈しない
- バリデーション:
  - **非空**: trim した長さが 0 なら `BusinessRuleError(MemoErrorCode.EmptyBody)`（保存する値は入力そのまま。trim は空判定のみに使う）
  - **上限長**: **10,000 文字**（Unicode コードポイント数）を超えたら `BusinessRuleError(MemoErrorCode.BodyTooLong)`。メモは「アトム」であり長大な文書はドキュメントの領分、という位置づけを上限で表現する
- 等価性: 文字列値の完全一致（`MemoBody.equals(a, b)`）。edit / rollback の「同一なら積まない」判定に用いる

### RevisionNumber

- フィールド: `number`（ブランド付き）
- バリデーション: 1 以上の整数でなければ `BusinessRuleError(MemoErrorCode.InvalidRevisionNumber)`
- 補助ファクトリ: `RevisionNumber.first()`（= 1）、`RevisionNumber.next(n)`（= n + 1）
- 等価性: 数値の一致

### TimelineCursor

- フィールド: `string`（ブランド付き）。タイムラインのカーソルページング用の不透明トークン。エンコード内容（postedAt + MemoId 等）はアダプター実装詳細とし、ドメイン・application 層は解釈しない。カーソルは**位置のみ**を表し方向を含まない（読む向きは `findTimelinePage` の `direction` が決める。同一カーソルから両方向へ読める）
- バリデーション: 非空でなければ `BusinessRuleError(MemoErrorCode.InvalidCursor)`。デコード不能なカーソルはアダプター境界で `ValidationError` にマップする
- 等価性: 文字列値の一致

### 参照する外部の値オブジェクト

- `UserId` — identity ドメイン
- `Actor` — identity ドメイン（人間ユーザー / AIクライアントのトークン識別。リビジョンの「誰が」）
- `TrashRetentionDays` — identity ドメイン（`purgeAfter` の一括再計算の入力。算出規則は trash の `RetentionPolicy`）

## ドメインサービス

なし。メモは単一集約で完結し、複数エンティティにまたがるロジックを持たない。出典表示・検索・ゴミ箱規則はそれぞれ knowledge / search / trash の責務。

## ポート

### MemoRepository

- 目的: Memo 集約（メモ本体 + リビジョン）の永続化と読み取り
- 規約: `TransactionalRepository<Memo, MemoId>` の OCC 契約に従う（同期契約であり、全メソッドが `Promise` を返さない。domains/index.md「ポートの同期契約」）。`ExpectedVersion<Memo>` トークンは `Versioned<...>` を返す読み取りメソッド（`findById` / `findByIdIncludingTrashed` / `listTrashed` / `listActiveByIds`）が発行し、`save` / `hardDelete` は必須引数として受ける（「読まずに書く」を型エラーにする）。DB 例外はアダプターが `SystemError(DatabaseError)` に変換する
- **テナント分離（domains/index.md「テナント分離」）**: `userId` はユーザー単位 Durable Object の選択で消費済みなので、どのメソッドも引数に取らない。DO の中に他ユーザーの行が原理的に存在しないため、他ユーザーの ID を渡しても結果は「存在しない」（null / 空配列）になる。所有権検証は到達可能性により構造的に保証され、ユースケース層の追加検証に依存しない

```ts
export interface MemoRepository {
  // --- 書き込み ---
  insert(memo: ActiveMemo): void;
  insertRevision(revision: MemoRevision): void;
  save(memo: Memo, expectedVersion: ExpectedVersion<Memo>): void;
  hardDelete(id: MemoId, expectedVersion: ExpectedVersion<Memo>): void;

  // --- 単体読み取り ---
  findById(id: MemoId): Versioned<ActiveMemo> | null;
  findByIdIncludingTrashed(id: MemoId): Versioned<Memo> | null;

  // --- 出典表示用の一括読み取り ---
  listByIdsIncludingTrashed(ids: readonly MemoId[]): readonly Memo[];

  // --- active 限定の一括読み取り（AI 経路で使用可） ---
  listActiveByIds(ids: readonly MemoId[]): readonly Versioned<ActiveMemo>[];

  // --- タイムライン読み取り ---
  findTimelinePage(
    query: Readonly<{
      cursor: TimelineCursor | null;   // null なら先頭（最新）から。direction: "newer" では非 null 必須
      direction: "older" | "newer";    // カーソル位置から過去方向 / 新しい方向のどちらへ読むか
      limit: number;                   // 1〜100
      keyword: string | null;          // 本文の部分一致絞り込み（S-TL-03）
    }>,
  ): Readonly<{ items: readonly ActiveMemo[]; nextCursor: TimelineCursor | null }>;

  findTimelineAround(
    anchor: Readonly<
      | { kind: "date"; date: Date }   // 日付ジャンプ（S-TL-03）
      | { kind: "memo"; memoId: MemoId } // 指定メモ位置の表示（P-04）
    >,
    query: Readonly<{ limit: number; keyword: string | null }>,
  ): Readonly<{
    items: readonly ActiveMemo[];        // アンカー位置を含む前後のメモ（postedAt 降順）
    olderCursor: TimelineCursor | null;  // さらに古い側の続きを findTimelinePage(direction: "older") で読むためのカーソル
    newerCursor: TimelineCursor | null;  // さらに新しい側の続きを findTimelinePage(direction: "newer") で読むためのカーソル
  }>;

  // --- リビジョン読み取り ---
  listRevisions(memoId: MemoId): readonly MemoRevision[];
  findRevision(memoId: MemoId, revisionNumber: RevisionNumber): MemoRevision | null;

  // --- ゴミ箱向け読み取り（trash の TrashQueryPort アダプターの内部実装専用。ユースケースから直接呼ばない） ---
  listTrashed(): readonly Versioned<TrashedMemo>[];

  // --- 保持日数変更に伴う purgeAfter の一括再計算（trash.md「保持期限」） ---
  recalculatePurgeAfter(
    retentionDays: TrashRetentionDays,
    limit: number,
  ): Readonly<{ updatedCount: number; hasMore: boolean }>;
}
```

各メソッドの仕様とエラーケース:

| メソッド | 仕様 | エラーケース |
|---|---|---|
| insert | 初回永続化専用（version 0）。OCC トークン不要 | 主キー重複・DB 障害 → `SystemError(DatabaseError)` |
| insertRevision | リビジョンの追記。`Memo.create` / `edit` / `rollback` が返した `MemoRevision` を、メモ本体の `insert` / `save` と**同一 UoW** で書く | `(memoId, revisionNumber)` 一意制約違反（線形性の最終防衛線）・DB 障害 → `SystemError(DatabaseError)` |
| save | active / trashed を問わず現在状態を上書き（softDelete / restore / edit 後の反映に共通で使う）。0 行更新は競合 | version 不一致 → `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| hardDelete | メモ本体と**全リビジョン**を同一 UoW で物理削除する | version 不一致 → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。対象なしは呼び出し前の findByIdIncludingTrashed で検出済みの前提 |
| findById | **active のみ**返す。trashed は null（AI からゴミ箱が「存在しない」世界の土台。S-AI-04） | DB 障害 → `SystemError(DatabaseError)`（以下同） |
| findByIdIncludingTrashed | 状態を問わず返す。人間 UI の読み取り経路（出典リンクの「削除済み」表示・履歴等）と trash 系ユースケースで使用可。AI 向けユースケースでは使用しない | 同上 |
| listByIdsIncludingTrashed | 指定 ID 群のメモを trashed 含め一括取得する（出典表示用。ドキュメントの「元になったメモ」の本文抜粋・投稿日時＋削除済みフラグ表示 S-DT-07 が 1 クエリで成立する）。存在しない（ハードデリート済み）ID は結果に含めない。使用範囲は findByIdIncludingTrashed と同じ（AI 向けユースケースでは使用しない） | 同上 |
| listActiveByIds | 指定 ID 群のメモを **active のみ**一括取得する。trashed・存在しない ID はいずれも結果に含めない（区別せず一律「含まれない」とし、ゴミ箱内の存在事実も漏らさない）。**AI 経路で使用可**: knowledge の `createDocument` の出典メモ検証（要求 ID のうち結果に含まれないものが 1 件でもあれば全体を失敗。S-AI-03 異常系）が主用途 | 同上 |
| findTimelinePage | **active** なメモをカーソル位置から `direction` の向きに読む双方向カーソルページング。`items` は方向によらず常に `postedAt` 降順（同時刻は id で安定化）。`direction: "older"` はカーソルより過去側、`"newer"` はカーソルより新しい側を返し、`nextCursor` は同じ方向の続きを指す（`null` はその方向の終端）。`cursor: null` は先頭（最新）からの過去方向読みにのみ許される。`keyword` があれば本文部分一致で絞り込み。0 件は空配列（エラーにしない） | デコード不能な cursor → `ValidationError`。limit 範囲外・`direction: "newer"` で `cursor: null` はアダプター境界で `ValidationError` |
| findTimelineAround | アンカー位置を中心に前後（新しい側・古い側）のメモを読む。`anchor.kind: "date"` は指定日の先頭位置（その日にメモがなければ**前後で最も近い**メモの位置。S-TL-03）、`anchor.kind: "memo"` は指定メモの位置（P-04 の「指定メモ位置へのスクロール＋ハイライト」の初期ページ。対象メモを `items` に含める）。以降の両方向無限スクロールは戻り値の `olderCursor` / `newerCursor` から `findTimelinePage` で継続する。メモが 0 件（keyword 絞り込み後 0 件を含む）なら `items: []`・両カーソル null。`anchor.kind: "memo"` の対象が不在・trashed の場合の扱い（案内表示等）はユースケースの責務とし、本メソッドは空結果を返す | DB 障害 → `SystemError(DatabaseError)` |
| listRevisions | 指定メモの全リビジョンを `revisionNumber` 昇順で返す。メモが存在すれば必ず 1 件以上 | メモ不存在時は空配列（存在確認は呼び出し側の責務） |
| findRevision | 単一リビジョン取得（ロールバック・差分表示用）。なければ null | DB 障害 → `SystemError(DatabaseError)` |
| listTrashed | trashed メモを `trashedAt` 降順で返す（ゴミ箱一覧用）。**`TrashQueryPort` アダプターの内部実装（UNION 枝）専用であり、application 層のユースケースから直接呼ばない**（ゴミ箱一覧の読み取り契約は trash の `TrashQueryPort` に一本化されており、本メソッドはその実装素材。読み取り契約の二重定義ではない） | 同上 |
| recalculatePurgeAfter | ゴミ箱内のメモのうち、`purgeAfter` が `retentionDays` から算出される値と一致しない行を `limit` 件まで一括更新する（**OCC トークンを取らない。`version` も進めない** — 派生値の追随であって業務上の変更ではないため）。戻り値の `hasMore` が残件の有無で、進捗はカーソルではなく作業述語が表す（trash.md「保持期限」）。**active な行には触れない**（`purgeAfter` を持つのは trashed だけである） | 同上 |

保持期限切れ項目の処理（自動ハードデリート。S-TR-05）は本ポートには列挙メソッドを置かない。各項目の `purgeAfter` を索引で引くのは trash の `TrashQueryPort.listItemsToPurge` であり、それを呼ぶのは自分の Durable Object の Alarm ジョブである（trash.md「保持期限」）。そこで得た ID に対し `findByIdIncludingTrashed` で OCC トークン付きの対象を個別再取得してハードデリートする。**`recalculatePurgeAfter` は列挙ではなく一括更新の書き込み口であり、この規則の例外ではない**（読み取り契約は `TrashQueryPort` に一本化したままである）。

ポートはドメイン型（ブランド VO・直和型エンティティ）を受け渡す。行データからのデコード（ブランド再構築・状態判別）はアダプター境界の責務で、不整合な行は `SystemError(DataIntegrityError)` にマップする。

補足: 出典リンクの照会ポートは memo には**置かない**。「→ ドキュメントX」表示に必要な逆引き（`MemoId[] → 出典リンク先ドキュメント`）は knowledge ドメインのポート（`DocumentRepository.listSourceLinksByMemos`。タイムライン1ページ分を1クエリで一括逆引き）として定義され、タイムライン表示のユースケースがそれを併用する。

## ユースケース（概要）

詳細は Phase 4（ユースケース設計）で定義。列挙のみ。

外部入力の ID を受ける全ユースケース（get / 編集 / 履歴 / 削除系）に共通: 対象の所有権は到達可能性（ユーザー単位 Durable Object の中に他ユーザーの行が存在しないこと）により構造的に保証され、他ユーザーの ID は NotFound となる。ユースケースごとの所有権チェックは列挙しない（domains/index.md「テナント分離」）。

### 人間 UI 用

| ユースケース | 概要 | 対応シナリオ |
|---|---|---|
| postMemo | メモを投稿する（初版リビジョンを伴う） | S-TL-01 |
| getTimeline | タイムラインをカーソルページングで閲覧する（`findTimelinePage`。初期表示は先頭から過去方向、以降は `direction: "older" / "newer"` で両方向の無限スクロールに対応）。表示用に knowledge の `listSourceLinksByMemos` へ1ページ分のメモ ID 群を渡して出典リンクを一括逆引き照会する | S-TL-02, S-TL-07 |
| filterTimeline / jumpToDate | キーワード絞り込み・日付ジャンプ。日付ジャンプは `findTimelineAround(anchor: { kind: "date" })` で前後を含む初期ページを取得し、以降は `olderCursor` / `newerCursor` から `findTimelinePage` で両方向に閲覧を継続する | S-TL-03 |
| showMemoInTimeline | 他画面（P-05 / P-07 / P-08 / P-11）からの「タイムラインの該当位置へ」遷移の受け口。`findTimelineAround(anchor: { kind: "memo" })` で対象メモを含む前後ページを取得し、スクロール＋ハイライト表示する（対象が不在・trashed なら案内表示）。以降の両方向閲覧は jumpToDate と同様 | P-04（指定メモ位置の表示） |
| editMemo | 本文を編集する（同一本文なら何もしない。OCC 競合は警告 → 再適用） | S-TL-04 |
| listMemoRevisions | 履歴（誰が・いつ）を閲覧する | S-TL-05 |
| diffMemoRevisions | 任意二点のリビジョンを取得し差分を表示時計算する | S-TL-05 |
| rollbackMemo | 過去リビジョンと同内容の新リビジョンを積む | S-TL-05 |
| softDeleteMemo | ソフトデリート（ゴミ箱へ） | S-TL-06 |

復元（restoreMemo）・ハードデリート（hardDeleteMemo）・保持期限の自動削除は trash ドメインのユースケースとして定義され、本ドメインの `Memo.restore` / `MemoRepository.hardDelete` を利用する（S-TR-02〜05）。

### AI API 用（MCP / REST）

| ユースケース | 概要 | 備考 |
|---|---|---|
| post_memo | メモの投稿。Actor は AI クライアントのトークン識別から解決 | S-AI-01 |
| update_memo | メモの修正（**全文置換のみ**。履歴は自動で積まれる）。trashed は NotFound 扱い。requirements 4.3 の「原則パッチ」はドキュメント専用とし、メモはパッチ対象外（[ADR-006](../adr/006-memo-fulltext-update.md)） | S-AI-04 |
| recent_memos | タイムライン直近の取得（findTimelinePage の keyword なし・`cursor: null`・`direction: "older"`） | S-AI-02 |
| get | メモ全文の単体取得（active のみ）。パッチ編集の前提操作 | S-AI-02 |
| delete | ソフトデリートのみ | S-AI-05 |

AI 用に**公開しない**もの: ハードデリート・ゴミ箱操作（一覧・復元）・履歴閲覧・ロールバック（requirements 4.5）。二層で構造的に排除する（domains/identity.md「TokenScope」）: `actor` を入力に持つ ★ ユースケース（editMemo / rollbackMemo）は `actor` の型を `UserActor` に限定して型エラーで排除し、`actor` を持たない ★ ユースケース（履歴閲覧・削除系）は AI 側 presentation に配線しないこと（配線分離）＋ AI トークンの認可ミドルウェアの許可ユースケース列挙に含めないことで排除する。
