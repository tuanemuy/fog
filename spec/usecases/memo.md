# Memo ユースケース

memo ドメインのユースケース定義。

- 上流: [domains/memo.md](../domains/memo.md)（ユースケース概要の列挙）、[シナリオ: タイムライン](../scenario/timeline.md)、[シナリオ: AI連携](../scenario/ai.md)
- 関連: [domains/knowledge.md](../domains/knowledge.md)（出典リンクの逆引きポート）、[ADR-006](../adr/006-memo-fulltext-update.md)（メモの更新は全文置換のみ）
- 復元・ハードデリート・保持期限の自動削除は trash ドメインのユースケース（spec/usecases/trash.md）であり、本ファイルには含めない

## 共通事項

- **公開面**: 各ユースケースに「人間UI ★ / AI API / 両方」を明記する。履歴閲覧（listMemoRevisions / diffMemoRevisions）・ロールバック（rollbackMemo）・タイムライン閲覧系は人間UI専用。AI に公開しないユースケースの排除は二層で保証する（domains/identity.md「TokenScope」、domains/index.md「権限の非対称性」）: `actor` を入力に持つ ★ ユースケースは `actor` の型を `UserActor` に限定して型エラーで排除し、`actor` を持たない ★ ユースケース（listMemoRevisions / diffMemoRevisions 等）は AI 側 presentation（MCP / REST）に配線しないこと（配線分離）＋ AI トークンの認可ミドルウェアの許可ユースケース列挙に含めないことで排除する
- **操作主体**: `userId` は認証済みセッション（人間UI）または AI トークン（AI API）から解決済みの値を受ける。`actor`（リビジョンの「誰が」）は identity ドメインの `Actor` 型で、同じく認証コンテキストから解決済みの値を受ける。入力DTOには「外部から自由に指定できる値」としては現れない。人間UI専用（★）のユースケースでは `actor` を `Actor` の `UserActor` バリアント（`{ kind: "user" }`）に狭めて受け、`AiClientActor` を渡すことは型エラーとする（AI 側には別ユースケース post_memo / update_memo がある）
- **テナント分離**: 外部入力の ID を受ける全ユースケースは、リポジトリの userId スコープ（各メソッドの第一引数に操作主体の `userId` を渡す）により所有権が構造的に保証される。他ユーザー所有の ID は NotFound となる。以降、各ユースケースのエラーケースでは個別に再掲しない
- **now / id**: ユースケース冒頭で `container.clock.now()` / `container.idGenerator.next()` により解決する。ドメインは `new Date()` / ID 生成をしない
- **DTO の型**: 出力DTOのフィールドはプリミティブ（string / number / boolean / Date）に射影する。ブランド VO・画面語彙は使わない
- **MemoView（共通出力射影）**: `{ id: string; body: string; postedAt: Date; updatedAt: Date; latestRevisionNumber: number; version: number }`。`version` は人間UIの編集開始時に OCC トークンとして保持され、editMemo の `expectedVersion` になる
- **ActorView（共通出力射影）**: `{ kind: "user" } | { kind: "aiClient"; clientName: string }`。identity の `Actor` からの判別可能ユニオンの射影（knowledge 側の actor 射影と同形）。AI クライアントによる編集をクライアント名で区別する（S-TL-05）。`kind: "user"` の表示名（例:「あなた」）は presentation の責務であり、射影は名前を持たない（`UserActor` は `userId` のみでユーザー表示名という属性を持たないため）。履歴一覧（listMemoRevisions）・差分（RevisionView）・編集競合（ConflictView.latestRevision）の各出力DTOの `actor` はすべてこの射影を用いる
- **エラーモデル**: VO 生成違反は `BusinessRuleError<MemoErrorCode>`、OCC の 0 行更新は `ConflictError("OPTIMISTIC_LOCK_FAILURE")`、DB 障害は `SystemError(DatabaseError)`（アダプター境界で変換済み）。各ユースケースでは固有のものだけ列挙する

---

