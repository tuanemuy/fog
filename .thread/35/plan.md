# 実装計画 — Issue #35: [spec] spec と CLAUDE.md を FTS5 全文検索 + Durable Objects 単独構成へ改訂する

**Issue:** #35
**作成日:** 2026-08-01
**複雑度:** 中〜大規模
**実装方針:** steps.md

---

## 目的

#34 で確定した設計（Cloudflare Workers + ユーザー単位 SQLite-backed Durable Objects、検索は SQLite FTS5 の全文検索のみ、Outbox 廃止と DO ローカル同期コミット）を、`spec/` の 72 ファイルと `CLAUDE.md` へ**上流から下流へ一貫して**反映し、旧前提（ベクトル検索 / D1・libSQL・Turso / Outbox 経由のインデックス維持）の有効な設計記述を `spec/` から一掃する。コードは変更しない。

## 受け入れ基準

Issue 本文の受け入れ条件7項目を起点に、**grep か目視で検証できる形**へ分解する。検証コマンドの全文は「テスト方針」に置く。

| # | 基準（検証可能な形で） | 由来 | 対応ステップ |
|---|---|---|---|
| AC-1 | `V-1`（ベクトル / embedding / RRF / Vectorize / ハイブリッド / 意味検索 / `search_embeddings`）が `spec/**/*.md`（`review/` と `spec/adr/` を除く）で **0 行**になる | 受け入れ条件1 | 2,3,4,5,6,8,10,12,13,15.5,16 |
| AC-2 | `V-2`（`D1` / `libSQL` / `Turso` / `PendingBatch` / `_occ_guard`）が同じ射程で **0 行**になり、`V-2c`（除外した2ファイルの旧ランタイム語）も **0 行**になる | 受け入れ条件1 | 7,10,12,13,16 |
| AC-3 | `V-3`（`Outbox` / `collectEvents` / `consumer` / `relay` / `DLQ` / `pruner` / `processed_events` / `IndexerReadPort` / `EmbeddingPort` / `maintainSearchIndex`）が同じ射程で **0 行**になる。**射程から外すのは `spec/index.md` の ADR 一覧表の `005` 行1行だけ**である — リンク先ファイル名 `005-search-index-via-outbox.md` が走査語 `Outbox` に当たるためで、この行は AC-13 / `V-5` が「同一行に `superseded` の注記があること」で別途ゲートする（adr.md ADR-014） | 受け入れ条件1・対応項目2 | 2,5,6,7,8,9,10,11,12,13,14,15.5,16 |
| AC-4 | `spec/requirements.md` 4.4 の先頭行が「SQLite FTS5 による全文検索」を定義し、4.5 の `search` が「全文検索。トピックによる絞り込み可」になっている。「検索方式の選択をAIに委ねない」は**残っている**（`P-11` の2本で測る。**残す側は `V-*` では絶対に検出できない** — 負の検証は「消えたこと」しか測れないので、削り落としても誰も気づかない） | 受け入れ条件2 前半 | 2 |
| AC-5 | `spec/requirements.md` 5.1 または 5.3 に「ユーザー単位の SQLite-backed Durable Object への**物理分離**」「分離の保証は列条件ではなく**到達可能性**」「1 DO あたり 10 GB」が入っている | 受け入れ条件2 後半 | 2 |
| AC-6 | `spec/domains/search.md` の `SearchIndexPort` が **`query` 1メソッドのみ**を持ち、`Promise` を返さない。`upsertMemo` / `upsertDocument` / `removeMemo` / `removeDocument` / `IndexerReadPort` / `EmbeddingPort` が `spec/` 全域で 0 行。加えて「検索の規則」節に設計 第7.2.1節の4点が載っている（`bm25` による順位と安定 tie-breaker `timestamp DESC, type, id` / optional 単一 topic filter と `TOPIC_NOT_FOUND` / スナップショットページング / 削除・復元時の projection 同期）— `P-2` の後半3本で確認する | 受け入れ条件3（**設計 第11.1節による訂正後の文言**）・対応項目3 | 5,7,8,9,10,12,13,14,15.5 |
| AC-6b | **第7.2.1節の4点が `spec/domains/search.md` の外の適用先にも届いている**（adr.md ADR-012）— (i) `TOPIC_NOT_FOUND` が `spec/domains/search.md` と `spec/usecases/search.md` の**エラーケース表の両方**に載る（`P-2` の2本を独立に測る）、(ii) `spec/usecases/search.md` の入力 DTO・`spec/testcases/search/search.md` の該当4ケース・`spec/pages/index.md` P-11 から **page 番号方式が消え不透明カーソルへ読み替わっている**（`V-10` が 0 行） | 設計 第7.2.1節（#35 へ委譲）・対応項目3 | 4,5,8,13 |
| AC-7 | `spec/database/index.md` が SQLite-backed DO 一本の記述になり、(i) 設計 第4.1.1節のテーブル全数（**`P-10` が 0 行**。着手前は 10 行）、(ii) `_meta.schema_version` とゲート関数、(iii) forward-only と `migration_progress`、(iv) 「コードより新しい version」への fail-closed、(v) ロールバックせず PITR を代替とする方針、(vi) FTS5 tokenizer 方針（trigram + `instr()` フォールバック、NFKC、原文スニペット）、(vii) `jobs.kind` の全数表（12種を所有 DO クラス別に）を含む | 受け入れ条件4 | 10 |
| AC-8 | `spec/database/index.md:3` の `CLAUDE.md「Reference runtimes」` という壊れた名指し参照が解消され、`grep -rn 'Reference runtimes' spec CLAUDE.md` が 0 行 | Issue コメント（PR #39 引き継ぎ）第2項 | 10,17 |
| AC-9 | `spec/inventory/{domain,usecase,adapter,test,frontend}.md` に旧要素の行が残らず（`ADP-search-002`〜`009` / `ADP-search-embeddings-001` / `ADP-occ-guard-001` / `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-trash-004` / `DOM-search-005`〜`012` / `UC-search-002` / **ドメインイベント行 24 件**（`DOM-identity-013`〜`017` / `DOM-memo-007`〜`012` / `DOM-knowledge-015`〜`027`。**設計 第11.1節の台帳表が数え落としている分。adr.md ADR-011**）/ `TC-maintainSearchIndex-*` 28件。**`ADP-memos-001` / `ADP-topics-001` / `ADP-documents-001` はこのリストに入らない** — 設計 第4.3節 行18 の「箇所」欄が指すのは期限切れ部分索引3本であってテーブル行ではない）、**削除した ID は欠番のまま残り後続 ID が繰り上がっていない**（連番が飛んでいてよい。**`DOM-identity-023`〜`028` が改訂前と同じ `AiClientConnectionRepository` の6メソッドを指し続けること**が AC-15 の前提）、**ステップ13〜15 で新設したケース全件に `TC-*` が採番されて行が追加されている**（新設ケース数 = `test.md` の追加行数）。`P-8`（台帳の「定義場所」アンカーの実在検査）が 0 行 | 受け入れ条件5 | 12,15.5 |
| AC-10 | `spec/testcases/search/maintainSearchIndex.md` が**削除**され、`spec/testcases/search/search.md` からベクトル統合ケースと非同期反映ケースが消え、「投稿直後に必ずヒットする」ケースが入っている。**`V-7` の上流2ファイル（`spec/domains/search.md:149` / `spec/usecases/search.md:73`）はステップ5・8 が閉じる**ので対応ステップに含める | 受け入れ条件5・対応項目5 | 5,8,13 |
| AC-11 | `spec/manual-tests/` から consumer / pruner / インデックス反映待ちの環境前提が消え、共有 DB への直接 SQL 手順が DO 前提の手段（または #38 への委譲）に置き換わっている | 受け入れ条件5 | 16 |
| AC-12 | `CLAUDE.md` の「Reference runtime」「Key concepts」（Unit of Work / Outbox 項）「Retry strategy」「Error handling」が DO 単独構成を記述し、設計 第7.7節の7項目が写されている。**「ランタイムを差し替えても domain / application / presentation は無傷」という明言が削除されている**。第7.7節 項2 の4類型が `spec/database/index.md` の `jobs.kind` 全数表と同じ12種を覆う（`P-9` が 0 行） | 受け入れ条件6 | 10,17 |
| AC-13 | **無注記の `ADR-005` 参照が0本**である — `ADR-005` / `005-search-index-via-outbox` を含む行（`review/` と `spec/adr/005` 本体を除く）のうち、同一行に `.adr/003` / `.adr/004` / `superseded` のいずれも持たない行が **0 行**（`V-5`）。**ステップ11 が負うのはリンク6本とステップ5〜10 の射程内だけ**で、`spec/inventory/{domain,test}.md` / `spec/manual-tests/search.md:128` / `spec/testcases/search/search.md:28` の4件はそれぞれ 12 / 15.5 / 16 / 13 が閉じる（対応ステップ欄が全ファイルを覆っているのはこのため）。**`spec/adr/004` 側は測らない** — 実測で `004-domain-boundaries.md` はステータス行も本文も supersede ポインタを持たず（ステータスは「承認済み」。ポインタを持つのは `005` だけ）、Issue 対応項目4 が前提にしている「#34 で付けた supersede ポインタ」が 004 には存在しない。**004 を参照する 15 行のうち改訂後に嘘になるのは `spec/database/index.md:35` の1件だけ**で、それはステップ10a が扱う（ドメイン境界そのものは変えない — ステップ6） | 対応項目4 | 5,6,7,8,9,10,11,12,13,15.5,16 |
| AC-14 | #10 の実装チェックリストの ID がすべて改訂後の `spec/inventory/` に**実在**し、内容が一致している（`gh issue view 10` の各 ID を台帳へ grep して全件ヒット） | 受け入れ条件7 | 18 |
| AC-15 | #13 の実装チェックリストから、第7.3節で消える `DOM-identity-016` / `DOM-identity-017` / `TC-revokeAiClientConnection-002` が除かれ、残る行が改訂後の台帳に実在する | 設計 第11.1節の追加指示 | 18 |
| AC-16 | `spec/` の非 review Markdown すべてに判定があり（改訂 / 影響なし）、設計 第11.1節の一覧に載っていないファイルが存在しない。**ファイル数は着手前 101 / 完了後 100**（`spec/testcases/search/maintainSearchIndex.md` の削除1件のみ。新設ファイルは無い）。判定台帳は `.thread/35/coverage.md` に成果物として残す | 設計 第11.1節「#35 は同じ4つを再実行して漏れが無いことを確認する」 | 1,15,19 |
| AC-17 | `pnpm lint` / `pnpm format:check` が exit 0。`git diff --name-status main...HEAD` が `spec/**/*.md`・`CLAUDE.md`・`.thread/35/**` 以外を含まない | プロジェクト規約・Issue のスコープ | 19 |
| AC-18 | **本 Issue 自身の編集で嘘になる件数・構成の散文が同期されている** — `grep -n '9テーブル\|SQLite系\|52ユースケース\|192ケース\|約750ケース' spec/index.md` が **0 行**になり、`spec/manual-tests/index.md` の件数表の各行・合計が各ファイルの実測 TC 数（`grep -cE '^#+ TC-[0-9]+'`）と一致し、実行記録欄の分母も同じ値になっている | 対応項目5（「設計から自動生成・転記された全参照」） | 16.5 |
| AC-19 | **手段4 の9ファイルが実際に改訂されている**ことが機械検査で確認できる（`P-7` の各行がヒットする）。目視レビューの補助ではなく完了ゲートの一項目として扱う。**`P-7` は9ファイルを1本ずつ固定する10本**（`loginWithPassword.md` が2本 + 残り8ファイルが1本ずつ。`spec/inventory/frontend.md` はステップ12 で処理される）で、**ディレクトリ指定や複数ファイルの OR は使わない** — 束ねると片方だけ改訂しても通る | 設計 第11.1節「改訂する — 手段4 でのみ拾えたもの」 | 15 |

