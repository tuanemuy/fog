# DB設計

fog の永続化スキーマ。**Cloudflare Workers + ユーザー単位 SQLite-backed Durable Objects**（CLAUDE.md「Reference runtime」）を前提とし、型は SQLite の型アフィニティ（TEXT / INTEGER）で記す。実装先は #51 が新設する Durable Object のアダプター（`packages/core/src/adapters/cloudflare/`）である。

- 入力: [spec/domains/](../domains/index.md) の全エンティティ・VO・ライフサイクル状態・リポジトリのクエリパターン
- 関連 ADR: [ADR-001](../adr/001-restore-document-without-topic.md) / [ADR-003](../adr/003-source-link-after-hard-delete.md) / [ADR-004](../adr/004-domain-boundaries.md) / [.adr/003](../../.adr/003-sqlite-fts5-only-search.md)（検索は FTS5 の全文検索のみ） / [.adr/004](../../.adr/004-do-local-commit-and-alarm-jobs.md)（DO ローカルの同期コミットと Alarm ジョブ） / [.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)（DO ローカル Outbox と Alarm relay）。`spec/adr/005`（superseded。根拠側は `.adr/003`、方式側は `.adr/004`）
- **本ファイルが `spec/` 側のスキーマの正本である。** 由来は Issue #34 の設計であり、以後の変更は本ファイルを直す
- **本ファイルが持つのは物理形だけである。** 非同期処理の3類型の判定規則と全数表（`event.type` / `jobs.kind`）は [async/index.md](../async/index.md) が正本である

## 物理境界

テーブルは2つの Durable Object クラスに分かれて置かれる。**同じ形のテーブルが両クラスに現れることがある**（`jobs` / `outbox_events` / `_meta`）。

| DO クラス | インスタンスの単位 | 置くもの |
|---|---|---|
| User Data DO | 1ユーザー1インスタンス | そのユーザーのドメインデータ全部（アカウント状態・設定・メモ・ナレッジ・検索 projection・ジョブ） |
| Identity Directory DO | bucket 単位 | `userId` が未確定の経路から引かれる認証クレデンシャルの写像・リセットトークン・bucket 単位のジョブ |

- **テナント分離の保証は列条件ではなく到達可能性による**（domains/index.md「テナント分離」）。同じ User Data DO の中に他ユーザーの行は原理的に存在せず、他ユーザーの DO stub を得る経路も存在しない。**したがってどのテーブルも `user_id` 列を持たず、複合インデックスの先頭に `user_id` を置くこともしない**（唯一 `credential_mappings.user_id` だけは例外だが、それは分離のための述語ではなくクレデンシャルから `userId` への**写像そのもの**である）
  - **`outbox_events` も `user_id` 列を持たない。ただし配送メッセージは宛先 DO の routing key を運ぶ** — DO の識別子が DO の外へ出る唯一の点である。Queue メッセージが運ぶ routing key は、**発行元 DO 自身の locator** である（Identity Directory では `_meta.self_locator` と同じ `dir:g{世代}:b{番号}` の bucket 名。多数の利用者で共有される粒度なので個人を指さない）。**クレデンシャル単位の内部キー（canonical の全長 HMAC）は載せない** — 窓で切れない仮名になり、`aggregate_id`（窓キー）を外した理由（DLQ 上での宛先相関）をそのまま無効化する（async/index.md「payload と `terminal_reason` の衛生規則」）
- 自分の `userId` は `_meta.self_locator` に1行だけ持つ。用途はエクスポートのヘッダ・移送と検証・DO 名が使えない経路のフォールバックに限り、**行データの絞り込みには使わない**
- 1 DO あたりのストレージ上限は 10 GB で、**本体と FTS5 インデックスの合計**で見る（requirements 5.3）。**`outbox_events` と `reset_request_windows` も同じ 10 GB に算入する**（前者は保持期間ぶんの `published` 行と `quarantined` 行を、後者は掃除されるまでの窓行を抱える）。**ただし「保持期間ぶんの `published` 行」は上限ではない** — prune はジョブランナーの起動末尾でしか走らないので、**終端行しか残っていない DO は定義上 `deleteAlarm()` 済みで起床せず、保持期間を過ぎた `published` 行が次の投入まで残る**（実効的な露出窓の上限は async/index.md「呼び出しガード」が持つ）。**`quarantined` の行は prune の対象外であり、自動では減らない** — 減らす手段は operator 経路の再駆動と明示削除だけである（`outbox_events` の節 / 「operator 専用 maintenance 経路」）。逼迫時は書き込みだけが失敗し読みと削除は通るので、導線は「ゴミ箱を空にする / エクスポートして削除する」が生きる

## 共通方針

- **ID**: 単一の `TEXT` 列を主キーに持つテーブルでは、その値は UUIDv7 等（生成は `IdGenerator` ポート）とし、ブランド VO への再水和はアダプターの責務とする。**例外は2つで、これが全数である** — (a) `password_reset_tokens.token_id`（時刻由来を避けた暗号論的乱数の不透明値。後述）、(b) `jobs.operation_key`（**生成せず、ジョブの同一性から決定的に導く値である**。**現行の11種はいずれもジョブの同一性から導く値（DO ごとの定数キー・`operationId` 由来・対象バージョンや世代由来）であり、対象と時間窓から導く形は旧構成の外部送信ジョブが使っていたもので現行の `kind` には無い**。**`IdGenerator` で採番すると再投入のたびに別のキーになり、`jobs` の収束規則3つがどれも成立しない**。導出の規則は `jobs` の節と各ユースケースが正本）。**`outbox_events.id` は生成 ID なので例外は増えない**（`IdGenerator` が採番する不変の主キーであり、収束させないことが `outbox_events` の契約そのものである。後述）。**`reset_request_windows.window_key` は例外 (b) と同じ1件である** — 生成せず、**対象 canonical の全長 HMAC と依頼の窓から決定的に導く**同一性キーであり、別の例外を新設しない（同じ窓に同じキーが出ることがスロットル判定の成立条件そのものである。**導出主体と導出鍵の在り処を含む導出規則の正本は `reset_request_windows` の節であり、`jobs.operation_key` の規則を参照しない** — 上のとおり、この導出形を採る現行の `kind` は無い）。**主キーの形は3通りある** — (1) 単一 `TEXT` 列、(2) 複合キー（`memo_revisions` / `source_links` / `credential_locators` / `credential_mappings` / `migration_progress` / `rotation_checkpoints`）、(3) `search_entries` の `rowid INTEGER PRIMARY KEY`（`id TEXT` は名前つき UNIQUE 索引を持つ別列。後述）。**単一行のテーブル**（`account` / `user_settings` / `_meta`）は業務上の主キーを持たない（単一行制約の掛け方は実装裁量とする。#51）。**どのテーブルがどの形を採るかは各テーブルの節が正本であり、節に無いサロゲートの `id` 列を足してよいという読み方はしない**
- **日時**: `INTEGER`（Unix epoch ミリ秒）。カラム名は `*_at`
- **version（OCC）**: 集約ルートに `version INTEGER NOT NULL`（生成時 0）。`save` / `delete` は `WHERE id = ? AND version = ?（読み取り時の値）` の条件付き更新とし、**0 行更新を `ConflictError("OPTIMISTIC_LOCK_FAILURE")` にマップする**。**単一行テーブルは `id` 列を持たないので `WHERE version = ?` だけで条件付ける**（`id` 述語は不要。他の行が存在しないため）。**本 spec の範囲でこの形の条件付き更新を発行するのは `user_settings` だけである** — `account` も `version` 列を持つが書き手が無い（後述の `account` の項）。0 行かどうかは `UPDATE ... WHERE id = ? AND version = ? RETURNING 1` が返した行の有無で読む（単一行テーブルでは `id` 述語を除いた同じ形。意味論がその文の中で閉じるため。`changes()` は第二候補、課金単位である書き込み行数カウンタは使わない）。リビジョン・出典リンクは不変の子行のため `version` を持たない。**持つテーブル / 持たないテーブルの全数は後述**
- **boolean**: `INTEGER`（0 / 1）
- **ライフサイクル直和型**: `status TEXT NOT NULL` + 状態依存カラムを nullable にし、「その状態でのみ非 NULL」を CHECK 制約で強制する（あり得ない行を DB でも排除。ドメインの判別可能ユニオンと 1:1 対応）
- **書き込みの単位**: 書き込みは DO 内蔵の SQLite に対する単一の同期トランザクションで確定する。**本体行と検索 projection（`search_entries` / `search_fts`）も同じトランザクションに入る**（domains/search.md「インデックスの維持」）。**イベント行（`outbox_events`）も同じトランザクションに入る** — (1) 業務データの書き込み、(2) FTS5 projection の更新、(3) `enqueueEvent` によるイベント行の追加、の3つが1つの `transactionSync` の中で一度に確定し、**rollback すると3つとも巻き戻る**（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）
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
| `outbox_events` | User Data | 共通基盤 | Outbox イベント行（**初期のイベント型は0件**。表と機構だけを置く） |
| `operations` | User Data | 共通基盤 | saga / RPC の冪等キーと phase |
| `migration_progress` | User Data | 共通基盤 | migration の部分適用カーソル |
| `_meta` | User Data | 共通基盤 | `schema_version` と自 locator |
| `credential_mappings` | Identity Directory | identity（アダプター） | クレデンシャル → `userId` の写像・検証材料・予約 |
| `password_reset_tokens` | Identity Directory | identity（アダプター） | `PasswordResetTokenPort` の永続化 |
| `reset_request_windows` | Identity Directory | identity（アダプター） | `PasswordResetThrottlePort` の永続化（リセット依頼のスロットル窓） |
| `jobs` | Identity Directory | 共通基盤 | Alarm ジョブ（5種） |
| `outbox_events` | Identity Directory | 共通基盤 | Outbox イベント行（`identity.passwordResetRequested`） |
| `rotation_checkpoints` | Identity Directory | identity（アダプター） | 鍵ローテーションの進捗記録 |
| `_meta` | Identity Directory | 共通基盤 | `schema_version` と自 locator |