## 人間UI用ユースケース

### postMemo ★

#### 概要

メモを投稿する。タイムスタンプ（postedAt）は自動付与され、初版リビジョンを必ず伴って生成される（S-TL-01）。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | 認証コンテキストから解決済み |
| body | string | 必須 | 非空・10,000 文字以内（`MemoBody.create` が担保。ユースケースは事前検証しない） |
| actor | UserActor | 必須 | 認証コンテキストから解決済み（人間ユーザー）。`AiClientActor` を渡すことは型エラー（AI 側は post_memo） |

#### 出力DTO

| フィールド | 型 |
|---|---|
| memo | MemoView |

#### 処理フロー

1. `now = clock.now()`、`id = idGenerator.next()` を解決する
2. `Memo.create({ id, userId, body, actor }, now)` を呼ぶ。`{ memo, initialRevision }` と `eventDrafts`（`memo.created`）が返る
3. UnitOfWork 内で:
   1. `MemoRepository.insert(memo)`
   2. `MemoRepository.insertRevision(initialRevision)`
   3. 本体・revision・FTS5射影・idempotency結果を`SemanticCommitPort.transactionSync`で同時に確定する
4. `memo` を MemoView に射影して返す

#### エラーケース

| 条件 | 種類 |
|---|---|
| 本文が空（trim 後 0 文字） | ビジネスルール違反 `BusinessRuleError(EmptyBody)`（ドメインで検出） |
| 本文が 10,000 文字超 | ビジネスルール違反 `BusinessRuleError(BodyTooLong)` |
| DB 障害 | `SystemError(DatabaseError)` |

### getTimeline ★

#### 概要

タイムラインをカーソルページングで閲覧する（S-TL-02, S-TL-07）。初期表示は先頭（最新）から過去方向、以降は `direction` で両方向の無限スクロールに対応する。`keyword` を指定するとキーワード絞り込みになる（S-TL-03 の絞り込み。domains/memo.md の filterTimeline は本ユースケースの `keyword` 指定として実現する — DTO・フローに差分がなく独立した名詞を持たないため分割しない）。各メモには出典導線（→ ドキュメントX）を付与する。

日付見出しのグルーピングは UI の表示上の概念であり、本ユースケースは関知しない。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | 認証コンテキストから解決済み |
| cursor | string \| null | 任意（既定 null） | 非空文字列（`TimelineCursor.create`）。null は先頭（最新）から。デコード不能はアダプター境界で `ValidationError` |
| direction | "older" \| "newer" | 任意（既定 "older"） | `"newer"` のとき cursor は非 null 必須 |
| limit | number | 任意（既定 50） | 1〜100 の整数 |
| keyword | string \| null | 任意（既定 null） | trim 後空なら null と同義（絞り込みなし） |

#### 出力DTO

| フィールド | 型 |
|---|---|
| items | TimelineItemView[]（postedAt 降順） |
| nextCursor | string \| null（同方向の続き。null は終端） |

TimelineItemView = MemoView + 次のフィールド:

| フィールド | 型 |
|---|---|
| sourceDocuments | { documentId: string; title: string; isTrashed: boolean }[] |

- `sourceDocuments` は「このメモを出典とするドキュメント」の導線（S-TL-07）。`isTrashed: true` は「削除済みのドキュメント」として遷移不可表示にする（表示制御は presentation の責務）。ハードデリート済みドキュメントへのリンクはリンク自体が消えているため現れない（ADR-003）

#### 処理フロー

1. `MemoRepository.findTimelinePage(userId, { cursor, direction, limit, keyword })` で 1 ページ分の active メモと `nextCursor` を取得する
2. ページ内のメモ ID 群で knowledge の `DocumentRepository.listSourceLinksByMemos(userId, memoIds)` を呼び、出典リンクを 1 クエリで一括逆引きする（N+1 にしない）
3. リンク先ドキュメント ID 群（重複除去）で knowledge の `DocumentRepository.listByIdsIncludingTrashed(userId, documentIds)` を呼び、タイトルと trashed 状態を取得する（「削除済みのドキュメント」表示のため trashed 込み。人間UI専用の読み取り経路）
4. メモごとに出典リンクを突き合わせて TimelineItemView に射影して返す
5. 0 件（keyword 絞り込みで一致なしを含む）は `items: []` を返す（エラーにしない。空状態・「見つからなかった」の表示は presentation の責務）

