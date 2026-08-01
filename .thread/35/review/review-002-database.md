# レビュー 002 — DB 設計・永続化アダプター

**対象:** PR #46 / Issue #35 / ベース `main` / `HEAD` = `888377d`
**ラウンド:** 2（1ラウンド目の Blocker 10 / Warning 27 はすべて `fix` 済み。`.thread/35/review/triage.md` の判定済み Key は再審議しない）
**変更ファイル:** 97件（全量をカバレッジ表で 1 対 1 に記録した）

## 受け入れ基準の検証

`.thread/35/plan.md` の検証コマンドを逐語実行した。

| AC | 検査 | 結果 |
|---|---|---|
| AC-2 | `V-2a`（`libSQL` / `Turso` / `PendingBatch` / `occ_guard`）| **0 行** ✅ |
| AC-2 | `V-2b`（`\bD1\b`。`manual-tests/{search,trash}.md` 除外）| **0 行** ✅ |
| AC-2 | `V-2c`（除外2ファイルの旧ランタイム語）| **0 行** ✅ |
| AC-7 (i) | `P-10`（設計 第4.1.1節のテーブル全数 19）| **`TABLE-MISSING` 0 行** ✅ |
| AC-7 (ii)(iii) | `P-3`（`schema_version` / `migration_progress` / `forward-only` / `fail-closed` / `PITR`）| 22 行 / 18 行 ✅ |
| AC-7 (vi) | `P-2`（`trigram` 6 / `NFKC` 3 / `instr(` 2 / `不透明カーソル` 1 / `FTS5` 11）| すべて 1 以上 ✅ |
| AC-7 (vii) | `P-9`（12種が CLAUDE.md と `spec/database/index.md` の両方に）| **`KIND-MISSING` 0 行** ✅ |
| AC-8 | `V-6`（`Reference runtimes` / `drizzleSqlite`）| **0 行** ✅（`spec/database/index.md:3` は `CLAUDE.md「Reference runtime」`、CLAUDE.md の見出しは `## Reference runtime`）|
| AC-9 | `P-8`（台帳の「定義場所」アンカーの実在検査）| **`DANGLING` / `NOFILE` 0 行** ✅ |
| AC-9 | 欠番規約 | ✅（下記）|

### 列の全数（`P-10` が検出できない側）を原文と突き合わせた結果

`P-10` はテーブル名しか見ないので、設計 `.thread/34/design.md` 第4.1.1節（`:530-547`）の**列**を1テーブルずつ手で突き合わせた。**欠落は 0 件**である。

- `account` 6列（+ `created_at` / `updated_at`）/ `user_settings` / `credential_locators` 9列 / `ai_client_connections` 9列 / `jobs` 12列 / `operations` 7列 / `migration_progress` 4列 / `_meta` 2列 / `credential_mappings` 24列（識別4・写像2・認証材料5・PII 3・濫用抑止3・saga 6・`caller_token` 1）/ `password_reset_tokens` 8列 / `rotation_checkpoints` 8列 — **すべて spec 側に存在する。**
- 設計 第4.1.1節が言う「User Data DO 16 + Identity Directory DO 5 = 21セル / 名前の異なり数 19」も `spec/database/index.md:34-56` の一覧表と一致する。

### 欠番規約（AC-9）

`origin/main` の `ADP-*` 85件と `HEAD` の 99件を集合比較した。

- **消えた 13 件**（`ADP-search-002`〜`009` / `ADP-search-embeddings-001` / `ADP-occ-guard-001` / `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-trash-004`）は**どれも再利用されていない**。
- **新設 26 件**はすべて既存の最大番号の後ろに採番されている（`ADP-identity-017`〜`025` / `ADP-trash-005`・`006` / `ADP-memo-014` / `ADP-knowledge-028`・`029` ほか）。**繰り上がりは 0 件。**
- 設計 第4.3節が #35 へ送った「`ExportRenderer.render` に `ADP-*` が無い」も `ADP-export-003` として採番済み。

### `.thread/34/handoff.md` 第3節の前方互換点4点

