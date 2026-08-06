# Trash

ソフトデリート済み項目（メモ / ドキュメント / トピック）の横断閲覧・復元・ハードデリート・保持期限の規則を定めるドメイン。

削除状態そのものは memo / knowledge の各エンティティがライフサイクル状態として持つ（ADR-004）。本ドメインはエンティティを持たず、横断ビュー（値オブジェクト）・規則（ドメインサービス）・読み取りポートのみで構成される。他ドメインの型はすべてID参照（`UserId` / `MemoId` / `DocumentId` / `TopicId`）で扱い、エンティティを直接参照しない。

関連: requirements.md 4.3、S-TR-01〜05、P-12、ADR-001、ADR-003、ADR-004

## ユビキタス言語

| 英語名 | 日本語名 | 定義 |
|---|---|---|
| Soft Delete | ソフトデリート | 項目をゴミ箱へ移す可逆な削除。データ・リビジョン履歴は保持され、検索にヒットせず、AIからは「存在しない」扱いになる |
| Trash | ゴミ箱 | ソフトデリート済み項目が保持期限まで留まる場所。実体はコンテナではなく、memo / knowledge の削除状態を横断して一覧する読み取りビュー |
| Trash Item | ゴミ箱項目 | ゴミ箱に表示される1件。種別（メモ / ドキュメント / トピック）の直和として表現される読み取り専用ビュー |
| Hard Delete | ハードデリート | リビジョン履歴・出典リンクごとの完全消去（ADR-003）。不可逆。人間のUI操作専用でAIには存在しない |
| Restore | 復元 | ゴミ箱項目を元の場所（メモはタイムラインの元の位置、ドキュメントは元のトピック配下）へ戻す操作。人間のUI専用 |
| Retention Period | 保持期限 | ソフトデリートからハードデリートまでの猶予日数。既定30日、ユーザー設定（identity ドメイン）で変更可能。変更は既存のゴミ箱項目にも遡及適用される |
| Cascade Delete (Set Delete) | セット削除 | トピックのソフトデリート時に配下ドキュメントも一緒に削除されること。復元・ハードデリートもセットで扱われる |
| Cascade Restore (Set Restore) | セット復元 | セット削除されたトピックと配下ドキュメントを一括で復元すること |
| Expiration | 期限切れ | **保存された `purgeAfter` が現在時刻を過ぎた状態。** `purge-trash` ジョブによる自動ハードデリートの対象。判定の権威は保存値であり、`trashedAt + retentionDays` の算出結果ではない（保持日数の変更直後は再計算が済むまで両者が一致しない） |
| Empty Trash | 空にする | ゴミ箱内の全項目を一括ハードデリートする操作 |

## エンティティ

なし。

ソフトデリート状態（`trashedAt` を含む）は memo ドメインの `Memo`、knowledge ドメインの `Document` / `Topic` が各自のライフサイクル状態（直和型）として持つ。trash ドメインはそれらを `TrashItem` という読み取り専用ビューに射影して扱うだけで、状態を所有しない。したがってリポジトリ（`TransactionalRepository`）も持たない。

## 値オブジェクト

### TrashItem

ゴミ箱一覧の1件を表す読み取り専用ビュー。種別ごとの直和型として定義し、あり得ないフィールドの組み合わせ（例: メモに `topicId` がある）を型上排除する。

```ts
export type TrashedMemoItem = Readonly<{
  kind: "memo";
  id: MemoId;
  excerpt: string;        // 本文の先頭抜粋（表示用。切り詰め方式は実装詳細）
  trashedAt: Date;
  expiresAt: Date;        // 保存された purge_after をそのまま返す
}>;

export type TrashedDocumentItem = Readonly<{
  kind: "document";
  id: DocumentId;
  title: string;          // ドキュメントのタイトル（表示用）
  topicId: TopicId;       // 削除時点の所属トピック（復元先の判定に使う）
  deletedWithTopic: boolean; // true: トピックのセット削除で一緒に削除された（S-TR-01 のセット関係表示に使う）
  trashedAt: Date;
  expiresAt: Date;
}>;

export type TrashedTopicItem = Readonly<{
  kind: "topic";
  id: TopicId;
  name: string;           // トピック名（表示用）
  setDocumentIds: readonly DocumentId[]; // セット削除された配下ドキュメントの ID 群（セット復元・セットハードデリートの対象。TrashQueryPort が一覧・単体取得時に trashedWith から射影して埋める）
  trashedAt: Date;
  expiresAt: Date;
}>;

export type TrashItem = TrashedMemoItem | TrashedDocumentItem | TrashedTopicItem;
```

