# レビュー 001 — DB 設計・永続化アダプター

対象: PR #46（Issue #35） / ベース `origin/main` / 変更 80 件
契約: `.thread/35/plan.md` / 設計の正本: `.thread/34/design.md`

## 総評

**設計 第4.1.1節のテーブル全数（User Data DO 16 / Identity Directory DO 5）は1テーブルずつ突き合わせて全件一致した。列の全数を書くと決めた群（認証・saga・ジョブ系）も、`jobs` の12列 / `operations` の7列 / `credential_mappings` の22列 / `password_reset_tokens` の8列 / `rotation_checkpoints` の8列 / `credential_locators` の9列 / `account` の6列 / `ai_client_connections` の9列がすべて揃っている。** 旧前提（`outbox` / `processed_events` / `_occ_guard` / `search_embeddings` / 期限切れ部分索引3本 / `user_id` 列と先頭 `user_id` の複合索引）はすべて消えており、ADR-021 の索引改名も4本＋置き換え3本が漏れなく適用され、`spec/inventory/adapter.md` への波及6行も追随している。台帳側の削除 ID 13件は AC-9 の列挙と完全一致し、繰り上がりも起きていない（`ADP-identity-017` / `ADP-export-003` は末尾採番）。`#45` の射程（巻き戻し手順・段構成・材料寿命・再試行上限）は `spec/database/index.md:437` で明示的に委譲されており、先取りは無い。`#44` も同様（`:463` / `:644`）。AC-2 / AC-7 / AC-8 / AC-9 は満たされていると判断する。

指摘は「設計の写し漏れ」ではなく、**写した先で本ファイル自身が内部矛盾を起こしている箇所**と、**設計が持っていた実装制約の一部が spec のどこにも着地していない箇所**に集中している。

## Blockers

- **[B-001]** `credential_locators` / `credential_mappings` に主キーの宣言が無く、共通方針の「例外は `search_entries` だけ」という排他宣言が少なくとも9テーブルで成立していない
  - 場所: `spec/database/index.md:24`（共通方針）、`spec/database/index.md:93-119`（credential_locators）、`spec/database/index.md:511-580`（credential_mappings）
  - 理由: 本 PR は共通方針の「**ID**: すべて `TEXT` 主キー」に **「例外は `search_entries` で〜」という排他句を新規に足した**（旧版は排他句を持たなかった）。ところが実際に `TEXT` 主キーを持たないテーブルは `search_entries` だけではない — `memo_revisions`（複合 PK）/ `source_links`（複合 PK）/ `migration_progress`（複合 PK）/ `rotation_checkpoints`（複合 PK）/ `account` / `user_settings` / `_meta`×2（単一行で PK 宣言なし）/ **`credential_locators` / `credential_mappings`（PK 宣言そのものが無い）** の9〜10テーブルが当たる。排他句を足したことで、旧版より断定が強く・より誤りになっている。
  - とくに重いのは後者2つである。`grep -n 'PK\|PRIMARY KEY\|主キー' spec/database/index.md` を実行すると、この2テーブルの節には1行もヒットしない。複数行が載る実テーブルで、`account` / `user_settings` / `_meta` のような「単一行だから実装裁量（#37）」の逃げ道も書かれていない。**本ファイルは `:7` で「`spec/` 側のスキーマの正本」を名乗り、`:3` で「実装先は #37」と書いているので、#37 は共通方針に従って `credential_mappings` に `id TEXT PK` を足す方向へ倒れうる** — それは設計 第4.1.1節の列の全数に無い列を発明することであり、同節が「同一性は `(kind, hmac)`、`credentialId` にも bucket 内 UNIQUE」と決め切った権威を二重化する。
  - 提案: (a) 共通方針の排他句を「例外は `search_entries`（`rowid INTEGER PRIMARY KEY`）と、複合 PK・単一行のテーブルである。各テーブルの節が正本」へ緩める、(b) `credential_locators` に `PK: (credential_id, generation)`（＝`cl_credential_uq` を PK に昇格）、`credential_mappings` に `PK: (kind, hmac)`（＝`cm_credential_uq` を PK に昇格）を明示する、(c) `account` / `user_settings` / `_meta` は「単一行なので PK を置かない（単一行制約の掛け方は #37 の裁量）」を `account:64` と同じ形で各節に書く。