trash / export ドメインは自前のテーブルを持たない（ADR-004）。ゴミ箱一覧は上記テーブルの射影（`TrashQueryPort` の UNION クエリ）、保持期限の到達処理は各行の `purge_after` を引く Alarm ジョブ、エクスポートは読み取りのみ。**search は `search_entries` / `search_fts` を持つ** — ただし常に本体テーブルから再構築可能な派生データであり、集約ではない。

## User Data DO のテーブル

### account

アカウントの状態・失効の権威・退会 tombstone。**単一行のテーブルである**（その DO の中に1人分しか存在しない）。単一行制約の掛け方は実装裁量とする（#51）。

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
- **ドメイン側の口は `AccountStore` である**（domains/identity.md）。名前は `*Store` だが**この表は後述の非集約ストア9つには入らない** — OCC の `version` を持つ集約ルート側であり、`User` 集約に畳まないことと非集約であることは別である
- `session_epoch` / `reset_version` の前進は単調増加カウンタの更新なので、`version` の条件を付けない単独文で書き、`version` も進めない（`ai_client_connections.last_used_at` と同じ扱い）
- **`version` 列は保持するが、本 spec の範囲では OCC の条件付き更新を発行する操作が無い。** `AccountStore` の3メソッド（`find` / `advanceSessionEpoch` / `advanceResetVersion`。domains/identity.md）はいずれも `version` を読まず進めない。`status` の3値遷移・`deleted_at`・`caller_token` を書くのは退会 saga の前進（`finalize-withdrawal`）であり、**その書き手は #51 が DO の RPC 側で決める**。列を落とさないのは、「集約ルートは `version` を持つ」という全数（後述の OCC の表）を崩さないためである

### user_settings

identity の `User` のユーザー単位設定。**単一行のテーブルである**（`account` と同じく業務上の主キーを持たない。単一行制約の掛け方は実装裁量とする。#51）。`UserSettingsRepository` は `find()` で引き、`findById` を持たない（他の `userId` を渡せるという読み方を残さないため。domains/identity.md）。

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

Alarm ジョブの多重化テーブル。1 DO につき Alarm は1本しか持てないので、複数種類のジョブを1つの表に載せ、Alarm は「最も早い `next_run_at`」に張り直す。**Identity Directory DO も同じ11列を持つ**（後述）。

**Alarm が多重化するのはこの表だけではない。** `outbox_events`（後述）も第2の起床要求元であり、**1本の Alarm が2つの表を多重化する。** 張り直しの式・起床の中の順序・件数上限の持ち方は後述の「Alarm の多重化」が正本である。

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
| `terminal_reason` | TEXT | nullable。終端の理由 |
| `completed_at` | INTEGER | nullable。**`done` / `poison` へ落ちた時刻**。`pending` / `running` では `NULL`。`next_run_at` では代用できない（あちらはバックオフで未来へ先送りされる列である） |

インデックス:

| 名前 | 定義 | 用途 |
|---|---|---|
| `jobs_runnable_idx` | (`status`, `next_run_at`) WHERE `status IN ('pending','running')` | claim（実行可能集合の最早行）と Alarm の張り直し |
| `jobs_lease_idx` | (`lease_until`) WHERE `status = 'running'` | DO がリセットされたジョブの回収 |
| `jobs_completed_idx` | (`status`, `completed_at`) | `done` / `poison` の prune（保持期間を過ぎた行を有界に削除する） |

- **この表に外部 I/O を伴う `kind` は存在しない。** local job はすべて DO ローカルで完結する（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）。**この表の行はネットワークに出ない**と読んでよい
- **外部プロバイダへ渡す冪等キーの列は、この表にも `outbox_events` にも置かない。** provider へ渡すキーは `event.id` から DO が決定的に導き、送信材料 RPC の応答に載せて consumer へ渡す（async/index.md「送信材料 RPC」）。導出鍵は DO の中にあるので、列に持たせても誰も読まない
- **usecase からの書き込み口は `enqueueJob`（UoW コンテキストの副作用登録メソッド）だけである。** 投入点の全数は [async/index.md](../async/index.md) の全数表が持つ。claim・完了・backoff・prune はジョブランナー（アダプター）が同じ行に対して行うので、口を通らない。**`outbox_events` の書き込み口は `enqueueEvent` であって `enqueueJob` ではない** — 別の表なので、この断言は `jobs` について変わらずに成り立つ
- **再投入（`enqueueJob`）の収束規則は3つで、これが全数である。** `operation_key` の欄が言う「同じキーの再投入は既存行に収束する」だけでは、`kind` によって逆向きの更新が要求されるためである。**`status` 別の (2)(3) は (1) と `payload_digest` 列の規則の両方に優先する** — `done` / `poison` の行は `next_run_at` が `NULL` なので「早める方向」という判定そのものが定義されず、payload の差も終端済みの行では競合ではなく次の一回分の入力だからである
  - **(1) 再投入は `next_run_at` を早める方向にのみ更新し、遅らせない。** 射程は実行可能集合（`status IN ('pending','running')`）の行で、既存値より早ければ更新し、同じか遅ければ何も書かずに成功を返す。**`status = 'running'` の行の `next_run_at` は書き換えない**（claim 済みの実行を横から動かさない）。保持期限の延長で次の期限が後ろへ動く場合はこの規則では何も書かれないが、ジョブが既存の早い時刻に1回空振りし、その完了トランザクションの中の再武装が新しい時刻を書くので正しい時刻に収束する
  - **(2) `status = 'poison'` の行への再投入は、`kind` によらず同じ行を `pending` へ戻し、`attempt` を 0 にして `next_run_at` / `payload` / `payload_digest` を引数の値で置き換える。別行は作らない**（`operation_key` はそのジョブの同一性なので、行を増やすと同一性の意味が壊れる）。`terminal_reason` は上書きせずに残す
  - **(3) `status = 'done'` の行を `pending` へ戻すのは、再武装する5種（`purge-trash` / `sweep-reservations` / `sweep-reset-tokens` / `sweep-orphan-mapping` / `rotate-encryption`）に限る。残る6種は `done` の行を復活させず、何も書かずに成功を返す。** 5種を復帰させるのは、定数 `operation_key` を持つこれらが1回完走した時点で prune の保持期間ぶん再投入を受け付けなくなるからである（平常時はどれも必ず `done` へ落ちるので、投入点からの復帰が唯一の再起動手段になる）。残る6種の `done` は「その `operation_key` が表す一回分の仕事が完了した」という意味なので、**同じキーの再投入は新しい仕事ではなく重複依頼である** — 復活させると、たとえば `resume-credential-change` の重複依頼や `finalize-withdrawal` の二重投入が、完了済みの saga を起こし直して起床回数と書き込み行数を依頼回数に比例させる。**`payload_digest` の一致では5種と6種を分けられない**（5種は投入点が毎回同じ payload を渡すので digest も一致する）
  - **3つの射程は外部からの再投入だけである。** ジョブ自身が完了時に行う再スケジュール（後述の再武装）には (1) を適用しない — 適用すると次の期限が現在の `next_run_at` より後のときに何も書けず、`done` に落ちて二度と起きなくなる
- **claim と完了は CAS で行う。** `UPDATE jobs SET status='running', lease_until=?, owner_token=? WHERE operation_key=? AND (status='pending' OR (status='running' AND lease_until < ?))` の 0 行更新を「他が持っている」とみなす。**第2の選言に `status='running'` を必ず含める**（落とすと `done` / `poison` の行が過去の `lease_until` を保持したまま再 claim の対象になる）。完了も `WHERE operation_key=? AND owner_token=?` の CAS。**`outbox_events` の claim / finalize も同じ形の CAS であり、述語キーは `id` である**（`jobs` の `operation_key` に対応する位置。`UPDATE outbox_events SET status='publishing', lease_until=?, owner_token=? WHERE id=? AND (status='pending' OR (status='publishing' AND lease_until < ?))` と `WHERE id=? AND owner_token=?`。値域が `publishing` に変わるだけ）
  - **「上限件数まで claim」の実装形を確定させる。** `UPDATE ... LIMIT` / `DELETE ... LIMIT` は `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` を有効にしたビルドでしか使えず、**DO の SQLite で使える保証が無い**ので、これを前提にした書き方をしない。**実行可能集合を索引順に上限件数だけ `SELECT` し、行ごとの CAS を1文ずつ発行する**（0 行更新の行は他が持っているものとして飛ばす）。**この `SELECT` の述語は「実行可能集合 ∧ `next_run_at <= now`」である** — 実行可能集合そのものは `status` だけで定義され、時刻の条件は claim の選択にだけ掛かる（後述の「Alarm の多重化」が正本）。**掛け忘れると backoff が無効化される**（上の CAS は `status` と `lease_until` しか見ないので、`next_run_at` を先送りした行がその場で再実行される）。`WHERE id IN (?, …)` のような一括形へまとめる場合は、**件数上限を 100 bind parameter の内側に収める**（CLAUDE.md「Storage limits」。bulk insert を chunk するのと同じ制約であり、素朴に展開すると bind の上限が件数上限の実質的な天井になる）
  - **Alarm の張り直しは、この CAS の第2選言と対で読む。** claim が `lease_until` の満了を要求する以上、**lease 中の行（`running` / `publishing`）は `max(next_run_at, lease_until)` で算入する。** 過去の `next_run_at` を持つ leased 行だけが残った状態で `next_run_at` をそのまま採ると、「起床 → 1行も claim できない → 同じ過去時刻へ張り直す」の空転になる。**この規則は `jobs` と `outbox_events` の両方に同じ形で掛かる**（後述の「Alarm の多重化」）