- バリデーションルール: `excerpt` / `title` / `name` は表示用文字列で制約なし（原本の制約は memo / knowledge が担う）。`expiresAt > trashedAt` であること（`retentionDays >= 1` から導かれる）。ID は各ドメインのブランド付きVOをそのまま用いる
- 等価性: `kind` + `id` の組で同一とみなす
- 生成経路: `TrashQueryPort` を実装するアダプターが memo / knowledge のテーブルから射影して生成する（ドメイン層にファクトリは置かず、型定義のみ置く。読み取り専用ビューでありビジネスルールによる生成制約がないため）
- `expiresAt` は**保存値**（各エンティティの `purgeAfter`）である。保持期限変更の遡及適用（S-TR-05 エッジケース）は、変更と同一トランザクションでゴミ箱内全項目の `purgeAfter` を一括再計算することで成立する（後述「保持期限」）

### 保持日数（TrashRetentionDays）

保持期限の日数を表す VO は trash では定義せず、**identity ドメインの `TrashRetentionDays` を参照する**（依存方向は trash → identity であり、既存の `UserId` 参照と同方向。循環は生じない）。

- 定義・バリデーション（1以上の整数）・既定値（`TrashRetentionDays.default()` = 30）・エラーコード（`IdentityErrorCode.InvalidTrashRetentionDays`）はすべて identity 側の定義に従う。trash 側に重複定義やエラーコードは置かない
- 期限計算の規則（`RetentionPolicy`）は trash が定め、その入力として identity の `TrashRetentionDays` を受け取る

## ドメインサービス

いずれも純関数の集まりとして定義する（外部ポートに依存しない。`now: Date` は引数で受け取る）。

### RestorePolicy

- 責務: 種別ごとの復元規則と、ドキュメント復元時の分岐判定を定める
- 依存するポート: なし（純関数）

復元規則:

| 対象 | 規則 |
|---|---|
| メモ | 単独で復元。タイムラインの元の位置（元のタイムスタンプ）に戻る |
| ドキュメント | 所属トピックの状態により分岐（下記 `decideDocumentRestore`） |
| トピック | セット削除された配下ドキュメント（`setDocumentIds`）ごとセット復元。個別に削除されてゴミ箱にあるドキュメントは対象外 |

メソッド:

```ts
/** 復元しようとするドキュメントの所属トピックの現況。呼び出し側（ユースケース）が knowledge のリポジトリで調べて渡す */
export type TopicStatusForRestore =
  | { kind: "active" }      // トピックは通常状態（アーカイブ済み含む）で存在する
  | { kind: "trashed" }     // トピックもゴミ箱内にある
  | { kind: "hardDeleted" }; // トピックはハードデリート済みで存在しない

/** ドキュメント復元の実行計画 */
export type DocumentRestorePlan =
  | { kind: "restoreAlone" }                                  // 単独復元してよい
  | { kind: "restoreWithTopic"; topicId: TopicId }            // トピックとのセット復元。実行前にユーザー確認を要する（S-TR-02）
  | { kind: "selectDestination" };                            // 復元先トピックの選択（既存 / 新規作成）を要する（ADR-001）

export const RestorePolicy = {
  /** ドキュメント復元の分岐を判定する純関数 */
  decideDocumentRestore: (
    item: TrashedDocumentItem,
    topicStatus: TopicStatusForRestore,
  ): DocumentRestorePlan => {
    switch (topicStatus.kind) {
      case "active":      return { kind: "restoreAlone" };
      case "trashed":     return { kind: "restoreWithTopic", topicId: item.topicId };
      case "hardDeleted": return { kind: "selectDestination" };
    }
  },
};
```