| # | 内容 | 落ち先 |
|---|---|---|
| 1 | `operations.target_locators` を終端の各段が終わるまで消さない | `spec/database/index.md:504` / `ADP-operations-001` ✅ |
| 2 | コーディネーター予約行を終端の各段が終わるまで消さない | `spec/database/index.md:616` / `ADP-credential-mappings-001` ✅ |
| 3 | `account.caller_token` を退会完走時以外に消さない（否定形）| `spec/database/index.md:71` / `ADP-account-001` ✅ |
| 4 | `credential_mappings.change_state` を3値で実装する | `spec/database/index.md:562` / `ADP-credential-mappings-001` ✅ |

**4点とも spec に落ちている。**

### `#45` の射程の先取り

`spec/database/index.md:460`（巻き戻しの具体）/ `:616`（掃除と終端の関係）/ `spec/usecases/identity.md:530`（終端の具体的手順）はいずれも #45 へ明示委譲しており、**段の順序・原子性境界・終端モードの印・再試行上限を書いた箇所は無い**。先取りは検出されなかった（ただし W-001 を参照）。

## Blockers

### **[B-001]** `jobs.operation_key` が「単一 `TEXT` 主キー = UUIDv7（`IdGenerator`）」規則の例外として宣言されていない

**場所:** `spec/database/index.md:24`（共通方針「ID」）と `:431` / `:453-457` / `:440`、`spec/usecases/identity.md:208`

**理由:** 1ラウンド目（B-009 の修正）で共通方針の「ID」節が**排他的な形へ書き直された** — 「単一の `TEXT` 列を主キーに持つテーブルでは、その値は UUIDv7 等（生成は `IdGenerator` ポート）とし（**例外は `password_reset_tokens.token_id`** で、こちらは時刻由来を避けた暗号論的乱数の不透明値である）」。

`jobs.operation_key` は単一の `TEXT` 主キー（`:431`）だが、その値は UUIDv7 ではない。同じファイルの `:456` が「**定数 `operation_key` を持つこれら**が1回完走した時点で…」と書き、`:440` が「`provider_idempotency_key` は `operation_key` から**決定的に導く**」と書き、`spec/usecases/identity.md:208` が「収束のキーは `operationKey` で、**対象クレデンシャルと依頼の窓から決定的に導く**（クライアントから受け取らない）」と書いている。

**#37 が共通方針を字義どおり読むと `operation_key` を `IdGenerator` で採番することになり、そのとき壊れるのは表記ではなく機能である** — 毎回新しいキーになるので「同じキーの再投入は既存行に収束する」（`:431`）が成立せず、収束規則 (1)(2)(3) が一度も発火せず、`send-mail` の連打は依頼回数ぶんのジョブ行を作り（`spec/testcases/identity/requestPasswordReset.md:18` の期待値が落ちる）、再武装5種の `done` からの復帰（`:456`）も不能になる。`operations.operation_id` は「採番はサーバー側だけで行う」なので UUIDv7 で矛盾しないが、`operation_key` だけは別物である。

**提案:** `:24` の例外欄を2件にする。例:「例外は2つで、これが全数である — (a) `password_reset_tokens.token_id`（時刻由来を避けた暗号論的乱数の不透明値）、(b) `jobs.operation_key`（生成せず、**ジョブの同一性から決定的に導く値**である。定数キーを持つ種別と、対象と時間窓から導く種別がある。`jobs` の節が正本）」。

### **[B-002]** `payload_digest` 列の規則と、1ラウンド目で足した収束規則 (2)(3) が同じ入力に逆の指示を出す

**場所:** `spec/database/index.md:434`（列定義）と `:453` / `:455` / `:456`

**理由:** 列定義は無条件形である — 「`payload_digest` … **同じ `operation_key` に違う payload が来たら `ConflictError`**」。

1ラウンド目で足した収束規則はこれと衝突する。