## Warnings

- **[W-001]** external-content FTS5 の `'delete'` が**特殊コマンド構文**であることが spec のどこにも書かれておらず、素直に `DELETE FROM search_fts WHERE rowid = ?` と書くと本ファイル自身が警告している「黙って壊れる」に落ちる
  - 場所: `spec/database/index.md:404-405`、`spec/domains/search.md:224-227`
  - 理由: 設計 第7.1節 実装制約1 は形まで書いている — `INSERT INTO search_fts(search_fts, rowid, <cols>) VALUES('delete', <old rowid>, <old values>)`。spec 側に残ったのは「旧値で delete → 新値で insert」「整合は SQL トリガーではなく projection コードが担う」「**踏み外すと例外が上がらず索引だけが黙って壊れる**」の3点で、**踏み外さないための唯一の具体（構文）だけが落ちている**。「旧値の読み出しは同じトランザクションの中で行う」から間接的に推測はできるが、この失敗モードは実行時に何のシグナルも出さない種類のものなので、推測に委ねる箇所ではない。レビュー観点の設問（triggers か明示的な `INSERT INTO search_fts(search_fts, ...)` か）に対する答えは「trigger は使わないと明記、代替の具体は未記載」である。
  - 提案: `spec/database/index.md` の `search_fts` 節に `INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', <旧 rowid>, <旧 title>, <旧 body>)` を1行そのまま置く。同節は既に `CREATE VIRTUAL TABLE` を SQL フェンスで持っているので、置き場所の一貫性も取れる。

- **[W-002]** OCC の共通方針が `WHERE id = ? AND version = ?` と断定しているが、`account` / `user_settings` には `id` 列が無い。台帳側は「`id` 述語は不要」と書いており、正本と台帳が食い違う
  - 場所: `spec/database/index.md:26` vs `spec/database/index.md:66-75` / `:84-89` / `spec/inventory/adapter.md:37`
  - 理由: `ADP-identity-002`（`UserSettingsRepository.save`）は「`WHERE version = ?` の条件付き更新（単一行なので `id` 述語は不要）」と正しく書けている。ところが台帳の生成元である `spec/database/index.md:26` は `id` を含む形しか示していない。`version` を持つ6テーブルのうち2つ（`account` / `user_settings`）が例外なので、無視できる比率ではない。
  - 提案: `:26` に「単一行テーブル（`account` / `user_settings`）は `id` 述語を持たず `WHERE version = ?` だけで条件付け、`RETURNING 1` の有無で 0 行を検出する」を追記する。

- **[W-003]** 非集約ストア6つの**書き込み口**が `CLAUDE.md` にしか存在せず、`spec/` 側に1件も無い。とくに `credential_locators` は「到達性検査の権威・唯一の逆引き情報」と宣言されながら、書き込みポートも usecase 手順も spec に存在しない
  - 場所: `CLAUDE.md:68` vs `spec/domains/identity.md:363-381`（`CredentialMappingRepository` は読み3本のみ）/ `spec/usecases/identity.md`（`locator` の語が0件）
  - 理由: `CLAUDE.md:68` は `credentialLocatorStore` / `resetTokenStore` / `rotationCheckpointStore` と `enqueueJob` / `recordOperation` / `updateOperation` / `setMigrationCursor` を挙げ、**「Those two groups are the complete set of write paths」と断定している**。実測でこの7語は `spec/**` に**1件もヒットしない**（`grep -rl` で 0 ファイル）。加えて `resetTokenStore` は spec 側では `PasswordResetTokenPort` という別名で存在しており、同じものに2つの名前が並ぶ。
  - 影響がいちばん具体的なのは `credential_locators` である。`spec/database/index.md:95` は「退会・SSO 連携解除のときに Identity Directory 側の写像を消すための唯一の逆引き情報」と書き、`:118` で到達性照合の規則まで決めているのに、**この表に行を書く経路が spec のどこにも無い**（`credential_locators` の語は `spec/testcases/identity/loginWithPassword.md:23` の読み側1件を除いて `spec/database/index.md` と `spec/inventory/adapter.md` にしか出てこない）。`spec/usecases/identity.md:43-47` の signup 手順も「予約を取る」「初期化する」「予約を確定させる」までで、設計 phase 4 の `record-credential-locator` に相当する段が無い。
  - 同型の穴がもう1つある: `purge-trash` が `purge_after` 索引を引く**読み**経路にも台帳行が無い（`ADP-memo-013` が「期限切れ列挙メソッドは実装しない」と書いて Alarm ジョブへ委ねたまま、引き取り先の `ADP-*` / `DOM-*` が採番されていない）。
  - 提案: plan / steps はこれを明示的に要求していないので本 PR で必須とまでは言わないが、少なくとも (i) `CLAUDE.md:68` の `resetTokenStore` を `PasswordResetTokenPort` に合わせるか、spec 側に別名の対応表を置く、(ii) `spec/database/index.md` の `credential_locators` / `jobs` / `operations` / `migration_progress` / `rotation_checkpoints` の各節に「書き込み口」の1行（設計 第4.1.1節の非集約ストア表と同じ内容）を足す、のどちらかは本 PR の射程で閉じられる。#37 が spec だけを読んで実装できることを狙った ADR-006 の目的に直結する。