## スコープ

### 含まれるが Issue 本文には無いもの（設計 第11.1節が #35 へ委譲した分）

Issue #35 の「対応項目1〜7」にも「受け入れ条件7項目」にも現れないが、設計 第11.1節が本 Issue へ明示的に委譲しているため**スコープ内**である。PR レビューで scope creep と読まれないよう、ここに列挙しておく。

- **画面仕様4件**（ステップ4）— P-02 の verification 非実施と重複エラー文言、P-03 のリセット完了導線、P-13 の SSO 専用アカウント。根拠は設計 `design.md:2341-2347`。
- **identity 系テストケースの追加**（ステップ15）— 設計 `design.md:2453-2468` の表が9ファイルそれぞれに期待値の書き方を指定している。**AC-19 / `P-7` が対応する受け入れ基準である。**
- **#13 への OAuth 2.1 / PKCE / `jti` の追記**（ステップ18）— 設計 `design.md:2333` の追加指示。
- **目次・件数の同期**（ステップ16.5）— 設計は `spec/manual-tests/index.md` を「影響なし」と判定しているが、その判定は件数が動かないことを前提にしている。本 Issue 自身の編集で件数が動くため判定を上書きする（adr.md ADR-010）。
- **ドメインイベント台帳行 24 件の削除**（ステップ12）— 第7.3節がイベントを廃止し、ステップ7 が定義表を消す一方、設計 第11.1節の台帳表がこの 24 行を数え落としている。**設計側の漏れを #35 で埋める**（adr.md ADR-011）。
- **検索 API のページング方式の適用先**（ステップ4・8・13）— 第7.2.1節は「#35 へ委譲」と明記された節で、`spec/` 側にしか正本が無い。4点を `spec/domains/search.md` に書くだけでは `spec/usecases/search.md` の入力 DTO・エラーケース表と `spec/testcases/search/search.md` の既存ケースが page 番号方式のまま残るので、適用先まで届かせる（adr.md ADR-012）。スナップショットの物理定義の置き場は adr.md ADR-013。