#### エラーケース

| 条件 | 種類 |
|---|---|
| cursor がデコード不能 | バリデーションエラー `ValidationError` |
| limit が 1〜100 の範囲外 / `direction: "newer"` で cursor が null | バリデーションエラー `ValidationError` |
| DB 障害 | `SystemError(DatabaseError)` |

### jumpToDate ★

#### 概要

日付指定でその日のメモ位置へジャンプする（S-TL-03）。指定日を含む前後のメモを初期ページとして返し、以降の両方向無限スクロールは戻り値のカーソルから getTimeline（`findTimelinePage`）で継続する。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | 認証コンテキストから解決済み |
| date | Date | 必須 | 有効な日付 |
| limit | number | 任意（既定 50） | 1〜100 の整数 |
| keyword | string \| null | 任意（既定 null） | 絞り込み継続中のジャンプに対応 |

#### 出力DTO

| フィールド | 型 |
|---|---|
| items | TimelineItemView[]（postedAt 降順。getTimeline と同一射影） |
| olderCursor | string \| null（古い側の続き） |
| newerCursor | string \| null（新しい側の続き） |

#### 処理フロー

1. `MemoRepository.findTimelineAround(userId, { kind: "date", date }, { limit, keyword })` でアンカー前後のメモと両方向カーソルを取得する。指定日にメモがなければ前後で最も近いメモの位置が返る（S-TL-03 エッジケース。リポジトリ契約）
2. getTimeline の手順 2〜4 と同様に `listSourceLinksByMemos` → `listByIdsIncludingTrashed` で出典導線を付与する
3. メモが 0 件なら `items: []`・両カーソル null を返す

#### エラーケース

| 条件 | 種類 |
|---|---|
| date が不正 | バリデーションエラー `ValidationError` |
| DB 障害 | `SystemError(DatabaseError)` |

### showMemoInTimeline ★

#### 概要

他画面（ドキュメントの出典・検索結果・履歴等）からの「タイムラインの該当位置へ」遷移の受け口（P-04）。対象メモを含む前後ページを返し、UI がスクロール＋ハイライト表示する。対象が不在・trashed の場合は案内表示のための状態を返す。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | 認証コンテキストから解決済み |
| memoId | string | 必須 | 非空（`MemoId.create`） |
| limit | number | 任意（既定 50） | 1〜100 の整数 |

#### 出力DTO

| フィールド | 型 |
|---|---|
| targetState | "found" \| "trashed" \| "notFound" |
| targetMemoId | string |
| items | TimelineItemView[]（targetState: "found" のとき対象メモを含む。それ以外は空配列） |
| olderCursor | string \| null |
| newerCursor | string \| null |

- ハイライト対象の特定（`items` 内の `targetMemoId` 一致）とスクロールは presentation の責務
- `targetState` が "trashed" / "notFound" のときの案内表示（「ゴミ箱にあります」「見つかりません」等の文言と、通常タイムラインへのフォールバック）は presentation の責務

#### 処理フロー

1. `MemoRepository.findByIdIncludingTrashed(userId, memoId)` で対象の存在と状態を判定する（人間UI専用の読み取り経路）。null なら `targetState: "notFound"`、trashed なら `"trashed"` として空結果を返す
2. active の場合、`MemoRepository.findTimelineAround(userId, { kind: "memo", memoId }, { limit, keyword: null })` で対象メモを含む前後ページと両方向カーソルを取得する
3. getTimeline の手順 2〜4 と同様に出典導線を付与し、`targetState: "found"` で返す

#### エラーケース

