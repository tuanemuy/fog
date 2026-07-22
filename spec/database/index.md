# DB設計

fog の永続化スキーマ。SQLite 系ランタイム（libSQL / D1 / Turso。CLAUDE.md「Reference runtimes」）を前提とし、型は SQLite の型アフィニティ（TEXT / INTEGER）で記す。drizzle（`sqliteTable`）での表現を適宜注記する。実装先はテンプレートの流儀どおり `packages/core/src/adapters/{drizzleSqlite|d1}/schema.ts`（domain tables + `_occ_guard`。docs/backend_implementation_example.md）。

- 入力: [spec/domains/](../domains/index.md) の全エンティティ・VO・ライフサイクル状態・リポジトリのクエリパターン
- 関連 ADR: [ADR-001](../adr/001-restore-document-without-topic.md) / [ADR-003](../adr/003-source-link-after-hard-delete.md) / [ADR-004](../adr/004-domain-boundaries.md) / [ADR-005](../adr/005-search-index-via-outbox.md)

## 共通方針

- **ID**: すべて `TEXT` 主キー（UUIDv7 等。生成は `IdGenerator` ポート）。ブランド VO への再水和はアダプターの責務
- **日時**: `INTEGER`（Unix epoch ミリ秒）。drizzle では `integer("...", { mode: "timestamp_ms" })`。カラム名は `*_at`
- **version（OCC）**: 集約ルートに `version INTEGER NOT NULL`（生成時 0）。`save` / `delete` は `WHERE id = ? AND version = ?（読み取り時の値）` の条件付き更新とし、0 行更新を `ConflictError("OPTIMISTIC_LOCK_FAILURE")` にマップする。D1（interactive tx なし）では `_occ_guard` の CHECK 制約でバッチ全体を abort する（テンプレート流儀）。リビジョン・出典リンクは不変の子行のため `version` を持たない
- **boolean**: `INTEGER`（0 / 1）。drizzle では `integer("...", { mode: "boolean" })`
- **ライフサイクル直和型**: `status TEXT NOT NULL` + 状態依存カラムを nullable にし、「その状態でのみ非 NULL」を CHECK 制約で強制する（あり得ない行を DB でも排除。ドメインの判別可能ユニオンと 1:1 対応）。drizzle では `text("status", { enum: [...] })` + テーブル第3引数の `check(...)`
- **テナント分離**: ユーザー所有テーブルは `user_id TEXT NOT NULL` を持ち、アダプターは常に `user_id` でスコープしたクエリを発行する（domains/index.md「テナント分離」）。複合インデックスは原則 `user_id` を先頭に置く
- **FK と PRAGMA**: 外部キーは宣言する（`REFERENCES ... ON DELETE ...`）が、SQLite は `PRAGMA foreign_keys = ON` が接続ごとの設定であり、D1 のバッチ実行では実行順にも依存するため、**参照整合性の一次的な担保はアプリケーション層（ユースケース + リポジトリ契約）に置き、FK は defense-in-depth とする**。カスケードの方針は各テーブルの項に明記する

## テーブル一覧

| テーブル | ドメイン | 対応エンティティ / 用途 |
|---|---|---|
| `users` | identity | User（認証方式の直和） |
| `password_reset_tokens` | identity（アダプター） | PasswordResetTokenPort の永続化 |
| `ai_client_connections` | identity | AiClientConnection |
| `memos` | memo | Memo（集約ルート） |
| `memo_revisions` | memo | MemoRevision |
| `topics` | knowledge | Topic |
| `documents` | knowledge | Document |
| `document_revisions` | knowledge | DocumentRevision |
| `source_links` | knowledge | SourceLink |
| `outbox` | 共通基盤 | ドメインイベントの Outbox（テンプレート流儀） |
| `processed_events` | 共通基盤 | consumer の冪等化（IdempotencyStore。テンプレート流儀） |
| `_occ_guard` | 共通基盤 | D1 バッチの OCC abort 用（テンプレート流儀） |

trash / search / export ドメインは自前のテーブルを持たない（ADR-004）。ゴミ箱一覧・期限切れ列挙は上記テーブルの射影（`TrashQueryPort` の UNION クエリ）、検索インデックスは派生データ（後述）、エクスポートは読み取りのみ。セッション・OAuth トークン等の認証インフラは本設計のスコープ外（後述）。