- `restoreWithTopic` の確認、および `selectDestination` の選択UIはユースケース / プレゼンテーションの責務。ドメインは「どの分岐か」の判定のみを担う
- `restoreWithTopic` の実行は restoreDocument ユースケースが確認のうえ `TopicTrashService.restoreTopicSet` で行う。このとき復元要求対象のドキュメント自身が個別削除（`trashedWith: null`）のため `skippedDocuments` に分類された場合は、ユースケースが**同一 UoW 内で当該ドキュメントを追加で `Document.restore` する**（トピックは直前に復元済みのため不変条件を満たす）。`restoreTopicSet` のシグネチャは変えず、ユースケース側のオーケストレーションで「復元を要求した当のドキュメントは必ず復元される」（S-TR-02）を保証する
- `selectDestination` で選択された復元先（既存 `TopicId` または新規作成トピック）への付け替えは、knowledge ドメインの `Document` の振る舞い（所属トピック変更を伴う復元）として実行される
- 復元後、当該項目を参照する出典リンクの「削除済み」表示は解消される（requirements.md 4.1）。リンク自体はソフトデリート中も保持されているため、trash 側での操作は不要

### HardDeletePolicy

- 責務: ハードデリートの対象範囲と意味を定める
- 依存するポート: なし（純関数）

規則:

- ハードデリートは対象のリビジョン履歴を含む完全消去であり、対象を参照する出典リンクも消去する（ADR-003。相手側に「削除済み」表示も残さない）。リンク消去の実行は knowledge のリポジトリが担う: メモのハードデリートでは trash のユースケースが同一 UoW で `DocumentRepository.deleteSourceLinksByMemo` を呼び、ドキュメントのハードデリートでは `DocumentRepository.delete` のカスケード（リビジョン・documentId 側リンクの同時消去）による
- リンク消去で出典関連フィールドが変わる相手側（メモのハードデリートなら当該メモを出典とするドキュメント、ドキュメントのハードデリートなら出典メモ）には、消去前に影響先 ID を確定し、同一 UoW でその相手の検索インデックスエントリを作り直す（詳細は下記「保持期限」および search.md「インデックスの維持」）
- 対象はゴミ箱内（ソフトデリート済み）の項目に限る。通常状態の項目を直接ハードデリートする経路は存在しない
- トピックのハードデリートは、セット削除された配下ドキュメント（`TrashedTopicItem.setDocumentIds`）も履歴・出典リンクごと消去する。個別に削除されたドキュメントは対象に含めない（ADR-001 の代替案検討で不採用とした通り、ユーザーが明示していない不可逆削除を作らない）
- 「空にする」はユーザーのゴミ箱全項目に対する上記規則の一括適用

メソッド:

```ts
/** ハードデリートの実行計画。種別ごとの消去対象 ID 群 */
export type HardDeletePlan = Readonly<{
  memoIds: readonly MemoId[];
  documentIds: readonly DocumentId[];
  topicIds: readonly TopicId[];
}>;

/** ハードデリートの対象集合を展開する純関数。トピックはセットの配下を含む */
export const HardDeletePolicy = {
  expandTargets: (item: TrashItem): HardDeletePlan => {
    // memo     → { memoIds: [item.id], documentIds: [], topicIds: [] }
    // document → { memoIds: [], documentIds: [item.id], topicIds: [] }
    // topic    → { memoIds: [], topicIds: [item.id],
    //              documentIds: item.setDocumentIds }
  },
};
```

- topic バリアントの展開は `TrashedTopicItem.setDocumentIds`（`TrashQueryPort` が射影時に埋める）だけで決まるため、引数は `TrashItem` 1つで足りる。追加のポート照会は不要。核となる規則は「トピックはセットの配下も対象」の一点である

### RetentionPolicy

- 責務: 保持期限の計算と期限切れ判定を定める
- 依存するポート: なし（純関数）

```ts
export const RetentionPolicy = {
  /** 期限日時。ソフトデリート時と retentionDays 変更時に算出し、purgeAfter として保存する */
  expiresAt: (trashedAt: Date, retentionDays: TrashRetentionDays): Date =>
    new Date(trashedAt.getTime() + retentionDays * 86_400_000),

  /** 期限切れ判定: 保存された purgeAfter が now を過ぎたか */
  isExpired: (purgeAfter: Date, now: Date): boolean =>
    purgeAfter.getTime() < now.getTime(),
};
```

