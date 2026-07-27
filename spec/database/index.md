# DB設計

fog の本番永続化は Cloudflare Workers の SQLite-backed Durable Objects に集約する。1つの共有DBは持たず、責務ごとに独立した3 classを使う。

- `UserDataDurableObject`: `userId` ごとの個人データ、設定、検索射影、冪等化、永続 job
- `IdentityDirectoryDurableObject`: credential locator shard ごとの credential mapping と reservation
- `AccountHomeDurableObject`: `userId` ごとの account summary、saga、credential reverse locator、削除 tombstone/epoch

request Worker は認証済み canonical `userId` または秘密鍵付き locator から対象を選び、公開入力から object ID / partition key を受け取らない。

## 共通方針

- 各 class は独立した SQLite class として宣言し、`schema_migrations` で forward-only lazy migration を行う
- constructor の `blockConcurrencyWhile` で migration を完了してから RPC / Alarm を受け付ける
- migration は再実行可能で、既知より新しい schema version を検出した場合は fail closed
- DO 内の書き込みは `ctx.storage.transactionSync` に限定し、callback 内へ Promise、RPC、暗号、メール、外部 API を持ち込まない
- 日時は UTC ISO 8601 `TEXT`、boolean は `INTEGER` 0/1、ID は検証済み `TEXT`
- SQL parameter数、batch件数、CPU時間、query UTF-8 byte数に明示上限を置く
- `SQLITE_FULL` は `StorageCapacityExceeded` に変換し、自動 retry しない
- transaction 内の FK を有効化する。加えて repository contract と unique/check constraint で不変条件を守る
- 共有DB向けの OCC guard や非同期配送テーブルは持たない。1 object 内の入力は直列化され、複合変更は同期 transaction で確定する

## 共通テーブル

各3 classに次を持つ。

### schema_migrations

| 列 | 型 | 制約 |
|---|---|---|
| version | INTEGER | PRIMARY KEY |
| name | TEXT | NOT NULL |
| applied_at | TEXT | NOT NULL |

### idempotency_records

mutation RPC を公開する class に置く。

| 列 | 型 | 制約 |
|---|---|---|
| operation_id | TEXT | PRIMARY KEY |
| operation_kind | TEXT | NOT NULL |
| request_hash | TEXT | NOT NULL |
| result_json | TEXT | NULL |
| status | TEXT | NOT NULL CHECK (`pending`,`completed`,`failed`) |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

同じ `operation_id` と異なる request hash の組み合わせは conflict。completed の再送は保存済み結果を返す。

## UserDataDurableObject

object name は canonical `userId` から request Worker が決定する。object 内のテーブルに `user_id` を重複保持せず、別ユーザーを指定するクエリも提供しない。

### profiles

| 列 | 型 | 制約 |
|---|---|---|
| singleton | INTEGER | PRIMARY KEY CHECK (`singleton = 1`) |
| display_name | TEXT | NULL |
| version | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

### settings

| 列 | 型 | 制約 |
|---|---|---|
| singleton | INTEGER | PRIMARY KEY CHECK (`singleton = 1`) |
| trash_retention_days | INTEGER | NOT NULL CHECK (`>= 1`) |
| version | INTEGER | NOT NULL DEFAULT 0 |
| updated_at | TEXT | NOT NULL |

### ai_client_connections

| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PRIMARY KEY |
| client_name | TEXT | NOT NULL |
| status | TEXT | NOT NULL CHECK (`active`,`revoked`) |
| connected_at | TEXT | NOT NULL |
| last_used_at | TEXT | NULL |
| revoked_at | TEXT | NULL |
| version | INTEGER | NOT NULL DEFAULT 0 |

token material は外部 token adapter が所有し、この表は認可の事実だけを保持する。

### memos / memo_revisions

`memos`:

| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PRIMARY KEY |
| body | TEXT | NOT NULL |
| posted_at | TEXT | NOT NULL |
| trashed_at | TEXT | NULL |
| version | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