## users

identity の `User`。認証方式の判別可能ユニオン（`PasswordUser | SsoUser`）を「判別タグ + nullable カラム + CHECK」で表現する。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `email` | TEXT | NOT NULL, UNIQUE。正規化（trim・小文字化）済みの値を保存する |
| `auth_method` | TEXT | NOT NULL, CHECK (`auth_method IN ('password','sso')`) |
| `password_hash` | TEXT | nullable。`auth_method = 'password'` のときのみ非 NULL |
| `sso_provider` | TEXT | nullable, CHECK (`sso_provider IS NULL OR sso_provider IN ('google','apple')`)。`auth_method = 'sso'` のときのみ非 NULL |
| `sso_provider_subject` | TEXT | nullable。同上。空文字不可（CHECK `length(sso_provider_subject) > 0`） |
| `trash_retention_days` | INTEGER | NOT NULL, CHECK (`trash_retention_days >= 1`)。既定 30（既定値の補完は application 層。DB DEFAULT は置かなくてよい） |
| `version` | INTEGER | NOT NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

直和の CHECK 制約（テーブル制約として 1 本で書く）:

```sql
CHECK (
  (auth_method = 'password'
    AND password_hash IS NOT NULL
    AND sso_provider IS NULL AND sso_provider_subject IS NULL)
  OR
  (auth_method = 'sso'
    AND password_hash IS NULL
    AND sso_provider IS NOT NULL AND sso_provider_subject IS NOT NULL)
)
```

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `users_email_uq` | UNIQUE (`email`) | メール一意性（認証方式をまたいで適用）。`insert` の制約違反を `ConflictError("EMAIL_ALREADY_REGISTERED")` にマップ。`findByEmail` |
| `users_sso_identity_uq` | UNIQUE (`sso_provider`, `sso_provider_subject`) WHERE `sso_provider IS NOT NULL`（部分一意インデックス） | SSO 主体の一意性。制約違反を `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")` にマップ。`findBySsoIdentity` |

drizzle 注記: 部分インデックスは `uniqueIndex("users_sso_identity_uq").on(t.ssoProvider, t.ssoProviderSubject).where(sql`sso_provider IS NOT NULL`)`。アダプターは行の `auth_method` で判別して `PasswordUser` / `SsoUser` に再水和し、CHECK に反する行（理論上到達不能）は `SystemError(DataIntegrityError)` にマップする。

## password_reset_tokens

`PasswordResetTokenPort`（issue / verifyAndConsume）のアダプター実装が使う。トークンの形式・署名はアダプターの責務だが、永続化先として定義する。**生トークンは保存せず、ハッシュ（SHA-256 等）を保存する**（DB 漏えい時にトークンが使えないようにする）。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `user_id` | TEXT | NOT NULL, FK → `users.id` |
| `token_hash` | TEXT | NOT NULL, UNIQUE。照合キー |
| `expires_at` | INTEGER | NOT NULL。発行時に `now + TTL` で確定（TTL はアダプター設定） |
| `used_at` | INTEGER | nullable。消費済みなら非 NULL（使い捨ての事実） |
| `created_at` | INTEGER | NOT NULL |

- `verifyAndConsume` は `token_hash` 一致・`used_at IS NULL`・`expires_at > now` を満たす行を条件付き UPDATE（`used_at = now`）で消費し、0 行更新なら null を返す（並行消費のレースも 1 回に収束）
- OCC の `version` は持たない（集約ではなくアダプター内部のストア）
- 期限切れ行は pruner / 定期ジョブで削除してよい（`expires_at` インデックスを利用）

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `prt_token_hash_uq` | UNIQUE (`token_hash`) | 照合 |
| `prt_user_idx` | (`user_id`) | ユーザーの既存トークン無効化・整理 |
| `prt_expires_idx` | (`expires_at`) | 期限切れ行の掃除 |

## ai_client_connections