- **(2)**「`status = 'poison'` の行への再投入は … `next_run_at` / `payload` / **`payload_digest` を引数の値で置き換える**」→ 違う payload が来ても `ConflictError` にせず**上書きする**。
- **(3)**「残る7種は `done` の行を復活させず、**何も書かずに成功を返す**」→ 違う payload が来ても `ConflictError` にせず**成功を返す**。

`:453` が置いた優先規則は「**`status` 別の (2)(3) が (1) に優先する**」であり、射程は (1) だけである。`payload_digest` 列の規則は (1) ではないので、この優先規則では解決しない。**同じ節が「収束規則は3つで、これが全数である」と宣言しているため、#37 は `poison` 行への payload 違いの再投入をどう扱うか決められない**（throw するか上書きするかで、`poison` からの復旧手順そのものが変わる）。

**提案:** `:434` の列定義に status 条件を入れる（例:「**射程は実行可能集合（`status IN ('pending','running')`）の行だけである。** `done` / `poison` の行に対する挙動は下の収束規則 (2)(3) が定め、digest の不一致では弾かない」）か、`:453` の優先規則を「(2)(3) は (1) と `payload_digest` 列の規則の両方に優先する」に広げる。どちらでもよいが、片方だけを直すと2箇所目が取り残される。

## Warnings

### **[W-001]** 「材料の寿命は #45 が決めるので本ファイルには書かない」と、同じファイルが書いた材料寿命規則3本が矛盾する

**場所:** `spec/database/index.md:460` と `:71` / `:504` / `:616`

**理由:** `:460` は「巻き戻し（自動回収）の具体 — 段の順序・原子性境界・**材料の寿命**・後始末の再試行上限 — は #45 が決める**ので、本ファイルには書かない**」と断定している。ところが同じファイルは材料の寿命を3箇所で書いている — `account.caller_token` を「消すのは退会の完走時だけ」（`:71`、1ラウンド目で否定形へ）、`operations.target_locators` を「終端の後始末が終わるまで消さない」（`:504`）、コーディネーター予約行を「終端の後始末が終わるまで消さない」（`:616`、1ラウンド目で追加）。

3本は `.thread/34/handoff.md:58-63` が「#37 が落とすと #45 がどう設計しても後から入れられなくなる」と名指しした前方互換点であり、**書いてあること自体は正しい**。壊れているのは `:460` の排他宣言のほうである。1ラウンド目の修正（B-010 / W-025）が `:460` を更新しないまま材料寿命を足した結果、同じファイルが「書かない」と言いながら書いている。

**提案:** `:460` を「材料の寿命のうち **#37 が落としてはならない前方互換点3本**（`account.caller_token` / `operations.target_locators` / コーディネーター予約行）は本ファイルが各テーブルの節で持つ。それ以外の巻き戻しの具体 — 段の順序・原子性境界・終端モードの印・後始末の再試行上限 — は #45 が決めるので本ファイルには書かない」に直す。

### **[W-002]** 主要クエリ対応表の「全文検索」の索引が、1ラウンド目で足した rowid の説明と食い違う

**場所:** `spec/database/index.md:819` と `:374` / `:391`

**理由:** `:819` は「全文検索（`SearchIndexPort.query`。3文字以上）| `search_fts`（trigram）+ **`search_entries_id_uq` で本体行へ**、`topics` とは join」と書く。

しかし 1ラウンド目で足した `:391` は「FTS5 は列値が必要になるたびに content テーブルを **`WHERE <content_rowid> = ?`** で引く」、`:374` は「`search_fts` の `content_rowid` がこの値（= `rowid`）を参照する」と明記した。**FTS5 の一致行から本体行を引き当てる経路は `rowid`（PK）であって `search_entries_id_uq`（`id TEXT` の UNIQUE）ではない。** `search_entries_id_uq` の用途は `:387` が書いているとおり「projection の作り直し（旧値 delete → 新値 insert）と結果行の引き当て」の projection 側である。

