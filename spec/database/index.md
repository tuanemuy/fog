# DB設計

fog の永続化スキーマ。**Cloudflare Workers + ユーザー単位 SQLite-backed Durable Objects**（CLAUDE.md「Reference runtime」）を前提とし、型は SQLite の型アフィニティ（TEXT / INTEGER）で記す。実装先は #37 が新設する Durable Object のアダプター（`packages/core/src/adapters/cloudflare/`）である。

- 入力: [spec/domains/](../domains/index.md) の全エンティティ・VO・ライフサイクル状態・リポジトリのクエリパターン
- 関連 ADR: [ADR-001](../adr/001-restore-document-without-topic.md) / [ADR-003](../adr/003-source-link-after-hard-delete.md) / [ADR-004](../adr/004-domain-boundaries.md) / [.adr/003](../../.adr/003-sqlite-fts5-only-search.md)（検索は FTS5 の全文検索のみ） / [.adr/004](../../.adr/004-do-local-commit-and-alarm-jobs.md)（DO ローカルの同期コミットと Alarm ジョブ）。`spec/adr/005`（superseded。根拠側は `.adr/003`、方式側は `.adr/004`）
- **本ファイルが `spec/` 側のスキーマの正本である。** 由来は Issue #34 の設計であり、以後の変更は本ファイルを直す

## 物理境界

テーブルは2つの Durable Object クラスに分かれて置かれる。**同じ形のテーブルが両クラスに現れることがある**（`jobs` / `_meta`）。

| DO クラス | インスタンスの単位 | 置くもの |
|---|---|---|
| User Data DO | 1ユーザー1インスタンス | そのユーザーのドメインデータ全部（アカウント状態・設定・メモ・ナレッジ・検索 projection・ジョブ） |
| Identity Directory DO | bucket 単位 | `userId` が未確定の経路から引かれる認証クレデンシャルの写像・リセットトークン・bucket 単位のジョブ |

- **テナント分離の保証は列条件ではなく到達可能性による**（domains/index.md「テナント分離」）。同じ User Data DO の中に他ユーザーの行は原理的に存在せず、他ユーザーの DO stub を得る経路も存在しない。**したがってどのテーブルも `user_id` 列を持たず、複合インデックスの先頭に `user_id` を置くこともしない**（唯一 `credential_mappings.user_id` だけは例外だが、それは分離のための述語ではなくクレデンシャルから `userId` への**写像そのもの**である）
- 自分の `userId` は `_meta.self_locator` に1行だけ持つ。用途はエクスポートのヘッダ・移送と検証・DO 名が使えない経路のフォールバックに限り、**行データの絞り込みには使わない**
- 1 DO あたりのストレージ上限は 10 GB で、**本体と FTS5 インデックスの合計**で見る（requirements 5.3）。逼迫時は書き込みだけが失敗し読みと削除は通るので、導線は「ゴミ箱を空にする / エクスポートして削除する」が生きる

## 共通方針

- **ID**: 単一の `TEXT` 列を主キーに持つテーブルでは、その値は UUIDv7 等（生成は `IdGenerator` ポート）とし、ブランド VO への再水和はアダプターの責務とする。**例外は2つで、これが全数である** — (a) `password_reset_tokens.token_id`（時刻由来を避けた暗号論的乱数の不透明値。後述）、(b) `jobs.operation_key`（**生成せず、ジョブの同一性から決定的に導く値である**。DO ごとに定数のキーを持つ種別と、対象と時間窓から導く種別がある。**`IdGenerator` で採番すると再投入のたびに別のキーになり、`jobs` の収束規則3つと `provider_idempotency_key` の決定的な導出がどれも成立しない**。導出の規則は `jobs` の節と各ユースケースが正本）。**主キーの形は3通りある** — (1) 単一 `TEXT` 列、(2) 複合キー（`memo_revisions` / `source_links` / `credential_locators` / `credential_mappings` / `migration_progress` / `rotation_checkpoints`）、(3) `search_entries` の `rowid INTEGER PRIMARY KEY`（`id TEXT` は名前つき UNIQUE 索引を持つ別列。後述）。**単一行のテーブル**（`account` / `user_settings` / `_meta`）は業務上の主キーを持たない（単一行制約の掛け方は実装裁量とする。#37）。**どのテーブルがどの形を採るかは各テーブルの節が正本であり、節に無いサロゲートの `id` 列を足してよいという読み方はしない**
- **日時**: `INTEGER`（Unix epoch ミリ秒）。カラム名は `*_at`
- **version（OCC）**: 集約ルートに `version INTEGER NOT NULL`（生成時 0）。`save` / `delete` は `WHERE id = ? AND version = ?（読み取り時の値）` の条件付き更新とし、**0 行更新を `ConflictError("OPTIMISTIC_LOCK_FAILURE")` にマップする**。**単一行テーブルは `id` 列を持たないので `WHERE version = ?` だけで条件付ける**（`id` 述語は不要。他の行が存在しないため）。**本 spec の範囲でこの形の条件付き更新を発行するのは `user_settings` だけである** — `account` も `version` 列を持つが書き手が無い（後述の `account` の項）。0 行かどうかは `UPDATE ... WHERE id = ? AND version = ? RETURNING 1` が返した行の有無で読む（単一行テーブルでは `id` 述語を除いた同じ形。意味論がその文の中で閉じるため。`changes()` は第二候補、課金単位である書き込み行数カウンタは使わない）。リビジョン・出典リンクは不変の子行のため `version` を持たない。**持つテーブル / 持たないテーブルの全数は後述**
- **boolean**: `INTEGER`（0 / 1）
- **ライフサイクル直和型**: `status TEXT NOT NULL` + 状態依存カラムを nullable にし、「その状態でのみ非 NULL」を CHECK 制約で強制する（あり得ない行を DB でも排除。ドメインの判別可能ユニオンと 1:1 対応）
- **書き込みの単位**: 書き込みは DO 内蔵の SQLite に対する単一の同期トランザクションで確定する。**本体行と検索 projection（`search_entries` / `search_fts`）も同じトランザクションに入る**（domains/search.md「インデックスの維持」）
- **FK と PRAGMA**: 外部キーは宣言する（`REFERENCES ... ON DELETE ...`）が、SQLite は `PRAGMA foreign_keys = ON` が接続ごとの設定であるため、**参照整合性の一次的な担保はアプリケーション層（ユースケース + リポジトリ契約）に置き、FK は defense-in-depth とする**。カスケードの方針は各テーブルの項に明記する

## テーブル一覧

| テーブル | DO クラス | ドメイン | 対応エンティティ / 用途 |
|---|---|---|---|
| `account` | User Data | identity | アカウント状態・セッション失効の権威・退会 tombstone |
| `user_settings` | User Data | identity | User のユーザー単位設定（単一行） |
| `credential_locators` | User Data | identity | 保有クレデンシャルの逆引き（bucket の所在とログイン到達性の権威） |
| `ai_client_connections` | User Data | identity | AiClientConnection |
| `memos` | User Data | memo | Memo（集約ルート） |
| `memo_revisions` | User Data | memo | MemoRevision |
| `topics` | User Data | knowledge | Topic |
| `documents` | User Data | knowledge | Document |
| `document_revisions` | User Data | knowledge | DocumentRevision |
| `source_links` | User Data | knowledge | SourceLink |
| `search_entries` | User Data | search | 検索 projection の本体（1エントリ1行） |
| `search_fts` | User Data | search | FTS5 仮想テーブル（external-content） |
| `jobs` | User Data | 共通基盤 | Alarm ジョブ（6種） |
| `operations` | User Data | 共通基盤 | saga / RPC の冪等キーと phase |
| `migration_progress` | User Data | 共通基盤 | migration の部分適用カーソル |
| `_meta` | User Data | 共通基盤 | `schema_version` と自 locator |
| `credential_mappings` | Identity Directory | identity（アダプター） | クレデンシャル → `userId` の写像・検証材料・予約 |
| `password_reset_tokens` | Identity Directory | identity（アダプター） | `PasswordResetTokenPort` の永続化 |
| `jobs` | Identity Directory | 共通基盤 | Alarm ジョブ（6種） |
| `rotation_checkpoints` | Identity Directory | identity（アダプター） | 鍵ローテーションの進捗記録 |
| `_meta` | Identity Directory | 共通基盤 | `schema_version` と自 locator |

trash / export ドメインは自前のテーブルを持たない（ADR-004）。ゴミ箱一覧は上記テーブルの射影（`TrashQueryPort` の UNION クエリ）、保持期限の到達処理は各行の `purge_after` を引く Alarm ジョブ、エクスポートは読み取りのみ。**search は `search_entries` / `search_fts` を持つ** — ただし常に本体テーブルから再構築可能な派生データであり、集約ではない。

## User Data DO のテーブル

### account

アカウントの状態・失効の権威・退会 tombstone。**単一行のテーブルである**（その DO の中に1人分しか存在しない）。単一行制約の掛け方は実装裁量とする（#37）。

| カラム | 型 | 制約 |
|---|---|---|
| `status` | TEXT | NOT NULL, CHECK (`status IN ('active','deleting','deleted')`) |
| `session_epoch` | INTEGER | NOT NULL。セッション失効の唯一の権威。**進める操作は4つだけ**（パスワード変更・リセット完了・SSO 連携の解除・退会）で単調増加する。**SSO 連携の追加では進めない**（domains/identity.md「AccountStore」） |
| `deleted_at` | INTEGER | nullable。`status = 'deleted'` のときのみ非 NULL |
| `caller_token` | TEXT | nullable。DO 間 RPC の呼び出し元束縛に使う不透明値。**消すのは退会の完走時だけであり、それ以外の経路では消さない**（束縛の材料はこの列だけなので、先に消すと写像を消す経路が発行できなくなる）。ログ・エラー・ジョブの `terminal_reason` に出さない |
| `reset_version` | INTEGER | NOT NULL。初期値 0。**パスワードリセットの完了だけで進む単調増加カウンタ**で、通常のパスワード変更・SSO の連携 / 解除では進まない。AI クライアント接続の自動失効の基準になる |
| `version` | INTEGER | NOT NULL（OCC） |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