identity の `AiClientConnection`。「認可の事実」であり、トークン実体（アクセストークン等）は認証アダプターの責務（スコープ外）。失効の直和（`active | revoked`）を CHECK で表現する。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `user_id` | TEXT | NOT NULL, FK → `users.id` |
| `client_name` | TEXT | NOT NULL。100 文字以下（VO で検証。DB は長さ CHECK 不要） |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('active','revoked')`) |
| `connected_at` | INTEGER | NOT NULL |
| `revoked_at` | INTEGER | nullable |
| `last_used_at` | INTEGER | nullable。`recordUsage` による単独 UPDATE（`version` を進めない後勝ち更新） |
| `version` | INTEGER | NOT NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

直和の CHECK:

```sql
CHECK (
  (status = 'active'  AND revoked_at IS NULL) OR
  (status = 'revoked' AND revoked_at IS NOT NULL)
)
```

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `acc_user_connected_idx` | (`user_id`, `connected_at` DESC) | `listByUserId`（接続一覧。connectedAt 降順） |

- `findById(userId, id)` は PK 引き + `user_id = ?` 条件（テナント分離）。`findActiveById(id)` は認可ミドルウェア専用の信頼済み ID 経路で PK 引き + `status = 'active'` 条件。いずれも追加インデックス不要
- `recordUsage` は `UPDATE ... SET last_used_at = ? WHERE id = ? AND status = 'active'` の単独文。OCC 対象外（version 不変）

## memos

memo の `Memo`（集約ルート）。直和（`active | trashed`）。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `user_id` | TEXT | NOT NULL, FK → `users.id` |
| `body` | TEXT | NOT NULL。最新リビジョンの本文と常に一致（不変条件 3。担保は同一 UoW 書き込み）。非空・10,000 文字以下は VO で検証 |
| `latest_revision_number` | INTEGER | NOT NULL, CHECK (`latest_revision_number >= 1`) |
| `posted_at` | INTEGER | NOT NULL。作成後不変。タイムラインの位置 |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('active','trashed')`) |
| `trashed_at` | INTEGER | nullable |
| `version` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

直和の CHECK:

```sql
CHECK (
  (status = 'active'  AND trashed_at IS NULL) OR
  (status = 'trashed' AND trashed_at IS NOT NULL)
)
```

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `memos_timeline_idx` | (`user_id`, `posted_at` DESC, `id` DESC) WHERE `status = 'active'`（部分インデックス） | `findTimelinePage`（カーソルページング。カーソルは `(posted_at, id)` のタプル比較で双方向に読む）、`findTimelineAround`（日付ジャンプ = `posted_at` の範囲シーク、メモアンカー = 対象の `posted_at` を引いてから同じシーク）。`keyword` 絞り込み（`body LIKE '%...%'`）はこのインデックス範囲内のスキャンで適用 |
| `memos_trash_idx` | (`user_id`, `trashed_at` DESC) WHERE `status = 'trashed'` | `listTrashed`（ゴミ箱一覧。trashedAt 降順）、`TrashQueryPort.listTrashItems` の UNION 枝 |
| `memos_expired_idx` | (`trashed_at`) WHERE `status = 'trashed'` | `TrashQueryPort.listExpiredItems`。全ユーザー横断で `users` と JOIN し `trashed_at + trash_retention_days * 86400000 < now` を評価（`RetentionPolicy` と同一の規則） |

- カーソル比較の実装注記: `direction: "older"` は `(posted_at, id) < (カーソル値)`、`"newer"` は `>`。SQLite の行値比較 `(posted_at, id) < (?, ?)` が使える
- `findById` は active のみ（`WHERE id = ? AND user_id = ? AND status = 'active'`）、`findByIdIncludingTrashed` は status 条件なし。いずれも PK 引き

## memo_revisions

memo の `MemoRevision`。不変・追記のみ。識別子は `(memo_id, revision_number)` の複合 PK（独立 ID を持たないドメイン定義どおり）。

| カラム | 型 | 制約 |
|---|---|---|
| `memo_id` | TEXT | NOT NULL, FK → `memos.id` ON DELETE CASCADE |
| `revision_number` | INTEGER | NOT NULL, CHECK (`revision_number >= 1`) |
| `actor_type` | TEXT | NOT NULL, CHECK (`actor_type IN ('user','ai_client')`) |
| `actor_connection_id` | TEXT | nullable。`ai_client` のときのみ非 NULL（`AiClientConnectionId`。FK は張らない: 接続の失効・削除と履歴の保全は独立） |
| `actor_client_name` | TEXT | nullable。`ai_client` のときのみ非 NULL。**表示用スナップショット**（接続が失効・改名されても当時の名前で残る。S-AI-04） |
| `body` | TEXT | NOT NULL。全文スナップショット |
| `created_at` | INTEGER | NOT NULL |