### 含まれないもの

- **実装コードの変更**（`packages/` / `apps/` / `infra/` / `wrangler*.toml` / マイグレーション SQL）。撤去と DO 移行は #37。
- **`docs/runtime_cloudflare.md` の更新。** Issue が明示的にスコープ外とし、#38 の担当。
- **`spec/**/review/` の 39 ファイル**と **`spec/usecases/review/002.md`。** レビュー記録は過去の判断の履歴であり、本文を書き換えると記録としての意味が消える（設計 第11.1節が断定）。**Issue #35 本文の背景節が `spec/usecases/review/002.md` を旧前提ファイルに挙げているが、これは「レビュー記録なので改訂対象から外す」と読み替える。**
- **`spec/adr/` の 6 ファイルと `.adr/` の 4 ファイルの本文。** 参照側だけを更新する（Issue 対応項目4）。`spec/adr/004:25` の「単一のハイブリッド検索」という引用も残す — 引用元の要件が変わっても棄却理由は成立し続けるため。
- **ベクトル検索・意味検索・Vectorize の再検討。** `.adr/003` の決定であり、覆さない。
- **鍵ローテーションの手順（#44）と cross-DO saga の異常系の自動回収（#45）。** `.thread/34/handoff.md` により #34 の成果物から切り出されている。`spec/` に書けるのは「一様な終端（`terminalReason` + `poison` + operator エスカレーション）」と**利用者から観測できる結果**までで、**巻き戻し手順・段構成・終端モードの印・材料寿命・再試行上限を書かない。** **`.thread/34/design.md` にはこの切り出しがまだ反映されていない**（handoff 第2節末尾・第3節ステップ1）ので、design 第11.1節の記述をそのまま `spec/` へ写すと #45 の射程を先取りする。線引きは adr.md ADR-009。
- **設計そのもののやり直し。** 設計 第11.1節が「#35 は本書と Issue の受け入れ条件を突き合わせ直さなくてよい」と書いている。判断が必要になったら design.md の該当節に従い、無ければ adr.md に記録して進める。
- **`spec/design/`（HTML デザイン・トークン）と `spec/issues.md`。** 視覚言語のみで永続化・検索・認証に触れない（設計の「影響なし」判定）。

## リスクと注意点