- 退会後も**非 PII の tombstone** としてこの行が残る（`status = 'deleted'`）。復活を防ぐため、状態の権威は常にこの行である
- `reset_version` を `credential_version` で代用しない。侵害と復旧のあいだにパスワード変更が1回でも挟まると、失効させたい接続が対象から外れるためである
- **ドメイン側の口は `AccountStore` である**（domains/identity.md）。名前は `*Store` だが**この表は後述の非集約ストア7つには入らない** — OCC の `version` を持つ集約ルート側であり、`User` 集約に畳まないことと非集約であることは別である
- `session_epoch` / `reset_version` の前進は単調増加カウンタの更新なので、`version` の条件を付けない単独文で書き、`version` も進めない（`ai_client_connections.last_used_at` と同じ扱い）
- **`version` 列は保持するが、本 spec の範囲では OCC の条件付き更新を発行する操作が無い。** `AccountStore` の3メソッド（`find` / `advanceSessionEpoch` / `advanceResetVersion`。domains/identity.md）はいずれも `version` を読まず進めない。`status` の3値遷移・`deleted_at`・`caller_token` を書くのは退会 saga の前進（`finalize-withdrawal`）であり、**その書き手は #12 / #45 が決める**（当初は #37 に割り当てていたが、#37 は退会をスコープ外とし `finalize-withdrawal` のハンドラも実装していない）。列を落とさないのは、「集約ルートは `version` を持つ」という全数（後述の OCC の表）を崩さないためである

### user_settings

identity の `User` のユーザー単位設定。**単一行のテーブルである**（`account` と同じく業務上の主キーを持たない。単一行制約の掛け方は実装裁量とする。#37）。`UserSettingsRepository` は `find()` で引き、`findById` を持たない（他の `userId` を渡せるという読み方を残さないため。domains/identity.md）。

| カラム | 型 | 制約 |
|---|---|---|
| `trash_retention_days` | INTEGER | NOT NULL, CHECK (`trash_retention_days >= 1`)。既定 30（既定値の補完は application 層。DB DEFAULT は置かなくてよい） |
| `version` | INTEGER | NOT NULL（OCC） |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

- `trash_retention_days` の変更は、**変更したのと同一トランザクションでゴミ箱内の全項目の `purge_after` を再計算する**（後述の `memos` / `topics` / `documents`）
- **件数が大きい場合はチャンク分割へ落ちる**（`purge-trash` の再計算フェーズ。後述の `jobs`）。**そのときの作業述語は自己消尽する形で書く** — `WHERE status = 'trashed' AND purge_after <> <新しい trash_retention_days で算出した値>`（＝まだ再計算していない行）とし、更新した行がその場で述語から外れるようにする。**述語が単調に縮むことが、`purge-trash` が永続カーソルを持たずに済む唯一の根拠である**（後述の `migration_progress`）。素朴に `WHERE status = 'trashed'` で回すと述語が縮まず、中断のたびに先頭へ戻って完了しない。**自己消尽しない UPDATE を `purge-trash` に足してはならない** — 足す必要が生じたら、そのジョブは永続カーソルを持つ側へ移す

### credential_locators

保有クレデンシャルの逆引き。**ログインの到達性検査の権威**であり、退会・SSO 連携解除のときに Identity Directory 側の写像を消すための唯一の逆引き情報でもある。原本（メールアドレス）も検証材料も持たない。

| カラム | 型 | 制約 |
|---|---|---|
| `credential_id` | TEXT | NOT NULL。世代に依存しないクレデンシャルの同一性 |
| `kind` | TEXT | NOT NULL, CHECK (`kind IN ('email','sso')`) |
| `hmac` | TEXT | NOT NULL。canonical 値の HMAC（全長 64 hex） |
| `generation` | INTEGER | NOT NULL。写像鍵の世代 |
| `bucket_index` | INTEGER | NOT NULL。Identity Directory bucket の番号 |
| `credential_version` | INTEGER | NOT NULL |
| `status` | TEXT | NOT NULL, CHECK (`status = 'active'`)。**値域は `active` の1値だけである** — 除去は物理削除で行うので他の値を取らない。`revoked` のような論理削除状態を置かない（置くと「有効な行」を数える述語が2系統になる） |
| `usable_for_login` | INTEGER | NOT NULL（boolean）。そのクレデンシャルが単独でログイン手段として成立するか。`kind = 'sso'` は常に真、`kind = 'email'` は写像側が検証材料を持つときだけ真。値は Identity Directory 側が判定して引数で運ぶ |
| `label` | TEXT | NOT NULL。設定画面に出す**非 PII の表示名**（`kind = 'sso'` なら provider 名、`kind = 'email'` なら空文字）。**SSO の subject もメールアドレスも入れない** |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| （PK） | (`credential_id`, `generation`) | 到達性検査・世代ごとの upsert |
| `cl_hmac_uq` | UNIQUE (`kind`, `hmac`, `generation`) | 同じ canonical が2つの `credential_id` を持たないことの保証 |

- **PK は (`credential_id`, `generation`) の複合キーである**（上表の `（PK）` 行。**複合 PK の暗黙索引には名前を付けられない**ので、`CREATE INDEX` を書くのは名前欄が埋まっている行だけである。`source_links` と同じ表記である）。**サロゲートの `id` 列は置かない** — 同一性は世代非依存の `credential_id` と世代の組が持つので、別の主キーを足すと同一性の権威が二重になる
- **到達性の照合は `credential_id` だけを見て `generation` を含めない。** 鍵のローテーション中は同じクレデンシャルについて新旧2世代の行が並存しうるためである
- **したがって「ログイン手段の数」は行数ではなく、`usable_for_login = 1` の行の `credential_id` の異なり数である**（domains/identity.md の不変条件と同じ数え方）
- **書き込み口は UoW コンテキストの `credentialLocatorStore` だけである。** 書き込み箇所は3つで、これが全数である — (1) 新規登録・SSO 連携の完了時の upsert、(2) SSO 連携解除・退会時の削除、(3) クレデンシャル変更の適用時の全世代更新。`usable_for_login` と `label` の値は Identity Directory 側が判定して引数で運ぶ（この表は自分では判定しない）。**鍵ローテーションに伴う追加と旧世代行の削除も同じ口を使うが、その呼び出し規約は #44 が定める**

### ai_client_connections

identity の `AiClientConnection`。「認可の事実」であり、トークン実体は認証アダプターの責務。失効の直和（`active | revoked`）を CHECK で表現する。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `client_name` | TEXT | NOT NULL。100 文字以下（VO で検証。DB は長さ CHECK 不要） |
| `scope` | TEXT | NOT NULL。許可したトークンスコープ |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('active','revoked')`) |
| `connected_at` | INTEGER | NOT NULL |
| `revoked_at` | INTEGER | nullable |
| `last_used_at` | INTEGER | nullable。`recordUsage` による単独 UPDATE（`version` を進めない後勝ち更新） |
| `created_at_reset_version` | INTEGER | NOT NULL。**作成時点の `account.reset_version`**。リセット完了時の自動失効はこの値と現在値の比較で決まる |
| `version` | INTEGER | NOT NULL（OCC。設定画面からの二重解除操作の競合を検出する対象そのもの） |
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
| `acc_connected_idx` | (`connected_at` DESC) | `listByUserId`（接続一覧。connectedAt 降順） |

- `findById(id)` / `findActiveById(id)` はいずれも PK 引き（後者は `status = 'active'` 条件を足す）。追加インデックス不要
- `recordUsage` は `UPDATE ... SET last_used_at = ? WHERE id = ? AND status = 'active'` の単独文。OCC 対象外（version 不変）
- **失効の権威はこの行である。** 失効を別の場所へ配送する経路は無く、次のリクエストの DO 内ガードが `status` と `account.status` を直接読む

### memos

memo の `Memo`（集約ルート）。直和（`active | trashed`）。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `body` | TEXT | NOT NULL。最新リビジョンの本文と常に一致（不変条件 3。担保は同一トランザクションでの書き込み）。非空・10,000 文字以下は VO で検証 |
| `latest_revision_number` | INTEGER | NOT NULL, CHECK (`latest_revision_number >= 1`) |
| `posted_at` | INTEGER | NOT NULL。作成後不変。タイムラインの位置 |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('active','trashed')`) |
| `trashed_at` | INTEGER | nullable |
| `purge_after` | INTEGER | nullable。**保持期限**。ソフトデリート時に `RetentionPolicy.expiresAt` の算出結果を保存し、復元時に `NULL` へ戻す |
| `version` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

直和の CHECK（`trashed` であることと `purge_after` を持つことは同値。domains/trash.md「保持期限」）:

```sql
CHECK (
  (status = 'active'  AND trashed_at IS NULL     AND purge_after IS NULL) OR
  (status = 'trashed' AND trashed_at IS NOT NULL AND purge_after IS NOT NULL)
)
```

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `memos_timeline_idx` | (`posted_at` DESC, `id` DESC) WHERE `status = 'active'`（部分インデックス） | `findTimelinePage`（カーソルページング。カーソルは `(posted_at, id)` のタプル比較で双方向に読む）、`findTimelineAround`（日付ジャンプ = `posted_at` の範囲シーク、メモアンカー = 対象の `posted_at` を引いてから同じシーク）。`keyword` 絞り込み（`body LIKE '%...%'`）はこのインデックス範囲内のスキャンで適用 |
| `memos_trash_idx` | (`trashed_at` DESC) WHERE `status = 'trashed'` | `listTrashed`（ゴミ箱一覧。trashedAt 降順）、`TrashQueryPort.listTrashItems` の UNION 枝 |
| `memos_purge_idx` | (`purge_after`) WHERE `status = 'trashed'` | `purge-trash` ジョブの作業述語（`WHERE trashed AND purge_after < ?`）と駆動源（`WHERE trashed` の `min(purge_after)`）。**全ユーザー横断の JOIN は無い** — DO の中には自分の期限しか存在しない |

- カーソル比較の実装注記: `direction: "older"` は `(posted_at, id) < (カーソル値)`、`"newer"` は `>`。SQLite の行値比較 `(posted_at, id) < (?, ?)` が使える
- `findById` は active のみ（`WHERE id = ? AND status = 'active'`）、`findByIdIncludingTrashed` は status 条件なし。いずれも PK 引き
- 書き込み・ソフトデリート・復元・ハードデリートはいずれも**同一トランザクションで `search_entries` / `search_fts` の projection を更新する**（domains/search.md）

### memo_revisions

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

- `Actor.userId` はカラムに持たない。再水和時は DO の同一性（`_meta` の自 locator）から補う
- `listRevisions` / `findRevision` は PK 前方一致（`memo_id`）で引く。追加インデックス不要
- ON DELETE CASCADE はハードデリート時の全リビジョン消去（不変条件 7）に対応するが、一次的には `MemoRepository.hardDelete` がリビジョン削除文を同一トランザクションで明示発行する（FK は defense-in-depth。共通方針参照）

### topics