- **[W-004]** `jobs` の再投入規則が「同じキーの再投入は既存行に収束する」だけで、設計が決定的と名指しした `done` / `poison` 行への再投入規則が spec 全域に無い
  - 場所: `spec/database/index.md:414`（`operation_key` の説明）、`:435-439`
  - 理由: 設計 第7.4節は「『同じキーの再投入は既存行に収束する』だけでは `kind` によって逆の更新が要求される」と自ら書いたうえで3つの規則を置いている — (1) 再投入は `next_run_at` を早める方向にのみ更新する、(2) `poison` 行は `pending` へ戻して `attempt` を 0 にする、(3) **`done` 行を `pending` へ戻すのは再武装分類 (A)/(B) の5種に限り、(C) の7種は復帰させない**。spec 側に着地しているのは (1) の `purge-trash` 分だけで（`spec/domains/trash.md:238`「投入は早める方向にのみ効く」）、(2)(3) はどこにも無い。設計は (3) を落とすと「(A)(B) の周期ジョブが1回完走した時点で prune 保持期間ぶん再投入を受け付けなくなる」「`send-mail` の同窓連打で起床回数と rows written が依頼回数に比例する」と失敗モードまで書いている。
  - 本節は claim の CAS 文・backoff・prune・再武装（`:435` / `:436` / `:439` / `:461`）まで踏み込んで書いているので、「スキーマ正本だから振る舞いは書かない」という線引きにはなっていない。**同じ深さで書くものの中から (2)(3) だけが落ちている**という不均衡である。
  - 提案: `:414` か `:435` の直後に「再投入の収束規則」の3行（早める方向のみ / `poison` は復帰 / `done` の復帰は (A)(B) の5種のみ）を足す。類型欄が既に4類型を持っているので、(A)(B)/(C) の割り当ては `kind` 全数表から引ける。

- **[W-005]** 物理スキーマの決定（`search_entries` の PK を `rowid INTEGER PRIMARY KEY` にする）が `spec/domains/search.md` に置かれており、同ファイル自身の隠蔽宣言および `spec/database/index.md:367` と二重管理になっている
  - 場所: `spec/domains/search.md:224-227` vs `spec/domains/search.md:180` / `spec/database/index.md:367`
  - 理由: `spec/domains/search.md:180` は「索引の構成・トークナイズ・順位付け・スニペットの組み立ては**すべてこのポートの実装に隠蔽する**」と宣言している。その44行下で「`search_entries` の PK を `rowid INTEGER PRIMARY KEY` にし、`id TEXT` を UNIQUE 制約付きの別列にする」という DDL レベルの指示を出しているのは、その宣言と正面から衝突する。`.thread/35/adr.md` の ADR-004 / ADR-015 が tokenizer 機構を `spec/database/index.md` に一本化したのと同じ理由が、この2点にも当たる（実際 `trigram` / `instr(` / `NFKC` は正しく `spec/database/index.md` だけに閉じている — そこは良い）。
  - さらに二重管理の実害がある: `search_entries` の PK 形は `spec/database/index.md:367` にも書かれており、片方だけを直すと静かに食い違う。plan の目視レビュー項目が「この向きの誤りは `V-*` にも `P-*` にも掛からない」と自認している形そのものである。
  - 提案: `spec/domains/search.md:224-227` は「external-content の FTS5 を採るための実装制約が2つある（詳細は `spec/database/index.md`）」まで残し、制約2（PK の形）は参照に落とす。制約1（旧値 delete → 新値 insert）はドメイン側の projection 契約として残す意味があるので残してよい。