- **【最大リスク】語彙走査だけで作業すると9ファイルを落とす。** 設計 第11.1節の「手段4 でのみ拾えたもの」9件（`spec/testcases/identity/{requestPasswordReset,loginWithPassword,getCurrentUser,listAiClientConnections}.md` / `spec/testcases/export/exportAllData.md` / `spec/testcases/trash/listTrash.md` / `spec/scenario/account.md` / `spec/manual-tests/account.md` / `spec/inventory/frontend.md`）は、本設計が**足した**振る舞いに触れているファイルなので、旧語彙の grep には1件もヒットしない。**ステップ15 を飛ばすと AC-16 が満たせない。**
- **`.thread/34/handoff.md` 第4節の警告がそのまま効く。** 「正本だけを直して適用先の散文に届けない」形の破れに #34 は機械検査を設計できなかった。**design.md 第11.1節の表の1行だけを読んで書き換えず、必ず根拠節（第7.1節・第9.2節など）を開く。** steps.md の各ステップに根拠節を明記してある。
- **Issue 本文の受け入れ条件3 の文言が誤っている。** 「query / upsert / remove に単純化」ではなく **`query` 1本**（設計 第11.1節が訂正指示を出している）。Issue 本文どおりに `upsert` / `remove` をポートに残すと第7.1節と矛盾する。
- **`spec/inventory/test.md` の「定義場所」は `#L{行番号}` を持つ。** テストケース表の行を削除・追加すると **779 行の台帳側の行番号が全部ずれる。** ステップ12 では `domain` / `usecase` / `adapter` / `frontend` の4台帳だけを閉じ、**`test.md` は行を触るステップ（13・14・15）がすべて終わったあとの独立ステップ 15.5 で閉じる。** **ステップ15 も6ファイルにケースを追加する**ので、`#L` の往復対象に含める。
- **`spec/inventory/test.md` のヘッダは「連番はテーブルの行順（上から下）に対応する」と宣言している。** 表の途中にケースを挿入すると後続の `TC-{usecase}-{連番}` が別のケースを指すようになり、#10 / #13 が参照する ID が静かに取り違わる（AC-14 / AC-15 は「実在する」ことしか見ないので検出できない）。**新設ケースは各表の末尾に append し、既存ケースの行順を入れ替えない。(C) で削除したケースの連番は欠番のまま残す。**
- **同じ欠番規約が `TC-*` 以外の台帳 ID にも要る。** ステップ12 は `spec/inventory/domain.md` から**ドメインイベント行 24 件**（`DOM-identity-013`〜`017` / `DOM-memo-007`〜`012` / `DOM-knowledge-015`〜`027`）を行ごと消す。ここで連番を詰めると、**#13 が参照する `DOM-identity-023`〜`028`（`AiClientConnectionRepository` の6メソッド）が別の要素を指す** — 削除した5件の直後に `DOM-identity-018`〜`022` が並んでいるので、繰り上げると 023〜028 が 018〜023 へずれる。AC-14 / AC-15 は「実在する」ことしか見ないので**静かに取り違わる。削除した ID は欠番のまま残し、後続 ID を繰り上げない**（steps.md ステップ12 の「台帳 ID の共通規約」。adr.md ADR-011）。
- **設計 第11.1節の台帳表そのものに数え落としがある。** `spec/inventory/domain.md` の行（`design.md:2433`）は「`IndexEntry` 系のベクトル由来 / `User` 判別共用体 / trash の期限列挙」の3項目しか挙げておらず、**第7.3節が消すドメインイベント 24 件に触れていない。** 表の1行だけを読んで書き換えると必ず取り残す — `.thread/34/handoff.md` 第4節 罠1 そのものである。24 行は `V-3` に**全件掛かる**（「定義場所」欄が `spec/domains/*.md#ドメインイベント` なので走査語 `ドメインイベント` に当たる）が、**`V-3` が見せるのは「この行はヒットしている」までで「行ごと消す」ではない** — 要点欄とアンカーだけを書き換えると 24 行が定義場所を失ったまま残り、`P-8` も「アンカー先の見出しが実在するか」しか見ないので拾えない。
- **`spec/database/index.md:35` はどの負の検証にも掛からない。** 「trash / **search** / export ドメインは自前のテーブルを持たない（ADR-004）」「セッション・OAuth トークン等の**認証インフラは本設計のスコープ外**（後述）」という2つの宣言を持つ1行で、`V-1`〜`V-10` のどの語にも当たらない。**改訂を完璧にやっても AC-7（`search_entries` / `search_fts` をテーブルとして書く・認証系テーブルを列の全数まで書く）と正面から矛盾する宣言が同じファイルに残る。** ステップ10a が `:355-357` の同趣旨の宣言だけを消す形になっていたので、`:35` を明示的に対象へ加えてある。
- **設計 第4.3節の「不要になる」判定は、必ず「箇所」欄まで読む。** 第11.1節の削除リストは台帳 ID だけを並べているので、リストだけを読むと**スキーマ行の全削除に読める**。実際に行18（`ADP-memos-001` / `ADP-topics-001` / `ADP-documents-001`）の「箇所」欄は**期限切れ部分索引3本と `users` との全ユーザー JOIN** であり、テーブル行ではない。**行を削除すると `spec/inventory/adapter.md` から主要3テーブルが消え、`purge_after` 列の追加先も失われる。** 同じ表の行9 / 行16 / 行17 / 行22 / 行24 は行全体が消えて正しく、**行18 だけが例外である。** これは `.thread/34/handoff.md` 第4節が警告した破れ方そのもの。
- **台帳の「定義場所」欄はアンカー（`{file}#{見出し}` / `#L{n}`）を持つ。** ステップ10 が `spec/database/index.md` の節構成を DO 2部構成へ変え、ステップ8 が `spec/usecases/search.md#maintainSearchIndex` を消すので、**残す行のアンカーも大量に指し先を失う。** `P-8` で機械検査する（着手前は 0 件で、これを維持する）。
- **`spec/index.md` の「進捗」「成果物」節と `spec/manual-tests/index.md` の件数表は、本 Issue 自身の編集で嘘になる。** 「SQLite系・9テーブル」「52ユースケース」「約750ケース」「192ケース」はどれも V-1〜V-3 のどの語にも掛からないので機械検査で落ちない。**ステップ16.5 で最後に数え直す**（AC-18）。
- **`spec/domains/search.md` は 271 行のうち大半が消える。** 「インデックス更新フロー」節・`IndexerReadPort` 節・`EmbeddingPort` 節を丸ごと削るので、残る節（ユビキタス言語 / `IndexEntry` / 検索の規則）との整合が崩れやすい。`IndexEntry` は消さずに「projection の1行」として書き直す（`search_entries` の行に対応する）。
- **新しく書く文言が負の検証の走査語に当たることがある。** とくに **`埋め込み`** — 設計 第7.1節は「`search_entries` / `search_fts` は本体テーブルと同一の**埋め込み** SQLite に置かれる」と書いており、ステップ10 / 5 でこの言い回しを写すのは自然だが、`V-1` は `埋め込み` を走査語に持つので**正しい記述がベクトル残存として誤検出される。** 走査語のほうは削れない（`spec/` の旧記述は「埋め込みベクトル」「埋め込み生成」という形で残っている）ので、**書く側で「DO 内蔵の SQLite」「同一 DO 内の SQLite」と言い換える**（adr.md ADR-016）。
- **`spec/database/index.md` は削除だけでなく追記のほうが重い。** 403 行の前提（共有 SQLite + `user_id` 列による論理分離）ごと入れ替えたうえで、設計 第4.1.1節の 21 テーブル・第9章の migration 方針・FTS5 tokenizer 方針を足す。**現行の「認証インフラテーブルはスコープ外」宣言（`:355-357`）が消える**ので、認証系テーブルの記述先がこのファイルになる。**削除側（10a）だけ済ませて追記（10b / 10c）を飛ばしても、`V-*` と `P-1`〜`P-9` は全部通る** — この中間状態を検出する唯一の検査が `P-10` である。
- **`CLAUDE.md` は実装より先に走る。** #37 が終わるまで実体は D1 + Queues のままなので、規則だけを新構成で断定すると `CLAUDE.md` が現状の作業ガイドとして嘘になる。移行中であることの注記の置き方は adr.md ADR-005 で決める。
- **`spec/testcases/` のイベント期待の書き換えは3通り（(A) projection の期待へ読み替え / (B) 期待を落とす / (C) ケースごと削除）で、どれを選ぶかは設計 第11.1節の表が個別に指定している。** 一律 (C) にすると業務上意味のあるケース（作成・編集の正常系）まで消える。
- **`spec/manual-tests/{trash,timeline,settings}.md` の DB 直接更新手順は、代替手段の実体が #38 にある。** #35 は「Alarm の強制発火 / DO 単位のシード投入に相当する手段（実体は #38）」までしか書けない。**具体的なコマンドを推測で書かない。**
- **#10 / #13 の Issue 本文更新は `gh issue edit` を伴う外部副作用である。** 台帳の改訂が固まる前に編集すると二度手間になるので、必ず最後（ステップ18）に回す。
- **Markdown のスタイル。** `markdown-style` の規約（強調の見出し代用をしない、余計な区切り線を置かない、不自然な改行をしない）に従い、既存ファイルの書式を踏襲する。

## テスト方針

自動テストは無い（ドキュメント Issue）。**代わりに「旧前提が残っていないこと」を機械的に確認する grep バッテリーを完了ゲートにする。** steps.md の最終ステップ（19）で全件を実行し、結果を PR 本文に貼る。

### 負の検証（ヒットしたら不合格）

射程はすべて `spec/**/*.md` から `**/review/**` と `spec/adr/**` を除いたもの。**除外2つのどちらを落としても検証は機能しない**（adr.md ADR-007）。

**着手前の実測ベースライン（2026-08-01 時点。全件を実行して確認済み）:**

| 検査 | ベースライン | 完了時の期待 |
|---|---|---|
| V-1 | 41 行 | 0 行 |
| V-2 | 16 行（V-2a 12 + V-2b 12。重複を除いた実体が 16 行） | 0 行 |
| V-2c | 4 行（すべて `spec/manual-tests/trash.md` の「テスト環境の DB」） | 0 行 |
| V-3 | 296 行（除外前は 297 行。`spec/index.md:42` の ADR 一覧表の `005` 行1行を射程から外した数。adr.md ADR-014） | 0 行 |
| V-4 | 92 行 | 0 行 |
| V-5 | 26 行（`ADR-005` / `005-search-index-via-outbox` を含む行は全 26 行で、**現状はその全部が無注記**） | 0 行 |
| V-6 | 2 行（`Reference runtimes` 1 + `drizzleSqlite` 1。**2コマンドの合計である**） | 0 行 |
| V-7 | 7 行 | 0 行 |
| V-8 | 2 行 | 0 行 |
| V-9 | 2 行（`CLAUDE.md:69` の Outbox 項・`:70` の `SQLITE_BUSY` / `adapters/d1`） | 0 行 |
| V-10 | 9 行（`spec/usecases/search.md:24,64,82` / `spec/testcases/search/search.md:7,24,25,27,34,35`。`spec/pages/index.md` は 0 行） | 0 行 |