knowledge の `Topic`。三状態の直和（`active | archived | trashed`）+ `wasArchived`。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `name` | TEXT | NOT NULL。非空・改行なし・100 文字以下は VO で検証 |
| `description` | TEXT | nullable。`NULL` = 説明なし（空文字は保存しない） |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('active','archived','trashed')`) |
| `trashed_at` | INTEGER | nullable |
| `purge_after` | INTEGER | nullable。`memos` と同じ規則（trashed のときのみ非 NULL） |
| `was_archived` | INTEGER | nullable（boolean）。trashed のときのみ非 NULL。復元先状態の記憶 |
| `version` | INTEGER | NOT NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

直和の CHECK:

```sql
CHECK (
  (status IN ('active','archived')
    AND trashed_at IS NULL AND purge_after IS NULL AND was_archived IS NULL)
  OR
  (status = 'trashed'
    AND trashed_at IS NOT NULL AND purge_after IS NOT NULL
    AND was_archived IS NOT NULL AND was_archived IN (0, 1))
)
```

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `topics_live_idx` | (`status`, `name`) | `listByUser`（一覧。includeArchived の有無・名前順の安定順序） |
| `topics_trash_idx` | (`trashed_at` DESC) WHERE `status = 'trashed'` | `listTrashedByUser`、ゴミ箱 UNION 枝 |
| `topics_purge_idx` | (`purge_after`) WHERE `status = 'trashed'` | `purge-trash` ジョブ（`memos_purge_idx` と同じ規則） |

### documents

knowledge の `Document`（集約ルート）。直和（`active | trashed`）+ `trashedWith`（セット削除の識別）。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK |
| `topic_id` | TEXT | NOT NULL。**FK は張らない**（後述） |
| `title` | TEXT | NOT NULL。非空・改行なし・200 文字以下は VO で検証 |
| `body` | TEXT | NOT NULL。空文字可・1,000,000 文字以下は VO で検証 |
| `latest_revision_number` | INTEGER | NOT NULL, CHECK (`latest_revision_number >= 1`)。ドメインの `latestRevision`。OCC の `version` とは独立 |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('active','trashed')`) |
| `trashed_at` | INTEGER | nullable |
| `purge_after` | INTEGER | nullable。`memos` と同じ規則 |
| `trashed_with` | TEXT | nullable。セット削除元の `TopicId`。個別削除は NULL |
| `version` | INTEGER | NOT NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

CHECK（直和 + 不変条件 8「`trashed_with` 非 NULL なら `topic_id` と一致」）:

```sql
CHECK (
  (status = 'active'
    AND trashed_at IS NULL AND purge_after IS NULL AND trashed_with IS NULL) OR
  (status = 'trashed'
    AND trashed_at IS NOT NULL AND purge_after IS NOT NULL)
),
CHECK (trashed_with IS NULL OR trashed_with = topic_id)
```

**`topic_id` に FK を張らない理由（設計判断）**: 個別削除済みドキュメントが残ったままトピックがハードデリートされるケースが正当に存在する（ADR-001。ゴミ箱内ドキュメントの `topic_id` は消滅済みトピックを指したままになり、復元時に `moveToTopic` で差し替える）。`ON DELETE CASCADE` はユーザーが明示していない不可逆削除（ADR-001 で不採用）を、`RESTRICT` は正当なトピックハードデリートの阻害を招く。NOT NULL のため `SET NULL` も不可。したがって「active なドキュメントの `topic_id` は実在する Live トピックを指す」の保証はユースケース（作成時の検証 + トピック touch による OCC 直列化、restore 時の呼び出し側保証）に置く。

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `docs_topic_active_idx` | (`topic_id`) WHERE `status = 'active'` | `listActiveByTopic` / `listActiveByTopics`（トピック詳細・一覧・セット削除対象の確定） |
| `docs_topic_trashed_idx` | (`topic_id`) WHERE `status = 'trashed'` | `listTrashedByTopic`（セット復元・トピックハードデリート対象）。`trashed_with = ?` の絞り込みはこの範囲内で評価 |
| `docs_trash_idx` | (`trashed_at` DESC) WHERE `status = 'trashed'` | `listTrashedByUser`、ゴミ箱 UNION 枝 |
| `docs_purge_idx` | (`purge_after`) WHERE `status = 'trashed'` | `purge-trash` ジョブ（`memos_purge_idx` と同じ規則） |
| `docs_updated_idx` | (`updated_at` DESC) WHERE `status = 'active'` | エクスポートの全件読み・一覧系の安定順序（必要十分でなければ実装時に削ってよい） |

- `TrashedTopicItem.setDocumentIds` の射影は `docs_topic_trashed_idx` を使い `WHERE topic_id = ? AND trashed_with = topic_id` で得る

### document_revisions

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

- Actor の CHECK と `userId` の扱いは memo_revisions と同じ（DO の同一性から補う）
- ON DELETE CASCADE はドキュメントハードデリート時の全リビジョン消去に対応。一次的には `DocumentRepository.delete` のアダプターが同一トランザクションでリビジョン削除文を明示発行する（契約どおり）

### source_links

knowledge の `SourceLink`。ドキュメント → 出典メモの純粋な関連。同一性は `(document_id, memo_id)` の複合。サロゲートキーは不要（ドメイン定義でアダプター裁量とされているが、複合 PK で十分）。

| カラム | 型 | 制約 |
|---|---|---|
| `document_id` | TEXT | NOT NULL, FK → `documents.id` ON DELETE CASCADE |
| `memo_id` | TEXT | NOT NULL, FK → `memos.id` ON DELETE CASCADE |
| `created_at` | INTEGER | NOT NULL。紐付け日時（= ドキュメント作成日時） |

- PK: (`document_id`, `memo_id`)。`Document.create` の重複除去に加え、DB でも同一組の重複を排除
- **JOIN によるユーザースコープは不要になった。** DO の中には1人分の行しか存在しないので、読み取りも消去系（`deleteSourceLinksByMemo` 等）も `document_id` / `memo_id` だけで引く。「消去系は documents 側 JOIN に限定する」という旧規則は前提ごと撤回する

**ハードデリート時のカスケード消去（ADR-003）の方針**: **一次的な消去はアプリケーション層が行い、FK の ON DELETE CASCADE は defense-in-depth とする。**

- メモのハードデリート: trash ドメインのユースケースが同一トランザクション内で (1) `listSourceLinksByMemo` で影響ドキュメント ID を確定 → (2) `MemoRepository.hardDelete` → (3) `DocumentRepository.deleteSourceLinksByMemo(memoId)` → (4) 影響先ドキュメントの projection 更新、をオーケストレーションする。**projection の作り直しのために消去前の影響先確定が必須**であり、FK カスケード任せにはできない（カスケードは影響先を教えてくれない）
- ドキュメントのハードデリート: `DocumentRepository.delete` のアダプターが同一トランザクションで `document_id` 側のリンク削除文を発行する（リビジョンと同様）
- FK カスケードを併置する理由: PRAGMA が有効な場合、万一アプリ層の消去が漏れても孤児リンクが残らない。カスケードが先に効いた場合もアプリ層の DELETE は 0 行更新の no-op（冪等）で問題ない

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| （PK） | (`document_id`, `memo_id`) | `listSourceLinksByDocument` / `listSourceLinksByDocuments`（document → memos 方向。前方一致） |
| `source_links_memo_idx` | (`memo_id`) | `listSourceLinksByMemo` / `listSourceLinksByMemos`（memo → documents の逆引き。タイムライン 1 ページ分の一括逆引き・ADR-003 の消去・projection 更新時の影響先確定）、`deleteSourceLinksByMemo` |

### search_entries

検索 projection の本体。domains/search.md の `IndexEntry` 1件に対応する1行であり、**本体を書くトランザクションの中で作り直される**。集約ではないので OCC の `version` を持たない。

**この表の物理形（主キーの取り方・列の型・索引）を決めるのは本ファイルであり、domains/search.md ではない。** あちらは「索引の構成・トークナイズ・順位付け・スニペットの組み立ては `SearchIndexPort` の実装に隠蔽する」と宣言しているので、DDL レベルの指示を両側に置くと片方だけが直って静かに食い違う。

| カラム | 型 | 制約 |
|---|---|---|
| `rowid` | INTEGER | **PRIMARY KEY**。真の rowid alias なので VACUUM でも再採番されない。`search_fts` の `content_rowid` がこの値を参照する |
| `id` | TEXT | NOT NULL。対象の ID（`MemoId` / `DocumentId`）。projection の作り直しはこのキーで引く。**一意性は列制約ではなく下の `search_entries_id_uq` で取る**（列に `UNIQUE` を書くと名前のない暗黙索引が同じ列にもう1本できる） |
| `type` | TEXT | NOT NULL, CHECK (`type IN ('memo','document')`) |
| `topic_id` | TEXT | nullable。`type = 'document'` のときのみ非 NULL（所属トピック） |
| `title` | TEXT | NOT NULL。ドキュメントのタイトル。メモは空文字（タイトルを持たない）。**NFKC 正規化 + trim 済みの値**を入れる |
| `body` | TEXT | NOT NULL。本文。**NFKC 正規化 + trim 済みの値**を入れる |
| `timestamp` | INTEGER | NOT NULL。メモは `posted_at`、ドキュメントは `updated_at`。安定順位の第1キー |
| `source_ids` | TEXT | NOT NULL。出典リンクの相手側 ID の集合（JSON 配列）。**active な相手のみを入れる**（ゴミ箱内・ハードデリート済みの ID を露出させない。domains/search.md） |

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `search_entries_id_uq` | UNIQUE (`id`) | projection の作り直し（旧値 delete → 新値 insert）と、`id` を指定する引き当て。**全文検索の一致行から本体行を引く経路ではない**（そちらは `rowid`。後述） |
| `search_entries_topic_idx` | (`topic_id`) WHERE `topic_id IS NOT NULL` | トピック絞り込み |
| `search_entries_order_idx` | (`timestamp` DESC, `type`, `id`) | 安定順位の tie-breaker と短語フォールバックのページング |

- **PK を `rowid INTEGER PRIMARY KEY` にする理由。** `search_fts` の削除コマンドに渡す**安定した INTEGER rowid** が要り、`INTEGER PRIMARY KEY` は真の rowid alias なので VACUUM でも再採番されない。**別の INTEGER 列を surrogate にする形を採る場合は、その列に UNIQUE 制約と索引を必須にする** — FTS5 は列値が必要になるたびに content テーブルを `WHERE <content_rowid> = ?` で引くので、索引が無いと列値取得のたびに全走査になる
- **`rowid` は DO の外の DTO に出さない。** 安定性が意味を持つのは同一 DO の中だけであり、外へ出す識別子は `id`（`MemoId` / `DocumentId`）である
- **原文は持たない。** スニペットは正規化前の原文から組み立てるので、原文は本体テーブル（`memos.body` / `documents.title` / `documents.body`）から引く
- トピック名は複製せず、問い合わせ時に `topics` との join で解決する（トピックのリネームが検索結果へ即座に反映されるのはこのため）
- ソフトデリート済み・ハードデリート済みの対象の行は**存在しない**（同一トランザクションで除去する）