- **[W-006]** `purge-trash` の「再計算フェーズ」の作業述語が spec のどこにも無いまま、`migration_progress` 節が「`purge-trash` は作業述語そのものが進捗を表す」という結論だけを断定している
  - 場所: `spec/database/index.md:447`（`kind` 全数表の用途欄）、`:494`、`spec/domains/trash.md:246`、`spec/usecases/trash.md:335`
  - 理由: 設計 第7.5節は、`trashRetentionDays` 変更時の `purge_after` 一括再計算がチャンク分割へ落ちたとき、**述語を自己消尽する形（`WHERE trashed = 1 AND purge_after <> <新しい値で算出した値>`）で書くことが、`purge-trash` が永続カーソルを持たずに済む唯一の根拠**だと明示している（`design.md:1830-1833` / `:1896`）。そのうえで「自己消尽しない UPDATE をこの2種に足してはならない」と禁止まで置いた。spec 側は結論（`:494`「作業述語そのものが進捗を表す」）と順序（`:447` / `spec/domains/trash.md:246`「再計算の残件があれば先に進める」）だけを写し、**述語の形と禁止が落ちている**。素朴に `WHERE trashed = 1` で回すと述語が縮まず、大きく育った DO では中断のたびに先頭へ戻って完了しない。
  - あわせて、`spec/database/index.md:91`（「変更したのと同一トランザクションでゴミ箱内の全項目の `purge_after` を再計算する」）と `:447`（ジョブに再計算フェーズがある）が、両者をつなぐ「件数が大きい場合はチャンク分割へ落ちる」の一文を欠いたまま並んでいる。
  - 提案: `memos` / `topics` / `documents` のいずれか（または `user_settings:91`）に述語の形を1行足し、`:447` の用途欄から参照する。

## Notes

- **[N-001]** 設計 第4.1.1節が「列の全数」と宣言した認証系テーブルに、設計に無い `created_at` / `updated_at` を追加している（`account` / `credential_locators` / `ai_client_connections` / `credential_mappings` / `password_reset_tokens`（`created_at` のみ）/ `user_settings`）。`jobs`（12列ちょうど）と `operations`（7列ちょうど）は設計と厳密に一致させているので、意図的な差である。`spec/database/index.md:7` の「以後の変更は本ファイルを直す」という宣言で正当化されるが、#37 が design 第4.1.1節と突き合わせると差分に見える。列自体は共通方針（日時 `*_at`）に沿っており害は無い。
  - 場所: `spec/database/index.md:74-75` / `:108-109` / `:136-137` / `:578-579` / `:607`

- **[N-002]** `_meta` の locator 列名 `self_locator` は spec 側の新規命名である（設計は「自 locator」としか書いていない）。両クラスで同じ名前を使っており一貫している。
  - 場所: `spec/database/index.md:504` / `:648`

- **[N-003]** `search_entries.id` の UNIQUE が列定義（`NOT NULL, **UNIQUE**`）と索引表（`search_entries_id_uq | UNIQUE (id)`）で二重に宣言されている。素直に実装すると UNIQUE 索引が2本できる。
  - 場所: `spec/database/index.md:368` と `:380`
  - 提案: どちらか一方に寄せる（索引表側に名前付きで残すほうが `cl_*` / `cm_*` と揃う）。