**`isExpired` は保存値を入力に取る。** 期限を保存する形にした以上、判定の権威は `purgeAfter` であり、`trashedAt` と `retentionDays` から算出し直すと保持日数の変更直後（再計算が済むまで）に保存値と食い違う。列挙そのものは索引で引くので（後述「保持期限」）、この関数の用途は単一項目の判定である。

**算出規則そのものは変えない。変えるのは結果の持ち方である。**

- **期限は保存する**（各エンティティの `purgeAfter`）。次に起こすべき時刻を索引で引く必要があるためで、毎回算出する形では「最も早い期限」を求められない
- **`trashed` であることと `purgeAfter` を持つことは同値である。** ソフトデリートで設定し、復元で必ず `null` へ戻す。戻さないと復元済みの行が過去の期限を保持し続ける
- **保持期限を短く変更した場合も、既にゴミ箱にある項目に適用される**（S-TR-05）。変更と**同一トランザクションで**ゴミ箱内全項目の `purgeAfter` を再計算し、新しい最も早い期限で次回の起床を張り直す。件数は利用者1人分なので一括更新で足り、大きい場合はチャンクに分けて進める
  - **書き込み口は各ドメインの Repository の `recalculatePurgeAfter(retentionDays, limit)` である**（memo / knowledge の3ポート。上記「書き込みポートについて」）。**進捗はカーソルではなく作業述語が表す** — 「まだ再計算していない項目」＝「`purgeAfter` が新しい保持日数から算出される値と一致しない項目」であり、更新した項目はその場で述語から外れるので、残件の有無だけを戻り値に持てば次のチャンクは先頭から始めてよい。保持日数が再計算の途中でもう一度変わっても、述語が新しい値に対して定義され直されるだけで先頭からやり直しにはならない
  - **算出規則の正本は `RetentionPolicy.expiresAt` である。** アダプターは一括更新のために同じ規則を持つが、規則を変えるときは両方を動かす（同じ規則を2箇所に持つことの明示的な受容である）
- **延長方向の変更では、再計算が済むまで削除を進めない。** 再計算前の項目は古い（短い）期限を持っているので、順序を決めないと利用者が延ばしたはずの項目が消える。削除が次の起床へ遅れるのは安全側である（保持期限は「少なくともこの期間は保持する」規定である）。述語が単調に縮み、1回の起床で回すチャンク反復回数にも上限があるので、**残件は有限回の起床で空になる**（後述「ジョブのフロー」）

## ポート

### TrashQueryPort

- 目的: ユーザーのゴミ箱一覧（memo / knowledge を横断した `TrashItem` の射影）をページング付きで取得する。読み取り専用
- 実装: memo / knowledge のテーブルからソフトデリート済み行を横断的に射影するアダプター（自分の Durable Object 内の SQLite に対する UNION クエリ）。`expiresAt` には保存済みの `purgeAfter` をそのまま載せる。topic 項目の `setDocumentIds` は、アダプターが `trashedWith = topicId` のゴミ箱内ドキュメントを射影して埋める（`listTrashItems` / `findTrashItem` のどちらでも付与する。`HardDeletePolicy.expandTargets` が追加照会なしにセット展開できることの前提）

```ts
export interface TrashQueryPort {
  /** ゴミ箱一覧。削除日時の降順 */
  listTrashItems(pagination: Pagination): PaginationResult<TrashItem>;

  /** 単一項目の取得（復元・ハードデリートの対象確認用）。ゴミ箱にない場合は null */
  findTrashItem(
    ref: TrashItemRef, // { kind: "memo"; id: MemoId } | { kind: "document"; id: DocumentId } | { kind: "topic"; id: TopicId }
  ): TrashItem | null;

  /** ゴミ箱の総件数（「空にする」確認の件数表示、S-TR-04 に使う） */
  countTrashItems(): number;

  /**
   * 自分の Durable Object のゴミ箱から、保存された purgeAfter が now を過ぎた項目を
   * limit 件まで返す（purgeAfter の昇順）。purge-trash ジョブの駆動源。
   */
  listItemsToPurge(now: Date, limit: number): readonly TrashItem[];

  /** ゴミ箱内の purgeAfter の最小値。無ければ null（次の起床時刻の材料） */
  findEarliestPurgeAfter(): Date | null;
}
```