| 条件 | 種類 |
|---|---|
| memoId が空 | バリデーションエラー |
| 対象が不在・trashed・他ユーザー所有 | エラーにしない（`targetState` で表現。案内表示のため） |
| DB 障害 | `SystemError(DatabaseError)` |

### editMemo ★

#### 概要

メモの本文を編集する（S-TL-04）。同一本文なら新しいリビジョンを積まない。編集開始後に他者（AI クライアント等）が編集していた場合は保存せずに警告情報を返し、ユーザーの「そのまま保存」で最新に対する再適用として新リビジョンを積む（AI の編集も履歴に残り失われない）。

編集競合の検出は OCC で行う: 編集開始時に UI が保持した `version`（MemoView の `version`）を `expectedVersion` として渡し、保存時点の現在 `version` と異なれば競合とみなす。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | 認証コンテキストから解決済み |
| memoId | string | 必須 | 非空（`MemoId.create`） |
| body | string | 必須 | 非空・10,000 文字以内（`MemoBody.create` が担保） |
| expectedVersion | number | 必須 | 0 以上の整数。編集開始時に取得した MemoView の `version` |
| actor | UserActor | 必須 | 認証コンテキストから解決済み（人間ユーザー）。`AiClientActor` を渡すことは型エラー（AI 側は update_memo） |

#### 出力DTO

| フィールド | 型 |
|---|---|
| result | "saved" \| "unchanged" \| "conflict" |
| memo | MemoView（"saved" / "unchanged" は保存後・現在の状態。"conflict" は他者編集後の現在の状態） |
| conflict | ConflictView \| null（"conflict" のときのみ非 null） |

ConflictView（警告表示用）:

| フィールド | 型 |
|---|---|
| currentBody | string（他者編集後の現在本文。突き合わせ表示用） |
| currentVersion | number（「そのまま保存」時に `expectedVersion` として渡し直す値） |
| latestRevision | { revisionNumber: number; actor: ActorView; createdAt: Date }（誰がいつ編集したか） |

- 「そのまま保存」は、UI が警告表示後に本ユースケースを `expectedVersion = conflict.currentVersion` で再度呼ぶことで実現する。ドメインの `Memo.edit` が最新状態に対して適用され、自分の内容が新リビジョンとして積まれる（S-TL-04。domains/memo.md「edit 補足」の再適用手順）

#### 処理フロー

1. `now = clock.now()` を解決する
2. UnitOfWork 内で:
   1. `MemoRepository.findById(userId, memoId)` で active なメモを OCC トークン付きで取得する。null なら `NotFoundError`
   2. 取得したメモの `version` が入力 `expectedVersion` と異なる場合、**何も書かずに** `result: "conflict"` を組み立てて返す。`conflict.latestRevision` は `MemoRepository.findRevision(userId, memoId, memo.latestRevisionNumber)` で取得する
   3. 一致する場合、`Memo.edit(memo, { body, actor }, now)` を呼ぶ
      - `newRevision: null`（同一本文）なら何も書かず `result: "unchanged"`（version も上がらない）
      - 新リビジョンありなら `MemoRepository.save`、`insertRevision`、FTS5 upsertを同じsemantic commitで行い `result: "saved"`
3. 現在のメモを MemoView に射影して返す

#### エラーケース

| 条件 | 種類 |
|---|---|
| 対象が不在・trashed・他ユーザー所有 | `NotFoundError`（`findById` が active のみ返すことで一律に検出） |
| 本文が空 / 10,000 文字超 | ビジネスルール違反 `BusinessRuleError(EmptyBody / BodyTooLong)` |
| 編集開始後に他者が編集（version 不一致） | エラーにしない（`result: "conflict"` の正常応答。警告表示のため） |
| 手順 2-ii の判定通過後、save までの間に競合（レア） | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。UI は再取得して再試行 |
| DB 障害 | `SystemError(DatabaseError)` |

### listMemoRevisions ★

#### 概要