- **[N-004]** `ADP-users-001` を欠番にせず「schema: users（廃止・分裂）」の墓標行として残し、定義場所を `spec/database/index.md#テーブル一覧` へ付け替えている。AC-9 の削除リストに含まれない ID なので規約違反ではなく、行き先4つ（`ADP-account-001` / `ADP-user-settings-001` / `ADP-credential-mappings-001` / `ADP-credential-locators-001`）を明記しているのは追跡性として良い。ただし**「要素」欄が実在テーブルを指さない唯一の行**になるので、台帳とテーブルの1対1という読み方からは外れる。`.thread/35/adr.md:796` が「どこに明記するかを決めていない」と自認していた箇所であり、判断としては妥当。
  - 場所: `spec/inventory/adapter.md:9`

- **[N-005]** `operations.kind` の値域が日本語ラベル（「新規登録 / 連携 / 連携解除 / クレデンシャル変更 / 退会」）だけで、リテラル値も CHECK も無い。`phase` も「saga の進行段階」のみ。設計 第4.1.1節にも列挙が無いので #37 が決める余地だが、他テーブルは軒並み CHECK まで書いているので、ここだけ粒度が落ちている。設計本文には `kind = 'unlink'`（`design.md:1759`）というリテラルが出てくるので、そこから拾える。
  - 場所: `spec/database/index.md:472` / `:474`

- **[N-006]** 「主要クエリとインデックスの対応（確認表）」に新設索引の一部が現れない — `cl_hmac_uq` / `cm_credential_id_uq` / `prt_credential_idx` / `jobs_lease_idx` / `search_entries_id_uq`（`:788` に間接的に出るのみ）/ `migration_progress` の PK。確認表であって全数表ではないと明記されていないので、全数のつもりで読むと索引の一部が「用途不明」に見える。
  - 場所: `spec/database/index.md:775-800`

- **[N-007]** `.thread/34/handoff.md` 第3節の「#37 が落としてはいけない前方互換点」4点は、**テーブル定義としては4点とも落ちていない** — `operations.target_locators`（`:475` / `:480` に「終端の後始末が終わるまで消さない」まで明記）/ コーディネーター予約行の `locators` `candidate_user_id` `caller_token`（`:562` / `:565` / `:572`）/ `account.caller_token`（`:71`「退会の完走時に消す」）/ `credential_mappings.change_state` の3値（`:537` に CHECK 付き）。ただし「消さない」という寿命の規定が明記されているのは `target_locators` だけで、コーディネーター予約行の3列には無い。#45 の射程（終端の段構成）に触れずに寿命だけを書くことは可能なので、対称に1行足す余地はある。
  - 場所: `spec/database/index.md:557-566`

- **[N-008]** 良い点として記録しておく: 実測値の断定を避ける線引きが正確である。`bm25` の重み（設計の実測は `bm25(search_fts, 3.0, 1.0)`）とページサイズを `spec/database/index.md:660` で明示的に #37 へ委ね、`spec/domains/search.md:151` / `spec/inventory/adapter.md:108` / `spec/inventory/domain.md:118` の3箇所すべてで「重みの実値は実装側が持つ」に揃えている。tokenizer 機構語（`trigram` / `instr(` / `NFKC`）が `spec/database/index.md` の外に漏れていないことも実測で確認した（`spec/manual-tests/search.md:156` と `spec/testcases/search/*` の期待値、および `spec/inventory/test.md` の対応行だけがテスト観点で言及しており、これは ADR-015 の想定どおり）。

- **[N-009]** 機械ゲートは本レビューの射程内で全件通ることを確認した — V-1 / V-2a / V-2b / V-2c / V-4 / V-6 が 0 行、P-3 / P-8 / P-9 / P-10 が期待どおり（`P-10` の `TABLE-MISSING` 0 件、`P-9` の `KIND-MISSING` 0 件、`P-8` の `DANGLING` / `NOFILE` 0 件）、`pnpm format:check` が exit 0。`spec/inventory/adapter.md` の削除 ID は AC-9 の列挙（`ADP-search-002`〜`009` / `ADP-search-embeddings-001` / `ADP-occ-guard-001` / `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-trash-004`）と**完全一致**で過不足なし。`jobs.kind` の12種は `CLAUDE.md:80-86` の4類型表と `spec/database/index.md:445-458` の全数表で所有クラス・類型とも一致する。

## カバレッジ

一覧の80件と1対1で対応させる。

### 確認（差分または本文を読み、DB 観点で判定した）