- **backoff と終端。** 失敗時は `attempt` を進めて指数バックオフで `next_run_at` を先送りする。上限を超えたら `status='poison'` にして `terminal_reason` を残し、ホットパスの索引から外す。**`done` / `poison` のどちらへ落とすときも、同じトランザクションで `completed_at` に現在時刻を書き、`lease_until` / `owner_token` / `next_run_at` を `NULL` にする**
  - **上限未到達の失敗（= 大多数の失敗）で書く列も確定させる。** 同じトランザクションで `status` を `pending` へ戻し、**`lease_until` / `owner_token` を解放（`NULL`）したうえで `attempt` と `next_run_at` を書く**。上のチャンク反復上限の規則（後述）と同じ形であり、**`jobs` と `outbox_events` の両方に同じ形で掛かる**（「共通化する規約」の backoff の範囲）。**`running` / `publishing` のまま `next_run_at` だけを先送りしない** — 後述の「Alarm の多重化」が置く不変条件（leased 行では `next_run_at ≤ lease_until` が常に成り立つ）が破れ、4本の min がその行を `lease_until` で数えて空振り起床を繰り返すからである
    - **`outbox_events` では `owner_token` の解放が二次的な安全性も持つ。** その回に Queue へ出た（かもしれない）メッセージの持参人証がその場で失効し、以後は再 claim で採り直した値だけが呼び出しガードを通る。古い対を持った consumer は `nothing-to-send` に落ちるが、行そのものは再 claim → 再 publish で配送されるので**配送は失われない** — at-least-once の観点で安全側である
  - **`outbox_events` には例外が1つある。** backoff と終端の規約そのものは共有するが、**`outbox_events` は終端（`published` / `quarantined`）へ落とすときも `owner_token` を `NULL` にしない** — 送信材料 RPC の呼び出しガードの照合材料として終端後も残すためである。`NULL` にする列は `lease_until` / `next_run_at` の2つだけになる（後述の `outbox_events` の節と async/index.md「呼び出しガード」）
- **終端は一様である。** 前進不能が確定したジョブは `terminal_reason` を残して `poison` にし、operator 経路へエスカレーションする（後述）。**「黙って中間状態を残す」は選ばない。** 材料の寿命のうち **#51 が落としてはならない前方互換点3本は本ファイルが各テーブルの節で持つ** — `account.caller_token`（消すのは退会の完走時だけ）/ `operations.target_locators`（終端の後始末が終わるまで消さない）/ `credential_mappings` のコーディネーター予約行（同）。**それ以外の巻き戻し（自動回収）の具体 — 段の順序・原子性境界・終端モードの印・後始末の再試行上限 — は #45 が決める**ので、本ファイルには書かない
  - **`outbox_events` の行はこの3本に加えない。3本のままである。** prune が触るのは**保持期間を過ぎた `published` の行だけ**で、**`quarantined` の行は恒久的に残る**ので、「終端の後始末に要る材料を prune が消す」経路が存在しない。**据え置きであることを明記する** — 書かないと、3本という数が改訂で取り残されたのか意図的なのかを判別できない
- **1回の起動で触る量は件数だけで有界にする。** 経過時間では測らない（`Date.now()` はコード実行中に進まない）。ジョブ件数・チャンク反復回数・1チャンクの行数の3階層の上限を置き、値は #51 が spike で出して #38 が運用値として確定する。**relay パスは独立した件数上限を持つ**（上限を共有すると片方の滞留がもう片方を飢えさせる。後述の「Alarm の多重化」）
- **チャンク反復回数の上限に達したら、その時点の進捗をコミットするのと同じトランザクションで `status` を `pending` へ戻し、`lease_until` / `owner_token` を解放して次の起床へ回す**（解放した行は同じ起動の中では再 claim しない。しないと上限を置いた意味が消える）。**したがって「残件が空になるまで回す」と書かれたフェーズもこの上限の内側にある** — 空になるまでというのは**フェーズの順序の規定であって、1回の起床で終わることの規定ではない**。該当するのは `purge-trash` の再計算フェーズで、**削除フェーズへ進むのは再計算の残件が空になった起床でだけである**（有限回の起床で空になる根拠は `user_settings` の項の自己消尽する作業述語が持つ）
- **prune 専用の `kind` は置かない。** ジョブランナーが1回の起動の末尾で、保持期間を過ぎた `done` / `poison` を上限件数だけ削除する（`jobs_completed_idx` から引く）。**`outbox_events` の prune も同じ末尾処理に載せる**（`outbox_completed_idx` から引き、`published` を削除して `quarantined` は残す）
  - **prune の実装形も claim と同じ制約を受ける。** `DELETE ... LIMIT` を前提にせず、`DELETE FROM <表> WHERE <PK> IN (SELECT <PK> FROM <表> WHERE status = ? AND completed_at < ? ORDER BY completed_at LIMIT ?)` の形で書く（副問い合わせの `LIMIT` は bind を件数ぶん消費しない）。対象を先に `SELECT` してから `IN (?, …)` へ展開する形を採る場合は、**上限件数を 100 bind parameter の内側に収める**
  - **`published` 行の保持期間には運用値の制約が2本掛かり、これが全数である**（実値の確定は #38）。**`Queue の最大 retry 期間 + DLQ の保持期間 ≤ published 行の保持期間`**（下側）と **`Queue の最大 retry 期間 + DLQ の保持期間 < リセットトークンの TTL`**（上側）である。前者は、送信材料 RPC の呼び出しガードが行の存在を要求するので、prune が行を消した後の DLQ 再駆動が必ず空振りするからである。後者は**機能要件**である — 満たしていれば、DLQ 滞在の末期に再駆動しても**リセットトークンがまだ TTL の内側にあり、有効なリンクを届けられる。** **`DLQ の保持期間 < TTL` とだけ書くとこの帰結が導けない** — 再駆動の時点でトークンが経過しているのは DLQ の滞在時間だけではなく、その前に Queue が retry を焼き切るまでの時間も含むからである。**2本は左辺が同じ `Queue の最大 retry 期間 + DLQ の保持期間` で、上限として置く相手だけが違う**（リセットトークンの TTL と `published` 行の保持期間）。相手は独立に決まる運用値なので片方から他方は導けず、**「配送の運用値の制約は2本で全数」は動かない。上側だけを書くと両立しない2値を選べてしまい、再駆動が恒久的に空振りする形は運用上ほとんど検出できない**ので、対で書く

#### `kind` の全数

**全数表は [async/index.md](../async/index.md) が持つ。** `kind` の一覧・所有 DO クラス・投入点（全数）・類型・用途・consumer・冪等性キーは同表が正本であり、本ファイルは物理形に専念する。**`kind` を足したときに直すのは同ファイルの全数表1つである。**

**種別は11種で、所有 DO クラスの内訳は User Data 6 種 / Identity Directory 5 種である。** **投入点の欄を落とさない**という不変条件は全数表側が持つ — 投入点を同じ表に持たせることで、**投入されるが二度と起きないジョブ**を欄の空白として検出できるようにするためである（投入点の無い再武装ジョブは1回完走した時点で恒久的に停止する）。**ユースケースから投入する 7 種は、いずれもそのジョブが待つ状態を書くのと同じトランザクション**の中で `enqueueJob` する。残る4種は経路が違う — `reindex` / `migrate-bulk` はユースケースからは投入せず（スキーマ移行の適用側が投入する）、`rotate-encryption` は operator 経路の起動による。`finalize-withdrawal` は退会のユースケースが本 spec に存在しない（`spec/inventory/domain.md` の `AccountStore` の項）ため、投入点は #51 が DO の RPC 側で決める。