**すべて 0 になれば完了。** 進捗の目安に使う。

**正の検証の着手前ベースライン（同日実測。`P-1`〜`P-6` と `P-11` の第2行は「着手前 0 → 完了後 1 以上」を判定できる形にしてある。`P-11` の第1行だけは「着手前 1 → 完了後も 1」の維持検査で、これは「残すべき一文を消していない」ことを測る唯一の手段である）:**

| 検査 | ベースライン | 完了時の期待 |
|---|---|---|
| `P-1`（6ファイル別。**検査語はファイルの層に合わせて2種類**） | `FTS5` 群: `requirements 0 / domains/search 0 / database/index 1 / manual-tests/search 0`。`全文検索` 群: `scenario/search 0 / usecases/search 0` | 全ファイル 1 以上 |
| `P-2`（tokenizer と検索の規則） | `trigram` database 1 / `NFKC` database 0 / `不透明カーソル` database 0。`instr(` 0。`不透明カーソル` domains 0。`bm25\|timestamp DESC` domains 0。`TOPIC_NOT_FOUND` domains 0 / usecases 0 | 各行 1 以上 |
| `P-3` | すべて 0 行 | 各行 1 以上 |
| `P-4` | すべて 0 行 | 各行 1 以上 |
| `P-5` | `Durable Object` 0 / `at-least-once\|Alarm\|transactionSync` 1（`CLAUDE.md:69` の Outbox 項。**ステップ17 で消える行**なので、この 1 は「もう満たしている」ことを意味しない） | 各行 1 以上 |
| `P-6` | `SearchIndexPort` は 5 メソッド（`query` + 書き込み4本） | `query` 1行のみ |
| `P-7`（10本） | すべて 0 行 | 各行 1 以上 |
| `P-8` | 0 行 | 0 行 |
| `P-9` | 12 行（`KIND-MISSING:` が 12 種すべて） | 0 行 |
| `P-10` | 10 行（`TABLE-MISSING:` が `account` / `user_settings` / `credential_locators` / `search_entries` / `jobs` / `operations` / `migration_progress` / `_meta` / `credential_mappings` / `rotation_checkpoints`） | 0 行 |
| `P-11` | `検索方式の選択をAIに委ねない` 1 行 / `search — 全文検索` 0 行 | それぞれ 1 行 / 1 行以上 |

**`P-1` / `P-2` は「1ファイルでもヒットすれば通る」形にしない。** 複数ファイルを1コマンドに束ねると、`spec/database/index.md` の着手前 1 行（`:349` の「FTS5 仮想テーブル」「トークナイザ（trigram 等）」。**どちらもステップ10 で削除される行**）だけでゲートを通過してしまい、AC-4 / AC-6 / AC-7 / AC-11 の裏づけにならない。**ファイルごとに数え、全ファイルが 1 以上**を条件にする。

**正の検証のセルは「そのファイルを担当するステップが実際に書く語」でだけ測る**（adr.md ADR-015）。ステップの指示に無い語を検査が要求すると、実装者はゲートを通すためだけに語を挿すことになり、**その挿し先が ADR-004 のレイヤ配置（tokenizer 機構は `spec/database/index.md` に一本化する）を破る。** 3周目レビューが実際に見つけた形なので、セルを変えた3箇所を明示しておく。

- **`trigram` / `NFKC` / `instr(` は `spec/database/index.md` だけで測る。** `spec/domains/search.md` 側の要求は落とした — ステップ5 は tokenizer に触れないし、触れさせてもいけない（ADR-001 が狙った「search ドメインは問い合わせに一点集中」も崩れる）。
- **`spec/scenario/search.md` / `spec/usecases/search.md` は `FTS5` ではなく `全文検索` で測る。** ステップ3 の指示は「ハイブリッド検索 → 全文検索」の置換であり、design `:2358` も全文検索への置き換えまでしか要求していない。**シナリオ層に実装語彙（FTS5）を持ち込まない。** 着手前は両ファイルとも `全文検索` が 0 行なので、完了検出としては `FTS5` と同じ強さを保つ。
- **`P-7` の第8・第9行**（`spec/manual-tests/account.md` / `spec/testcases/export/exportAllData.md`）も同じ理由でステップ15 の指示語に合わせた（`ロックアウト` / `上限\|transactionSync`）。旧セルの `所有確認\|verification` は scenario 側の指示（第7行）であり、手順書側には設計・ステップのどちらにも根拠が無かった。`総バイト` も同様で、ステップの文言は「上限超過」である。