1ラウンド目は `:824` / `:825` の2行（`cm_credential_uq` / `cl_credential_uq` に PK の注記を足す）は直したが、同じ表の `:819` は据え置かれた。**索引の対応表は #37 が「どの索引が要るか」を判断する材料なので、誤った対応が残ると `search_entries_id_uq` を FTS のホットパス用として設計してしまう。**

**提案:** `:819` を「`search_fts`（trigram）→ 一致 rowid で `search_entries` の `rowid` PK を引き、`topics` とは join」に直す。

### **[W-003]** PRIMARY KEY へ昇格した2件が「インデックス」表に `*_uq` の名前つき索引として残っており、`source_links` の表記と不統一

**場所:** `spec/database/index.md:118`（`cl_credential_uq`）/ `:610`（`cm_credential_uq`）と `:363`（`source_links` の `（PK）`）、`:375` / `:387`（`search_entries.id`）

**理由:** 1ラウンド目（B-009 の修正）は複合 UNIQUE を PRIMARY KEY へ昇格させたが、**「インデックス」表の行はそのまま残して定義欄だけを `UNIQUE (...)` → `**PRIMARY KEY** (...)` に書き換えた**。結果、名前が `_uq` のままの「索引」が PK になっている。

- 同じファイルの `source_links` は PK の行を **`（PK）`** と表記している（`:363`）。**同じ概念に2通りの表記が併存している。**
- SQLite では複合 PRIMARY KEY の暗黙索引に名前を付けられない（`sqlite_autoindex_*` になる）。「インデックス | 名前 | 定義 | 用途」という表は #37 が `CREATE INDEX` を書くための表なので、`cl_credential_uq` / `cm_credential_uq` という名前で作れると読める形は誤解を生む。素直に実装すると PK の暗黙索引に加えて同一列の名前つき UNIQUE 索引がもう1本できる（同じ問題が `search_entries.id` にもある — 列制約が `NOT NULL, **UNIQUE**`（`:375`）で、索引表にも `search_entries_id_uq | UNIQUE (id)`（`:387`）がある）。

**提案:** `source_links` に合わせて PK 行の「名前」欄を `（PK）` に統一し、本文と `:824` / `:825` の参照は「`credential_mappings` の PK」「`credential_locators` の PK」という言い方で引く。`search_entries.id` はどちらか一方（列制約か索引表）に寄せる。

### **[W-004]** `account` の OCC `version` に書き手が無く、`status` / `deleted_at` / `caller_token` の書き込み経路も spec に存在しない

**場所:** `spec/database/index.md:26`（共通方針・1ラウンド目で追記）/ `:68-75`、`spec/domains/identity.md:454-483`（`AccountStore`）、`spec/inventory/adapter.md:53-55`

**理由:** 1ラウンド目の W-014 の修正は共通方針にこう足した — 「**単一行テーブル（`account` / `user_settings`）は `id` 列を持たないので `WHERE version = ?` だけで条件付ける**」。`user_settings` 側はこれが機能している（`UserSettingsRepository.save(user, expectedVersion)` / `ADP-identity-002`）。

`account` 側は機能していない。

- `AccountStore` のメソッドは `find()` / `advanceSessionEpoch()` / `advanceResetVersion()` の3本だけで、**`save` に相当するものが無い**（`spec/domains/identity.md:468-477`）。
- `AccountState` は `status` / `sessionEpoch` / `resetVersion` の3フィールドで、**`version` を返さない**。呼び出し側は `WHERE version = ?` に渡す値を取得できない。
- 2つの前進メソッドは `spec/database/index.md:80` と `spec/domains/identity.md:481` が明示的に「`version` の条件を付けない単独文で書き、`version` も進めない」と定めている。
- `status` の3値遷移・`deleted_at`・`caller_token` を書くポートは spec のどこにも無い（`grep -rn 'deleting\|tombstone\|withdraw' spec` のヒットは `spec/database/index.md` と `spec/domains/identity.md:461` の型定義だけ）。