メモのリビジョン履歴（誰が・いつ）を閲覧する（S-TL-05）。AI クライアントによる編集はクライアント名で区別できる。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | 認証コンテキストから解決済み |
| memoId | string | 必須 | 非空（`MemoId.create`） |

#### 出力DTO

| フィールド | 型 |
|---|---|
| memoId | string |
| latestRevisionNumber | number |
| revisions | { revisionNumber: number; actor: ActorView; createdAt: Date }[]（revisionNumber 昇順） |

- 一覧は「誰が・いつ」のみで本文を含めない。本文が要るのは差分表示（diffMemoRevisions）とロールバック確認であり、それぞれのユースケースで取得する
- リビジョンが 1 件のみの場合に差分・ロールバック操作を出さない制御は presentation の責務

#### 処理フロー

1. `MemoRepository.findByIdIncludingTrashed(userId, memoId)` で存在確認する（人間UIの履歴閲覧はゴミ箱内メモにも許される読み取り経路）。null なら `NotFoundError`
2. `MemoRepository.listRevisions(userId, memoId)` で全リビジョンを revisionNumber 昇順で取得する（メモが存在すれば必ず 1 件以上）
3. actor を ActorView に射影して返す

#### エラーケース

| 条件 | 種類 |
|---|---|
| 対象が不在（ハードデリート済み含む）・他ユーザー所有 | `NotFoundError` |
| DB 障害 | `SystemError(DatabaseError)` |

### diffMemoRevisions ★

#### 概要

任意二点のリビジョンの全文を取得する（S-TL-05）。リビジョンは全文スナップショットであり差分は保存されていないため、**差分の計算・整形は presentation 層の責務**とし、本ユースケースは二点の全文とメタデータを返すだけに留める（domains/memo.md「差分は保存しない」）。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | 認証コンテキストから解決済み |
| memoId | string | 必須 | 非空（`MemoId.create`） |
| baseRevisionNumber | number | 必須 | 1 以上の整数（`RevisionNumber.create`） |
| targetRevisionNumber | number | 必須 | 1 以上の整数。baseRevisionNumber と異なること |

#### 出力DTO

| フィールド | 型 |
|---|---|
| base | RevisionView |
| target | RevisionView |

RevisionView:

| フィールド | 型 |
|---|---|
| revisionNumber | number |
| body | string（全文スナップショット） |
| actor | ActorView |
| createdAt | Date |

#### 処理フロー

1. `MemoRepository.findRevision(userId, memoId, baseRevisionNumber)` と `MemoRepository.findRevision(userId, memoId, targetRevisionNumber)` で二点を取得する。いずれかが null なら `NotFoundError`
2. それぞれを RevisionView に射影して返す（差分計算はしない）

#### エラーケース

| 条件 | 種類 |
|---|---|
| baseRevisionNumber と targetRevisionNumber が同一 | バリデーションエラー `ValidationError` |
| いずれかのリビジョンが不在（メモ不在・他ユーザー所有含む） | `NotFoundError` |
| リビジョン番号が 1 未満・非整数 | ビジネスルール違反 `BusinessRuleError(InvalidRevisionNumber)` |
| DB 障害 | `SystemError(DatabaseError)` |

### rollbackMemo ★

#### 概要

過去リビジョンと同内容の**新しい**リビジョンを積む（S-TL-05「この内容に戻す」）。履歴は消えない。現在本文と対象リビジョンが同一なら何も起きない。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | 認証コンテキストから解決済み |
| memoId | string | 必須 | 非空（`MemoId.create`） |
| targetRevisionNumber | number | 必須 | 1 以上の整数（`RevisionNumber.create`） |
| actor | UserActor | 必須 | 認証コンテキストから解決済み（人間ユーザー）。`AiClientActor` を渡すことは型エラー（ロールバックは AI トークンのスコープに存在しない） |