- `CLAUDE.md` — 全差分。Key concepts / 非同期実行契約 / Retry strategy / Error handling / Reference runtime を設計 第7.7節・第8.4節と突合。`jobs.kind` 4類型 × 12種を `spec/database/index.md` と相互照合
- `spec/database/index.md` — 全 800 行を精読。設計 第4.1.1節（`524-577`）/ 第4.3節（`595-650`）/ 第7.2節（`1628-1641`）/ 第7.4節（`1680-1883`）/ 第8.4節（`2124-2141`）/ 第9.1〜9.5節（`2152-2252`）/ 第10.1節（`2255-2278`）と1テーブル・1列ずつ突合
- `spec/inventory/adapter.md` — 全 127 行を精読。`spec/database/index.md` のテーブル21セル（distinct 19）との1対1、アンカーの実在、削除 ID / 新設 ID の照合
- `spec/domains/search.md` — `SearchIndexPort` / `IndexEntry` / 検索の規則 / インデックスの維持を精読。W-005 の根拠
- `spec/domains/index.md` — テナント分離・ポートの同期契約・派生データの更新の3項目を精読
- `spec/domains/identity.md` — ポート節（`352-503`）を精読。`CredentialMappingRepository` / `UserSettingsRepository` / `PasswordResetTokenPort` と `credential_mappings` / `user_settings` / `password_reset_tokens` の突合。W-003 の根拠
- `spec/domains/trash.md` — 保持期限節（`230-250`）を精読。`purge_after` / `purge-trash` の駆動源・再武装・再計算フェーズ
- `spec/domains/memo.md` — `search_entries` / `purge_after` / `transactionSync` / 旧語の grep 検査。DB 観点の矛盾なし
- `spec/domains/knowledge.md` — 同上
- `spec/domains/export.md` — 同上（`ExportSourceReader` の同期契約と `ADP-export-001` の突合）
- `spec/index.md` — テーブル件数の散文（「User Data DO 16 テーブル / Identity Directory DO 5 テーブル」）が実測と一致することを確認
- `spec/requirements.md` — 4.4（FTS5）/ 5.1（物理分離・到達可能性）/ 5.3（10 GB は本体 + FTS の合計）を確認
- `spec/inventory/domain.md` — `DOM-*` の DB 関連行（`DOM-search-004` ほか）と旧語の grep 検査。ID 繰り上がりが無いことを確認
- `spec/inventory/usecase.md` — `P-8` のアンカー検査対象として全行を機械検査。DB 関連の旧語 0 件
- `spec/inventory/test.md` — `P-8` の `#L` 検査 + `purge_after` / `trigram` / `instr` / `bm25` を含む行の内容確認
- `spec/inventory/frontend.md` — `P-8` のアンカー検査対象として全行を機械検査（DB 観点の記述は無し）
- `spec/usecases/trash.md` — `purge-trash` の実行手順（`311-340`）と projection 更新の位置を精読
- `spec/usecases/identity.md` — signup / SSO / リセットの手順節を精読。W-003（`credential_locators` の書き込み段が無い）の根拠
- `spec/usecases/memo.md` — `search_entries` / `search_fts` projection の記述を確認
- `spec/usecases/knowledge.md` — 同上
- `spec/usecases/search.md` — インデックス維持・エラーケースの記述を確認（page 番号方式の残存なし）
- `spec/usecases/export.md` — `transactionSync` 1回のスナップショット読みと実行位置の分割を確認
- `spec/testcases/search/maintainSearchIndex.md` — 削除されていることを確認（D エントリ）
- `spec/testcases/search/search.md` — trigram / 短語フォールバック / NFKC / bm25 の期待値4件が `spec/database/index.md` の tokenizer 方針と一致することを確認
- `spec/testcases/trash/pruneExpiredTrashItems.md` — `purge_after` 索引・駆動源・再計算の期待値を `spec/database/index.md` と突合
- `spec/testcases/trash/listTrash.md` — `expiresAt` が保存済み `purge_after` であることの期待値を突合
- `spec/testcases/identity/changeTrashRetentionDays.md` — 同一トランザクションでの `purge_after` 一括再計算の期待値を突合
- `spec/testcases/identity/loginWithPassword.md` — `credential_locators` の2世代並存と到達性照合の期待値を突合
- `spec/manual-tests/search.md` — `V-2c` の射程として全文検査（旧ランタイム語 0 件）+ trigram 手順の確認
- `spec/manual-tests/trash.md` — `V-2c` の射程として全文検査（「テスト環境の DB」4行が消えていることを確認）
- `.thread/35/plan.md` — 受け入れ基準 AC-2 / AC-7 / AC-8 / AC-9 と検証バッテリーの全文
- `.thread/35/adr.md` — ADR-004 / ADR-015（tokenizer の落とし先）/ ADR-021（索引改名）/ ADR-022（`jobs` / `_meta` の二重定義回避）を精読。ADR-021 の改名4本 + 置き換え3本が実物と一致することを確認
- `.thread/35/steps.md` — ステップ10（`spec/database/index.md`）/ ステップ12（`spec/inventory/adapter.md`）の指示と成果物を突合