- PK: (`memo_id`, `revision_number`)。この一意制約が履歴線形性の最終防衛線（`insertRevision` の重複違反 → `SystemError` / `ConflictError`）
- Actor の CHECK（memo / document 共通の表現）:

```sql
CHECK (
  (actor_type = 'user'
    AND actor_connection_id IS NULL AND actor_client_name IS NULL)
  OR
  (actor_type = 'ai_client'
    AND actor_connection_id IS NOT NULL AND actor_client_name IS NOT NULL)
)
```

- `Actor.userId` はカラムに持たない。再水和時は親（`memos.user_id` / `documents.user_id`）から補う（リビジョンの読み取りは常に親を `user_id` でスコープした JOIN / サブクエリ経由のため、追加照会は生じない）
- `listRevisions` / `findRevision` は PK 前方一致（`memo_id`）+ 親メモの `user_id` スコープで引く。追加インデックス不要
- ON DELETE CASCADE はハードデリート時の全リビジョン消去（不変条件 7）に対応するが、一次的には `MemoRepository.hardDelete` がリビジョン削除文を同一 UoW で明示発行する（FK は defense-in-depth。共通方針参照）

## topics

knowledge の `Topic`。三状態の直和（`active | archived | trashed`）+ `wasArchived`。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `user_id` | TEXT | NOT NULL, FK → `users.id` |
| `name` | TEXT | NOT NULL。非空・改行なし・100 文字以下は VO で検証 |
| `description` | TEXT | nullable。`NULL` = 説明なし（空文字は保存しない） |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('active','archived','trashed')`) |
| `trashed_at` | INTEGER | nullable |
| `was_archived` | INTEGER | nullable（boolean）。trashed のときのみ非 NULL。復元先状態の記憶 |
| `version` | INTEGER | NOT NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

直和の CHECK:

```sql
CHECK (
  (status IN ('active','archived') AND trashed_at IS NULL AND was_archived IS NULL)
  OR
  (status = 'trashed' AND trashed_at IS NOT NULL AND was_archived IS NOT NULL AND was_archived IN (0, 1))
)
```

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `topics_user_live_idx` | (`user_id`, `status`, `name`) | `listByUser`（一覧。includeArchived の有無・名前順の安定順序） |
| `topics_trash_idx` | (`user_id`, `trashed_at` DESC) WHERE `status = 'trashed'` | `listTrashedByUser`、ゴミ箱 UNION 枝 |
| `topics_expired_idx` | (`trashed_at`) WHERE `status = 'trashed'` | `listExpiredItems`（`users` と JOIN。memos_expired_idx と同じ規則） |

## documents

knowledge の `Document`（集約ルート）。直和（`active | trashed`）+ `trashedWith`（セット削除の識別）。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `user_id` | TEXT | NOT NULL, FK → `users.id` |
| `topic_id` | TEXT | NOT NULL。**FK は張らない**（後述） |
| `title` | TEXT | NOT NULL。非空・改行なし・200 文字以下は VO で検証 |
| `body` | TEXT | NOT NULL。空文字可・1,000,000 文字以下は VO で検証 |
| `latest_revision_number` | INTEGER | NOT NULL, CHECK (`latest_revision_number >= 1`)。ドメインの `latestRevision`。OCC の `version` とは独立 |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('active','trashed')`) |
| `trashed_at` | INTEGER | nullable |
| `trashed_with` | TEXT | nullable。セット削除元の `TopicId`。個別削除は NULL |
| `version` | INTEGER | NOT NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

CHECK（直和 + 不変条件 8「`trashed_with` 非 NULL なら `topic_id` と一致」）:

```sql
CHECK (
  (status = 'active'  AND trashed_at IS NULL AND trashed_with IS NULL) OR
  (status = 'trashed' AND trashed_at IS NOT NULL)
),
CHECK (trashed_with IS NULL OR trashed_with = topic_id)
```