`memo_revisions`: `(memo_id, revision_number)` PRIMARY KEY、全文 `body`、actor kind/id/name、`created_at`。親の hard delete で cascade。

### topics

| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PRIMARY KEY |
| name | TEXT | NOT NULL |
| description | TEXT | NOT NULL |
| archived | INTEGER | NOT NULL DEFAULT 0 |
| trashed_at | TEXT | NULL |
| version | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

### documents / document_revisions

`documents`:

| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PRIMARY KEY |
| topic_id | TEXT | NOT NULL REFERENCES topics(id) |
| title | TEXT | NOT NULL |
| body | TEXT | NOT NULL |
| trashed_at | TEXT | NULL |
| trashed_with_topic_id | TEXT | NULL |
| version | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

`document_revisions`: `(document_id, revision_number)` PRIMARY KEY、全文 title/body、change reason、actor、`created_at`。親の hard delete で cascade。

### source_links

| 列 | 型 | 制約 |
|---|---|---|
| document_id | TEXT | REFERENCES documents(id) ON DELETE CASCADE |
| memo_id | TEXT | REFERENCES memos(id) ON DELETE CASCADE |
| linked_at | TEXT | NOT NULL |

PRIMARY KEY `(document_id, memo_id)`。メモ hard delete 時は link を transaction 内で消し、影響する document projection を同時更新する。

### search_entries / FTS

`search_entries` は検索結果DTOの事実データを持つ。

| 列 | 型 | 制約 |
|---|---|---|
| rowid | INTEGER | PRIMARY KEY |
| entity_type | TEXT | NOT NULL CHECK (`memo`,`document`) |
| entity_id | TEXT | NOT NULL |
| title | TEXT | NULL |
| body | TEXT | NOT NULL |
| timestamp | TEXT | NOT NULL |
| topic_id | TEXT | NULL |

UNIQUE `(entity_type, entity_id)`。

`search_entries_fts` は contentless FTS5 virtual table とし、`title`, `body` を `tokenize='trigram'` で索引化する。アプリケーション trigger は使わず、transaction-scoped `SearchProjectionPort` が本体変更と同じ `transactionSync` で両表を更新する。

`search_entry_sources(entity_type, entity_id, source_entity_type, source_entity_id)` は result DTO の source links と topic scope の join 用。ゴミ箱項目への link は射影しない。

1〜2 byte の短語は専用のエスケープ済み fallback query を使い、入力文字列をSQLへ連結しない。

### jobs

外部 I/O と retention のみを扱う。検索射影には使わない。

| 列 | 型 | 制約 |
|---|---|---|
| id | TEXT | PRIMARY KEY |
| kind | TEXT | NOT NULL |
| payload_json | TEXT | NOT NULL |
| status | TEXT | NOT NULL CHECK (`pending`,`leased`,`completed`,`poison`) |
| attempt | INTEGER | NOT NULL DEFAULT 0 |
| next_run_at | TEXT | NOT NULL |
| lease_until | TEXT | NULL |
| owner_token | TEXT | NULL |
| provider_idempotency_key | TEXT | NOT NULL |
| poison_reason | TEXT | NULL |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

索引は `(status, next_run_at)` と `(lease_until)`。claim は期限切れ lease を reclaim できる。完了/再試行は `owner_token` の CAS で行う。

job mutation と最早 `next_run_at` の読取を同じ transaction の戻り値にし、commit 後に `await ctx.storage.setAlarm()` する。設定失敗時は次の DO input gate で再計算する。

## IdentityDirectoryDurableObject

正規化 credential を request Worker の versioned HMAC keyring で locator 化し、固定 bucket/generation の Directory DO へ送る。canonical credential は rotation 用 sensitive field であり、object name、ログ、監査イベントに出さない。

### credential_mappings

| 列 | 型 | 制約 |
|---|---|---|
| locator | TEXT | PRIMARY KEY |
| credential_kind | TEXT | NOT NULL CHECK (`email`,`sso`) |
| canonical_value_encrypted | TEXT | NOT NULL |
| user_id | TEXT | NULL |
| account_home_locator | TEXT | NOT NULL |
| state | TEXT | NOT NULL CHECK (`reserved`,`initialized`,`active`,`tombstoned`) |
| operation_id | TEXT | NOT NULL |
| generation | INTEGER | NOT NULL |
| reservation_expires_at | TEXT | NULL |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