つまり **`account.version` 列は spec 上どの経路からも読まれず書かれない。** 共通方針が `account` を名指しした結果、「使う規則は書いてあるが使う操作が無い」状態になっている。設計 第4.1.1節（`:551`）が「持つのは集約ルートの3つだけである — `account` / `user_settings` / `ai_client_connections`」と決めているので列を落とすのは #35 の裁量外だが、**規則の側は #37 が実装できる形にしておくべきである。**

**提案:** `:26` の単一行テーブルの例示から `account` を外して `user_settings` だけにし、`account` の節（`:80` 付近）に「**`version` 列は保持するが、本 spec の範囲では OCC 条件付き更新を発行する操作が無い**（`status` 遷移を伴う退会 saga の書き手は設計 第6.7節に属し、#37 の DO RPC 側で決まる）。`AccountStore` の3メソッドはいずれも `version` を読まず進めない」と明記する。

### **[W-005]** `purge-trash` の再計算フェーズが無界で、`jobs` の「1回の起動で触る量は件数だけで有界にする」と矛盾する

**場所:** `spec/database/index.md:461` と `spec/usecases/trash.md:334`（手順2）/ `spec/domains/trash.md:258` / `spec/testcases/trash/pruneExpiredTrashItems.md`（最終行）

**理由:** `spec/database/index.md:461` は「**1回の起動で触る量は件数だけで有界にする。** … ジョブ件数・**チャンク反復回数**・1チャンクの行数の3階層の上限を置き」と定める。理由も同じファイルが書いている — CPU 予算超過の帰結はエラーではなくリセットである（`:508` / `:716`）。

ところが再計算フェーズはこの上限の外にある。

- `spec/usecases/trash.md:334`「`MemoRepository.recalculatePurgeAfter` / `TopicRepository.…` / `DocumentRepository.…` を、**3つとも `hasMore` が偽になるまで呼ぶ**」
- `spec/domains/trash.md:258`「再計算の残件があれば、**空になるまで先に進める**（各 Repository の `recalculatePurgeAfter` を**残件が無くなるまで**呼ぶ）」
- `chunkLimit` の説明（`spec/usecases/trash.md` 入力DTO）は「1 回の起床で処理する上限」だが、手順3（削除フェーズ）にしか効いていない。

さらに**テストケースだけが3者と違うことを言っている** — `spec/testcases/trash/pruneExpiredTrashItems.md` の最終行は「**有限回の起床で**残件が空になり、そのあと期限判定のフェーズへ進む」と、複数回の起床に分かれる前提で書かれている。usecase 手順2 の「この起床で空になるまで呼ぶ」と両立しない。

自己消尽する作業述語（1ラウンド目の W-018 の修正）が保証するのは「先頭へ戻らない」ことであって「1回の起床で終わる」ことではないので、ゴミ箱に大量の項目がある DO では再計算フェーズ単体で予算を使い切って**黙ってリセットされる**。

**提案:** `spec/usecases/trash.md` 手順2 と `spec/domains/trash.md` の該当行に反復上限を入れる（例:「`recalculatePurgeAfter` の呼び出し回数にも上限を置き、上限に達したら `hasMore: true` で抜けて次の起床に委ねる。削除フェーズへは残件が空になった起床でだけ進む」）。`chunkLimit` を再計算フェーズにも効かせるのか別の上限を置くのかは `spec/database/index.md:461` の3階層に合わせて明記する。

## Notes

### **[N-001]** `search_fts` が「主キーの形3通り + 単一行3つ」のどれにも属さない

**場所:** `spec/database/index.md:24`

19テーブルのうち 18 は 3 通り（単一 `TEXT` / 複合 / `rowid INTEGER PRIMARY KEY`）または単一行3つに割り当てられているが、`search_fts` だけがどこにも現れない。FTS5 仮想テーブルなので宣言された PK を持たない（暗黙 rowid が `content_rowid` で `search_entries.rowid` に対応する）のは正しいが、`:24` は「主キーの形は3通りある」という排他的な形で書かれている。**全テーブルを1つずつ確認した結果、例外はこの1件だけである。** 「仮想テーブルの `search_fts` は宣言された主キーを持たない（暗黙 rowid が `search_entries.rowid` に対応する。後述）」の一句を足せば全数が閉じる。