- **類型は3つ（同期実行 / Outbox event / local job）で、local job はさらに3つのサブ類型（期限処理 / チェックポイント分割を要する一括処理 / cross-DO saga の前進）に分かれ、11種を漏れなく1回ずつ覆う。** 判定規則と全数表は async/index.md が持つ。**`kind` を足したら `spec/async/index.md` の全数表を直し、投入点欄も同時に埋める**
- **完了時に自分を再武装する5種は `purge-trash` / `sweep-reservations` / `sweep-reset-tokens` / `sweep-orphan-mapping` / `rotate-encryption` であり、これが全数である**（サブ類型からは導けない — 前3種は期限処理、`sweep-orphan-mapping` は cross-DO saga の前進、`rotate-encryption` は一括処理である）。完了トランザクションの中で自分の駆動源（`min(purge_after)` などの時刻、または残件の有無）を読み直し、残件があれば `pending` へ戻す。**残件が無いときだけ `done` にする**。この再武装が無いと、1回完走した時点で dormant な DO が二度と起きない。**残る6種は完走したら `done` で終わりであり、次の起動は投入点からの再投入だけが張る**（上の収束規則 (3)）
- **`sweep-reset-tokens` は2目的を持つ。** 責務は「期限切れのリセットトークン行（`password_reset_tokens`）の削除**と、期限切れの窓行（`reset_request_windows`）の削除**」である。**投入点も「リセットトークン行または窓行を書くのと同じトランザクション（= `requestPasswordReset` の4ケースすべて）」である** — 窓行は4ケースすべてで作られるので投入も4ケースすべてで起きる。**宛先の登録有無で投入を分けない**（分けると、未登録アドレスだけを投げられた bucket で掃除が一度も投入されず窓行が単調増加し、`enqueueJob` の有無が4ケースで割れて起床が観測可能な差になる）。`kind` は増やさない
  - **再武装の駆動源も2表の min である** — `min(password_reset_tokens.expires_at, reset_request_windows.expires_at)` を `prt_expires_idx` / `rrw_expires_idx` からそれぞれ読み、**どちらかに残件があるあいだは `done` にしない**。トークン行だけを読む実装だと「トークン行が0件・窓行が残っている」bucket で `done` に落ち、窓行が次の依頼まで掃除されずに単調増加が再武装側から再発する
  - 投入時の **`next_run_at` は窓の終端（= その窓の開始 + 窓の長さ）から導き、送る側でもリセットトークンの `expires_at` を材料にしない。** 窓行の `expires_at` は窓の終端に**猶予**を足した値だが、**猶予は窓行を書くアダプター側の掃除条件にだけ効くので、投入時刻の材料にしない** — 投入側にも置くと「2層が同じ設定値を読む」対象が窓の長さに加えてもう1つ増え、ズレたときに静かに壊れる面が広がる。窓の終端に起きた掃除は窓行についてはまだ空振りしうるが、**完了時の再武装が2表の索引（`prt_expires_idx` / `rrw_expires_idx`）から `min(expires_at)` を読み直して正しい時刻を張り直すので収束する。** 投入時刻を宛先の登録有無に依存させないことは変わらない（依存させると「同じ起床を張る」が4ケースで割れる）
- **両表の実行可能集合が空になったときだけ `deleteAlarm()` する**（`jobs` の `status IN ('pending','running')` と `outbox_events` の `status IN ('pending','publishing')` が両方とも空のとき）。**例外は fail-closed で止まっている DO だけである**（後述）
- **`rotate-remap`（写像鍵ローテーションの再写像）は Alarm ジョブではない**ので `kind` に現れない。写像鍵を Alarm 起動時に手元へ持てないためである。実行主体そのものは #44 が決める。**Outbox relay も `jobs.kind` ではない** — 起床時刻の権威が二重化し、backoff の単位（outbox は行ごと、ジョブ行は `attempt` 1本）も食い違うためである（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）

#### Alarm の多重化

**1本の Alarm が `jobs` と `outbox_events` の2表を多重化する。**

```text
setAlarm( min(
    min(jobs.next_run_at)          WHERE status = 'pending',      -- jobs_runnable_idx
    min(jobs.lease_until)          WHERE status = 'running',      -- jobs_lease_idx
    min(outbox_events.next_run_at) WHERE status = 'pending',      -- outbox_runnable_idx
    min(outbox_events.lease_until) WHERE status = 'publishing'    -- outbox_lease_idx
) )
両表の実行可能集合（jobs: pending / running、outbox_events: pending / publishing）が
両方とも空のときだけ deleteAlarm()
```

- **式は4本の min の合成として書く。索引で解ける形にするためである。** 4本はいずれも宣言済みの索引の先頭列等値 + 次の列の最小で引ける（上のコードブロックの注記が対応を示す）。`min(max(next_run_at, lease_until))` を1本の SQL として発行すると**式を key にした索引が無いので実行可能集合の全走査になり、そのコストが backlog の件数に比例して毎起床かかる。**
- **4本の合成が「lease 中の行は `max(next_run_at, lease_until)` で算入する」と一致する根拠は、leased 行では `next_run_at ≤ lease_until` が常に成り立つことである**（claim の時点で `next_run_at` は過去、`lease_until` は未来なので、`max` は必ず `lease_until` を採る）。したがって leased 行を `lease_until` だけで数え、`pending` の行を `next_run_at` だけで数えれば、両者の最小は式の値と等しい。
- **lease の算入規則を明示するのは、claim の CAS が `lease_until` の満了を要求するからである**（上の claim の項）。算入しないと、過去の `next_run_at` を持つ leased 行だけが残った状態で空振り起床を繰り返す。**`jobs` 側にも同じ形で掛かる。**
- **「実行可能集合」は `status` だけで定義する**（`jobs` は `pending` / `running`、`outbox_events` は `pending` / `publishing`）。**`next_run_at <= now` を集合の定義に入れず、claim の選択述語としてだけ掛ける** — 定義に入れると、まだ時刻の来ていない行しか残っていない DO で `deleteAlarm()` の条件（両表の実行可能集合が空）が成立し、二度と起きなくなる。逆に claim 側で掛け忘れると backoff が無効化される（上の claim の項）。**この区別は `jobs` と `outbox_events` の両方に同じ形で掛かる。**
- **件数上限は各パスが独立に持ち、毎回の起床で両方のパスを必ず1回通す。** 片方が上限を使い切っても他方は必ず走る（上限を共有すると片方の滞留がもう片方を飢えさせる）。
- **relay の1パスは3相で、Queue への送信だけがトランザクションの外にある。**
  1. `transactionSync`: 実行可能な行を上限件数まで claim（`status='publishing'`、`lease_until` / `owner_token` を CAS で書く）
  2. トランザクション外: Queue へ publish
  3. `transactionSync`: `published` へ落とす／**上限未到達の失敗なら `status` を `pending` へ戻し、`lease_until` / `owner_token` を解放して `attempt` と `next_run_at` を書く**／上限超過は `quarantined` + `terminal_reason`（書く列の全数は `jobs` の「backoff と終端」が持ち、`jobs` と共通である）
- **at-least-once の根拠は相 2 と 3 のあいだにある。** そこで DO がリセットすると、`lease_until` の満了後に同じ行が再 claim され再 publish される。**`alarm()` から throw しない**規則は relay パスにも掛かる（1行の失敗が他の配送を止めない）。
- `alarm()` の中の順序は後述の「スキーマバージョンと lazy migration」が持つ。**relay は `queue.send()` を await するので、`await` を1つも挟まない migration ゲートの中には置けない。**

### outbox_events

DO ローカル Outbox のイベント行。**業務データの書き込み・FTS5 projection の更新と同じ `transactionSync` の中で追加され、Alarm relay が Queue へ publish する**（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）。**Identity Directory DO も同じ13列・同じ索引を持つ**（後述）。**専用の Outbox DO は作らない** — 業務更新とイベント行の追加を原子的に書けるのは発行元 DO のローカル表だけだからである。

| カラム | 型 | 制約 |
|---|---|---|
| `id` | TEXT | PK。`EventId`。`IdGenerator` が採番する**不変**の値。`jobs.operation_key`（同一性で収束する）とは対照的に、**イベントは収束しない** |
| `type` | TEXT | NOT NULL。`event.type`（`jobs.kind` に対応する位置づけ） |
| `payload` | TEXT | NOT NULL。JSON。**PII および再利用可能な秘密を入れない**（`jobs.payload` と同じ制約）。**100 KB/文・2 MB/行の内側に収める**（後述） |
| `aggregate_id` | TEXT | NOT NULL。イベントが指す集約の識別子 |
| `occurred_at` | INTEGER | NOT NULL。**ドメインが決めた発生時刻** |
| `created_at` | INTEGER | NOT NULL。**行が Outbox に載った時刻**。backlog の滞留時間を読む起点はこちらで、`occurred_at` では代用できない（ドメインが過去の時刻を入れうる） |
| `attempt` | INTEGER | NOT NULL。リトライ回数（`jobs` と**同名・同意味**） |
| `next_run_at` | INTEGER | nullable。次に relay してよい時刻。終端行では `NULL`（`jobs` と**同名・同意味**） |
| `status` | TEXT | NOT NULL, CHECK (`status IN ('pending','publishing','published','quarantined')`)。**形は `jobs` と同じで名前が別である** — `published` は「Queue へ渡した」であって「処理された」ではない |
| `lease_until` | INTEGER | nullable。claim の有効期限（`jobs` と**同名・同意味**） |
| `owner_token` | TEXT | nullable。**claim ごと・行ごとに一意な capability である**（`jobs` の「claim した実行主体の識別子」という言い回しはこの表では使わない）。**暗号論的乱数から生成し、時刻・連番・DO 識別子など推測可能な材料から導かない。長さは 128 bit 以上とする。** finalize は CAS でこれを照合し、**送信材料 RPC の呼び出しガードの照合材料でもある。終端（`published` / `quarantined`）へ落とすときも `NULL` にしない** — 名前は `jobs` と同じだが**意味の射程が広い**（後述）。**列が `NULL` の行は照合で常に不一致とする**（`password_reset_tokens.change_auth_token` と同じ規則。後述） |
| `terminal_reason` | TEXT | nullable。終端の理由。**PII と秘密を入れない**（運用者が読む） |
| `completed_at` | INTEGER | nullable。`published` / `quarantined` へ落ちた時刻（`jobs` と**同名・同意味**） |

**13列である。**

索引:

| 名前 | 定義 | 用途 |
|---|---|---|
| `outbox_runnable_idx` | (`status`, `next_run_at`) WHERE `status IN ('pending','publishing')` | relay の claim（実行可能集合の最早行）と Alarm の張り直し |
| `outbox_lease_idx` | (`lease_until`) WHERE `status = 'publishing'` | DO がリセットされた行の回収 |
| `outbox_completed_idx` | (`status`, `completed_at`) | 保持期間を過ぎた `published` の prune |