**`topic_id` に FK を張らない理由（設計判断）**: 個別削除済みドキュメントが残ったままトピックがハードデリートされるケースが正当に存在する（ADR-001。ゴミ箱内ドキュメントの `topic_id` は消滅済みトピックを指したままになり、復元時に `moveToTopic` で差し替える）。`ON DELETE CASCADE` はユーザーが明示していない不可逆削除（ADR-001 で不採用）を、`RESTRICT` は正当なトピックハードデリートの阻害を招く。NOT NULL のため `SET NULL` も不可。したがって「active なドキュメントの `topic_id` は実在する Live トピックを指す」の保証はユースケース（作成時の検証 + トピック touch による OCC 直列化、restore 時の呼び出し側保証）に置く。

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `docs_topic_active_idx` | (`user_id`, `topic_id`) WHERE `status = 'active'` | `listActiveByTopic` / `listActiveByTopics`（トピック詳細・一覧・セット削除対象の確定） |
| `docs_topic_trashed_idx` | (`user_id`, `topic_id`) WHERE `status = 'trashed'` | `listTrashedByTopic`（セット復元・トピックハードデリート対象）。`trashed_with = ?` の絞り込みはこの範囲内で評価 |
| `docs_trash_idx` | (`user_id`, `trashed_at` DESC) WHERE `status = 'trashed'` | `listTrashedByUser`、ゴミ箱 UNION 枝 |
| `docs_expired_idx` | (`trashed_at`) WHERE `status = 'trashed'` | `listExpiredItems`（`users` と JOIN） |
| `docs_user_updated_idx` | (`user_id`, `updated_at` DESC) WHERE `status = 'active'` | エクスポートの全件読み・一覧系の安定順序（必要十分でなければ実装時に削ってよい） |

- `TrashedTopicItem.setDocumentIds` の射影は `docs_topic_trashed_idx` を使い `WHERE user_id = ? AND topic_id = ? AND trashed_with = topic_id` で得る

## document_revisions

knowledge の `DocumentRevision`。不変・追記のみ。こちらは独立 ID（`DocumentRevisionId`）を持つ。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `document_id` | TEXT | NOT NULL, FK → `documents.id` ON DELETE CASCADE |
| `revision_number` | INTEGER | NOT NULL, CHECK (`revision_number >= 1`) |
| `title` | TEXT | NOT NULL。当時のタイトル全文 |
| `body` | TEXT | NOT NULL。当時の本文の全文スナップショット |
| `actor_type` | TEXT | NOT NULL, CHECK (`actor_type IN ('user','ai_client')`) |
| `actor_connection_id` | TEXT | nullable。Actor の CHECK は memo_revisions と同一 |
| `actor_client_name` | TEXT | nullable。同上（表示用スナップショット） |
| `change_reason` | TEXT | NOT NULL。非空・改行なし・200 文字以下は VO で検証 |
| `created_at` | INTEGER | NOT NULL |

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `doc_revs_doc_rev_uq` | UNIQUE (`document_id`, `revision_number`) | 履歴線形性の最終防衛線（`insertRevision` の違反 → `ConflictError`）。`listRevisions`（昇順）・`findRevision` もこのインデックスで引く |

- Actor の CHECK と `userId` の扱いは memo_revisions と同じ（親 `documents.user_id` から補う）
- ON DELETE CASCADE はドキュメントハードデリート時の全リビジョン消去に対応。一次的には `DocumentRepository.delete` のアダプターが同一バッチでリビジョン削除文を明示発行する（契約どおり）

## source_links

knowledge の `SourceLink`。ドキュメント → 出典メモの純粋な関連。同一性は `(document_id, memo_id)` の複合。サロゲートキーは不要（ドメイン定義でアダプター裁量とされているが、複合 PK で十分）。

| カラム | 型 | 制約 |
|---|---|---|
| `document_id` | TEXT | NOT NULL, FK → `documents.id` ON DELETE CASCADE |
| `memo_id` | TEXT | NOT NULL, FK → `memos.id` ON DELETE CASCADE |
| `created_at` | INTEGER | NOT NULL。紐付け日時（= ドキュメント作成日時） |

- PK: (`document_id`, `memo_id`)。`Document.create` の重複除去に加え、DB でも同一組の重複を排除
- `user_id` カラムは持たない（正規化を優先）。読み取りの userId スコープは `documents`（または `memos`）との JOIN で担保する（`listSourceLinksByMemos(userId, ...)` は `JOIN documents d ON d.id = document_id AND d.user_id = ?` 等）
- **消去系（`deleteSourceLinksByMemo` 等）の userId スコープは documents 側 JOIN（`document_id IN (SELECT id FROM documents WHERE user_id = ?)`）に限定する。** メモのハードデリート手順では `deleteSourceLinksByMemo` 実行時点で同一 UoW 内の memos 行が既に削除済みのため、memos 側 JOIN では常に 0 行更新となり孤児リンクが残る（ADR-003 違反）。memos 側 JOIN を消去系に使ってはならない