### search_fts

FTS5 の仮想テーブル。**external-content 構成**にして本文の二重保持を避ける。

```sql
CREATE VIRTUAL TABLE search_fts USING fts5(
  title,
  body,
  content='search_entries',
  content_rowid='rowid',
  tokenize='trigram'
);
```

- 索引対象は `title` / `body` の2列だけである。`type` / `topic_id` / `timestamp` / `source_ids` は `search_entries` 側で絞り込み・順位付けに使うので FTS 側に持たない
- **external-content は作成時に content テーブルから自動で populate されない。** 既存行を索引に載せるのは migration の `reindex` ジョブである（後述）
- **更新・削除は「旧値で delete → 新値で insert」の2段で行う。** external-content の FTS5 は本体行の内容を自分で保持しないので、本体を書き換える前に旧内容を索引から引き算する必要がある。旧値の読み出しは同じトランザクションの中で行う。**踏み外すと例外が上がらず索引だけが黙って壊れる**
- **引き算は `DELETE` 文ではなく特殊コマンド構文で書く。** 形は次のとおりで、旧値をそのまま渡す。

  ```sql
  INSERT INTO search_fts(search_fts, rowid, title, body)
    VALUES('delete', <旧 rowid>, <旧 title>, <旧 body>);
  ```

  **`DELETE FROM search_fts WHERE rowid = ?` と書くと索引が黙って壊れる** — external-content では旧値を渡さない削除が索引側の項目を取り消せないためである。新値の投入は通常の `INSERT INTO search_fts(rowid, title, body) VALUES (?, ?, ?)` でよい
- **整合は SQL トリガーではなく projection コードが担う。** 本体を書くリポジトリと同じトランザクションの中で projection 関数が明示的に delete → insert を発行する
- 書き込みコストは増幅する。仮想テーブルへの書き込みも書き込み行数に算入され、trigram は索引行数が最も多い部類である。**容量の見積りは本体の数倍**を前提にする（external-content で消えるのは本文の二重保持であって索引セグメントではない）

### jobs

Alarm ジョブの多重化テーブル。1 DO につき Alarm は1本しか持てないので、複数種類のジョブを1つの表に載せ、Alarm は「最も早い `next_run_at`」に張り直す。**Identity Directory DO も同じ12列を持つ**（後述）。