**3本である**（`jobs` の3本と1対1で対応する）。**部分 UNIQUE 索引は置かない** — `dedupe_key` を置かないので dedupe のための索引が要らない。

`jobs` との規約の関係を明示する。

- **共通化する規約**（**列名と状態遷移そのものは規約の項目として数えず、上の列表と `status` の欄が持つ** — 同名・同意味の列は各列定義が、値域の差は下の 2. が正本である）: Alarm scheduler（張り直しの式と lease の算入）/ backoff（`attempt` を進めて指数バックオフで先送り、上限超過で終端）/ lease（claim の CAS と `lease_until` 満了による回収）/ prune（ジョブランナーの起動末尾で、保持期間を過ぎた行を上限件数だけ削除）。**ランナーの実装は2表で共有する。ただし削除の対象集合は共有しない** — 下の 2.（値域の分離）から決まり、`outbox_events` 側で消えるのは `published` だけである
- **分離する規約**は3つで、これが全数である。
  1. **同一性と収束の有無** — `jobs` は `operation_key` で収束し、収束規則3つが載る。**`outbox_events` は例外なく「1イベント1行・不変」であり、収束しない。** 2回起きた事実を1行に畳むと片方が配送されない
  2. **配送状態の値域** — `pending` / `publishing` / `published` / `quarantined`（`jobs` は `pending` / `running` / `done` / `poison`）。**prune の対象集合はこの値域の差から決まる** — `jobs` は終端2値（`done` / `poison`）の両方を消すが、`outbox_events` が消すのは `published` だけで、**`quarantined` は恒久保持する**（下の「その他」）
  3. **終端時に `NULL` にする列** — `outbox_events` は `lease_until` / `next_run_at` の**2つだけ**であり、**`owner_token` は残す**（`jobs` は3つとも `NULL` にする）。落とすと呼び出しガードが `published` の行に対して必ず失敗し、正常系の配送が全滅する。**射程は終端（`published` / `quarantined`）だけである** — 上限未到達の失敗で `pending` へ戻すときは両表とも `owner_token` を解放する（`jobs` の「backoff と終端」）。行が再び claim を待つ状態へ戻る以上、呼び出しガードの照合材料として残す理由が無いためである

その他:

- **`dedupe_key` を置かない。** 同一窓への連打の抑止は行の一意制約ではなく、`reset_request_windows` を読むスロットル判定（同じ transaction の中）が担う（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）
- **外部プロバイダへ渡す冪等キーの列を置かない。** `event.id` から DO が導出し、送信材料 RPC の応答で consumer へ渡す
- **書き込み口は UoW コンテキストの `enqueueEvent` だけである**（`jobs` の `enqueueJob` と同じ形。同期・戻り値なし・同じ `transactionSync` の中で行を書く）。`EventId` の採番は UoW 実装が `IdGenerator` に対して行う。claim・publish・finalize・prune は relay（アダプター）が同じ行に対して行うので、口を通らない
  - **`enqueueEvent` は draft の配列を取るので、draft ごとに1文で INSERT する（まとめる場合は 100 bind parameter の内側に収める）** — 下のバレットが確定させるとおり **INSERT が bind するのは9列なので、N ≥ 12 で上限に触れる**（9 × 11 = 99 / 9 × 12 = 108。CLAUDE.md「Storage limits」。claim / prune の一括形に掛かるのと同じ制約である）。**`NULL` の4列も明示 bind する形を採るなら 13 列なので N ≥ 8 が境界になる**（13 × 7 = 91 / 13 × 8 = 104）
  - **INSERT が書くのは `id` / `type` / `payload` / `aggregate_id` / `occurred_at` / `created_at = now` / `attempt = 0` / `next_run_at = now` / `status = 'pending'` の9列であり、`lease_until` / `owner_token` / `terminal_reason` / `completed_at` は `NULL` である**（9 + 4 = 13 列の内訳と対になる）。**`next_run_at` を省いて `NULL` のまま入れない** — 「operator 専用 maintenance 経路」が再駆動について警戒しているのと同じ「起きるが1行も進まない」状態（張り直しの `min()` が SQL の `min()` の NULL 無視でこの行を拾わず、claim の述語 `next_run_at <= now` にも掛からず、それでも実行可能集合は空でないので `deleteAlarm()` もされない）が、そのまま新規イベント側で起きて backlog だけが伸びる
- OCC の `version` は持たない（非集約ストア）
- `user_id` 列は持たない（構造的テナント分離）。**ただし配送メッセージは宛先 DO の routing key を運ぶ**（「物理境界」の項）
- **保持期間を持つのは `published` だけである。`quarantined` は運用者が再駆動するか明示的に削除するまで恒久保持し、prune は触らない**（隔離の原因を調べる材料そのものなので、運用者が見る前に消える窓を作らない）。`published` の保持期間に掛かる運用値の制約2本は `jobs` の prune の項が持つ
  - **したがって隔離行は自動では減らない。** Queue producer binding の障害などで一斉に隔離が起きると、10 GB へ向かう増加が運用でしか止まらない。これを明示的な運用制約として引き受ける（減らす手段の全数は「operator 専用 maintenance 経路」が持つ）
- **`payload` は 100 KB/文・2 MB/行の内側に収める**（CLAUDE.md「Storage limits」）。イベント行は業務トランザクションと同じ `transactionSync` の中で INSERT されるので、**payload が大きいと業務データの書き込みごと失敗する**（`jobs.payload` は投入点が限られるが、イベントは任意のユースケースから積まれうる）。**大きな材料は payload に載せず、発行元 DO から引き直す**（送信材料 RPC と同じ形）
- **`owner_token` は claim ごと・行ごとに一意で、暗号論的乱数から採る**（列定義）。**同じ起床で claim した複数行に同じ値を書かない** — 共有させると、DLQ に落ちた1件から得た `(event.id, owner_token)` の対で同じバッチの他の行の呼び出しガードを通せる（`event.id` は Queue メッセージにも DLQ にも載る）。**主キーではないので「共通方針」の ID の例外の数え上げには入らない**（例外は `password_reset_tokens.token_id` と `jobs.operation_key` の2つのままである）
  - **行の `owner_token` が `NULL` の呼び出しは、引数の値にかかわらず常に不一致として扱う**（`password_reset_tokens.change_auth_token` と同じ規則）。`owner_token` が `NULL` になるのは正常系で頻出する2状態 — `enqueueEvent` の INSERT 直後から最初の claim までと、上限未到達の失敗で `pending` へ戻された後から次の claim まで — であり、**そこを `NULL` 同士の一致として通す実装は「`event.id` を知る者が送信材料を引ける」ことを意味する。** 引数側の `owner_token` も、**欠落・空文字・規定長（128 bit）未満は照合の前に不一致として扱う**（async/index.md「呼び出しガード」）
- **失敗の記録先は「Queue に入る前か後か」で分かれる。** relay が publish できない失敗はこの表の `quarantined` + `terminal_reason`、consumer の失敗は Queue の retry → DLQ である。**consumer からの ack を発行元 DO へ書き戻さない**（async/index.md「責務分界と DLQ」）
- **DDL 分類は単発適用である**（`CREATE TABLE` + 空テーブルへの `CREATE INDEX`。後述の「単発適用で足りる DDL」）

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

**濫用抑止:**

| カラム | 型 | 制約 |
|---|---|---|
| `failed_attempts` | INTEGER | NOT NULL。既定 0 |
| `next_attempt_allowed_at` | INTEGER | nullable。ロックアウトの解除時刻 |

**リセット依頼のスロットル判定の列はこの表に置かない。** 権威は `reset_request_windows`（後述）ただ1つである — この表の行が置かれるのは登録・予約の経路だけで**未登録の canonical には行が無く**、ここに載せると4ケース一様性が構造的に成立しないからである（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）。**列削除の DDL 分類は「データ量に依存する（分割か回避が要る）」の (i) 側である**（後述）。

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
| `prt_expires_idx` | (`expires_at`) | `sweep-reset-tokens` の期限切れ行の掃除（**同ジョブは `reset_request_windows` の `rrw_expires_idx` も引く。1つの `kind` が2目的を持つ**） |

- `verifyAndConsume` は `token_hash` 一致・`used_at IS NULL`・`expires_at > now` を満たす行を条件付き UPDATE（`used_at = now`）で消費し、0 行更新なら null を返す（並行消費のレースも 1 回に収束）
- OCC の `version` は持たない（集約ではなくアダプター内部のストア）
- **書き込み口は UoW コンテキストの `resetTokenStore` だけである**（ドメイン側のポート名は `PasswordResetTokenPort` で、同じものを指す）。発行・消費・一括削除・期限切れ掃除の4つが書き込み箇所であり、これが全数である
- **削除の射程は経路ごとに違う。** クレデンシャル変更の開始時は「未使用行を全削除し、残る全行の `change_auth_token` を `NULL` にする」の2段、SSO 連携解除と退会はその `credential_id` の行を `used_at` の有無を問わず全削除である
- 新しいトークンの発行は、同じトランザクションでその `credential_id` の未使用行を全削除する

### reset_request_windows

リセット依頼のスロットル窓。**ドメイン側のポート名は `PasswordResetThrottlePort`**（domains/identity.md）で、UoW コンテキスト側のハンドル名は `resetThrottleStore` である（`resetTokenStore` / `PasswordResetTokenPort` と同じ「ハンドル名とポート名が別」の形）。**生のメールアドレスも SSO subject も持たない**ので、この表を新設しても PII は増えない。