**ハードデリート時のカスケード消去（ADR-003）の方針**: **一次的な消去はアプリケーション層が行い、FK の ON DELETE CASCADE は defense-in-depth とする。**

- メモのハードデリート: trash ドメインのユースケースが同一 UoW 内で (1) `listSourceLinksByMemo` で影響ドキュメント ID を確定 → (2) `MemoRepository.hardDelete` → (3) `DocumentRepository.deleteSourceLinksByMemo(userId, memoId)` → (4) `document.sourceLinksChanged` 発行、をオーケストレーションする。イベント発行のために**消去前の影響先確定が必須**であり、FK カスケード任せにはできない（カスケードは影響先を教えてくれない）
- ドキュメントのハードデリート: `DocumentRepository.delete` のアダプターが同一バッチで `document_id` 側のリンク削除文を発行する（リビジョンと同様）
- FK カスケードを併置する理由: PRAGMA が有効なランタイムでは、万一アプリ層の消去が漏れても孤児リンクが残らない。カスケードが先に効いた場合もアプリ層の DELETE は 0 行更新の no-op（冪等）で問題ない

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| （PK） | (`document_id`, `memo_id`) | `listSourceLinksByDocument` / `listSourceLinksByDocuments`（document → memos 方向。前方一致） |
| `source_links_memo_idx` | (`memo_id`) | `listSourceLinksByMemo` / `listSourceLinksByMemos`（memo → documents の逆引き。タイムライン 1 ページ分の一括逆引き・ADR-003 の消去・search consumer のファンアウト）、`deleteSourceLinksByMemo` |

## outbox / processed_events / _occ_guard（共通基盤）

テンプレートの既存流儀（docs/backend_implementation_example.md の schema.ts / outboxRepository / IdempotencyStore / deferred-batch UoW）にそのまま従い、本設計で再定義しない。要点のみ:

- `outbox`: ドメインイベント行（`id`（EventId。UoW の `collectEvents` が採番）, `event_type`, `aggregate_id`, `payload`（TEXT / JSON。**対象 ID のみ**。ADR-005）, `created_at`, `processed_at`, `attempts`, `next_attempt_at`, `failed_at`）。`claimPending` 用の部分インデックス（`processed_at IS NULL AND failed_at IS NULL`）を持ち、poison 行（`failed_at` 非 NULL）はホットパスから外れる。処理済み行は `pruneOutbox` が削除
- `processed_events`: consumer の event.id ベース冪等化（`INSERT OR IGNORE` で claim）
- `_occ_guard`: D1（interactive tx なし・PendingBatch 方式）で OCC 不一致時に CHECK 制約違反でバッチ全体を abort させるためのガードテーブル。libSQL / Turso（interactive tx あり）では条件付き UPDATE の 0 行検出で足りるが、スキーマは共通に持つ