### **[N-002]** 「6ストア・7メソッド」の「メソッド」が実際にはストアハンドル3つ + メソッド4つの混在

**場所:** `spec/database/index.md:752`、`CLAUDE.md:68`、`spec/domains/identity.md:378`

3ファイルで数字は完全に一致している（7テーブル / 6ストア / 7メソッド / `_meta` だけ口なし）ので**整合性の問題は無い**。ただし列挙の内訳を見ると、`enqueueJob` / `recordOperation` / `updateOperation` / `setMigrationCursor` はメソッド名、`credentialLocatorStore` / `resetTokenStore` / `rotationCheckpointStore` は**ストアハンドル名**である。`credentialLocatorStore` だけで書き込みメソッドは3本ある（`record` / `advanceCredentialVersion` / `deleteByCredentialId` — `ADP-identity-023`〜`025`）。「7メソッド」は「UoW コンテキストが露出する口が7つ」の意味であって書き込みメソッドの本数ではない。誤読を避けるなら「6ストア・**7つの口**」等。

### **[N-003]** `ADP-credential-locators-001` の書き込み箇所 (1) から「新規登録」が落ちている

**場所:** `spec/inventory/adapter.md:21` と `spec/database/index.md:124`

`spec/database/index.md:124` は「(1) **新規登録・SSO 連携の完了時**の upsert」。台帳側は「**連携完了時**の upsert」で新規登録が落ちている。設計 第4.1.1節（`:564`）も「signup phase 4 = `resume-signup` / link 手順4 = `resume-link`」の2経路である。件数（3つ）は合っているので #37 が数を取り違えることはないが、経路名は揃えたほうがよい。

### **[N-004]** `ADP-trash-006` が「再武装」を「投入」と並べており、収束規則 (1) の適用除外と読み違えられる

**場所:** `spec/inventory/adapter.md:131` と `spec/database/index.md:457`

台帳は「ソフトデリート・保持日数変更・**ジョブ完了時の再武装**が次の起床時刻の材料として読む（**投入は早める方向にのみ効く**。spec/database/index.md#jobs）」。`spec/database/index.md:457` は「**3つの射程は外部からの再投入だけである。** ジョブ自身が完了時に行う再スケジュール（再武装）には (1) を適用しない — 適用すると次の期限が現在の `next_run_at` より後のときに何も書けず、`done` に落ちて二度と起きなくなる」と明記している。台詞としては「投入」に限定した括弧なので誤りではないが、3つの読み手を並べた直後に置かれているため再武装まで早める方向に縛られると読める。`spec/domains/trash.md:252` / `:313` は投入と再武装をきちんと分けて書いているので、台帳だけが曖昧である。

### **[N-005]** 退会（`status = 'deleting' / 'deleted'` / `deleted_at` / tombstone / `finalize-withdrawal` / `purge-user-mappings`）が DB spec にしか存在しない

**場所:** `spec/database/index.md:36` / `:64-77` / `:473` / `:757` — 対応する `spec/requirements.md` / `spec/scenario/` / `spec/usecases/` の記述は 0 件

`grep -rn '退会\|tombstone\|deleting' spec` のヒットは `spec/database/index.md` と `spec/domains/identity.md:461`（`AccountState` の型）だけである。設計 第6.7節が退会 saga を持つので DB spec 側は正しく、**#35 の欠陥ではない**（要件・シナリオへの退会の追加は #35 の受け入れ基準に無い）。ただし「本ファイルが `spec/` 側のスキーマの正本である」（`:7`）と宣言している以上、上流に導線が無い機構が3つ（`account` の退会列・`finalize-withdrawal` ジョブ・`purge-user-mappings` operator 経路）残っている事実は引き継ぎ先で認識されるべきである。W-004 と同根。

## この観点で確認して問題が無かった項目

無理に粗探しをせず、確認して**問題が見つからなかった**ものを明示する。