- editMemo と異なり `expectedVersion` を受けない。ロールバックは履歴画面から「その時点の内容へ戻す」明示操作であり、直前の他者編集があっても対象リビジョンの内容に戻す意図は変わらない（新リビジョンとして積まれるため他者編集も履歴に残る）。競合警告は不要で、UoW 内の読み直しに対する OCC 保存のみで整合を守る

#### 出力DTO

| フィールド | 型 |
|---|---|
| result | "rolledBack" \| "unchanged"（現在本文と同一で何も積まれなかった） |
| memo | MemoView |

#### 処理フロー

1. `now = clock.now()` を解決する
2. UnitOfWork 内で:
   1. `MemoRepository.findById(userId, memoId)` で active なメモを OCC トークン付きで取得する。null なら `NotFoundError`（trashed は編集不可のため一律 NotFound）
   2. `MemoRepository.findRevision(userId, memoId, targetRevisionNumber)` で対象リビジョンを取得する。null なら `NotFoundError`
   3. `Memo.rollback(memo, { targetRevision, actor }, now)` を呼ぶ
      - `newRevision: null`（現在本文と同一）なら何も書かず `result: "unchanged"`
      - 新リビジョンありなら `MemoRepository.save(memo, expectedVersionトークン)`、`MemoRepository.insertRevision(newRevision)`、`collectEvents(eventDrafts)`（`memo.edited`）を行い `result: "rolledBack"`
3. 現在のメモを MemoView に射影して返す

#### エラーケース

| 条件 | 種類 |
|---|---|
| メモが不在・trashed・他ユーザー所有 | `NotFoundError` |
| 対象リビジョンが不在 | `NotFoundError` |
| 対象リビジョンが別メモのもの | ビジネスルール違反 `BusinessRuleError(RevisionMismatch)`（ドメインで検出。userId スコープの `findRevision` を経る限り通常到達しない防衛線） |
| 保存時の OCC 競合 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。UI は再試行 |
| DB 障害 | `SystemError(DatabaseError)` |

### softDeleteMemo ★

#### 概要

メモをソフトデリートしてゴミ箱に移す（S-TL-06）。可逆であり、復元は trash ドメインのユースケース（restoreMemo）で行う。出典リンクは残り、参照元ドキュメント側では「削除済みのメモ」として表示される（S-DT-07。表示は knowledge 側の読み取りユースケースの責務）。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | 認証コンテキストから解決済み |
| memoId | string | 必須 | 非空（`MemoId.create`） |

#### 出力DTO

なし（void。タイムラインからの除去表示は presentation の責務）。

#### 処理フロー

1. `now = clock.now()` を解決する
2. UnitOfWork 内で:
   1. `MemoRepository.findById(userId, memoId)` で active なメモを OCC トークン付きで取得する。null なら `NotFoundError`（既に trashed のものも NotFound 扱い）
   2. `Memo.softDelete(memo, now)` で `TrashedMemo` と `eventDrafts`（`memo.trashed`）を得る
   3. `MemoRepository.save(trashedMemo, expectedVersionトークン)`
   4. 同じsemantic commitでmemo射影を除去し、影響するactive document射影を再upsertする

#### エラーケース

| 条件 | 種類 |
|---|---|
| 対象が不在・既に trashed・他ユーザー所有 | `NotFoundError` |
| 保存時の OCC 競合 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| DB 障害 | `SystemError(DatabaseError)` |

---

## AI API 用ユースケース（MCP / REST）

`userId`・`actor` はいずれも AI クライアントのトークンから解決する（トークン失効・スコープ外は identity / プレゼンテーション境界で認可エラーとなり、本層には到達しない）。ゴミ箱内のメモは「存在しない」世界を貫く（S-AI-04。`findById` が active のみ返すことで構造的に実現）。

### post_memo（AI API）

#### 概要

AI がユーザーの代理でメモを投稿する（S-AI-01）。タイムスタンプは自動付与され、リビジョンの「誰が」に AI クライアントが記録される。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | トークンから解決済み |
| body | string | 必須 | 非空・10,000 文字以内（`MemoBody.create` が担保） |
| actor | Actor | 必須 | トークンから解決済み（AI クライアント識別） |