| カラム | 型 | 制約 |
|---|---|---|
| `window_key` | TEXT | PK。**対象 canonical の全長 HMAC と依頼の窓から決定的に導く**（導出主体と導出鍵の在り処は下の「窓キーの導出」が正本）。**クライアントから受け取らない** |
| `key_generation` | INTEGER | NOT NULL。**`window_key` を導いた写像鍵の世代**（`credential_mappings.generation` と同じ番号体系であり、`password_reset_tokens.token_key_generation` のリセットトークン鍵の世代とも `credential_mappings.encryption_generation` の暗号鍵の世代とも別である）。**読み手は診断**（後述） |
| `first_requested_at` | INTEGER | NOT NULL。その窓での最初の依頼の時刻 |
| `last_requested_at` | INTEGER | NOT NULL。その窓での最後の依頼の時刻（2回目以降はこの列だけを更新する） |
| `expires_at` | INTEGER | NOT NULL。窓の終端 + 猶予。掃除の駆動源 |

索引:

| 名前 | 定義 | 用途 |
|---|---|---|
| `rrw_expires_idx` | (`expires_at`) | `sweep-reset-tokens` の期限切れ窓行の掃除（`prt_expires_idx` と同じ役割・同じ形） |

- **窓キーの導出。この節が導出規則の正本であり、他のファイルはここを参照する。** `windowKey` は **bucket 選択のために canonical の全長 HMAC を既に計算しているアダプター（Identity Directory の stub を選ぶ側）が、その同じ値を DO facade へプリミティブとして渡し**、ユースケースが窓と合成して組み立てる。**導出鍵はその stub 選択アダプターの中にあり、ユースケースにもポートにも渡らない。** facade が受け取る HMAC は server-side で導出された値であって外部入力ではないので、`CLAUDE.md`「Input validation」の第3の検証点にはならない（**クライアントからは受け取らない**）。合成は keyed な再導出を行わない（鍵付きの部分は HMAC 側で済んでいる）ので、`transactionSync` の中に暗号処理を持ち込まない
  - **合成は一方向である必要はない。** したがって `window_key` と `outbox_events.aggregate_id` は canonical の全長 HMAC を逐語で含みうる。これを受け入れられるのは次の4つによる — (i) 同じ DO の `credential_mappings.hmac` が登録済みクレデンシャルについて同じ値を既に恒久的に持っており、**DO 内部の読み手にとって新しい相関材料ではない**、(ii) 窓行は `sweep-reset-tokens` が掃除する、(iii) **DO の外へ出る経路（Queue メッセージ）には `aggregate_id` を載せない**、(iv) **`list-quarantined-events` も `aggregate_id` を返さない。** **(iii) か (iv) のどちらかを緩めるなら、合成を一方向にする（全長 HMAC と窓を連結したうえで一方向ハッシュを1回通す）ところまで戻る** — 緩めた側では窓で切れない仮名が DO の外へ出る
- **登録の有無に関係なく行を作る。** 4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）のどれでも**同じ1文で読み、同じ1文で書く。行の有無が観測可能な差にならないことが、この表を新設した理由そのものである**
- **書き込み口は UoW コンテキストの `resetThrottleStore` の `claimWindow` ただ1つであり、これが全数である。** その窓の最初の依頼なら行を作って `true`、既存の窓なら `last_requested_at` だけを更新して `false` を返す。**「読み」と「計上」を2つの書き込み箇所として数えない** — 判定と計上は1回の呼び出しで原子的に行われる（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）。戻り値の `boolean` が「イベント行を書くか」と「リセットトークンを発行するか」の**両方を決める唯一の分岐**である。**掃除の `DELETE` は `sweep-reset-tokens`（アダプター）が同じ行に対して行うので口を通らない**（`jobs` / `outbox_events` と同じ形）
- **期限切れ行の掃除は `sweep-reset-tokens` が担う**（新しい `jobs.kind` を足さない）。**投入点は「リセットトークン行または窓行を書くのと同じトランザクション（= `requestPasswordReset` の4ケースすべて）」であり、宛先の登録有無で投入を分けない**
- **窓の長さと `expires_at` の猶予は運用値であり、実値の確定は #38 である**（`jobs` の件数上限が「#51 が spike で出して #38 が確定する」のと同じ形）。窓の長さは (a) スロットルの強度、(b) この表の行数（= 10 GB 算入分）、(c) `sweep-reset-tokens` の起床頻度を同時に決める。**値の選び方には制約が1本掛かる — `スロットル窓の長さ < リセットトークンの TTL` を満たすこと。** 満たさないと、リンクが期限切れになった利用者が窓の明けるまで再送を得られず、`spec/scenario/account.md` の異常系（「リセットリンクが期限切れの場合、その旨が表示され再送をやり直せる」）と衝突する。**この制約は配送の運用値の制約2本（`jobs` の prune の項 / async/index.md「運用値の制約」）の外側にある別の1本であり、あちらの「2本で全数」を開かない**
  - **窓の長さは単一の設定値であり、`windowKey` の導出（ユースケース側）と `expires_at` の算出（アダプター側）が同じ値を読む。2箇所に別々の定数を置かない。** 同じ運用値が2層で必要になるのは、`claimWindow(windowKey, now)` が窓長を引数に取らないからである。ズレると静かに壊れる — アダプター側が短いと、まだ有効な窓の行が `sweep-reset-tokens` に消され、`claimWindow` が同じ窓で2度目の `true` を返す（下の世代跨ぎで例外的に許容している破れが、設定ミスで恒常化する）
  - **窓の中で配送が `quarantined` / DLQ に落ちた場合、その窓のあいだ利用者は1通も受け取れないまま再送も得られない**（2回目以降の依頼は `claimWindow` が `false` を返すのでイベント行を書かない）。復旧は operator 経路（隔離行の再駆動 / DLQ の再駆動）だけである
    - 隔離行の再駆動が**有効なリンクを届けられるのはリセットトークンが TTL 内のときだけ**である。`quarantined` は恒久保持なので、DLQ 側の運用値の制約に相当する束縛を置けない（束縛の相手は operator の反応時間であって設定値ではない）。TTL を過ぎてからの再駆動は送信材料 RPC が `nothing-to-send` を返し、利用者側の復旧は窓が明けてからの再依頼になる。**これは窓の運用値と同じ「外側の注記」であり、配送の運用値の制約2本（`jobs` の prune の項 / async/index.md「運用値の制約」）の「2本で全数」を開かない**（縛る対象が設定値ではなく operator の反応時間なので、3本目の不等式としては書けない）
- **`key_generation` の読み手は診断である** — 索引にも `claimWindow` の述語にも現れない（世代は既に `window_key` へ畳み込まれているので PK にも入らない）。運用者が「どの写像鍵世代で導かれた行か」を判別するために持つ。旧世代の行は誰にも引かれないまま `expires_at` で掃除されるので、**世代を述語にした一括削除は置かない**
  - **写像鍵の世代が進むと、同じ canonical・同じ時間窓でも `window_key` が別値になる**ので、同じ窓に2世代の行が併存し、**その窓のスロットルが一度だけリセットされる** — 新世代側の `claimWindow` が `true` を返し、未使用トークンの全置換（= 利用者の手元のリンクが死ぬ）と2通目のメールが起きうる。**これを許容する。** ローテーションは operator 起動の稀事象で、窓は分オーダー、破れは世代の前進1回ぶんに限られる一方、世代跨ぎの探索を `claimWindow` の契約へ入れると旧世代キーの再導出をアダプターへ要求することになり、釣り合わない
  - **世代を進める主体は #44（写像鍵のローテーション）である。** `rotate-encryption` はメール暗号鍵の世代を進めるジョブであり、この列は動かさない
- **行は依頼回数ではなく窓の数に比例して増える。** ただし**未登録アドレス宛の依頼でも行が増える**ので、**掃除が追いつかない、または窓の中で distinct なアドレスが大量に撒かれると** 10 GB 上限へ向かって伸び続ける（`requestPasswordReset` は未認証で叩け、窓キーは canonical ごとに独立なので、**canonical 単位のスロットルは異なるアドレスを撒く経路を抑止しない**）
  - **逼迫の影響はこの bucket に写像を持つ全ユーザーへ及ぶ。** Identity Directory DO は bucket 共有であり、逼迫した DO は書き込みだけが失敗するので、**同じ bucket の他ユーザーの新規登録・クレデンシャル変更・リセット依頼が巻き添えで止まる**（User Data DO の 10 GB と違い、単独ユーザーに閉じた話ではない）。発信元単位のレート制限は transport 境界の責務であり、本ファイルの範囲外である（#38 / #51）
- OCC の `version` は持たない（非集約ストア）
- **DDL 分類は単発適用である**（`CREATE TABLE` + 空テーブルへの `CREATE INDEX`。後述）

### jobs（Identity Directory DO）

User Data DO 側と**同じ11列・同じインデックス・同じ規則**である。job table と Alarm の実装は2クラスで共有する。違うのは `kind` の値域だけで、`resume-signup` / `resume-credential-change` / `sweep-reservations` / `sweep-reset-tokens` / `rotate-encryption` の5種である（全数表は [async/index.md](../async/index.md) を参照）。

### outbox_events（Identity Directory DO）