```bash
cd /Users/hikaru/github.com/tuanemuy/fog
SCOPE() { grep -v '/review/' | grep -v '^spec/adr/'; }

# V-1 ベクトル検索まわり（AC-1）— 期待 0 行
grep -rniE 'ベクトル|embedding|埋め込み|\bRRF\b|Vectorize|ハイブリッド|hybrid|意味検索|セマンティック検索|semantic search|search_embeddings|F32_BLOB' spec --include='*.md' | SCOPE

# V-2 旧ランタイム前提（AC-2）— 2本とも期待 0 行
# V-2a: D1 以外の旧ランタイム語。射程の除外なし
grep -rniE 'libSQL|Turso|PendingBatch|occ_guard' spec --include='*.md' | SCOPE
# V-2b: \bD1\b。ただし spec/manual-tests/{search,trash}.md を射程から外す
grep -rniE '\bD1\b' spec --include='*.md' | SCOPE | grep -vE '^spec/manual-tests/(search|trash)\.md:'

# V-2c V-2b で除外した2ファイルに旧ランタイム由来の記述が無いこと（AC-2）— 期待 0 行
grep -rniE 'libSQL|Turso|PendingBatch|occ_guard|wrangler|Cloudflare|共有 ?(DB|データベース)|テスト環境の ?DB' \
  spec/manual-tests/search.md spec/manual-tests/trash.md

# V-3 Outbox / イベント transport（AC-3）— 期待 0 行
# 最後の grep -v は spec/index.md の ADR 一覧表の 005 行1行だけを射程から外す（adr.md ADR-014）。
# リンク先ファイル名 005-search-index-via-outbox.md が走査語 Outbox に当たるため、
# この行を残す限り V-3 は構造的に 0 にならない。行の内容は V-5 が
# 「同一行に superseded の注記があること」でゲートするので、外しても検査は緩まない
grep -rniE 'Outbox|collectEvents|consumer|relay|DLQ|pruner|processed_events|IndexerReadPort|EmbeddingPort|maintainSearchIndex|EventDraft|ドメインイベント' spec --include='*.md' | SCOPE \
  | grep -v '^spec/index\.md:[0-9]*:| \[005\]'

# V-4 SearchIndexPort の書き込みメソッド（AC-6）— 期待 0 行
grep -rnE 'upsertMemo|upsertDocument|removeMemo|removeDocument|listExpiredItems' spec --include='*.md' | SCOPE

# V-5 無注記の supersede 済み ADR 参照（AC-13）— 期待 0 行
# 「併記すれば ADR-005 の文字列は正しく残る」ので、残存数ではなく無注記の数を測る。
# 注: 除外語は .adr/ 側のファイル名で書く。`adr/003` / `adr/004` と略すと
#     spec/adr/003-source-link-after-hard-delete.md / spec/adr/004-domain-boundaries.md への
#     正当なリンクを持つ行（spec/database/index.md:6 ほか計4行）まで excuse してしまう
grep -rn 'ADR-005\|005-search-index-via-outbox' spec --include='*.md' \
  | grep -v '/review/' | grep -v '^spec/adr/005' \
  | grep -v 'sqlite-fts5-only-search\|do-local-commit-and-alarm-jobs\|superseded'

# V-6 壊れた CLAUDE.md 参照（AC-8）— 2コマンドの合計で期待 0 行
grep -rn 'Reference runtimes' spec CLAUDE.md
grep -rn 'drizzleSqlite' spec CLAUDE.md

# V-7 非同期反映を利用者へ約束する記述（AC-10 / AC-11）— 期待 0 行
grep -rniE 'ヒットしない場合がある|反映は非同期|1〜2分待つ|少し待って' spec --include='*.md' | SCOPE

# V-8 CLAUDE.md のランタイム中立宣言（AC-12）— 期待 0 行
grep -n 'stay intact across such a swap\|the inward layers stay put' CLAUDE.md

# V-9 CLAUDE.md の Key concepts / Retry strategy に残る旧構成（AC-12）— 期待 0 行
# 射程を節に限定する。全文 grep は使えない — Reference runtime 節の
# worker/cloudflare/{relay,consumer,pruner,dlq}.ts と #40 の段落は #37 まで実在するので残す
sed -n '/^## Key concepts/,/^## Error handling/p' CLAUDE.md \
  | grep -niE 'Outbox|collectEvents|SQLITE_BUSY|SQLITE_LOCKED|adapters/d1'

# V-10 検索 API に残る page 番号方式（AC-6b）— 期待 0 行
# 第7.2.1節はページングを「期限付きスナップショット + 不透明カーソル」と決めており、
# page 番号方式と同居させない（adr.md ADR-012）。`limit` は方式に依らないので射程に入れない
grep -nw 'page' spec/usecases/search.md spec/testcases/search/search.md spec/pages/index.md
```

**V-2 が `spec/manual-tests/{search,trash}.md` を射程から外す根拠。** この2ファイルの `\bD1\b` は **10 行すべてがテストデータのドキュメント名**であり、Cloudflare D1 とは無関係である。内訳は `spec/manual-tests/search.md` の `:37` / `:44` / `:47` / `:70` / `:188` / `:189`（6行。いずれも `D-D1` というテスト用ドキュメント ID。`\bD1\b` は直前が非単語文字の `D-D1` にも当たる）と、`spec/manual-tests/trash.md` の `:97` / `:98` / `:99` / `:157`（4行。「D1を個別削除」「D1の「復元」」等のテスト用ドキュメント名）。**テストデータ名の改名は本 Issue のスコープ外**であり、パターンだけでは `D1（出典にメモ…` と `D1（interactive tx なし）` を分離できないため、ファイル単位で外したうえで V-2c を当てる。

**`V-3` が `spec/index.md` の ADR 一覧表の `005` 行を射程から外す根拠。** 除外するのは **1行だけ**である（実測で `spec/index.md` の `V-3` ヒットはこの行だけ）。`spec/index.md:42` は ADR 索引の行 `| [005](./adr/005-search-index-via-outbox.md) | 検索インデックスの更新方式 |` で、**走査語 `Outbox` に当たっているのはリンク先のファイル名だけ**である。ADR 本文もファイル名も本 Issue では変えない（対応項目4・adr.md ADR-007）一方、design `:2444` と AC-13 は「この表に `005` の superseded を反映する」＝**行を残す**ことを要求しているので、行を残す限り `V-3` は構造的に 0 にならない。**基準は緩めていない** — この行の内容は `V-5` が「同一行に `.adr/003` / `.adr/004` / `superseded` のいずれかがあること」で測っており、除外しても無注記のまま残せば `V-5` で落ちる。**除外パターンは行頭のセルの形（`| [005](...)`）に一致するので、ステップ11 はこのセルの形を保ったまま注記を足す**（adr.md ADR-014）。**併記側でファイル名 `005-search-index-via-outbox` を書かない**のもこのためで、書けば `V-3` のヒットが増える。

**Issue コメント（PR #39 引き継ぎ）第3項との対応。** コメントの `grep -rniE '\b(aws|gcp|lambda|turso|libsql)\b|node\.js|cloud run|pub/sub|dynamodb|sqs' spec/` は**実測 7 行 / 4 ファイル**である（コメント見出しの「6 行」は数え落とし。コメント本文の表自体は7箇所を列挙している）。**V-2 はこの grep の上位互換**であり、コメントが「有効な設計」として挙げた5行（`spec/database/index.md:3` / `:341` / `:349` / `:350` / `spec/inventory/adapter.md:22`）はすべてステップ10 / 12 に落ちている。「改訂不要」とした `spec/database/review/{002,003}.md` は ADR-007 により射程外。

### 正の検証（ヒットしなければ不合格）