エラーケース:

- DBエラー → `SystemError(DatabaseError)`（アダプターで `mapDbError` 変換）
- `findTrashItem` の不在は null 返却（エラーにしない。NotFound への変換はユースケースの責務）

**`retentionDays` は引数から落ちる。** `expiresAt` が保存値になったので、照会のたびに設定値を渡して算出し直す必要がない。

**期限切れの列挙は自分の Durable Object に閉じる。`userId` を引数に取らず、全ユーザー横断で舐めるメソッドも持たない。** 各 Durable Object の中には自分のユーザーの期限しか無く、横断する相手が存在しないためである（後述「保持期限」）。**引き方は `purgeAfter` の索引であり、`trashedAt` と保持日数からの算出ではない。** memo / knowledge のリポジトリ側には期限切れの列挙メソッドを置かない — ゴミ箱の横断ビューを読む契約は本ポートに一本化されており、二重定義にしないためである。

### 書き込みポートについて（設計判断）

trash 独自の書き込みポートは持たない。

- 復元は memo の `Memo.restore(...)`、knowledge の `Document.restore(...)` / `TopicTrashService.restoreTopicSet(...)` といった各エンティティ・ドメインサービスの状態遷移として実行し、永続化は各ドメインの Repository（`MemoRepository` / `DocumentRepository` / `TopicRepository`）の `save` を使う
- **保持日数の変更に伴う `purgeAfter` の一括再計算も各ドメインの Repository が担う**（`MemoRepository.recalculatePurgeAfter` / `TopicRepository.recalculatePurgeAfter` / `DocumentRepository.recalculatePurgeAfter`）。ゴミ箱内の全項目を `find` → `save` で回す形は採らない — 項目ごとに OCC トークンが要り、「同一トランザクションで一括更新する」という要求と噛み合わないためである（後述「保持期限」）
- ハードデリートは各 Repository のハードデリート用メソッドを使う。`MemoRepository.hardDelete(id, expectedVersion)` の契約は**メモ本体と全リビジョンの消去のみ**であり、出典リンク（knowledge のテーブル）は含まない。出典リンクの消去は、trash のユースケースが**同一 UnitOfWork 内で** knowledge の `DocumentRepository.deleteSourceLinksByMemo(memoId)` を併せて呼ぶことで行う（ADR-003 の同期方式。オーケストレーションは trash のユースケースの責務）。ドキュメント / トピックのハードデリートは knowledge の `DocumentRepository.delete` / `TopicRepository.delete`（アダプターが同一トランザクションでリビジョンと documentId 側の出典リンクも消去する契約）を使う
- **`purge-trash` の起床の投入も trash のポートではない。** 投入口は UnitOfWork コンテキストの `enqueueJob` であり、読み側の `TrashQueryPort.findEarliestPurgeAfter`（材料を返すだけ）と対になる。**したがって「trash は書き込みポートを持たない」は起床の投入を足しても崩れない** — 投入を行うのはソフトデリート・保持日数変更を実行する memo / knowledge / identity のユースケースであって、trash のユースケースではない（後述「保持期限」）
- **同じ論証がイベントの登録口にも及ぶ。** Outbox のイベント行を書く口も UnitOfWork コンテキストの `enqueueEvent` であってドメインポートではないので（domains/index.md）、Outbox が加わっても「trash は書き込みポートを持たない」は崩れない。**なお trash はイベントを定義しない** — 期限処理は local job（`purge-trash`）で完結し、consumer が無いからである（全数は [async/index.md](../async/index.md)）
- 理由: 削除状態の所有者は memo / knowledge であり（ADR-004）、書き込み経路を各ドメインに一本化することで、不変条件（リビジョンとの整合、出典リンクの消去、OCC）の実施箇所を分散させない。trash が独自の書き込みポートを持つと、同一テーブルへの書き込み契約が二重定義になる
- したがって trash のユースケースは、`TrashQueryPort`（読み取り）+ memo / knowledge の Repository（書き込み、UnitOfWork 経由）+ trash のドメインサービス（規則）を組み合わせる構成になる