#### 出力DTO

| フィールド | 型 |
|---|---|
| memo | { id: string; body: string; postedAt: Date } |

#### 処理フロー

postMemo と同一: `Memo.create` → UoW 内で `MemoRepository.insert` + `insertRevision` + `collectEvents(memo.created)`。人間UIとの差は `actor` の解決元（トークン）のみ。

#### エラーケース

| 条件 | 種類 |
|---|---|
| 本文が空 / 10,000 文字超 | ビジネスルール違反 `BusinessRuleError(EmptyBody / BodyTooLong)`（S-AI-01 異常系: メモは作成されない） |
| DB 障害 | `SystemError(DatabaseError)` |

### update_memo（AI API）

#### 概要

AI によるメモの修正（S-AI-04）。**全文置換のみ**（パッチ非対応。ADR-006）。履歴は自動で積まれ、同一本文なら積まれない。trashed のメモは「存在しない」扱い。

editMemo と異なり `expectedVersion` を受けない: AI は `get` で最新を取得してから全文を組み立てて渡す前提であり、警告 UI を持たないため、常に UoW 内で読み直した最新状態への適用とする（編集内容は新リビジョンとして積まれるため、並行編集があっても履歴で追跡・ロールバック可能。S-AI-04 手順 3）。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | トークンから解決済み |
| memoId | string | 必須 | 非空（`MemoId.create`） |
| body | string | 必須 | 非空・10,000 文字以内（全文。`MemoBody.create` が担保） |
| actor | Actor | 必須 | トークンから解決済み |

#### 出力DTO

| フィールド | 型 |
|---|---|
| result | "saved" \| "unchanged" |
| memo | { id: string; body: string; postedAt: Date; latestRevisionNumber: number } |

#### 処理フロー

1. `now = clock.now()` を解決する
2. UnitOfWork 内で:
   1. `MemoRepository.findById(userId, memoId)` で active なメモを OCC トークン付きで取得する。null なら `NotFoundError`（trashed・他ユーザー所有・不在を区別せず、ゴミ箱内の存在事実も漏らさない）
   2. `Memo.edit(memo, { body, actor }, now)` を呼ぶ
      - `newRevision: null` なら何も書かず `result: "unchanged"`
      - 新リビジョンありなら `MemoRepository.save(memo, expectedVersionトークン)` + `MemoRepository.insertRevision(newRevision)` + `collectEvents(memo.edited)` で `result: "saved"`

#### エラーケース

| 条件 | 種類 |
|---|---|
| 対象が不在・trashed・他ユーザー所有 | `NotFoundError`（S-AI-04 異常系） |
| 本文が空 / 10,000 文字超 | ビジネスルール違反 `BusinessRuleError(EmptyBody / BodyTooLong)` |
| 同一 UoW 内の読み書き間で競合（レア） | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。AI クライアントは再試行 |
| DB 障害 | `SystemError(DatabaseError)` |

### recent_memos（AI API）

#### 概要

タイムライン直近のメモを取得する（S-AI-02。直近の文脈把握用）。`findTimelinePage` の keyword なし・`cursor: null`・`direction: "older"` に固定した読み取りで、ページング・絞り込みは公開しない（過去の探索は search の責務）。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | トークンから解決済み |
| limit | number | 任意（既定 20） | 1〜100 の整数 |

#### 出力DTO

| フィールド | 型 |
|---|---|
| items | { id: string; body: string; postedAt: Date }[]（postedAt 降順） |

- 出典導線（sourceDocuments）は含めない。AI が出典関係を要するときは search の結果（出典リンク先 ID）を使う

#### 処理フロー

1. `MemoRepository.findTimelinePage(userId, { cursor: null, direction: "older", limit, keyword: null })` で直近の active メモを取得する（trashed は返らない: ゴミ箱は AI から見えない）
2. 各メモを射影して返す。0 件は空配列

#### エラーケース