fog で outbox に載るイベントは memo / knowledge / identity の各ドメインイベント（domains/*.md 参照）。search の indexer consumer と認証アダプターのトークン失効 consumer が購読する。

## 検索インデックスの永続化（アダプター実装詳細）

search ドメインはテーブルを持たず、インデックスは `SearchIndexPort` アダプター内部の派生データとする（常に本体テーブルから再構築可能。マイグレーションの整合対象としては扱うが、ドメインの集約ではない）。ランタイムごとに実装を差し替え得るため、本設計では候補構成のみ規定する:

- **FTS5 仮想テーブル**（libSQL / Turso / D1 いずれも利用可）: `search_fts(type, entity_id UNINDEXED, user_id UNINDEXED, topic_id UNINDEXED, title, content)` の contentless / external-content FTS5。upsert は delete + insert で冪等に。日本語対応のトークナイザ（trigram 等）の選定はアダプター実装の責務
- **embeddings テーブル**: `search_embeddings(type TEXT, entity_id TEXT, user_id TEXT, embedding BLOB(F32_BLOB), PRIMARY KEY (type, entity_id))`。libSQL / Turso はネイティブのベクトル型 + ベクトルインデックスを利用。D1 はベクトル検索を持たないため Cloudflare Vectorize 等の外部インデックスに差し替える（その場合 embeddings テーブル自体を持たない）
- 検索結果の `sourceOfDocumentIds` / `sourceMemoIds`（active な相手のみ）は、インデックスエントリ構築時（consumer のファンアウト。search.md）に確定して FTS 側の付随カラムまたは併設テーブルに保持する。埋め込み生成・RRF マージはポート実装に隠蔽

これらの DDL は選定したランタイムのアダプターのマイグレーションとして管理し、コアの domain tables とはファイルを分ける（差し替え時に domain tables へ影響を出さない）。

## 認証インフラテーブルはスコープ外

セッション（Cookie セッションストア）・OAuth 2.1 のアクセストークン / リフレッシュトークン / 認可コード / PKCE 検証子などの保存は**認証・認可アダプターの責務**であり、本設計のスコープ外とする（identity.md「スコープに関する注意」）。採用する認証ライブラリ / 基盤が要求するテーブルはアダプターのマイグレーションとして別途追加する。ただし `ai_client_connections` は「ユーザーが許可した」というドメインの認可の事実であるため本設計に含める。トークン検証時の失効判定は `ai_client_connections.status` を根拠とする（`identity.aiClientRevoked` イベントがアダプター側トークンストアの失効処理のトリガーになる）。

## リレーション図

```text
users 1 ──── * password_reset_tokens        (user_id)
users 1 ──── * ai_client_connections        (user_id)
users 1 ──── * memos                        (user_id)
users 1 ──── * topics                       (user_id)
users 1 ──── * documents                    (user_id)

memos 1 ──── * memo_revisions               (memo_id, ON DELETE CASCADE)
documents 1 ─ * document_revisions          (document_id, ON DELETE CASCADE)

topics 1 ──── * documents                   (topic_id。FK なし: ADR-001 のため
                                             アプリ層で整合を保証。trashed 行は
                                             消滅済みトピックを指し得る)

documents 1 ─ * source_links * ──── 1 memos (PK (document_id, memo_id)。
                                             双方向 ON DELETE CASCADE +
                                             アプリ層の同期消去 ADR-003)

memo_revisions.actor_connection_id    ┐ ai_client_connections.id への参照値
document_revisions.actor_connection_id┘ (FK なし: clientName スナップショットで
                                         履歴表示は自己完結)

outbox / processed_events / _occ_guard      (どのテーブルとも FK なし。共通基盤)
search_fts / search_embeddings              (派生データ。アダプター実装詳細)
```

## 主要クエリとインデックスの対応（確認表)

| クエリパターン（ポート） | 使うインデックス |
|---|---|
| タイムラインのカーソルページング・双方向読み（`findTimelinePage`） | `memos_timeline_idx`（`(posted_at, id)` 行値比較） |
| 日付ジャンプ・メモアンカー（`findTimelineAround`） | `memos_timeline_idx`（`posted_at` 範囲シーク） |
| キーワード絞り込み（`keyword`） | `memos_timeline_idx` の範囲内で `body LIKE` 評価 |
| ゴミ箱一覧（`listTrashed` / `listTrashedByUser` / UNION 射影） | `memos_trash_idx` / `docs_trash_idx` / `topics_trash_idx` |
| 期限切れ列挙（`listExpiredItems`。`users.trash_retention_days` と JOIN） | `memos_expired_idx` / `docs_expired_idx` / `topics_expired_idx` + `users` PK |
| 出典逆引き memo → documents（単発・一括） | `source_links_memo_idx` |
| 出典参照 document → memos（単発・一括） | `source_links` PK 前方一致 |
| トピック配下ドキュメント（active / trashed・一括） | `docs_topic_active_idx` / `docs_topic_trashed_idx` |
| 接続一覧（`listByUserId`） | `acc_user_connected_idx` |
| メール / SSO 主体でのユーザー解決 | `users_email_uq` / `users_sso_identity_uq` |
| 履歴一覧・単一リビジョン取得 | `memo_revisions` PK / `doc_revs_doc_rev_uq` |
| エクスポート全件読み（`ExportSourceReader.readAll`） | `memos_timeline_idx` / `topics_user_live_idx` / `docs_user_updated_idx` |
| outbox の claimPending | テンプレートの部分インデックス |