| カラム | 型 | 制約 |
|---|---|---|
| `operation_key` | TEXT | PK。ジョブの同一性。同じキーの再投入は既存行に収束する |
| `kind` | TEXT | NOT NULL。実行する処理の種別（下表） |
| `payload` | TEXT | NOT NULL。実行に必要な値（対象 ID など）。**PII および再利用可能な秘密を入れない**（生のリセットトークンが典型で、載せると DB 漏えい時に使えてしまい、PITR の保持期間ぶん残る） |
| `payload_digest` | TEXT | NOT NULL。**射程は実行可能集合（`status IN ('pending','running')`）の行だけである** — その範囲で同じ `operation_key` に違う payload が来たら `ConflictError`。**照合対象は `next_run_at` を除いた payload である**（含めると前倒しの再投入が競合になる）。`done` / `poison` の行への再投入は下の収束規則 (2)(3) が定め、**digest の不一致では弾かない**（(2)(3) はどちらもこの列を引数の値で置き換えるか、何も書かずに成功を返す） |
| `attempt` | INTEGER | NOT NULL。リトライ回数 |
| `next_run_at` | INTEGER | nullable。次に実行してよい時刻。`done` / `poison` では `NULL` |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('pending','running','done','poison')`) |
| `lease_until` | INTEGER | nullable。claim の有効期限 |
| `owner_token` | TEXT | nullable。claim した実行主体の識別子。完了は CAS でこれを照合する |
| `provider_idempotency_key` | TEXT | nullable。外部 I/O のプロバイダへ渡す冪等キー。`operation_key` から決定的に導く |
| `terminal_reason` | TEXT | nullable。終端の理由 |
| `completed_at` | INTEGER | nullable。**`done` / `poison` へ落ちた時刻**。`pending` / `running` では `NULL`。`next_run_at` では代用できない（あちらはバックオフで未来へ先送りされる列である） |

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `jobs_runnable_idx` | (`status`, `next_run_at`) WHERE `status IN ('pending','running')` | claim（実行可能集合の最早行）と Alarm の張り直し |
| `jobs_lease_idx` | (`lease_until`) WHERE `status = 'running'` | DO がリセットされたジョブの回収 |
| `jobs_completed_idx` | (`status`, `completed_at`) | `done` / `poison` の prune（保持期間を過ぎた行を有界に削除する） |

- **usecase からの書き込み口は `enqueueJob`（UoW コンテキストの副作用登録メソッド）だけである。** 投入点の全数は下の `kind` 全数表が持つ。claim・完了・backoff・prune はジョブランナー（アダプター）が同じ行に対して行うので、口を通らない
- **再投入（`enqueueJob`）の収束規則は3つで、これが全数である。** `operation_key` の欄が言う「同じキーの再投入は既存行に収束する」だけでは、`kind` によって逆向きの更新が要求されるためである。**`status` 別の (2)(3) は (1) と `payload_digest` 列の規則の両方に優先する** — `done` / `poison` の行は `next_run_at` が `NULL` なので「早める方向」という判定そのものが定義されず、payload の差も終端済みの行では競合ではなく次の一回分の入力だからである
  - **(1) 再投入は `next_run_at` を早める方向にのみ更新し、遅らせない。** 射程は実行可能集合（`status IN ('pending','running')`）の行で、既存値より早ければ更新し、同じか遅ければ何も書かずに成功を返す。**`status = 'running'` の行の `next_run_at` は書き換えない**（claim 済みの実行を横から動かさない）。保持期限の延長で次の期限が後ろへ動く場合はこの規則では何も書かれないが、ジョブが既存の早い時刻に1回空振りし、その完了トランザクションの中の再武装が新しい時刻を書くので正しい時刻に収束する
  - **(2) `status = 'poison'` の行への再投入は、`kind` によらず同じ行を `pending` へ戻し、`attempt` を 0 にして `next_run_at` / `payload` / `payload_digest` を引数の値で置き換える。別行は作らない**（`operation_key` はそのジョブの同一性なので、行を増やすと同一性の意味が壊れる）。`terminal_reason` は上書きせずに残す
  - **(3) `status = 'done'` の行を `pending` へ戻すのは、再武装する5種（`purge-trash` / `sweep-reservations` / `sweep-reset-tokens` / `sweep-orphan-mapping` / `rotate-encryption`）に限る。残る7種は `done` の行を復活させず、何も書かずに成功を返す。** 5種を復帰させるのは、定数 `operation_key` を持つこれらが1回完走した時点で prune の保持期間ぶん再投入を受け付けなくなるからである（平常時はどれも必ず `done` へ落ちるので、投入点からの復帰が唯一の再起動手段になる）。残る7種の `done` は「その `operation_key` が表す一回分の仕事が完了した」という意味なので、**同じキーの再投入は新しい仕事ではなく重複依頼である** — 復活させると `send-mail` の同窓連打で起床回数と書き込み行数が依頼回数に比例して増える。**`payload_digest` の一致では5種と7種を分けられない**（5種は投入点が毎回同じ payload を渡すので digest も一致する）
  - **3つの射程は外部からの再投入だけである。** ジョブ自身が完了時に行う再スケジュール（後述の再武装）には (1) を適用しない — 適用すると次の期限が現在の `next_run_at` より後のときに何も書けず、`done` に落ちて二度と起きなくなる
- **claim と完了は CAS で行う。** `UPDATE jobs SET status='running', lease_until=?, owner_token=? WHERE operation_key=? AND (status='pending' OR (status='running' AND lease_until < ?))` の 0 行更新を「他が持っている」とみなす。**第2の選言に `status='running'` を必ず含める**（落とすと `done` / `poison` の行が過去の `lease_until` を保持したまま再 claim の対象になる）。完了も `WHERE operation_key=? AND owner_token=?` の CAS
- **backoff と終端。** 失敗時は `attempt` を進めて指数バックオフで `next_run_at` を先送りする。上限を超えたら `status='poison'` にして `terminal_reason` を残し、ホットパスの索引から外す。**`done` / `poison` のどちらへ落とすときも、同じトランザクションで `completed_at` に現在時刻を書き、`lease_until` / `owner_token` / `next_run_at` を `NULL` にする**
- **終端は一様である。** 前進不能が確定したジョブは `terminal_reason` を残して `poison` にし、operator 経路へエスカレーションする（後述）。**「黙って中間状態を残す」は選ばない。** 材料の寿命のうち **#37 が落としてはならない前方互換点3本は本ファイルが各テーブルの節で持つ** — `account.caller_token`（消すのは退会の完走時だけ）/ `operations.target_locators`（終端の後始末が終わるまで消さない）/ `credential_mappings` のコーディネーター予約行（同）。**それ以外の巻き戻し（自動回収）の具体 — 段の順序・原子性境界・終端モードの印・後始末の再試行上限 — は #45 が決める**ので、本ファイルには書かない
- **1回の起動で触る量は件数だけで有界にする。** 経過時間では測らない（`Date.now()` はコード実行中に進まない）。ジョブ件数・チャンク反復回数・1チャンクの行数の3階層の上限を置き、値は #37 が spike で出して #38 が運用値として確定する
  - **#37 が置いた初期値**（`packages/core/src/lib/jobBudgets.ts`。2026-08-03 の spike 実測が根拠）: ジョブ件数 **25 / 起床**、チャンク反復 **20 / claim**、1チャンク **1,000行**。実測では 10万行を1トランザクションで INSERT して 223ms、自己消尽チャンクでの全件再計算が 101チャンク / 346ms（≒3.4ms/チャンク）だったので、20チャンク = 2万行 ≒ 70ms であり Alarm 1回の予算に対して十分保守的である。あわせて lease **60秒**、最大試行 **8回**、`done` の保持 **24時間** / `poison` の保持 **30日**、prune の1回あたり削除上限 **1,000行**、fail-closed の再武装間隔 **60秒**。**運用値としての確定は #38**
- **チャンク反復回数の上限に達したら、その時点の進捗をコミットするのと同じトランザクションで `status` を `pending` へ戻し、`lease_until` / `owner_token` を解放して次の起床へ回す**（解放した行は同じ起動の中では再 claim しない。しないと上限を置いた意味が消える）。**したがって「残件が空になるまで回す」と書かれたフェーズもこの上限の内側にある** — 空になるまでというのは**フェーズの順序の規定であって、1回の起床で終わることの規定ではない**。該当するのは `purge-trash` の再計算フェーズで、**削除フェーズへ進むのは再計算の残件が空になった起床でだけである**（有限回の起床で空になる根拠は `user_settings` の項の自己消尽する作業述語が持つ）
- **prune 専用の `kind` は置かない。** ジョブランナーが1回の起動の末尾で、保持期間を過ぎた `done` / `poison` を上限件数だけ削除する（`jobs_completed_idx` から引く）

#### `kind` の全数

**本表が `spec/` 側の `kind` の全数である。12種で、所有 DO クラスごとに6種ずつである。** **「投入点」欄を落とさない** — 投入点を同じ表に持たせることで、**投入されるが二度と起きないジョブ**を欄の空白として検出できるようにするためである（投入点の無い再武装ジョブは1回完走した時点で恒久的に停止する）。**ユースケースから投入する 8 種は、いずれもそのジョブが待つ状態を書くのと同じトランザクション**の中で `enqueueJob` する。残る4種は経路が違う — `reindex` / `migrate-bulk` はユースケースからは投入せず（スキーマ移行の適用側が投入する）、`rotate-encryption` は operator 経路の起動による。`finalize-withdrawal` は退会のユースケースが本 spec に存在しない（`spec/inventory/domain.md` の `AccountStore` の項）ため、投入点は **#12 / #45** が決める（当初は #37 に割り当てていたが、#37 は退会をスコープ外とし、`finalize-withdrawal` / `resume-link` / `resume-credential-change` / `sweep-orphan-mapping` / `rotate-encryption` の5種はハンドラも投入点も実装していない。型と本表の全数には残る）。

| `kind` | 所有 DO クラス | 投入点 | 類型 | 用途 |
|---|---|---|---|---|
| `purge-trash` | User Data | ソフトデリートの4ユースケース（`softDeleteMemo` / AI の `delete` / `trashDocument` / `trashTopic`）と `changeTrashRetentionDays`。`purge_after` を書くのと同じトランザクションで `TrashQueryPort.findEarliestPurgeAfter()` を読んで張る（domains/trash.md「保持期限」） | 期限処理 | 保持期限の到達処理（`purge_after` の再計算フェーズが先、削除フェーズが後。**再計算フェーズの自己消尽する作業述語は `user_settings` の項が持つ**） |
| `reindex` | User Data | migration ゲート（トークナイザ・正規化規則の変更を含む `schema_version` の前進時）。アダプター側で、usecase からは投入しない | チェックポイント分割を要する一括処理 | FTS5 の全件再構築（トークナイザ・正規化規則の変更時） |
| `migrate-bulk` | User Data | migration ゲート（データ書き換えを伴う段を切り出すとき）。アダプター側で、usecase からは投入しない | チェックポイント分割を要する一括処理 | データ書き換えを伴う migration |
| `finalize-withdrawal` | User Data | **2つあり、これが全数である** — (1) 退会の開始（`account.status` を `deleting` にするのと同じトランザクション）、(2) 新規登録 saga の終端規則によるアカウントの放棄（**その手順は #45 が定める**が、投入点が2つであること自体は本表が持つ） | cross-DO saga の前進 | 退会の後続手順の前進 |
| `sweep-orphan-mapping` | User Data | `unlinkSsoCredential` の逆引き削除（`credential_locators` の行を消すのと同じトランザクション）。**これが唯一の投入点である** — 落とすと写像の削除が落ちたときに `active` な孤児 mapping が恒久的に残る | cross-DO saga の前進 | SSO 連携解除後に残った孤児 mapping の削除再試行 |
| `resume-link` | User Data | SSO 連携 saga の開始（`operations` 行を記録するのと同じトランザクション） | cross-DO saga の前進 | SSO 連携 saga の前進 |
| `send-mail` | Identity Directory | `requestPasswordReset` を受けたトランザクション。**写像の有無・スロットルの有無にかかわらず必ず1行書く**（書くかどうかが列挙オラクルになるため） | 外部 I/O を伴う処理 | メール送信（**12種で唯一、外部 I/O を伴う**） |
| `resume-signup` | Identity Directory | 新規登録 saga の予約行を書くのと同じトランザクション。**コーディネーター bucket だけが自分に投入する**（非コーディネーター bucket には投入しない） | cross-DO saga の前進 | 新規登録 saga の前進 |
| `resume-credential-change` | Identity Directory | クレデンシャル変更 saga の開始（`change_state` を `pending` にするのと同じトランザクション） | cross-DO saga の前進 | クレデンシャル変更 saga の前進 |
| `sweep-reservations` | Identity Directory | 予約行を書く3箇所（新規登録 saga の予約2つと SSO 連携の予約）。**予約を書いた bucket が自分に投入する** | 期限処理 | 予約の期限切れ掃除 |
| `sweep-reset-tokens` | Identity Directory | リセットトークン行を発行するのと同じトランザクション | 期限処理 | リセットトークンの期限切れ行の掃除 |
| `rotate-encryption` | Identity Directory | operator 専用 maintenance 経路からの起動（後述）。**本 spec で確定している投入点はこれだけである** — 移送側からの再投入を足すかは #44 が決める | チェックポイント分割を要する一括処理 | メール暗号鍵ローテーションの再暗号化 |

- **類型は4つで、12種を漏れなく1回ずつ覆う**（CLAUDE.md「Key concepts」の非同期実行契約と同じ4類型である）。`kind` を足したら両方の表を同時に直し、**本表の投入点欄も同時に埋める**
- **完了時に自分を再武装する5種は `purge-trash` / `sweep-reservations` / `sweep-reset-tokens` / `sweep-orphan-mapping` / `rotate-encryption` であり、これが全数である**（類型欄からは導けない — 前3種は期限処理、`sweep-orphan-mapping` は cross-DO saga の前進、`rotate-encryption` は一括処理である）。完了トランザクションの中で自分の駆動源（`min(purge_after)` などの時刻、または残件の有無）を読み直し、残件があれば `pending` へ戻す。**残件が無いときだけ `done` にする**。この再武装が無いと、1回完走した時点で dormant な DO が二度と起きない。**残る7種は完走したら `done` で終わりであり、次の起動は投入点からの再投入だけが張る**（上の収束規則 (3)）
- 実行可能集合（`status IN ('pending','running')`）が空になったら `deleteAlarm()` する。**例外は fail-closed で止まっている DO だけである**（後述）
- **`rotate-remap`（写像鍵ローテーションの再写像）は Alarm ジョブではない**ので本表に現れない。写像鍵を Alarm 起動時に手元へ持てないためである。実行主体そのものは #44 が決める

### operations

saga と DO 間 RPC の冪等性を担う表。再送は `payload_digest` の照合で弾く。

| カラム | 型 | 制約 |
|---|---|---|
| `operation_id` | TEXT | PK。**採番はサーバー側だけで行う**（クライアントに冪等キーを持たせない） |
| `kind` | TEXT | NOT NULL。操作の種別（新規登録 / 連携 / 連携解除 / クレデンシャル変更 / 退会） |
| `payload_digest` | TEXT | NOT NULL。同じ `operation_id` に違う payload が来たら `ConflictError` |
| `phase` | TEXT | NOT NULL。saga の進行段階 |
| `target_locators` | TEXT | nullable。対象クレデンシャルの locator を退避する（JSON 配列。要素は `credential_id` + `kind` + 全長 HMAC + 世代 + bucket index）。**単一値ではなく配列である** — ローテーション中は同じクレデンシャルが2世代の bucket に行を持ちうる |
| `terminal_reason` | TEXT | nullable。終端の理由 |
| `created_at` | INTEGER | NOT NULL |

- OCC の `version` は持たない（集約ではなくアダプター内部のストア）
- **書き込み口は UoW コンテキストの `recordOperation` / `updateOperation` の2つで、これが全数である。** `recordOperation` は saga の開始時に行を作り、`updateOperation` は phase の前進と終端を書く
- **`target_locators` は終端の後始末が終わるまで消さない**（消すと回収の材料が失われる）

### migration_progress

migration の部分適用カーソル。**任意の最適化ではなく必須である**（CPU 予算超過の帰結はエラーではなくリセットなので、一括処理は「途中まで進んで黙って落ちる」）。

| カラム | 型 | 制約 |
|---|---|---|
| `target_version` | INTEGER | NOT NULL |
| `step` | TEXT | NOT NULL |
| `cursor` | TEXT | NOT NULL。次に再開する位置 |
| `updated_at` | INTEGER | NOT NULL |

- **PK: (`target_version`, `step`)。** `migrate-bulk` と `reindex` の2種が共有するので、同じ `target_version` から両方が投入されても行が衝突しない
- **永続カーソルを持つのはこの2種だけである。** `purge-trash` / `finalize-withdrawal` は作業述語そのものが進捗を表す（削除で行が消える、または更新した行がその場で述語から外れる。後者の述語は `user_settings` の項が持つ）ので持たない
- **書き込み口は UoW コンテキストの `setMigrationCursor` だけである**（`migrate-bulk` と `reindex` のカーソル前進）
- OCC の `version` は持たない

### _meta

DO ごとのメタ情報。単一行。

| カラム | 型 | 制約 |
|---|---|---|
| `schema_version` | INTEGER | NOT NULL。この DO に適用済みのスキーマバージョン |
| `self_locator` | TEXT | NOT NULL。自 locator。User Data DO ではその DO の `userId` が入る（DO 名が使えない経路のフォールバック、エクスポートのヘッダ、移送と検証の3用途に限る）。**行データの絞り込みには使わない** |

- **usecase からは書けない。書き込み口を持たない唯一の非集約ストアである。** 書くのは初期化時の自 locator 書き込みと migration ゲートの `schema_version` 更新だけであり、どちらもゲート／constructor であって usecase ではない（口を置くと `schema_version` を書ける経路ができ、fail-closed の権威が二重になる）
- OCC の `version` は持たない

## Identity Directory DO のテーブル

### credential_mappings

クレデンシャル（メール / SSO 主体）から `userId` への写像。**メール一意性・SSO 主体一意性の権威**であり、パスワードの検証材料の置き場でもある。1つの bucket に載る行は常に同一世代である（DO 名が世代を含むため）。

**識別:**

| カラム | 型 | 制約 |
|---|---|---|
| `credential_id` | TEXT | NOT NULL。世代に依存しないクレデンシャルの同一性 |
| `kind` | TEXT | NOT NULL, CHECK (`kind IN ('email','sso')`) |
| `hmac` | TEXT | NOT NULL。canonical 値の HMAC（全長 64 hex） |
| `generation` | INTEGER | NOT NULL。写像鍵の世代（DO 名と冗長だが持つ） |

**写像:**

| カラム | 型 | 制約 |
|---|---|---|
| `user_id` | TEXT | nullable。写像先。**分離のための述語ではなく写像そのものである** |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('reserved','active')`) |