User Data DO 側と**同じ13列・同じインデックス・同じ規則**である。Outbox relay の実装も2クラスで共有する。違うのは `type` の値域だけで、こちらは `identity.passwordResetRequested` の1種である（全数表は [async/index.md](../async/index.md) を参照）。**User Data DO 側のイベント型は初期0件だが、表と機構は両クラスに置く**（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）。

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
- **順位付けは `bm25` で行い、タイトルを本文より重く見る重み付けを行う。裏付けは実測**（公式ドキュメントに記載は無い）。**重みとページサイズの実値は本ファイルに固定しない** — 実装側が持ち、#51 が実環境で再検証して結果を spec へ反映する
- トークナイザや正規化規則を変えたときの全件再構築は migration の `reindex` ジョブが担う（次節）

## スキーマバージョンと lazy migration

### `_meta.schema_version` とゲート関数

- **持ち方は `_meta` の単一行の `schema_version`（整数）である。** KV ではなく SQL 側に置くのは、migration の適用とバージョンの更新を**同じトランザクションで確定させる**ためである
- **起動タイミングは、DO の全 RPC エントリおよび `alarm()` の先頭に置いた冪等なゲート関数である。** `alarm()` を RPC と同格に扱うのは、アクセスの無い利用者の User Data DO が次に起きる契機が `purge-trash` の Alarm しか無いからである（**Identity Directory DO ではこれに outbox relay の起床が加わる**）。ゲートを RPC だけに置くと、古いスキーマのまま新コードのジョブ実行部が走る
- 例外は operator 専用の診断エントリ2本（`read-schema-version` / `list-bucket-user-ids`）だけで、**それが全数である**。どちらも1行も書かず、スキーマの形に依存しない値だけを読むので、未 migrate の DO を壊す経路が無い
- **`blockConcurrencyWhile` は使わない。** 30秒でタイムアウトして DO をリセットするので、10 GB まで育った DO のスキーマ変更が1回のコールバックで終わる保証が無い
- **代わりの排他条件を置く。ゲート関数は同期関数とし、`schema_version` の読み取りから全 DDL ステップの適用まで `await` を1つも挟まない。** これで input gate が排他を保証する。`await` が1つでも入ると並行 RPC が割り込み、順序依存のあるステップ（列追加 → 値の充填 → 索引作成）の途中の観測が壊れる
- `alarm()` の順序を固定する。**(1) Alarm の再武装 + 永続化の確認 → (2) 本ゲート → (3-a) outbox relay パス → (3-b) jobs パス → (4) 両表から再計算して張り直す** である。(1) の待機はゲートに入る前に完了するので、上の排他条件は破れない
  - **relay をゲートの中に入れられないのは、ゲートが `await` を1つも挟まない同期関数だからである**（上の排他条件）。relay は相 2 で `queue.send()` を await するので、必ず (3-a) に来る
  - **(3-a) と (3-b) は毎回の起床で両方を必ず1回通し、件数上限は各パスが独立に持つ**（片方の滞留がもう片方を飢えさせないため。「Alarm の多重化」）

### 単発適用で足りる DDL と、分割・回避が要る DDL

- **データ量に依存しない（単発適用で足りる）**: `CREATE TABLE`、**制約を伴わない** `ALTER TABLE ADD COLUMN` / `RENAME`
- **データ量に依存する（分割か回避が要る）**: (i) CHECK 制約付きの列追加・NOT NULL の生成列追加・列削除、(ii) **`CREATE INDEX`**（索引構築は全行走査 + ソートである）
- **索引は原則としてテーブル新設時に同時に張る**（空テーブルへの `CREATE INDEX` は安い）。既に大きく育ったテーブルへ索引を足す必要が生じたら、`CREATE INDEX` を直接発行せず「**索引つきの新テーブルを作る → `migrate-bulk` で行をコピーする → 参照を切り替える → 旧テーブルを落とす**」という多段の forward-only migration へ分解する。SQLite では `CREATE INDEX` をチャンク分割できないので、逃がし先がこれしか無い
- **本改訂で実際に生じる DDL 差分は0件である。** 本ファイルの実装先はまだ配備されていない（#51 が新設する DO のアダプター。冒頭）ので、**#51 は改訂後の形で `CREATE TABLE` する** — `jobs` は最初から11列、`credential_mappings` は最初からリセット依頼スロットル列なしで作られ、`ALTER TABLE DROP COLUMN` は1回も発行されない。**以下の3件は、配備後に同じ変更を行う場合の分類である。**
  - **`outbox_events`（両クラス）と `reset_request_windows` の追加は単発適用である。** `CREATE TABLE` はデータ量に依存せず、索引も**空テーブルへの `CREATE INDEX`** なので安い。**`migrate-bulk` は行のコピーのための機構であり、コピーすべき行が0件のここでは出番が無い。** DO 全体が 10 GB まで育っていても、新設・空の表には関係しない（上の多段分解は「**既に大きく育った既存テーブル**へ索引を足す」場合の逃がし方であって、本件には当たらない）
  - **`jobs` からの、外部プロバイダへ渡す冪等キーの列の削除は (i) の列削除に当たる。**
  - **`credential_mappings` からのリセット依頼スロットル列の削除も (i) の列削除に当たる。** 新テーブル追加側だけ分類を書いて列削除側を書かないのは非対称なので、両方を書く
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
- **fail-closed の DO は relay もしない。** ゲートで戻るので `alarm()` の (3-a) に到達せず、`outbox_events` の行が滞留する。**滞留は失われた配送ではない** — 行は残り、コードが揃った次の起床で流れる
- **逆向きは非対称なので両方を書く。** fail-closed になる**前に** publish 済みのメッセージは Queue に残っており、consumer がそれを処理しようとすると**送信材料 RPC が本ゲートで `SystemError` を返し、Queue の retry を焼き切って DLQ へ落ちる。** デプロイのスキュー期間に限られるが、**DO 側の滞留が「失われない」のとは挙動が違う。** 復旧は DLQ の再駆動である（async/index.md「fail-closed の DO と DLQ の相互作用」）
- 射程から外れるのは診断エントリ2本だけである。fail-closed で止まっている DO の存在は運用側がメトリクスで検知する（#38）

### ロールバック方針

- **データのロールバックは行わない。** スキーマは forward-only で、下方向の migration を書かない
- コードのロールバックは可能だが、そのとき `schema_version` が進んでいれば fail-closed で止まる。**したがってスキーマを進める migration を含むリリースは、ロールバック不可のリリースとして扱う**
- **代替手段は PITR である**（object 単位・過去30日）。ただし**復旧単位は DO 1個であり、複数 DO を同一時点へ戻す手段は無い**
- **PITR は「対象を知っている場合の復旧手段」であって「対象を発見する手段」ではない。** DO の内部 ID から `userId` へは戻せないので、影響範囲は Identity Directory bucket の全走査（`list-bucket-user-ids` で `userId` を集め、`read-schema-version` で1つずつ確かめる）でしか作れない
- **現実的な防御線は PITR ではなく、fail-closed と部分適用の記録である。** PITR は個別救済の最後の手段であり、全ユーザー規模の巻き戻しを PITR で行う想定を持たない
- **PITR は失効を巻き戻す。** User Data DO を戻すと `session_epoch` と `ai_client_connections.status` が過去へ戻り、Identity Directory bucket を戻すと消費済み・削除済みのリセットトークン行が復活する。したがって復旧には必須ステップが伴う — User Data DO 側は `session_epoch` を現在時刻由来の十分大きな単調値へ進め、`ai_client_connections` を全件 `revoked` にする。Identity Directory bucket 側は `password_reset_tokens` を全行削除し、`failed_attempts` を 0・`next_attempt_allowed_at` を過去へ戻す。**復旧できないなら全部切るのが既定である。手順・承認・監査の実体は #38**
- **PITR は配送も巻き戻す。** `outbox_events` の `published` が `pending` に戻るので、**再 relay で重複配送になる。** at-least-once なので正しさは壊れないが、復旧の手順には「戻した時点以降に publish 済みだったイベントが再配送される」ことを織り込む。**巻き戻し後の再配送が利用者に何を届けるかは、上の必須ステップとの実行順序に依存する** — `password_reset_tokens` を全行削除した後の再配送は送信材料 RPC が引く行を持たないので**すべて `nothing-to-send` になる**（配送の重複は無害だが、利用者へは何も届かない）。同じリンクが再送されうるのは、必須ステップを実行する前に Alarm が起きた場合だけである
  - **`owner_token` も巻き戻る。** 終端時に `NULL` にしない列なので、巻き戻し前に Queue / DLQ へ出ていた `(event.id, owner_token)` の対が再び呼び出しガードを通りうる（`outbox_events` の capability の項）。露出窓を閉じるには operator 経路の再駆動（`owner_token` を採番し直す）を通す
  - **`reset_request_windows` も巻き戻るので、スロットルの窓が過去の状態に戻る。** こちらは順序に依存せず効く副作用である — `claimWindow` が同じ窓で `true` を返し、未使用トークンの全置換（利用者の手元のリンクが死ぬ）と2通目の発行が起きうる
- 退会済みアカウントの DO と、その credential が載っていた bucket への PITR 実行は禁止し、承認手続きの対象とする（両方を戻すと退会済みアカウントが復活するため。**退会は PITR 保持期間が経過して初めて不可逆になる**）
- **エクスポートは PITR の代替ではない。** ゴミ箱を除外し最新リビジョンのみを返すので、復旧用のバックアップとしては不完全である

## OCC の `version` を持つテーブル / 持たないテーブル

**持つのは集約ルートの6つだけである。**