- **1ラウンド目の修正どうしの相互破壊**: `spec/database/index.md` の 7 箇所以上の独立編集のうち、**矛盾が生じたのは W-001 / W-002 / B-002 の3件だけ**である。残り（`credential_locators` / `credential_mappings` の PK 昇格、external-content の `'delete'` 特殊コマンド構文、非集約ストア6つの書き込み口、`jobs` の収束規則3つ、`purge-trash` の自己消尽述語、コーディネーター予約行の保持、`account.caller_token` の否定形）は互いに整合している。
- **主キーの形の全テーブル適用**: 19テーブルを1つずつ確認した。単一 `TEXT`（`ai_client_connections` / `memos` / `topics` / `documents` / `document_revisions` / `jobs`×2 / `operations` / `password_reset_tokens`）、複合（`memo_revisions` / `source_links` / `credential_locators` / `credential_mappings` / `migration_progress` / `rotation_checkpoints` の6つ = `:24` の列挙と完全一致）、`rowid INTEGER PRIMARY KEY`（`search_entries`）、単一行（`account` / `user_settings` / `_meta`×2）。**例外は `search_fts` の1件だけ**（N-001）で、`:24` の列挙に**過不足は無い**。
- **OCC の全数表**: `:744-748` の5区分（6 + 3 + 2 + 7 + 1 = 19）が各テーブル定義と1対1で一致する。`version` 列を持つ6テーブルすべてに列定義があり、持たない13テーブルのどれにも `version` 列は無い（`credential_locators.credential_version` は別概念で、混同されていない）。設計 第4.1.1節（`:551-553`）の「集約ルート3つ + `memos` / `topics` / `documents`」「非集約ストア7つ」とも一致。
- **`account` が3ファイルで「集約ルート側」に揃っている**: `spec/database/index.md:79` / `:751`、`spec/domains/identity.md:378` / `:457`、`spec/inventory/domain.md:41`、`CLAUDE.md:68`（`account` is not on that roster）。**5箇所すべてで同じ判定**であり、ポート名が `AccountStore` であることによる分類のブレは無い。
- **`jobs.kind` の12種**: `spec/database/index.md:468-481` の全数表と `CLAUDE.md:80-86` の4類型表が、種別・所有 DO クラス・類型のすべてで一致する（`P-9` に加えて所有クラスと類型も手で突き合わせた）。Identity Directory 側の6種（`:652`）も設計 第4.1.1節 `:545` と一致。「4類型が12種を漏れなく1回ずつ覆う」も成立。
- **`spec/inventory/adapter.md` の新規14行の内容整合**: `ADP-identity-018`〜`025` は `spec/domains/identity.md` の `AccountStore` / `CredentialLocatorStore` 節と、`ADP-memo-014` / `ADP-knowledge-028` / `ADP-029` は `recalculatePurgeAfter` の3ポート定義と、`ADP-trash-005` / `006` は `spec/domains/trash.md:219-222` の `TrashQueryPort` と、それぞれ矛盾しない（N-003 / N-004 の2件を除く）。
- **external-content FTS5 の `'delete'` 構文**: `INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', …)` は SQLite の仕様どおりで、新値投入を通常 `INSERT` とする点も正しい。`ADP-search-fts-001` にも同じ形で落ちている。
- **W-017（`search_entries` の PK 二重管理）の解消**: `spec/domains/search.md:228` が DDL レベルの指示を持たない宣言に置き換わり、`spec/database/index.md:370` が受け皿の宣言を持つ。両側に PK の形が書かれた状態は解消されている。

## カバレッジ（97件）

### A. 精読（全文または該当節 + `git diff origin/main...HEAD`）— 17件