**認証材料:**

| カラム | 型 | 制約 |
|---|---|---|
| `password_verifier` | TEXT | nullable。**書き込み点は2つだけである** — 新規登録の予約行と、クレデンシャル変更 saga での `pending_verifier` からの昇格。**SSO の新規登録がメール一意性のために置く行には載せない**（その行の `usable_for_login` は偽になる） |
| `pending_verifier` | TEXT | nullable。変更中の新しい検証材料 |
| `change_state` | TEXT | nullable, CHECK (`change_state IS NULL OR change_state IN ('pending','advanced')`)。**値域は3値である。** `advanced` は変更の適用が locator 側へ届いたことを記録する値。**`NULL` でない値はどちらもログイン照合をダミー材料へ倒す**（中間状態のあいだは旧新どちらのパスワードも通らない） |
| `change_origin` | TEXT | nullable, CHECK (`change_origin IS NULL OR change_origin IN ('password-change','reset')`)。変更の起点。ジョブから再開するときに行だけを入力に復元できるようにするための列である |
| `credential_version` | INTEGER | NOT NULL。ログイン時に User Data DO 側の値と照合する |

**PII:**

| カラム | 型 | 制約 |
|---|---|---|
| `encrypted_canonical` | TEXT | nullable。メールアドレス原本の暗号文 |
| `encryption_generation` | INTEGER | nullable。暗号鍵の世代。**写像鍵の世代とは独立した番号体系である** |
| `encryption_nonce` | TEXT | nullable。AES-256-GCM の96ビット nonce。**独立列に持ち、暗号文に連結しない。** 行ごと・書き込みごとに再生成し、使い回さない |

**3列が nullable なのは列制約としてであって、書き手の裁量ではない。** #37 の実装では予約経路（`reserve-credential`）の引数 `sealedCanonical` が**必須**であり（`packages/core/src/domain/identity/ports/credentialMappingStore.ts` の `ReserveCredentialArgs`）、鍵が未設定の環境では予約そのものが `SystemError(CryptoError)` で失敗する — 原本を復元できない予約行を書くくらいなら登録を断る、という fail-closed である。したがって**メールの予約行は3列とも常に埋まる**。nullable を保つのは (i) SSO の mapping 行が原本を持たない、(ii) 再暗号化（#44）の途中で世代が混在する、の2点のためである。

**濫用抑止:**

| カラム | 型 | 制約 |
|---|---|---|
| `failed_attempts` | INTEGER | NOT NULL。既定 0 |
| `next_attempt_allowed_at` | INTEGER | nullable。ロックアウトの解除時刻 |
| `last_reset_requested_at` | INTEGER | nullable。リセット依頼のスロットル判定 |

**saga コーディネーター状態:**

| カラム | 型 | 制約 |
|---|---|---|
| `operation_id` | TEXT | nullable。予約を取った操作 |
| `candidate_user_id` | TEXT | nullable。確定前の `userId` 候補 |
| `reserved_until` | INTEGER | **NOT NULL**。予約 TTL の絶対時刻。予約行を書く3箇所すべてが値を書く。**NULL を許すと「残件はあるが `min(...)` が NULL」という状態が作れてしまう** |
| `saga_committed` | INTEGER | nullable（boolean）。印のある予約行は期限切れ掃除の対象から外れる |
| `locators` | TEXT | nullable。コーディネーター行が持つ全クレデンシャルの locator 一覧（JSON 配列） |
| `coordinator_locator` | TEXT | nullable。非コーディネーター行が持つ、コーディネーター行への参照 |

**呼び出し元束縛:**

| カラム | 型 | 制約 |
|---|---|---|
| `caller_token` | TEXT | nullable。この写像の所有アカウントが提示すべき不透明値。User Data DO 側の `account.caller_token` と同じ値。ログ・エラーに出さない |

**共通:**

| カラム | 型 | 制約 |
|---|---|---|
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| （PK） | (`kind`, `hmac`) | メール / SSO 主体の一意性。制約違反を `ConflictError("EMAIL_ALREADY_REGISTERED")` / `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")` にマップ |
| `cm_credential_id_uq` | UNIQUE (`credential_id`) | `credential_id` を指定する消費・削除経路（bucket 内の行は常に同一世代なので `(credential_id, generation)` と等価） |
| `cm_user_idx` | (`user_id`) | 退会の一括削除と、bucket 内の `userId` 列挙（運用の診断経路） |
| `cm_reservation_idx` | (`status`, `reserved_until`) WHERE `saga_committed IS NULL` | `sweep-reservations` の作業述語と駆動源 |

- **PK は (`kind`, `hmac`) の複合キーである**（上表の `（PK）` 行。**複合 PK の暗黙索引には名前を付けられない**ので、`CREATE INDEX` を書くのは名前欄が埋まっている行だけである）。**サロゲートの `id` 列は置かない** — 同一性は `(kind, hmac)` が持ち、`credential_id` にも bucket 内 UNIQUE を張るので、別の主キーを足すと同一性の権威が三重になる
- **終端の後始末が終わるまで予約行を消さない。** `locators` / `candidate_user_id` / `caller_token` を持つコーディネーター予約行は、**中断した saga を回収するための唯一の材料**であり、期限切れ掃除（`sweep-reservations`）がこれを先に消すと材料が失われる。掃除と終端の関係の具体（どの段でどの行を消すか）は #45 が決めるので本ファイルには書かない
- **OCC の `version` を持たない。** 書き込みはすべて `operation_id` / `change_state` / `status` / `saga_committed` を条件に含む CAS で直列化されており、同じ行に対する「読んで判断して書く」がリクエストを跨がない。汎用の OCC を重ねると CAS 条件と `version` のどちらが権威かが二重になる。**したがって `CredentialMappingRepository` は `ExpectedVersion` を取らない**（domains/identity.md）
- 検証材料の照合そのものはこの表を読むアダプターでは行わない。計算は `PasswordHasher` が担い、実行位置はトランザクションの外である

### password_reset_tokens

`PasswordResetTokenPort`（issue / verifyAndConsume）のアダプター実装が使う。**生トークンは保存せず、`token_id` から導出したハッシュを保存する**（DB 漏えい時にトークンが使えないようにする）。

| カラム | 型 | 制約 |
|---|---|---|
| `token_id` | TEXT | PK。**暗号論的乱数由来の128ビット以上の不透明値**。bucket 内で採番する。**連番・rowid・時刻由来の値を使わない** |
| `token_hash` | TEXT | NOT NULL, UNIQUE。照合キー |
| `credential_id` | TEXT | NOT NULL。対象クレデンシャル。**キーを `(kind, hmac)` にしない** — `hmac` は世代依存なので、ローテーション中に発行されたトークンが世代の違う削除要求から漏れる |
| `expires_at` | INTEGER | NOT NULL。発行時に `now + TTL` で確定（TTL はアダプター設定。時間オーダー） |
| `used_at` | INTEGER | nullable。消費済みなら非 NULL（使い捨ての事実） |
| `change_auth_token` | TEXT | nullable。消費時に採番する**128ビットの暗号論的乱数**。クレデンシャル変更をリセット経由で始めるときの必須ガードであり、束縛の実体はこの列だけである。**成功時に同じトランザクションで `NULL` へ戻す**（`値 → NULL` の CAS なので一回性）。**列が `NULL` の行は照合で常に不一致とする** |
| `consumed_by_operation_id` | TEXT | nullable。消費した操作の記録。**監査用であって束縛材料ではない** |
| `token_key_generation` | INTEGER | NOT NULL。リセットトークン鍵の世代。**写像鍵の世代とは別の番号体系である** |
| `created_at` | INTEGER | NOT NULL |

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `prt_token_hash_uq` | UNIQUE (`token_hash`) | 照合 |
| `prt_credential_idx` | (`credential_id`) | クレデンシャル単位の一括無効化・削除 |
| `prt_expires_idx` | (`expires_at`) | `sweep-reset-tokens` の期限切れ行の掃除 |

- `verifyAndConsume` は `token_hash` 一致・`used_at IS NULL`・`expires_at > now` を満たす行を条件付き UPDATE（`used_at = now`）で消費し、0 行更新なら null を返す（並行消費のレースも 1 回に収束）
- OCC の `version` は持たない（集約ではなくアダプター内部のストア）
- **書き込み口は UoW コンテキストの `resetTokenStore` だけである**（ドメイン側のポート名は `PasswordResetTokenPort` で、同じものを指す）。発行・消費・一括削除・期限切れ掃除の4つが書き込み箇所であり、これが全数である
- **削除の射程は経路ごとに違う。** クレデンシャル変更の開始時は「未使用行を全削除し、残る全行の `change_auth_token` を `NULL` にする」の2段、SSO 連携解除と退会はその `credential_id` の行を `used_at` の有無を問わず全削除である
- 新しいトークンの発行は、同じトランザクションでその `credential_id` の未使用行を全削除する

### jobs（Identity Directory DO）

User Data DO 側と**同じ12列・同じインデックス・同じ規則**である。job table と Alarm の実装は2クラスで共有する。違うのは `kind` の値域だけで、`send-mail` / `resume-signup` / `resume-credential-change` / `sweep-reservations` / `sweep-reset-tokens` / `rotate-encryption` の6種である（全数表は `jobs` の節を参照）。

### rotation_checkpoints

鍵ローテーションの進捗記録。**2種類のローテーションが同じ表を共有する**ので、種別を列で分けないと記録が互いを潰し合う。

| カラム | 型 | 制約 |
|---|---|---|
| `rotation_kind` | TEXT | NOT NULL, CHECK (`rotation_kind IN ('remap','encryption')`)。`remap` は写像鍵、`encryption` はメール暗号鍵 |
| `bucket_index` | INTEGER | NOT NULL |
| `generation` | INTEGER | NOT NULL。**`rotation_kind` によって意味が違う**（`remap` は退役させる写像鍵の世代、`encryption` は退役させる暗号鍵の世代。2つは独立した番号体系である） |
| `previous_count` | INTEGER | NOT NULL。旧世代の残行数 |
| `scanned_at` | INTEGER | NOT NULL。走査時刻 |
| `conflict_count` | INTEGER | NOT NULL。移送先に別の `user_id` の行があって移送を見送った件数 |
| `last_conflict_at` | INTEGER | nullable |
| `last_conflict_credential_id` | TEXT | nullable |