| 区分 | テーブル |
|---|---|
| 持つ（集約ルート） | `account` / `user_settings` / `ai_client_connections` / `memos` / `topics` / `documents` |
| 持たない（不変の子行） | `memo_revisions` / `document_revisions` / `source_links` |
| 持たない（派生データ） | `search_entries` / `search_fts` |
| 持たない（非集約ストア9つ） | `jobs` / `outbox_events` / `operations` / `migration_progress` / `credential_locators` / `password_reset_tokens` / `reset_request_windows` / `rotation_checkpoints` / `_meta` |
| 持たない（CAS で直列化） | `credential_mappings` |

- 非集約ストアの更新は専用の CAS（`owner_token` / `operation_id` / 置換キー）で守られるので、汎用の OCC を重ねない
- **`account` は集約ルート側であり、非集約ストアではない。** ドメイン側の口の名前が `AccountStore` であることは分類を変えない（domains/identity.md）。非集約ストアの全数は上表の9つで、`account` はそこに入らない
- **非集約ストアへの書き込み口は各テーブルの節が持ち、口を持つのは8ストア・9メソッドである** — `enqueueJob`（`jobs`）/ `enqueueEvent`（`outbox_events`）/ `recordOperation`・`updateOperation`（`operations`。ここだけ2つ）/ `setMigrationCursor`（`migration_progress`）/ `credentialLocatorStore`（`credential_locators`）/ `resetTokenStore`（`password_reset_tokens`）/ `resetThrottleStore`（`reset_request_windows`）/ `rotationCheckpointStore`（`rotation_checkpoints`）。**`_meta` だけが口を持たない**（アダプター専用）
- **OCC 不一致は握り潰さない。** `ConflictError("OPTIMISTIC_LOCK_FAILURE")` はユースケースを通ってトランスポート境界（ジョブの中なら `terminal_reason`）まで届く。アプリケーション層の OCC リトライデコレーターは置かない（CLAUDE.md「Retry strategy」）

## operator 専用 maintenance 経路

ジョブが一様な終端（`terminal_reason` + `poison`）に達したときのエスカレーション先として、**operator 専用の maintenance 経路が存在する**。`purge-user-mappings`（退会の最後の砦）と `cancel-reservation`（新規登録の予約の取り消し）の2つで、どちらも `jobs.kind` の11種には入らない（ジョブではなく RPC である）。診断用の `read-schema-version` / `list-bucket-user-ids` と、`rotate-encryption` の起動（全数表が名指しする唯一の投入点）も同じ経路に属する。**到達制御・監査ログ・運用手順の実体は #38 が定める。**

**`outbox_events` の `quarantined` に対する導線も同じ経路に属する** — `list-quarantined-events`（一覧）と `requeue-quarantined-event`（`pending` へ戻す再駆動）である。**どちらも `jobs.kind` にも `event.type` にも入らない**（ジョブでもイベントでもなく RPC である）。**consumer 側の失敗の導線はここではなく DLQ ハンドラである**（責務分界は「Queue に入る前か後か」の1本。async/index.md）。

**`list-quarantined-events` が返す列を確定させる。** 返すのは `event.id` / `type` / `attempt` / `created_at` / `completed_at` / `terminal_reason` であり、**`owner_token` と `payload` と `aggregate_id` は返さない。** 外す理由は列ごとに違う — `owner_token` は再駆動直後の行に対して**持参人証**になりうる（送信材料 RPC の呼び出しガードは `(event.id, owner_token)` の対だけで通る。async/index.md「呼び出しガード」）、`aggregate_id` は窓キーであり `quarantined` 行では恒久保持なので**窓をまたいで宛先を相関させる材料**になる（`reset_request_windows`「窓キーの導出」の (iv)）、`payload` は隔離の原因を読むための列ではない（それは `terminal_reason` である）ので、返す理由が無い。

**`requeue-quarantined-event` が書く列を確定させる。** 同じトランザクションで `status='pending'` / `next_run_at = 現在時刻` / `attempt = 0` / `completed_at = NULL` の4つを書き、`terminal_reason` は残し、`owner_token` は採番し直す。**そのトランザクションのあと、4本の min の合成で `setAlarm` を張り直す。**

- **`setAlarm` の張り直しは省けない。** `quarantined` は実行可能集合に入らないので（「Alarm の多重化」）、**隔離行しか残っていない DO は定義上 `deleteAlarm()` 済みである** — これはまさに operator が再駆動する典型的な状況であり、張り直さないと「行は `pending` に戻ったが誰も起こさない」という、下の「起きるが1行も進まない」より静かな停止になる。ユースケース側の投入点が `enqueueJob` / `enqueueEvent` と同じトランザクションのあとに起床を張るのと同じ規約であり、この経路だけを例外にしない。**`list-quarantined-events` は読みのみなので張り直さない**
- **`next_run_at` を書かないと再駆動が黙って空振りする。** 終端時に `NULL` にされる列なので（`outbox_events` の「分離する規約」3.）、`status` だけ戻すと (1) Alarm の張り直しの `min(outbox_events.next_run_at)` が SQL の `min()` の NULL 無視でこの行を拾わず、(2) claim の対象を選ぶ述語（`next_run_at <= now`）にも掛からず、(3) それでも実行可能集合は空でないので `deleteAlarm()` もされない、という「起きるが1行も進まない」状態が残る。`attempt` の 0 復帰は `jobs` の収束規則 (2)（`poison` → `pending`）と同じ形である。**`completed_at` の `NULL` 復帰のほうは `outbox_events` 側で明示的に定める規約であり、`jobs` の収束規則 (2)(3) が書く列には含まれていない** — 同名・同意味の列なので不変条件（終端でない状態では `NULL`）は両表に掛かるが、**`jobs` 側の逆向き遷移で `completed_at` をどう扱うかは本ファイルの現行の規則が定めておらず、そこを本 PR は動かしていない**。`outbox_events` の再駆動については、上の4列がこの表の全数である
- **`terminal_reason` は残す。** これも `jobs` の収束規則 (2) と同じで、隔離の原因は再駆動の後も運用者が読む唯一の記録である（次の失敗で上書きされる）
- **`owner_token` は再採番する** — 列の生成要件が「claim ごと・行ごとに一意な暗号論的乱数」である以上、終端後も残っている古い値を再駆動が引き継ぐ理由が無い。再採番すると、隔離前に Queue / DLQ へ渡っていた `(event.id, owner_token)` の対が呼び出しガードの 3.（`owner_token` の一致。async/index.md）で弾かれ、持参人証としての露出窓がその時点で閉じる。**副作用として、同じイベントの古い DLQ メッセージを再駆動すると `nothing-to-send` になる** — ただし行そのものは次の claim（そこでも `owner_token` は採番し直される）と publish で配送されるので、**配送は失われない。** 2つの operator 導線を同じイベントに対して両方回しても二重送信にはならない
- **`quarantined` の行を減らす手段は、この再駆動（`published` へ進めば prune の対象に戻る）と operator による明示削除の2つだけであり、自動では減らない**（`outbox_events` の「その他」/ 「物理境界」の 10 GB の項）。**明示削除の口は本ファイルでは名前まで確定させない** — 到達制御・監査ログ・運用手順と同じく、maintenance 経路の実体は #38 が定める

## 本ファイルで定義しないテーブル

- **OAuth 2.1 の `jti` 一回性テーブル。** 認可コードは署名済みの自己完結値なので永続化せず、User Data DO に置くのは交換済みコードの `jti` を短期間だけ記録する表だけである。**その定義は #13「AIクライアント接続（OAuth認可・一覧・失効）」の範囲であり、本ファイルでは名前を確定させない。** OCC の `version` は持たない（一回性の記録なので集約ではない）
- **検索の不透明カーソルが指す期限付きスナップショットの物理形。** ドメイン側で決まっているのは契約（同じカーソルからは同じ集合が読める / 期限切れのカーソルは拒否される / カーソルは不透明である。domains/search.md）だけで、**物理形は #51 が決める** — 期限付きの表・DO ストレージの一時キー・安定順位による再実行のいずれでも契約を満たせるうえ、寿命と粒度はストレージ上限に依存する判断だからである

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

jobs / outbox_events / operations             (どのテーブルとも FK なし。共通基盤)
migration_progress

[Identity Directory DO]（bucket 単位）

credential_mappings 1 ─ * password_reset_tokens  (credential_id。FK なし)
jobs / outbox_events / rotation_checkpoints / _meta   (どのテーブルとも FK なし)
reset_request_windows                            (FK なし。canonical との対応は
                                                  HMAC の一致で結ぶ。行を持つことが
                                                  登録の有無を意味しない)

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
| スロットル窓の期限切れ掃除（`sweep-reset-tokens` の第2の目的） | `rrw_expires_idx` |
| ジョブの claim（実行可能集合の最早行） | `jobs_runnable_idx` |
| lease 満了の `running` 行の回収 | `jobs_lease_idx` |
| 完了ジョブの prune | `jobs_completed_idx` |
| relay の claim（実行可能集合の最早行） | `outbox_runnable_idx` |
| lease 満了の `publishing` 行の回収 | `outbox_lease_idx` |
| 配送済み（`published`）イベントの prune | `outbox_completed_idx` |
| Alarm の張り直し（4本の min の合成。「Alarm の多重化」） | `jobs_runnable_idx`（`status='pending'` の `min(next_run_at)`）/ `jobs_lease_idx`（`status='running'` の `min(lease_until)`）/ `outbox_runnable_idx`（`status='pending'` の `min(next_run_at)`）/ `outbox_lease_idx`（`status='publishing'` の `min(lease_until)`） |
| bucket 内の `userId` 列挙（運用の診断経路） | `cm_user_idx` |
| スロットル窓の判定と計上（`claimWindow`） | `reset_request_windows` の PK (`window_key`) |