| ファイル | この観点での扱い |
|---|---|
| `CLAUDE.md` | 全文。Key concepts の UoW / 非同期実行契約 / Storage limits を DB spec と突き合わせ |
| `spec/database/index.md` | 全文 + 1ラウンド目の差分。B-001 / B-002 / W-001〜W-004 / N-001〜N-005 の出所 |
| `spec/inventory/adapter.md` | 全文 + `origin/main` との ID 集合比較。欠番規約・アンカー・14行の内容整合 |
| `spec/domains/index.md` | 差分全文。テナント分離 / ポートの同期契約 / 派生データの更新 |
| `spec/domains/identity.md` | `AccountStore` / `CredentialLocatorStore` / 非集約ストアの分類（`:378` / `:454-483`）。W-004 |
| `spec/domains/trash.md` | 保持期限・`TrashQueryPort`・`recalculatePurgeAfter`（`:191` / `:219-260`）。W-005 |
| `spec/domains/search.md` | projection の物理形の委譲（`:115` / `:228`）。W-017 の解消確認 |
| `spec/domains/memo.md` | `recalculatePurgeAfter` の契約（`:305` / `:329-331`） |
| `spec/domains/knowledge.md` | `recalculatePurgeAfter` ×2 の契約（`:418` / `:513`） |
| `spec/usecases/trash.md` | `pruneExpiredTrashItems` の処理フロー（`:305-360`）。W-005 |
| `spec/usecases/identity.md` | `AccountStore` 呼び出し4経路・`operationKey` の導出（`:208` / `:245` / `:290` / `:512-530` / `:565`）。B-001 / W-004 |
| `spec/inventory/domain.md` | `AccountStore` 3行（`DOM-identity-038`〜`040`）の分類記述 |
| `spec/inventory/test.md` | `search_entries` / `search_fts` 3行の projection 期待値 |
| `spec/inventory/usecase.md` | `AccountStore` / `operationKey` を参照する 3行 |
| `spec/testcases/trash/pruneExpiredTrashItems.md` | 全文。W-005 の3者不一致 |
| `.thread/35/plan.md` | 受け入れ基準と検証コマンドの逐語実行 |
| `.thread/35/review/triage.md` | 判定済み 37 Key の把握（再提出なし） |

### B. 機械検査で全件走査し、この観点の論点なしと判定 — 69件

`spec/` の残り 69 ファイル。次の検査がいずれも**全ファイルを走査対象に含めており**、この観点で見るべきヒットが無いことを確認した。

- `V-2a` / `V-2b` / `V-2c`（旧ランタイム語）— 0 行
- `P-8`（`spec/inventory/*.md` の全アンカー実在検査）— 0 行
- `P-10`（テーブル全数）/ `P-9`（`jobs.kind` 全数）— 0 行
- 横断 grep: 全テーブル名（14語）/ `operation_key` / `operationKey` / `purge_after` / `recalculatePurgeAfter` / `listItemsToPurge` / `findEarliestPurgeAfter` / `非集約ストア` / `AccountStore` / `deleting` / `tombstone` / `withdraw`

内訳: `spec/idea.md` / `spec/index.md` / `spec/requirements.md`（3）、`spec/domains/export.md`（1）、`spec/inventory/frontend.md`（1）、`spec/pages/index.md`（1）、`spec/scenario/*`（4）、`spec/manual-tests/*`（8）、`spec/usecases/{export,knowledge,memo,search}.md`（4）、`spec/testcases/export/*`（1）、`spec/testcases/identity/*`（15）、`spec/testcases/knowledge/*`（14）、`spec/testcases/memo/*`（9）、`spec/testcases/search/*`（2。うち `maintainSearchIndex.md` は削除）、`spec/testcases/trash/*`（6。`pruneExpiredTrashItems.md` は A に計上）。

### C. スキップ — 11件

`.thread/35/` の作業記録。**`spec/` の正本ではなく PR の成果物でもないため、この観点では内容をレビューしていない**（`plan.md` / `review/triage.md` の2件のみ A で精読）。

`adr.md` / `coverage.md` / `steps.md` / `step14-checklist.md` / `testing.md` / `review/review-001.md` / `review/review-001-database.md` / `review/review-001-design-fidelity.md` / `review/review-001-domain-usecase.md` / `review/review-001-requirements.md` / `review/review-001-testcases.md`

**合計: 17 + 69 + 11 = 97件** ✅