- **置換キー（PK）は (`rotation_kind`, `bucket_index`, `generation`) である。** 記録は置換で行う
- 衝突の3列（`conflict_count` / `last_conflict_at` / `last_conflict_credential_id`）は `rotation_kind = 'remap'` の行だけが使う。移送は `jobs` 行も `operations` 行も持たないので、`terminal_reason` を記録先にできないためである
- OCC の `version` は持たない
- **書き込み口は UoW コンテキストの `rotationCheckpointStore` だけである。** 書き手は2つで、写像鍵の移送（`remap`）とメール暗号鍵の再暗号化（`rotate-encryption`）である
- **記録の契機と読み方、およびローテーションの手順そのものは #44 が決める。** 本ファイルは列と用途までを定める

### _meta（Identity Directory DO）

User Data DO 側と同じ2列（`schema_version` / `self_locator`）。違うのは `self_locator` に入る値だけで、こちらは `dir:g{世代}:b{番号}` 形式の bucket 名である。単一行・OCC なし・usecase からは書けないところも同じである。

## FTS5 の tokenizer 方針

**日本語は空白でトークン分割できないため `tokenize='trigram'` を採る。** ただし裏付けの種別が項目ごとに違うので明記する。

- **トークナイザ（trigram）— 裏付けは実測。** workerd 上で `tokenize='trigram'` の仮想テーブルが動き、3文字のキーワードで期待どおりヒットすることを確認している。**公式ドキュメントに記載が無く、実測が唯一の根拠である**（workerd のバージョンが上がったら再検証が要る）
- **短語フォールバック — 裏付けは実測。** trigram は3文字未満の語を索引できないので、**1〜2文字のクエリは FTS ではなく `instr()` へフォールバックする**。述語は `instr(title, ?) > 0 OR instr(body, ?) > 0` の形である
  - **`LIKE` / `GLOB` は採らない。** 実測されているのは `instr()` のほうであり、実測されていない機構を結論に据えない。副次的な利点として、`LIKE` / `GLOB` のパターン長上限が `instr()` には掛からない。**したがって「索引の機構から導いた入力長上限」を置かない** — `SearchQuery.keyword` の 500 文字は transport 境界の DoS 対策であって機構由来の値ではない（domains/search.md）
  - **フォールバックは索引を使えない全走査なので、対象列（`title` / `body`）とページサイズを制限する。** 走査量は1人分の `search_entries` に閉じる
- **正規化（NFKC）— 自前の処理なので裏付けは不要。** インデックス側とクエリ側の**両方**で NFKC 正規化 + `trim()` を通す。全角・半角、合成済み文字と結合文字列の差が検索に響かなくなる
- **スニペットは正規化前の原文から組み立てる。** SQL の `snippet()` / `highlight()` には依存しない — workerd で使えるかが未確認であり、索引は正規化後のテキストを持つのに対し利用者に見せるスニペットは原文でなければならないためである。原文は本体テーブルから引き、grapheme 単位でマッチ位置を割り出す
- **順位付けは `bm25` で行い、タイトルを本文より重く見る重み付けを行う。裏付けは実測**（公式ドキュメントに記載は無い）。**重みとページサイズの実値は本ファイルに固定しない** — 実装側が持ち、#37 が実環境で再検証して結果を spec へ反映する
- トークナイザや正規化規則を変えたときの全件再構築は migration の `reindex` ジョブが担う（次節）

### #37 の再確認結果（2026-08-03 実測）

`.adr/003` が「実装着手時に再確認する」と書いた分の書き戻しである。環境は `@cloudflare/vitest-pool-workers@0.16.20` → `miniflare@4.20260625.0` 同梱の workerd。常設テストは `packages/core/src/adapters/cloudflare/search/__tests__/tokenizer.integration.test.ts`。

- **`tokenize='trigram'` は動く。** external-content（`content='search_entries'` / `content_rowid='rowid'`）の仮想表が作れ、3文字のキーワード（`東京駅`）が期待どおりヒットする。shadow テーブルは `search_fts_{config,data,docsize,idx}` の**4件**で、`search_fts_content` は作られない
- **短語の閾値は3文字である。** 2文字（`周辺`）を `MATCH` に渡すと **0 件**になることを実測した。したがって**1〜2文字は `instr()` フォールバックへ回す**（`MIN_FTS_KEYWORD_LENGTH = 3`。`packages/core/src/adapters/cloudflare/search/probe.ts`）
- **`bm25` の重みは `bm25(search_fts, 3.0, 1.0)`**（title 3.0 / body 1.0）。例外なく順位を返す。値は負で、SQLite の慣行どおり**昇順が良い順**なので `ORDER BY bm25(...) ASC` で使う
- **ページサイズは spec では固定しない。** `probe.ts` は `limit` / `offset` を引数に取るだけで既定値を持たない — ページサイズを決めるのは検索ユースケースであり **#10** の範囲である。ページングが `LIMIT 1 OFFSET n` で重複も欠落もなく割れることは実測・常設化した
- **`snippet()` / `highlight()` はどちらも使えた**が、上の「スニペットは正規化前の原文から組み立てる」という結論は変えない（索引が持つのは正規化後のテキストなので、依存しないほうが正しい）

## スキーマバージョンと lazy migration

### `_meta.schema_version` とゲート関数

- **持ち方は `_meta` の単一行の `schema_version`（整数）である。** KV ではなく SQL 側に置くのは、migration の適用とバージョンの更新を**同じトランザクションで確定させる**ためである
- **起動タイミングは、DO の全 RPC エントリおよび `alarm()` の先頭に置いた冪等なゲート関数である。** `alarm()` を RPC と同格に扱うのは、アクセスの無い利用者の User Data DO が次に起きる契機が `purge-trash` の Alarm しか無いからである。ゲートを RPC だけに置くと、古いスキーマのまま新コードのジョブ実行部が走る
- 例外は operator 専用の診断エントリ2本（`read-schema-version` / `list-bucket-user-ids`）だけで、**それが全数である**。どちらも1行も書かず、スキーマの形に依存しない値だけを読むので、未 migrate の DO を壊す経路が無い
- **`blockConcurrencyWhile` は使わない。** 30秒でタイムアウトして DO をリセットするので、10 GB まで育った DO のスキーマ変更が1回のコールバックで終わる保証が無い
- **代わりの排他条件を置く。ゲート関数は同期関数とし、`schema_version` の読み取りから全 DDL ステップの適用まで `await` を1つも挟まない。** これで input gate が排他を保証する。`await` が1つでも入ると並行 RPC が割り込み、順序依存のあるステップ（列追加 → 値の充填 → 索引作成）の途中の観測が壊れる
- `alarm()` の先頭に置くものは2つあるので順序を固定する。**(1) Alarm の再武装 + 永続化の確認 → (2) 本ゲート → (3) 仕事** である。(1) の待機はゲートに入る前に完了するので、上の排他条件は破れない

### 単発適用で足りる DDL と、分割・回避が要る DDL

- **データ量に依存しない（単発適用で足りる）**: `CREATE TABLE`、**制約を伴わない** `ALTER TABLE ADD COLUMN` / `RENAME`
- **データ量に依存する（分割か回避が要る）**: (i) CHECK 制約付きの列追加・NOT NULL の生成列追加・列削除、(ii) **`CREATE INDEX`**（索引構築は全行走査 + ソートである）
- **索引は原則としてテーブル新設時に同時に張る**（空テーブルへの `CREATE INDEX` は安い）。既に大きく育ったテーブルへ索引を足す必要が生じたら、`CREATE INDEX` を直接発行せず「**索引つきの新テーブルを作る → `migrate-bulk` で行をコピーする → 参照を切り替える → 旧テーブルを落とす**」という多段の forward-only migration へ分解する。SQLite では `CREATE INDEX` をチャンク分割できないので、逃がし先がこれしか無い
- **データ書き換えを伴う部分はジョブへ逃がす。** DDL 部分だけを単発のトランザクションで適用して `schema_version` を進め、既存行の書き換え・コピーは `migrate-bulk`、FTS5 の全件再構築は `reindex` に載せる。ジョブの投入自体は同期の1行書き込みなので、ゲートの「`await` を挟まない」条件を破らない
- **FTS5 の `'rebuild'` は使わない。** 1文で全索引を消して全行から作り直す単一 SQL 文であり、中断・再開の単位が存在しない。**`reindex` は projection の全行再実行（1行ずつ「旧値で delete → 新値で insert」）として実装する**
- **`tokenize` オプションそのものを変える場合**は「新しい `tokenize` の仮想表を作る（単発）→ `reindex` が全行を投入する → 検索の参照先を新しい表へ切り替える → 旧仮想表を落とす」の4段へ分解する（既存の FTS5 表の tokenizer を変更する手段は無い）。**正規化規則だけを変える場合はこの分解は要らない** — 正規化は projection 側で行うので仮想表の定義が変わらない

### forward-only と `migration_progress`

- **forward-only にする。下方向の migration は書かない**
- **各ステップは冪等に書き、ステップの適用と `schema_version` の更新を同じトランザクションに入れる。** これで「適用したがバージョンが進んでいない」状態が原理的に作れない。途中で失敗したステップは丸ごとロールバックされ、次のゲート通過時に同じステップから再実行される
- **1回で完了しない migration の部分適用を `migration_progress` に記録する。これは任意の最適化ではなく必須である** — CPU 予算超過の帰結はエラーではなくリセットなので、一括処理は「途中まで進んで黙って落ちる」形になる。「例外が上がるから検出できる」を前提にした設計にしない
- **途中状態でもリクエストは受け付ける。** DDL が完了して `schema_version` が進んでいれば受け付け、データ書き換えが進行中の期間は新旧どちらの形の行も読めるようにコードを書く（両対応の読み取り）。受付を止めると 10 GB 級の DO で長いダウンタイムになる。両対応が書けない変更は「新しい列を足して二重書きし、書き換え完了後に旧列を落とす」多段へ分解する
- ステップは `CREATE TABLE IF NOT EXISTS` のように再実行可能な形で書く。**ただし冪等であることは有界であることを意味しない**（大きく育ったテーブルへの `CREATE INDEX` は再実行可能でも1回の入力で完了しない）

### 「コードより新しい version」への fail-closed

- **`_meta.schema_version` がコード側の期待する最大バージョンより大きい場合、その DO はリクエストを受け付けず `SystemError` を返す。** 新しいスキーマの列を知らないコードが `INSERT` すると不完全な行を作るので、**読めないより壊れるほうが悪い**
- **fail-closed は `alarm()` にも掛ける。** 止まった DO の `alarm()` はジョブを実行せず、一定間隔で Alarm を張り直して戻る。**`poison` にはしない**（原因はデータではなくデプロイ状態であり、正しいコードが戻れば次の起動で回復するべきものである）。**間隔にバックオフは掛けない**
- **fail-closed の DO は Alarm を消さない。** 実行可能なジョブが無くても `deleteAlarm()` しない — 消すと、正しいコードが戻ってきても次の DO 入力があるまで誰も回復を検知せず、アクセスの無い DO では永久に止まる
- 射程から外れるのは診断エントリ2本だけである。fail-closed で止まっている DO の存在は運用側がメトリクスで検知する（#38）