## 保持期限

期限切れ項目を自動でハードデリートする（S-TR-05）。**全ユーザーを1バッチで舐める定期実行ワーカーは存在しない。** 各ユーザーの Durable Object が自分の期限だけを見る `purge-trash` ジョブとして実行する（`spec/database/index.md`）。

**期限の持ち方と起床の張り方:**

1. ソフトデリート時に `RetentionPolicy.expiresAt` を算出して `purgeAfter` に保存する
2. 同じトランザクションで「ゴミ箱内の `purgeAfter` の最小値」を求め（`TrashQueryPort.findEarliestPurgeAfter`）、それが現在予定されている起床より早ければ `purge-trash` ジョブを投入する（投入口は UnitOfWork コンテキストの `enqueueJob` であり、trash 独自の書き込みポートは介さない）。**投入は早める方向にのみ効く**ので、延長方向の変更では何も書かれず、既存の早い起床が1回空振りしてから手順3の張り直しが正しい時刻を書く
   - **投入点は5つで、これが全数である** — ソフトデリートの4ユースケース（memo の `softDeleteMemo` と AI `delete`、knowledge の `trashDocument` と `trashTopic`）と、保持日数の変更（identity の `changeTrashRetentionDays`）である。**どれか1つでも投入を書き落とすと、最初の `purge-trash` が空のゴミ箱で完走した時点で待機状態に落ち、以後どれだけソフトデリートしても自動ハードデリート（S-TR-05）が二度と走らない** — 手順3の張り直しは残件があるときにしか効かないので、待機状態からの復帰手段は投入点しかない
3. `purge-trash` は完了トランザクションの中で駆動源（ゴミ箱内の `purgeAfter` の最小値）を読み直し、対象が残っていれば自分の次回時刻をそこへ設定して待機状態へ戻す。**これが無いと1回目の完走で終了し、次の期限が来ても二度と起きない**
4. 復元時は `purgeAfter` を `null` へ戻す。戻さないと駆動源が過去へ固定され、起床が止まらなくなる

**ジョブのフロー:**

1. 再計算の残件（`trashRetentionDays` 変更に伴う `purgeAfter` の一括再計算）があれば先に進める（各 Repository の `recalculatePurgeAfter` を1チャンクずつ繰り返し呼ぶ）。**1回の起床で回すチャンク反復回数には上限があり、上限に達したら残件を残したまま抜けて次の起床に委ねる。削除フェーズ（手順2以降）へ進むのは、再計算の残件が空になった起床だけである** — 「残件が空になるまで」は起床をまたいだ収束であって1回の起床の中で完了することではない（1回の起床を無界にすると、ゴミ箱の大きい Durable Object では予算を使い切って途中で落ちる。`spec/database/index.md`「jobs」の3階層の上限）
2. 期限切れ項目（`purgeAfter` が現在時刻を過ぎたもの）を自分の Durable Object の索引から引く（`TrashQueryPort.listItemsToPurge(now, chunkLimit)`）
3. 各項目について `HardDeletePolicy.expandTargets(item)` で `HardDeletePlan` に展開する（期限切れトピックは自身の `setDocumentIds` から展開され、配下ドキュメントごと消去される。追加のポート照会は不要）
4. 項目ごとに UnitOfWork 内で実行する:
   - 消去前に影響先を確定する: メモの消去では `DocumentRepository.listSourceLinksByMemo` で当該メモを出典とするドキュメント ID 群、ドキュメントの消去では `DocumentRepository.listSourceLinksByDocument` で出典メモ ID 群を取得する
   - `findByIdIncludingTrashed`（memo / knowledge の各リポジトリ）で対象を OCC トークン付きで個別再取得し、該当 Repository のハードデリート（`MemoRepository.hardDelete` / `DocumentRepository.delete` / `TopicRepository.delete`）を実行する。メモの場合は同一 UoW で `DocumentRepository.deleteSourceLinksByMemo` も呼ぶ（ADR-003 の同期方式）
   - **同じトランザクションの中で、消去した項目の検索インデックスエントリを除去し、影響先（出典リンクの相手）のエントリを作り直す**（別ストアへ配送する経路は無い）