- email locator は正規化 email から生成する
- SSO locator は provider と subject の境界を保った canonical value から生成する
- active mapping の credential key は全 shard で一意
- reservation の競合は既存 active mapping、または決定順で最小 operation ID を勝者にする

### directory_reconcile_jobs

reservation/initialization の途中失敗を再開する永続状態。`operation_id`、account home locator、phase、attempt、next run、last errorを持ち、Directory Alarm が Account Home の operation/epoch と User Data 初期化状態を照合する。

### rotation_checkpoints

operator-only maintenance binding が全固定 bucket を走査するための generation/bucket別 checkpoint、scanned/moved/conflict countを持つ。active/previous の両 locator を lookup し、全 previous mapping と reverse locator が0件になるまで旧鍵を破棄しない。

## AccountHomeDurableObject

object name は `userId` の opaque representation から決定する。DirectoryとUser Dataを跨ぐ saga の権威。

### account_summary

| 列 | 型 | 制約 |
|---|---|---|
| singleton | INTEGER | PRIMARY KEY CHECK (`singleton = 1`) |
| status | TEXT | NOT NULL CHECK (`initializing`,`active`,`deleting`,`deleted`) |
| primary_email_locator | TEXT | NULL |
| auth_summary_json | TEXT | NOT NULL |
| session_epoch | INTEGER | NOT NULL DEFAULT 0 |
| operation_epoch | INTEGER | NOT NULL DEFAULT 0 |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

`auth_summary_json` は確定済み credential の種別だけを保持し、password hash、email、SSO subject を持たない。

### credential_locators

| 列 | 型 | 制約 |
|---|---|---|
| locator | TEXT | PRIMARY KEY |
| credential_kind | TEXT | NOT NULL |
| directory_bucket | INTEGER | NOT NULL |
| generation | INTEGER | NOT NULL |
| state | TEXT | NOT NULL CHECK (`pending`,`active`,`unlinking`,`tombstoned`) |
| operation_id | TEXT | NOT NULL |

### identity_operations

signup、password change/reset、SSO link/unlink、delete の再開可能な saga state。

| 列 | 型 | 制約 |
|---|---|---|
| operation_id | TEXT | PRIMARY KEY |
| kind | TEXT | NOT NULL |
| phase | TEXT | NOT NULL |
| payload_json | TEXT | NOT NULL |
| status | TEXT | NOT NULL CHECK (`pending`,`completed`,`failed`) |
| epoch | INTEGER | NOT NULL |
| last_error | TEXT | NULL |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

同じ operation ID の再送は同じ phase から再開する。最後の login credential は unlink できず、primary email は active email credential を指す。

### deletion_tombstone

退会開始時に `operation_epoch` を単調増加して先に `deleting` を永続化する。削除完了後は credential/email/auth summary/reverse locator を消し、非PIIの opaque key、status、epoch、completed_at だけを残す。この現行 tombstone/epoch が Directory/User Data 復旧より常に優先する。

## RPC と復旧境界

- RPC は versioned primitive DTO と `{ ok: true, value } | { ok: false, error: SerializedError }` のみ
- mutation は request 境界で生成・再利用する `operationId` が必須
- callback、repository、custom error instance を RPC 越しに渡さない
- User Data / Identity Directory は staging の disposable object で PITR smoke を行う
- Account Home は restore 対象外。operator tooling は class/namespace allowlist で拒否する
- Directory/User Data restore の前後で現在の Account Home tombstone/epoch を照合し、削除済み状態を復活させない

## リレーション

3 DO class 間に DB 外部キーは張らない。`userId`、opaque locator、operation ID、epoch と再開可能 saga で整合させる。各 class 内の参照整合性だけを SQLite transaction と FK で保証する。