```bash
# P-1 全文検索が上流から下流まで通っている（AC-4 / AC-6 / AC-7 / AC-11）— 全ファイルが 1 以上
# 束ねた grep は使わない。着手前から spec/database/index.md:349 が 1 行ヒットするので、
# 束ねると残り5ファイルが 0 のままでもゲートを通過してしまう
# 実装語彙（FTS5）を要求してよいのは要件・ドメイン・DB・手順書まで。
# シナリオとユースケースは `全文検索` で測る（ADR-015。着手前はどちらも 0 行）
for f in spec/requirements.md spec/domains/search.md \
         spec/database/index.md spec/manual-tests/search.md; do
  printf '%s FTS5=%s\n' "$f" "$(grep -c 'FTS5' "$f")"
done
for f in spec/scenario/search.md spec/usecases/search.md; do
  printf '%s 全文検索=%s\n' "$f" "$(grep -c '全文検索' "$f")"
done

# P-2 tokenizer 方針（AC-7）と検索の規則（AC-6 / AC-6b。設計 第7.2.1節の4点）
# ファイルをまたぐものは1行1ファイルに割る（片方だけ書いて通るのを防ぐ）
# 注: カーソルは `不透明カーソル` で測る。`スナップショット` 単独は既存のリビジョン記述に
#     6行当たり（`spec/database/index.md:183,184,292,295,380` / `spec/domains/search.md:15`）、
#     `カーソル` 単独は migration の `cursor` 列に当たるので、どちらも着手前 0 にならない
# 注: tokenizer の機構語（trigram / NFKC / instr()）は spec/database/index.md だけで測る。
#     ADR-004 が「方針と機構は spec/database/index.md に書く」と決めており、
#     spec/domains/search.md に要求すると実装機構が search ドメインへ漏れる（ADR-015）
printf 'spec/database/index.md trigram=%s NFKC=%s cursor=%s\n' \
  "$(grep -c 'trigram' spec/database/index.md)" \
  "$(grep -c 'NFKC' spec/database/index.md)" \
  "$(grep -c '不透明カーソル' spec/database/index.md)"
grep -n 'instr(' spec/database/index.md
grep -c '不透明カーソル' spec/domains/search.md     # ドメイン側はカーソル契約だけ
grep -niE 'bm25|timestamp DESC' spec/domains/search.md
grep -n 'TOPIC_NOT_FOUND' spec/domains/search.md    # domains 側（検索の規則）
grep -n 'TOPIC_NOT_FOUND' spec/usecases/search.md   # usecase 側（エラーケース表。ステップ8）

# P-3 schema version / lazy migration（AC-7）
grep -n 'schema_version' spec/database/index.md
grep -n 'migration_progress' spec/database/index.md
grep -niE 'forward-only|fail-closed|PITR' spec/database/index.md

# P-4 非機能要件の物理分離（AC-5）
grep -n 'Durable Object' spec/requirements.md
grep -niE '到達可能性|10 ?GB' spec/requirements.md

# P-5 CLAUDE.md（AC-12）
grep -n 'Durable Object' CLAUDE.md
grep -niE 'at-least-once|Alarm|transactionSync' CLAUDE.md

# P-6 SearchIndexPort が query 1本（AC-6）
grep -A6 'interface SearchIndexPort' spec/domains/search.md   # query 行だけであること

# P-7 手段4 で足す振る舞い（AC-19）— 各行がヒットすること。着手前はすべて 0 行
# 9ファイルを1本ずつ固定する。ディレクトリ指定や複数ファイルの OR は使わない
# （片方だけ改訂しても通るため。とくに getCurrentUser.md はディレクトリ指定では固定できない）
grep -n '到達性' spec/testcases/identity/loginWithPassword.md
grep -nE 'credentialVersion|nextAttemptAllowedAt|changeState' spec/testcases/identity/loginWithPassword.md
grep -n 'credentialId' spec/testcases/identity/getCurrentUser.md   # 第6.1.2節 (C5) の3つ組
grep -n 'createdAtResetVersion' spec/testcases/identity/listAiClientConnections.md
grep -n 'operationKey' spec/testcases/identity/requestPasswordReset.md
grep -n 'purge_after' spec/testcases/trash/listTrash.md
grep -niE '所有確認|verification' spec/scenario/account.md
grep -n 'ロックアウト' spec/manual-tests/account.md               # 手順側は 15c の指示語で測る
grep -niE '上限|transactionSync' spec/testcases/export/exportAllData.md
grep -n 'PAGE-password-reset-004' spec/inventory/frontend.md
# 補: ステップ14 側の裏づけ（AC-19 の 9 ファイルには含まれない）
grep -n 'changeState' spec/testcases/identity/changePassword.md

# P-8 台帳の「定義場所」アンカーが実在すること（AC-9）— 期待 0 行（着手前も 0 行）
slug() { tr 'A-Z' 'a-z' | sed 's/[`．・､，,。：:；;（）()／\/「」【】"?!]//g; s/ /-/g; s/-*$//'; }
awk -F'|' '/^\| /{gsub(/^ +| +$/,"",$4); if ($4 ~ /\.md#/) print $4}' spec/inventory/*.md | sort -u \
  | while IFS='#' read -r f a; do
      [ -f "$f" ] || { echo "NOFILE: $f#$a"; continue; }
      case "$a" in
        L[0-9]*) [ "$(wc -l < "$f")" -ge "${a#L}" ] || echo "DANGLING: $f#$a" ;;
        *) grep -E '^#{1,6} ' "$f" | sed 's/^#* //' | slug | grep -q "^$(printf '%s' "$a" | slug)" \
             || echo "DANGLING: $f#$a" ;;
      esac
    done

# P-9 jobs.kind の12種が CLAUDE.md の4類型と spec/database/index.md の全数表の両方にある（AC-7 / AC-12）
# 設計 第7.7節 項2 は「4類型が第7.4節の12種を漏れなく1回ずつ覆う」を第1.4節 I-7 の不変条件にしている。
# 改訂後はこの不変条件が CLAUDE.md（4類型）と spec/database/index.md（全数表）に分かれるので、
# 両側に同じ12種が載っていることを1本で押さえる — 期待 0 行（着手前は 12 行）
for k in send-mail purge-trash sweep-reservations sweep-reset-tokens reindex migrate-bulk \
         rotate-encryption finalize-withdrawal resume-link resume-signup \
         resume-credential-change sweep-orphan-mapping; do
  c=$(grep -c "$k" CLAUDE.md); d=$(grep -c "$k" spec/database/index.md)
  [ "$c" -ge 1 ] && [ "$d" -ge 1 ] || echo "KIND-MISSING: $k claude=$c db=$d"
done

# P-10 設計 第4.1.1節のテーブル全数が spec/database/index.md にある（AC-7 (i)）— 期待 0 行
# ステップ10 は「削除だけ済んで追記が中途半端」という中間状態で止まりやすい（steps.md が
# 自らそう名指ししている）。V-1〜V-10 と P-1〜P-9 は削除側しか測らないので、
# 10b（User Data DO 16テーブル）と 10c（Identity Directory DO 5テーブル）を丸ごと飛ばしても
# 全部通ってしまう。追記側を測る唯一の検査がこれである。着手前は 10 行
# 注: 第4.1.1節は「User Data DO 16 + Identity Directory DO 5」の21セルだが、
#     `jobs` と `_meta` が両クラスに現れるので、名前の異なり数は 19 である
for t in account user_settings credential_locators ai_client_connections \
         memos memo_revisions topics documents document_revisions source_links \
         search_entries search_fts jobs operations migration_progress _meta \
         credential_mappings password_reset_tokens rotation_checkpoints; do
  grep -q "\b$t\b" spec/database/index.md || echo "TABLE-MISSING: $t"
done

# P-11 要件 4.4 / 4.5 の「残す側」と「置き換える側」（AC-4）
# 負の検証は「消えたこと」しか測れないので、残すべき一文はここでしか守れない
grep -n '検索方式の選択をAIに委ねない' spec/requirements.md   # 着手前 1 行 → 完了後も 1 行
grep -n 'search — 全文検索' spec/requirements.md              # 着手前 0 行 → 完了後 1 行以上
```

### 目次・件数の同期（AC-18）

```bash
# spec/index.md の転記数値 — 期待 0 行（着手前は 6 行）
grep -n '9テーブル\|SQLite系\|52ユースケース\|192ケース\|約750ケース' spec/index.md

# spec/manual-tests/index.md の件数表が実測と一致すること
for f in account timeline document search trash ai settings; do
  printf '%s %s\n' "$f" "$(grep -cE '^#+ TC-[0-9]+' spec/manual-tests/$f.md)"
done
for f in account timeline document search trash ai settings; do
  grep -cE '^#+ TC-[0-9]+' spec/manual-tests/$f.md
done | paste -sd+ | bc                      # 合計。着手前は 192
grep -n '合計' spec/manual-tests/index.md   # 表の合計行が上の値と一致すること
```

**着手前の実測:** `account 37 / timeline 37 / document 41 / search 17 / trash 25 / ai 23 / settings 12`、合計 **192**。`spec/manual-tests/index.md:15-22` の件数表と完全一致する。ステップ15（`account.md` に3系統）とステップ16（`search.md` に FTS5 の確認項目）が新規 `TC-NN` を足すと**この一致が壊れる**ので、ステップ16.5 で表・合計・実行記録の分母を数え直す。

### カバレッジの再走査（AC-16）

設計 第11.1節の再現手順をそのまま実行し、判定の付いていないファイルが無いことを確認する。**ファイル数は着手前 101 / 完了後 100 で、差の1件は `spec/testcases/search/maintainSearchIndex.md` の削除である**（新設ファイルは無い。追加はすべて既存ファイルへの節・行追加）。100 以外になったらファイルが増減しているので、増えた分を第11.1節の判定表と `.thread/35/coverage.md` へ追加する。

```bash
find spec -name '*.md' | grep -v '/review/' | wc -l          # 着手前 101 / 完了後 100
grep -rlE 'Outbox|outbox|consumer|ベクトル|埋め込み|ハイブリッド|collectEvents|pruner|D1|libSQL|Turso|Vectorize|RRF|PendingBatch|occ_guard|UnitOfWork|indexer|embedding|イベント|Queue' \
  spec --include='*.md' | grep -v '/review/' | wc -l         # 改訂後は 0 に近い残数（V-1〜V-3 で個別に 0 を確認済み）

# 判定台帳（ステップ1 で作る）に全ファイルの行があること — 期待 0 行
find spec -name '*.md' | grep -v '/review/' | sort \
  | while read -r f; do grep -q "$f" .thread/35/coverage.md || echo "NO-VERDICT: $f"; done
```

### #10 / #13 との照合（AC-14 / AC-15）

```bash
# #10 のチェックリスト ID を抜き出して台帳に実在するか確かめる
# 注: TEST も alternation に入れる。入れないと #10 の `TEST-DO-004` / `TEST-MAN-002` が
#     どのパターンにも掛からず、MISSING にすら現れない（\bTC- は TEST- にマッチしない）
gh issue view 10 --json body -q .body | grep -oE '\b(DOM|UC|ADP|PAGE|TC|TEST)-[A-Za-z-]+-[0-9]{3}\b' | sort -u \
  | while read id; do grep -qrn "| $id " spec/inventory/ || echo "MISSING: $id"; done
# 期待: MISSING が 0 行
# 着手前の実測: ADP-UD-001〜004 / DOM-SEARCH-001〜004 / UC-SEARCH-001 / TEST-DO-004,006,007 /
#               TEST-MAN-002 が MISSING（一致しているのは PAGE-search-001〜004 のみ。adr.md ADR-008）

# #13 についても同じ
gh issue view 13 --json body -q .body | grep -oE '\b(DOM|UC|ADP|PAGE|TC|TEST)-[A-Za-z-]+-[0-9]{3}\b' | sort -u \
  | while read id; do grep -qrn "| $id " spec/inventory/ || echo "MISSING: $id"; done
# 着手前の実測: MISSING は 0 行（#13 の ID はすべて現行の台帳に実在する）。
# したがって AC-15 の作業は「消える3件を除く」ことと、残る行が改訂後も実在し続けることの維持である
```

### 機械ゲート（AC-17）

```bash
pnpm lint && pnpm format:check
git diff --name-status main...HEAD | grep -vE '^[AMD]\s+(spec/.*\.md|CLAUDE\.md|\.thread/35/.*)$'   # 期待 0 行
```

### 目視レビュー（grep で代替できない項目）

- **ステップ15 の 9 ファイル**が実際に改訂されているか。設計 第11.1節「改訂する — 手段4 でのみ拾えたもの」の表の各行の「指示」欄と1対1で突き合わせる。**`P-7` が機械側の裏づけになるが、`P-7` はキーワードの有無しか見ない**ので、期待値の中身は目視で確認する。
- **ステップ14 の (A)/(B)/(C) の適用**が、設計 第11.1節（`design.md:2394-2428`）の表の**行ごとの指定と1対1で一致しているか。** 「(A) にすべき行を (B) で処理した」（= projection の期待が抜けた）は V-3 では絶対に落ちない。**30行のチェックリストを `.thread/35/step14-checklist.md` に置き、適用結果を1行ずつ照合する。** チェックリストには「**`spec/inventory/test.md` 側の要点欄も直したか**」の列を持たせる — (A) / (B) で生き残ったケースのうち7件（`:138` / `:165` / `:396` / `:503` / `:516` / `:569` / `:754`）は台帳の要点欄に `Outbox` / `pruner` を持つので、ステップ15.5 がそれを拾う入力になる。
- **`spec/inventory/test.md` の `#L{行番号}`** が、改訂後の `spec/testcases/` の実際の行を指しているか（抜き取り10件）。`P-8` は「その行番号までファイルがある」ことしか見ないので、指し先が正しいケースかは目視で確認する。
- **`spec/domains/search.md` の残った節**（ユビキタス言語 / `IndexEntry` / 検索の規則）が、削った節への参照を残していないか。
- **`spec/domains/search.md` に tokenizer の機構（`trigram` / `instr()` / `NFKC`）が漏れていないか。** 落とし先は `spec/database/index.md` である（adr.md ADR-004 / ADR-015）。**この向きの誤りは `V-*` にも `P-*` にも掛からない** — 正の検証はセルを `spec/database/index.md` に固定したので、両方に書いても通ってしまう。ステップ5 の「やってはいけないこと」と1対1で確認する。