小計: 33 件

### スキップ

以下は **DB 観点の記述を含まないことを一括 grep で確認したうえで、本文の個別レビューをスキップした**（検査語: `user_id` / `outbox` / `processed_events` / `occ_guard` / `search_embeddings` / `libSQL` / `Turso` / `D1` / 旧索引名7本 / `search_entries` / `search_fts` / `purge_after` / `credential_locators` / `credential_mappings` / `jobs` / `migration_progress` / `schema_version` / `trigram` / `instr(` / `NFKC` / `bm25`）。ヒットした行は上の「確認」側へ回してある。

- `.thread/35/coverage.md` — #35 のファイル判定台帳。DB 設計の判断材料ではない
- `.thread/35/step14-checklist.md` — testcases のイベント期待の (A)/(B)/(C) 適用チェックリスト。testcase 観点の担当
- `.thread/35/testing.md` — 検証手順書。実行結果は上のバッテリーで直接確認済み
- `spec/idea.md` — 初期アイデア。永続化の記述なし
- `spec/pages/index.md` — 画面仕様。DB の記述なし（page 番号方式の除去は frontend / usecase 観点の担当）
- `spec/scenario/account.md` / `spec/scenario/ai.md` / `spec/scenario/index.md` / `spec/scenario/search.md` — シナリオ層。実装語彙を持たない設計方針（ADR-015）のとおり DB 記述なし（4件）
- `spec/manual-tests/account.md` / `ai.md` / `document.md` / `index.md` / `settings.md` / `timeline.md` — 手順書。DB 直接 SQL 手順の除去は運用 / テスト観点の担当（6件）
- `spec/testcases/export/exportAllData.md` — export の期待値。上限・`transactionSync` の記述は `ADP-export-001` 経由で確認済み
- `spec/testcases/identity/approveAiClientAuthorization.md` / `changePassword.md` / `denyAiClientAuthorization.md` / `executePasswordReset.md` / `getCurrentUser.md` / `listAiClientConnections.md` / `logout.md` / `registerOrLoginWithSso.md` / `registerWithPassword.md` / `requestPasswordReset.md` / `revokeAiClientConnection.md` — identity の期待値。テーブル名・列名への言及は grep で洗い出し済みで、残りは認証フロー観点の担当（11件）
- `spec/testcases/knowledge/createDocument.md` / `createTopic.md` / `editDocument.md` / `editDocumentByAi.md` / `rollbackDocument.md` / `trashDocument.md` / `trashTopic.md` / `updateTopic.md` — projection 更新の期待値は grep で全件確認済み（`search_entries` / `search_fts` の同一 `transactionSync` 記述が一貫）。個別の業務期待値はドメイン観点の担当（8件）
- `spec/testcases/memo/delete.md` / `editMemo.md` / `postMemo.md` / `post_memo.md` / `rollbackMemo.md` / `softDeleteMemo.md` / `update_memo.md` — 同上（7件）
- `spec/testcases/trash/emptyTrash.md` / `hardDeleteTrashItem.md` / `restoreDocument.md` / `restoreMemo.md` / `restoreTopic.md` — 復元・消去の期待値。`purge_after` の `NULL` 戻しは `spec/domains/trash.md` 側で確認済み（5件）

小計: 47 件

**合計 33 + 47 = 80 件（変更ファイル一覧と1対1）**