5. 1回の起床で処理する量には上限を置き、残件があれば進捗を確定してから次の起床を張る（1回で全件を消化しようとしない）。**上限は「1チャンクで触る行数」と「1回の起床で回すチャンク反復回数」の2つで、再計算フェーズと削除フェーズの双方に掛かる**（`spec/database/index.md`「jobs」の3階層のうち内側の2つ。経過時間では測らない）

補足:

- 冪等性: 既にハードデリート済みの項目は駆動源のクエリに現れず、二重に起きても安全。同一項目への並行実行は OCC / 行不在の検出で片方が no-op になる
- 期限内の項目には一切触れない。「期限内であればいつでも復元できる」（S-TR-05）を保証する
- セット削除されたドキュメントの `trashedAt` はトピックと同時刻であるため、通常はトピックと同じ起床で期限切れになる。万一ドキュメント側が先に単独で期限切れ扱いになっても、単品ハードデリートとして規則上問題ない
- **利用者がアクセスしていなくても期限処理は走る。** 起床が Durable Object を起こすためで、全ユーザーを1周する方式より遅延が読みやすい

## AI非公開（構造的排除）

ゴミ箱の一覧・復元・ハードデリート（空にするを含む）は、AIクライアント向けインターフェース（MCP / REST）に存在しない（requirements.md 4.5「公開しないインターフェース」、S-AI-02 / S-AI-04 / S-AI-05）。

- 本ドメインのユースケースはすべて Web UI 専用ユースケースとして application 層で公開範囲を分離し、AI用トークンのスコープには対応する権限自体が存在しない（identity ドメインのトークンスコープ設計と対応。domains/index.md「権限の非対称性」）
- ガイダンス（MCPサーバー指示）への依存ではなく、公開面の分離（AI 側 presentation に配線しない配線分離）と AI トークンの認可ミドルウェアの許可ユースケース列挙で構造的に保証する（本ドメインのユースケースは `actor` を入力に持たないため型による強制は用いない。domains/identity.md「TokenScope」の二層防壁）。ガイダンスを無視するAIクライアントに対しても安全性が保たれる
- AIから見えるのは delete（ソフトデリート）までであり、ゴミ箱内の項目は search / get でも「存在しない」扱いとなる（この非可視性の実装は search / memo / knowledge の各ドメインの責務。trash はゴミ箱操作を公開しないことに責任を持つ）

## ユースケース（概要）

詳細は Phase 4（ユースケース設計）で定義する。すべて Web UI 専用（AI非公開）。

- listTrash — ゴミ箱一覧の取得（ページング、削除日時・期限表示、セット関係表示）（S-TR-01）
- restoreMemo — メモの復元（S-TR-02）
- restoreDocument — ドキュメントの復元。`RestorePolicy.decideDocumentRestore` の3分岐（単独復元 / セット復元確認 / 復元先トピック選択 ADR-001）を持つ（S-TR-02）。セット復元分岐では確認のうえ `TopicTrashService.restoreTopicSet` を実行し、復元要求対象が `skippedDocuments`（個別削除分）に含まれた場合は同一 UoW 内で追加で `Document.restore` する
- restoreTopic — トピックの復元（セット削除された配下ドキュメントごとセット復元）（S-TR-02）
- hardDeleteTrashItem — 個別ハードデリート（トピックはセットの配下も対象。リビジョン・出典リンクごと消去）（S-TR-03）
- emptyTrash — ゴミ箱を空にする（全件ハードデリート。件数確認付き）（S-TR-04）。ゴミ箱一覧にはセット削除トピックとその配下ドキュメントが両方項目として現れるため、全件に `HardDeletePolicy.expandTargets` を適用すると配下ドキュメントが「トピックの展開結果」と「単独のゴミ箱項目」で二重に消去対象になり得る。消去対象 ID 集合を種別（memo / document / topic）ごとに和集合（重複除去）してから実行する。既にハードデリート済みの対象への操作は no-op として続行する（`purge-trash` ジョブと同じ規約）
- pruneExpiredTrashItems — 期限切れ項目の自動ハードデリート（自分の Durable Object の `purge-trash` ジョブから実行。ユーザー操作なし）（S-TR-05）