| 条件 | 種類 |
|---|---|
| limit が範囲外 | バリデーションエラー `ValidationError` |
| DB 障害 | `SystemError(DatabaseError)` |

### get（AI API）

#### 概要

メモ全文の単体取得（S-AI-02。検索結果のスニペットから全文が必要になったとき、および update_memo で全文を組み立てる前提操作）。active のみ。

種別ディスパッチ: AI の `get` ツールはメモ / ドキュメントを単一動詞で扱うため、MCP / REST の入力スキーマは `{ type: "memo" | "document"; id }` とする（`type` の語彙は search 結果の `type` と同じ。ID は不透明文字列であり、`type` なしでは判別できない）。presentation 層（MCP ツール / REST ハンドラ）が `type: "memo"` を本ユースケースへ、`type: "document"` を knowledge の `getDocument` へルーティングする。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | トークンから解決済み |
| memoId | string | 必須 | 非空（`MemoId.create`） |

#### 出力DTO

| フィールド | 型 |
|---|---|
| memo | { id: string; body: string; postedAt: Date; updatedAt: Date; latestRevisionNumber: number } |

#### 処理フロー

1. `MemoRepository.findById(userId, memoId)` で active なメモを取得する。null なら `NotFoundError`（ゴミ箱内は「取得できない」= 存在しない扱い。S-AI-02 エッジケース）
2. 射影して返す

#### エラーケース

| 条件 | 種類 |
|---|---|
| 対象が不在・trashed・他ユーザー所有 | `NotFoundError` |
| DB 障害 | `SystemError(DatabaseError)` |

### delete（AI API・メモ対象）

#### 概要

AI によるメモのソフトデリート（S-AI-05）。ソフトデリートのみで、ハードデリート・ゴミ箱操作の API は存在しない。復元は人間がゴミ箱から行う（trash ドメイン）。

種別ディスパッチ: AI の `delete` ツールはメモ・ドキュメント・トピックを単一動詞で扱うため、MCP / REST の入力スキーマは `{ type: "memo" | "document" | "topic"; id }` とする（`type` の語彙は search 結果の `type` と同じ。ID は不透明文字列であり、`type` なしでは判別できない）。presentation 層（MCP ツール / REST ハンドラ）が `type: "memo"` を本ユースケース（softDeleteMemo 相当）へ、`type: "document"` を knowledge の `trashDocument`、`type: "topic"` を knowledge の `trashTopic` へルーティングする。本ユースケースはメモ対象の実体。

#### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | トークンから解決済み |
| memoId | string | 必須 | 非空（`MemoId.create`） |

#### 出力DTO

なし（void）。

#### 処理フロー

softDeleteMemo と同一: UoW 内で `findById` → `Memo.softDelete` → `save` → `collectEvents(memo.trashed)`。既に trashed のメモは `findById` が null を返すため NotFound（「ゴミ箱の中身は見えない」を貫く）。

#### エラーケース

| 条件 | 種類 |
|---|---|
| 対象が不在・既に trashed・他ユーザー所有 | `NotFoundError` |
| 保存時の OCC 競合 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| DB 障害 | `SystemError(DatabaseError)` |

---

## トレーサビリティ

| domains/memo.md の列挙 | 本ファイルのユースケース |
|---|---|
| postMemo | postMemo |
| getTimeline | getTimeline |
| filterTimeline / jumpToDate | getTimeline（keyword 指定）/ jumpToDate |
| showMemoInTimeline | showMemoInTimeline |
| editMemo | editMemo |
| listMemoRevisions | listMemoRevisions |
| diffMemoRevisions | diffMemoRevisions |
| rollbackMemo | rollbackMemo |
| softDeleteMemo | softDeleteMemo |
| post_memo | post_memo |
| update_memo | update_memo |
| recent_memos | recent_memos |
| get | get |
| delete | delete |
| restoreMemo / hardDeleteMemo / 自動削除 | trash ドメインのユースケース（本ファイル対象外） |