### ロールバック方針

- **データのロールバックは行わない。** スキーマは forward-only で、下方向の migration を書かない
- コードのロールバックは可能だが、そのとき `schema_version` が進んでいれば fail-closed で止まる。**したがってスキーマを進める migration を含むリリースは、ロールバック不可のリリースとして扱う**
- **代替手段は PITR である**（object 単位・過去30日）。ただし**復旧単位は DO 1個であり、複数 DO を同一時点へ戻す手段は無い**
- **PITR は「対象を知っている場合の復旧手段」であって「対象を発見する手段」ではない。** DO の内部 ID から `userId` へは戻せないので、影響範囲は Identity Directory bucket の全走査（`list-bucket-user-ids` で `userId` を集め、`read-schema-version` で1つずつ確かめる）でしか作れない
- **現実的な防御線は PITR ではなく、fail-closed と部分適用の記録である。** PITR は個別救済の最後の手段であり、全ユーザー規模の巻き戻しを PITR で行う想定を持たない
- **PITR は失効を巻き戻す。** User Data DO を戻すと `session_epoch` と `ai_client_connections.status` が過去へ戻り、Identity Directory bucket を戻すと消費済み・削除済みのリセットトークン行が復活する。したがって復旧には必須ステップが伴う — User Data DO 側は `session_epoch` を現在時刻由来の十分大きな単調値へ進め、`ai_client_connections` を全件 `revoked` にする。Identity Directory bucket 側は `password_reset_tokens` を全行削除し、`failed_attempts` を 0・`next_attempt_allowed_at` を過去へ戻す。**復旧できないなら全部切るのが既定である。手順・承認・監査の実体は #38**
- 退会済みアカウントの DO と、その credential が載っていた bucket への PITR 実行は禁止し、承認手続きの対象とする（両方を戻すと退会済みアカウントが復活するため。**退会は PITR 保持期間が経過して初めて不可逆になる**）
- **エクスポートは PITR の代替ではない。** ゴミ箱を除外し最新リビジョンのみを返すので、復旧用のバックアップとしては不完全である

## OCC の `version` を持つテーブル / 持たないテーブル

**持つのは集約ルートの6つだけである。**

| 区分 | テーブル |
|---|---|
| 持つ（集約ルート） | `account` / `user_settings` / `ai_client_connections` / `memos` / `topics` / `documents` |
| 持たない（不変の子行） | `memo_revisions` / `document_revisions` / `source_links` |
| 持たない（派生データ） | `search_entries` / `search_fts` |
| 持たない（非集約ストア7つ） | `jobs` / `operations` / `migration_progress` / `credential_locators` / `password_reset_tokens` / `rotation_checkpoints` / `_meta` |
| 持たない（CAS で直列化） | `credential_mappings` |

- 非集約ストアの更新は専用の CAS（`owner_token` / `operation_id` / 置換キー）で守られるので、汎用の OCC を重ねない
- **`account` は集約ルート側であり、非集約ストアではない。** ドメイン側の口の名前が `AccountStore` であることは分類を変えない（domains/identity.md）。非集約ストアの全数は上表の7つで、`account` はそこに入らない
- **非集約ストアへの書き込み口は各テーブルの節が持ち、口を持つのは6ストア・7メソッドである** — `enqueueJob`（`jobs`）/ `recordOperation`・`updateOperation`（`operations`。ここだけ2つ）/ `setMigrationCursor`（`migration_progress`）/ `credentialLocatorStore`（`credential_locators`）/ `resetTokenStore`（`password_reset_tokens`）/ `rotationCheckpointStore`（`rotation_checkpoints`）。**`_meta` だけが口を持たない**（アダプター専用）
- **OCC 不一致は握り潰さない。** `ConflictError("OPTIMISTIC_LOCK_FAILURE")` はユースケースを通ってトランスポート境界（ジョブの中なら `terminal_reason`）まで届く。アプリケーション層の OCC リトライデコレーターは置かない（CLAUDE.md「Retry strategy」）

## operator 専用 maintenance 経路

ジョブが一様な終端（`terminal_reason` + `poison`）に達したときのエスカレーション先として、**operator 専用の maintenance 経路が存在する**。`purge-user-mappings`（退会の最後の砦）と `cancel-reservation`（新規登録の予約の取り消し）の2つで、どちらも `jobs.kind` の12種には入らない（ジョブではなく RPC である）。診断用の `read-schema-version` / `list-bucket-user-ids` と、`rotate-encryption` の起動（`jobs` の `kind` 全数表が名指しする唯一の投入点）も同じ経路に属する。**到達制御・監査ログ・運用手順の実体は #38 が定める。**

## 本ファイルで定義しないテーブル

- **OAuth 2.1 の `jti` 一回性テーブル。** 認可コードは署名済みの自己完結値なので永続化せず、User Data DO に置くのは交換済みコードの `jti` を短期間だけ記録する表だけである。**その定義は #13「AIクライアント接続（OAuth認可・一覧・失効）」の範囲であり、本ファイルでは名前を確定させない。** OCC の `version` は持たない（一回性の記録なので集約ではない）
- **検索の不透明カーソルが指す期限付きスナップショットの物理形。** ドメイン側で決まっているのは契約（同じカーソルからは同じ集合が読める / 期限切れのカーソルは拒否される / カーソルは不透明である。domains/search.md）だけで、**物理形は #10 が決める** — 期限付きの表・DO ストレージの一時キー・安定順位による再実行のいずれでも契約を満たせるうえ、寿命と粒度はストレージ上限に依存する判断だからである。**当初は #37 に割り当てていたが、#37 は `SearchIndexPort` を実装せず（tokenizer 検証用の最小の読み `adapters/cloudflare/search/probe.ts` だけを置く）、物理形はページングの実装と不可分なので、検索ユースケースを持つ #10 へ委譲した**（`.thread/37/adr.md` ADR-008）

## リレーション図

```text
[User Data DO]（1ユーザー1インスタンス。user_id 列は持たない）

account / user_settings / _meta              (いずれも単一行)
credential_locators                          (bucket の逆引き。FK なし)

memos 1 ──── * memo_revisions               (memo_id, ON DELETE CASCADE)
documents 1 ─ * document_revisions          (document_id, ON DELETE CASCADE)

topics 1 ──── * documents                   (topic_id。FK なし: ADR-001 のため
                                             アプリ層で整合を保証。trashed 行は
                                             消滅済みトピックを指し得る)

documents 1 ─ * source_links * ──── 1 memos (PK (document_id, memo_id)。
                                             双方向 ON DELETE CASCADE +
                                             アプリ層の同期消去 ADR-003)

memos / documents ──→ search_entries         (projection。同一トランザクションで更新)
search_entries ←──── search_fts              (external-content。content_rowid = rowid)
search_entries.topic_id ──→ topics           (join で解決。値の複製はしない)

memo_revisions.actor_connection_id    ┐ ai_client_connections.id への参照値
document_revisions.actor_connection_id┘ (FK なし: clientName スナップショットで
                                         履歴表示は自己完結)

jobs / operations / migration_progress       (どのテーブルとも FK なし。共通基盤)

[Identity Directory DO]（bucket 単位）

credential_mappings 1 ─ * password_reset_tokens  (credential_id。FK なし)
jobs / rotation_checkpoints / _meta              (どのテーブルとも FK なし)

[DO をまたぐ対応]（FK ではなく値の一致で結ぶ）

credential_locators.(credential_id, generation, bucket_index)
    ──→ credential_mappings.(credential_id, generation) が載る bucket
credential_mappings.user_id ──→ その User Data DO
account.caller_token        ──→ credential_mappings.caller_token（同じ値）
```

## 主要クエリとインデックスの対応（確認表)

| クエリパターン（ポート） | 使うインデックス |
|---|---|
| タイムラインのカーソルページング・双方向読み（`findTimelinePage`） | `memos_timeline_idx`（`(posted_at, id)` 行値比較） |
| 日付ジャンプ・メモアンカー（`findTimelineAround`） | `memos_timeline_idx`（`posted_at` 範囲シーク） |
| キーワード絞り込み（`keyword`） | `memos_timeline_idx` の範囲内で `body LIKE` 評価 |
| ゴミ箱一覧（`listTrashed` / `listTrashedByUser` / `TrashQueryPort.listTrashItems` の UNION 射影） | `memos_trash_idx` / `docs_trash_idx` / `topics_trash_idx` |
| 保持期限の到達処理（`purge-trash` の作業述語と駆動源） | `memos_purge_idx` / `docs_purge_idx` / `topics_purge_idx` |
| 出典逆引き memo → documents（単発・一括） | `source_links_memo_idx` |
| 出典参照 document → memos（単発・一括） | `source_links` PK 前方一致 |
| トピック配下ドキュメント（active / trashed・一括） | `docs_topic_active_idx` / `docs_topic_trashed_idx` |
| 接続一覧（`listByUserId`） | `acc_connected_idx` |
| 全文検索（`SearchIndexPort.query`。3文字以上） | `search_fts`（trigram）→ 一致 rowid で `search_entries` の `rowid` PK を引き、`topics` とは join |
| 短語フォールバック（1〜2文字） | 索引を使わない全走査（対象列とページサイズを制限する）+ `search_entries_order_idx` |
| トピック絞り込み・安定順位 | `search_entries_topic_idx` / `search_entries_order_idx` |
| 履歴一覧・単一リビジョン取得 | `memo_revisions` PK / `doc_revs_doc_rev_uq` |
| エクスポート全件読み（`ExportSourceReader.readAll`） | `memos_timeline_idx` / `topics_live_idx` / `docs_updated_idx` |
| メール / SSO 主体でのユーザー解決 | `credential_mappings` の PK (`kind`, `hmac`) |
| ログインの到達性検査 | `credential_locators` の PK (`credential_id`, `generation`)（前方一致） |
| リセットトークンの照合（`verifyAndConsume`） | `prt_token_hash_uq` |
| 予約の期限切れ掃除（`sweep-reservations`） | `cm_reservation_idx` |
| リセットトークンの期限切れ掃除（`sweep-reset-tokens`） | `prt_expires_idx` |
| ジョブの claim と Alarm の張り直し | `jobs_runnable_idx` |
| 完了ジョブの prune | `jobs_completed_idx` |
| bucket 内の `userId` 列挙（運用の診断経路） | `cm_user_idx` |
