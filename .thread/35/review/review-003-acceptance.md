# レビュー 003 — 受け入れ基準の充足（3ラウンド目 / 最終判定）

**PR:** #46（Issue #35） / ベース `main`（`2a88cf2`） / HEAD `f2a2fd4`
**観点:** 受け入れ基準の充足。Issue 本文の「対応項目1〜7」「受け入れ条件7項目」「PR #39 引き継ぎコメント3項目」を AC 表を経由せず直接潰し、AC-1〜AC-19 を全件コマンド実行で判定する。
**既判定:** `.thread/35/review/triage.md`（1R: B×10 / W×29、2R: B×12 / W×24）を読み、判定済み Key は再提出していない。

---

## 受け入れ基準の充足

### Blockers

**なし。**

Issue 本文の受け入れ条件7項目のうち、リポジトリ内で完結する6項目はすべて実測で充足している。7項目目（#10 の実装チェックリスト整合）だけが未実施だが、これは triage `W-029` で「判定は `fix`。実行順序は最後（APPROVED 後にステップ18）」と合意済みの運びであり、再提出しない。

### Warnings

**[W-001]** `.thread/35/steps.md:104` の「完了後のファイル数」が `102` のまま残っており、確定値 `103` と食い違う。

- **場所:** `.thread/35/steps.md:104`
  「着手時点の見込みでは完了後のファイル数は **100** だが、**レビューで新設ユースケース2件のテストケースファイルが増えたため最終値は 102**（adr.md **ADR-059**）」
- **理由:** 2ラウンド目に `ADR-062` が `linkSsoCredential` を足して新設ファイルが3件になり、確定値は **103** になった。`plan.md` AC-16（`103`）・`coverage.md:20`（`103`）・`testing.md:214`（`103`）・`ADR-059` の続報（`103`）はすべて 103 へ更新されているのに、`steps.md` だけが 2R 前の `102` / 「新設ユースケース2件」を保持している。実測は `find spec -name '*.md' | grep -v '/review/' | wc -l` = **103**。`.thread/35/` は PR に含まれる成果物であり、後から読む担当（#37）が「102 のはず」と数え違える材料になる。1R の `W-028` は `step14-checklist.md` 自身の件数の話で本件とは別の場所であり、2R 時点では `102` が正しかったので既判定の蒸し返しではない。
- **提案:** `steps.md:104` を「レビューで新設ユースケース**3件**のテストケースファイルが増えたため最終値は **103**（adr.md ADR-059 / **ADR-062**）」に直す。

### Notes

**[N-001]** 「30行のチェックリスト」という記述が4箇所に残っている（実体は 32 行）。

- **場所:** `.thread/35/plan.md:392` / `.thread/35/steps.md:319` / `.thread/35/steps.md:428` / `.thread/35/testing.md:224`
- **理由:** `step14-checklist.md` 自身は 1R の `W-028` を受けて 32 行になり、末尾（`:47`）で「設計の表は30ファイルを挙げているが、本チェックリストは32行ある」と差の理由を明記している。しかし参照側4箇所は「30行が全件埋まっていることを確認する」のままなので、`testing.md` 確認項目12 手順3 に素直に従うと 2 行ぶん検証が抜ける。実害は小さい（2R レビューが 32 行を全件照合済み）が、手順書としては不整合。
- **提案:** 4箇所を「32行」に揃えるか、`step14-checklist.md:47` の但し書きを参照する形に直す。

**[N-002]** `.thread/35/adr.md:1699` の ADR-059 の**見出し**が `spec/` のファイル数を `102` と書いたままである。

- **場所:** `.thread/35/adr.md:1699`「## ADR-059: 新設ユースケースのテストケースは新規ファイルで足し、`spec/` のファイル数を 102 とする」
- **理由:** 同 ADR の Consequences 末尾（`:1720`）に「**続報（2ラウンド目）:** … `spec/` のファイル数は 103、AC-16 の期待値も 103 である」と訂正が入っており、内容としては閉じている。見出しだけが旧値。ADR 本文を追記で訂正する運用（続報方式）自体はこのリポジトリで一貫しているので、矛盾する ADR の同居ではなく表題の陳腐化と判定した。
- **提案:** 見出しから数値を落とす（「新設ユースケースのテストケースは新規ファイルで足す」）と、以後の増減で再び古くならない。

**[N-003]** AC-14 / AC-15（#10 / #13 との照合）の実測 MISSING 件数。**ステップ18 の作業量の見積り材料として記録する。**

`gh issue view 10` の実測 — **MISSING 13 件**（#10 が参照する ID のうち改訂後の `spec/inventory/` に実在しないもの）:

```
ADP-UD-001 / ADP-UD-002 / ADP-UD-003 / ADP-UD-004
DOM-SEARCH-001 / DOM-SEARCH-002 / DOM-SEARCH-003 / DOM-SEARCH-004
UC-SEARCH-001
TEST-DO-004 / TEST-DO-006 / TEST-DO-007 / TEST-MAN-002
```

一致しているのは `PAGE-search-001`〜`004` の4件のみ。`plan.md` の着手前実測（`adr.md` ADR-008）と**完全に同一**であり、本 PR は #10 側を1文字も触っていない（外部副作用なので意図どおり）。ADR-008 が「#10 の Issue 本文を `spec/inventory/` の ID 体系に合わせる（逆ではない）」と決めているので、作業は #10 本文の書き換え13行ぶん。

`gh issue view 13` の実測 — **MISSING 3 件**:

```
DOM-identity-016 （#13:17 「identity.aiClientConnected イベント」）
DOM-identity-017 （#13:18 「identity.aiClientRevoked イベント」）
TC-revokeAiClientConnection-002 （#13:59 「失効イベントでのトークン削除」）
```

3件とも「設計 第7.3節で消える分」そのもので、AC-15 が除去を要求している行と一致する。**着手前は 0 行だったので、この 3 は本 PR が台帳から正しく消したことの裏返しである**（`testing.md` 確認項目10 の但し書きどおり「増えていないこと」を測る検査が、いま増えている状態）。あわせて `plan.md` スコープが挙げた「#13 への OAuth 2.1 / PKCE / `jti` の追記」も未実施（`gh issue view 13` に `PKCE` / `jti` の記述なし）。

いずれも triage `W-029`（判定 `fix`、実行順序は APPROVED 後）に沿った状態であり、新規指摘ではない。

**[N-004]** `linkSsoCredential` の新設は **scope creep ではない**と判定した。根拠を残す。

Issue #35 の「対応項目1〜7」にも「受け入れ条件7項目」にも SSO 連携は現れないので、字面だけ見れば範囲外である。しかし次の連鎖が閉じており、外すと `spec/` が自己矛盾する:

1. Issue 対応項目3 が「`spec/database/index.md` を SQLite-backed DO 一本化」「D1 固有 UoW の記述を DO の直列実行に合わせて書き換える」を要求する。Outbox の代替機構は `jobs` + Alarm なので、`jobs` テーブルの記述は必須。
2. `.thread/34/design.md` 第4.1.1節 / 第7.4節が `jobs.kind` の全数を**12種**と確定しており、`resume-link` はそのうちの1つ（`design.md:539`）。AC-7 (vii) と `P-9` / `P-10` はこの12種を機械ゲートにしている。
3. 同じ設計の第7.4節 (7) が「投入点の無い周期・反復ジョブは1回完走した時点で恒久停止する」を断定し、2R の `R2-B-004` を受けて `ADR-072` が「`kind` 全数表の投入点欄の非空」を不変条件にした。`resume-link` の投入点は SSO 連携の追加以外に存在しない。
4. 設計 第6.6節は SSO link を**4手順の cross-DO saga として全設計している**（`design.md:1387-1416`）。`.thread/34/design.md` の側では既に決着済みの設計であり、#35 が新たに発明した機能ではない。
5. 1R の `B-002` / 2R の `R2-B-002` で新設した `unlinkSsoCredential` は、link 経路が無いと**正常系が構造的に到達不能**になる。

実装の観点でも上流から下流まで一貫している（`spec/scenario/account.md:33-35` のエッジケース → `spec/pages/index.md` P-13 → `spec/domains/identity.md:641` → `spec/usecases/identity.md:500` → `spec/testcases/identity/linkSsoCredential.md` → `spec/inventory/{usecase,test,frontend}.md` → `spec/manual-tests/account.md` のカバレッジ表）ので、「画面だけが約束して契約が無い」型の破れも作っていない。`plan.md` スコープ節と `ADR-062` が判断を明示的に記録しており、レビュー時に scope creep と読まれない備えもある。

逆向き（Issue が要求しているのにやっていないこと）は **#10 の整合（対応項目7）だけ**で、これは N-003 のとおり合意済みの順序待ちである。

**[N-005]** `spec/database/index.md:808` の見出し `## 主要クエリとインデックスの対応（確認表)` が全角開き括弧 + 半角閉じ括弧で不揃い。`origin/main` の `spec/database/index.md:387` でも同じ形なので**本 PR 由来ではない**。ついでに直すなら直す、程度。

---

## AC-1〜AC-19 判定表

**全件、`plan.md`「テスト方針」の検証バッテリーを実際に実行して判定した。**
`origin/main` を `git archive` で別ツリーへ展開し、**ベースライン値も全件再実測**して「素通りする検査」が無いことを確認してある（下表の「着手前」列は再実測値で、`plan.md` の申告値と**全件一致**した）。

| AC | 判定 | 着手前（再実測） | 完了後（実測） | 根拠 |
|---|---|---|---|---|
| AC-1 | **充足** | `V-1` 41 行 | **0 行** | ベクトル / embedding / 埋め込み / RRF / Vectorize / ハイブリッド / 意味検索 / `search_embeddings` / `F32_BLOB` の全語が非 review・非 `spec/adr/` から消滅 |
| AC-2 | **充足** | `V-2a` 12 / `V-2b` 12 / `V-2c` 4 行 | **0 / 0 / 0 行** | libSQL / Turso / PendingBatch / `_occ_guard` / `\bD1\b` が 0。除外した `manual-tests/{search,trash}.md` の `D1` 10 行はテストデータ名（`D-D1` 等）で、`V-2c` が旧ランタイム語 0 を保証 |
| AC-3 | **充足** | `V-3` 296 / `V-3b` 279 行 | **0 / 0 行** | Outbox / relay / consumer / DLQ / pruner / `IndexerReadPort` / `EmbeddingPort` / `maintainSearchIndex` / ドメインイベント 0。イベント名24種の直接走査も 0。射程から外したのは `spec/index.md` の ADR 索引 `005` 行1行のみで、その行は AC-13 が別途ゲート |
| AC-4 | **充足** | `P-11` 1 行 / 0 行 | **1 行 / 1 行** | `requirements.md` 4.4 先頭行 =「SQLite FTS5 による全文検索を単一の検索として提供する。**検索方式の選択をAIに委ねない**」。4.5 =「`search — 全文検索。トピックによる絞り込み可`」。**残す側の一文が生存**（負の検証では測れない唯一の項目） |
| AC-5 | **充足** | `P-4` 0 / 0 | **2 / 2** | `requirements.md:131`「ユーザー単位の SQLite-backed Durable Object に**物理分離**される。分離の保証は列条件（`user_id`）ではなく**到達可能性**」/ `:143`「1 Durable Object あたり **10 GB**、本体データと全文検索インデックスの合計」 |
| AC-6 | **充足** | `V-4` 92 行 / `P-6` 5メソッド | **0 行 / `query` 1本** | `interface SearchIndexPort { query(query: SearchQuery): SearchPage; }`（**`Promise` を返さない**）。`upsertMemo` 等4本と `IndexerReadPort` / `EmbeddingPort` は `spec/` 全域 0。「検索の規則」節に `bm25` + tie-breaker `timestamp DESC, type, id`（3ヒット）/ `TOPIC_NOT_FOUND`（3ヒット）/ 不透明カーソル（1ヒット）/ 削除・復元時の projection 同期が実在 |
| AC-6b | **充足** | `V-10` 9 行 / `TOPIC_NOT_FOUND` domains 0・usecases 0 | **0 行 / 3・1** | `page` 番号方式が `usecases/search.md`・`testcases/search/search.md`・`pages/index.md` から消滅。入力 DTO は `cursor` + `limit`（`spec/usecases/search.md:24`「**ページ番号を受け取る入口は持たない**」）。`TOPIC_NOT_FOUND` は domains / usecases の**両方**のエラーケースに存在 |
| AC-7 | **充足** | `P-10` 10 行 / `P-3` 0・0・0 / `P-2` trigram 1・NFKC 0・cursor 0・`instr(` 0 | **0 行 / 14・9・18 / 6・3・1・2** | 19テーブル全部に**独立した `###` 節**が実在（節構成は `## User Data DO のテーブル`（16節）+ `## Identity Directory DO のテーブル`（5節）の2部）。`_meta.schema_version` とゲート関数 / forward-only + `migration_progress` / 「コードより新しい version」への fail-closed / ロールバックせず PITR / trigram + `instr()` フォールバック + NFKC + 原文スニペット / `jobs.kind` 12種の全数表（所有 DO クラス別6+6、**投入点欄が全12行で非空**）をすべて確認 |
| AC-8 | **充足** | `V-6` 2 行 | **0 行** | `spec/database/index.md:3` が `CLAUDE.md「Reference runtime」`（単数形）へ修正され、`drizzleSqlite` も消滅。PR #39 引き継ぎコメント第2項が閉じた |
| AC-9 | **充足** | `P-8` 0 行 | **0 行** + 追加検査 | 削除対象 ID（`ADP-search-002`〜`009` / `-embeddings-001` / `ADP-occ-guard-001` / `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-trash-004` / `DOM-search-005`〜`012` / `UC-search-002`）が **0 件**、`#ドメインイベント` アンカー **0 件**（24行削除済み）、`TC-maintainSearchIndex-` **0 件**。残すべき `ADP-{memos,topics,documents}-001` / `ADP-search-001` / `DOM-search-004` は **5件全部実在**、`DOM-identity-023`〜`028` も **6件実在（欠番規約遵守）**。**追加検査:** `TC-*` 838 行の `#L{n}` が**全件テーブル行を指し（NOTROW 0 / 重複 0）**、`spec/testcases/` 54ファイルのデータ行総数 **838 = 台帳 838 行の全単射**。ヘッダにも欠番規約の注記が入っている |
| AC-10 | **充足** | `V-7` 7 行 | **0 行** | `spec/testcases/search/maintainSearchIndex.md` が `D` で削除済み。`search.md` は 42 行のケースを持ち、FTS5 新設ケース（日本語 trigram / 1文字フォールバック / NFKC 半角全角・結合文字 / `bm25` タイトル重み / 安定順位 / カーソルページング / topic 絞り込み / ゴミ箱除外）が実在し、500 文字境界も維持（ADR-002） |
| AC-11 | **充足** | `V-2c` 4 行 | **0 行** | consumer / pruner / 「1〜2分待つ」/ 共有 DB 直接 SQL が消滅。代替は「対象ユーザーの Durable Object への**シード投入**」「**Alarm の強制発火に相当する手段**」「開発用 RPC」で、いずれも **実体は #38** と明記。`trash.md:19` は期限判定の権威が保存済み `purge_after` であることまで書いており、2R の `R2-B-012` が閉じている。**具体コマンドを推測で書いていない** |
| AC-12 | **充足** | `V-8` 2 / `V-9` 2 / `P-9` 12 行 | **0 / 0 / 0 行**、`P-5` 7・8 | `CLAUDE.md` の「Reference runtime」「Key concepts」「Retry strategy」「Error handling」が DO 単独構成。**設計 第7.7節の7項目が「Asynchronous execution contract」1〜7 と1対1で対応**（原文と突き合わせ済み）。4類型が `jobs.kind` 12種を**漏れなく1回ずつ**覆う（「Only `send-mail` reaches outside; the other eleven are DO-local」）。ランタイム中立の明言（`stay intact across such a swap` / `the inward layers stay put`）は削除済み。残すべき `pnpm dev` / `#40` / `worker/cloudflare/*` は生存 |
| AC-13 | **充足** | `V-5` 26 行 | **0 行** | 無注記の `ADR-005` 参照が 0。`005-search-index-via-outbox` の文字列残存は `spec/index.md:42` の ADR 索引 **1行のみ**で、`| [005](./adr/005-search-index-via-outbox.md) | 検索インデックスの更新方式（superseded。根拠側は `.adr/003`、方式側は `.adr/004`…）|` の形（セル形状が保たれ `V-3` の除外パターンと一致） |
| AC-14 | **未実施** | MISSING 13 件 | **MISSING 13 件** | N-003 参照。`#10` 本文は未編集。triage `W-029` により APPROVED 後のステップ18 で実施する運び |
| AC-15 | **未実施** | MISSING 0 件 | **MISSING 3 件** | N-003 参照。`DOM-identity-016` / `-017` / `TC-revokeAiClientConnection-002` が #13 に残存。OAuth 2.1 / PKCE / `jti` の追記も未。同上 |
| AC-16 | **充足** | 101 ファイル | **103 ファイル** | `NO-VERDICT` **0 行**。`coverage.md` の台帳 **104 行**（改訂 80 / 新設 3 / 削除 1 / 影響なし 20）で自己申告と実測が一致。台帳行のうち実ファイルの無いものは削除済み `maintainSearchIndex.md` の記録 1 行だけ（設計どおり）。残存語の再走査 15 ファイルはすべて正当（`UnitOfWork` の現行概念 / テストデータ名 `D1` / `spec/adr/` / 注記つき 005 行） |
| AC-17 | **充足** | — | **exit 0 / 0 行** | `pnpm lint` exit 0、`pnpm format:check` exit 0。`git diff --name-status main...HEAD` のホワイトリスト外 **0 行**。`docs/` / `README.md` / `.adr/` / `spec/design/` / `spec/issues.md` / `spec/adr/` / `spec/**/review/`（`spec/usecases/review/002.md` を含む）は **全件無改変**。`packages/` / `apps/` / `infra/` / `*.toml` / `*.json` も 0 件。`changed.txt`（104件）と `git diff` は**バイト一致** |
| AC-18 | **充足** | 旧値 grep 6 行 | **0 行** | `spec/index.md` が `54ユースケース` / `838ケース` / `39シナリオ` / マニュアルテスト `204ケース` / 「User Data DO 16 テーブル / Identity Directory DO 5 テーブル」。台帳実測（UC 54 / TC 838 / シナリオ 39）と**完全一致**。`spec/manual-tests/index.md` の件数表は 43/37/41/23/25/23/12 = **204** で各ファイルの `grep -cE '^#+ TC-[0-9]+'` と一致、正常系/異常系/境界値の内訳（87/88/29）も検証可能な5ファイルで一致、実行記録欄の分母も `/204件 PASS` |
| AC-19 | **充足** | `P-7` 10本すべて 0 行 | **10本すべて ≥1**（2/4/2/2/2/2/1/7/3/2） | 手段4 の9ファイルが全件改訂済み。補の `changePassword.md` の `changeState` も 2 ヒット |

**判定サマリー: 充足 17 / 未充足 0 / 未実施 2（AC-14・AC-15。triage `W-029` により APPROVED 後のステップ18 で実施）**

### 「素通りする検査」の監査結果

`origin/main` を別ツリーへ展開して `V-1`〜`V-10` / `V-3b` / `P-1`〜`P-11` / AC-18 / カバレッジ再走査のベースラインを**全件再実測**した。`plan.md` の申告値と**全件一致**（V-1 41 / V-2a 12 / V-2b 12 / V-2c 4 / V-3 296 / V-3b 279 / V-4 92 / V-5 26 / V-6 2 / V-7 7 / V-8 2 / V-9 2 / V-10 9 / P-9 12 / P-10 10 / ファイル 101 / UC 52 / TC 771 / シナリオ 39 / manual-tests 192 / `spec/index.md` 旧値 6）。

着手前から期待値を満たしていた検査は **2つだけ**で、どちらも `plan.md` / `testing.md` が自ら「完了検出ではない」と明記している:

- `P-8`（0 → 0）— アンカー実在の回帰ガード。本レビューでは `#L` 838 件が全件テーブル行を指すことと台帳⇔testcases の全単射を**別途機械検証**して補った。
- `#13` の `MISSING`（0 → 0 が期待）— 「増えていないこと」を測る検査。**現在 3 に増えている**（AC-15 未実施の症状として正しく現れている）。

構文エラー（実行できないコマンド）は `plan.md` / `testing.md` を通じて **0 件**。`testing.md` に書かれた手順は確認項目1〜14 の全コマンドを実際に走らせ、期待値どおりの出力を得た（`SCOPE()` の定義位置、`P-8` の `slug()`、`P-9` / `P-10` のループ、`coverage.md` の内訳カウント、`git archive` によるベースライン再現まで含む）。

### Issue 本文の直接照合

**対応項目（AC 表を経由しない確認）**

| # | 内容 | 判定 | 実測 |
|---|---|---|---|
| 1 | `idea.md` / `requirements.md` 4.4・4.5 / `scenario/{search,ai,index}.md` / 非機能要件 | **完了** | `idea.md:40`「メモ・ドキュメント横断の全文検索（SQLite FTS5）」、`requirements.md` 4.4 / 4.5、`scenario/index.md:43`「全文検索」、`scenario/ai.md:19`「search（全文検索。必要ならトピック絞り込み）」、`requirements.md:131`・`:143` |
| 2 | `domains/search.md` の vector 契約削除 / `SearchIndexPort` 単純化 / Outbox 経由の再設計 / `usecases/search.md` / `domains/index.md` | **完了** | `V-1` / `V-4` = 0。`query` 1本。`domains/search.md:194`「書き込み側はポートではない…本体を書くトランザクションの中の projection 処理へ畳まれる」。`domains/index.md:35` が同一トランザクション更新を宣言 |
| 3 | `database/index.md` 一本化 / `search_embeddings`・Vectorize 削除 / FTS5 テーブル・tokenizer・snippet・ランキング・topic・削除復元同期 / 日本語 tokenizer と短語 / `PendingBatch`・`_occ_guard`・D1 UoW の書き換え / schema version + lazy migration + 再実行 + ロールバック方針 | **完了** | AC-7 参照。`## FTS5 の tokenizer 方針` / `## スキーマバージョンと lazy migration`（5サブ節）が新設。「実環境での検証は #37」も明記 |
| 4 | ADR 参照側の更新（本文は書き換えない） | **完了** | `V-5` = 0。`spec/adr/` の6ファイル・`.adr/` の4ファイルは `git diff` で **0 行変更** |
| 5 | `testcases/search/` の入替 / `inventory/` の更新 / `manual-tests/` / 全参照の残存解消 | **完了** | AC-9 / AC-10 / AC-11 参照。`spec/inventory/adapter.md:22` の `ADP-search-embeddings-001` も削除済み |
| 6 | `CLAUDE.md` の Reference runtimes / UoW / Outbox / DB 制約 | **完了** | AC-12 参照。節名は PR #39 が変えた単数形 `## Reference runtime` を維持（コメント第1項どおり） |
| 7 | #10 との整合確認 | **未実施** | N-003。MISSING 13 件 |

**受け入れ条件7項目**

1. ベクトル / Vectorize / embedding / RRF / D1・libSQL・Turso の有効な設計が残っていない → **充足**（`V-1` / `V-2` = 0。ADR 本文の履歴的記述は射程外）
2. `requirements.md` 4.4 がキーワード全文検索 + 非機能要件に DO 物理分離 → **充足**
3. `SearchIndexPort` が FTS5 の query / upsert / remove に単純化 → **充足**（ただし設計 第11.1節の訂正指示に従い **`query` 1本**。`plan.md` リスク欄が Issue 本文の文言誤りを明示しており、意図的な逸脱として記録済み）
4. `database/index.md` が SQLite-backed DO 一本 + schema version / lazy migration → **充足**
5. `inventory/` / `testcases/search/` / `manual-tests/` が改訂後の設計と一致 → **充足**
6. `CLAUDE.md` の4節が DO 単独構成 → **充足**
7. #10 の実装チェックリストが改訂後の `inventory/` と一致 → **未実施**（N-003）

**Issue コメント（PR #39 引き継ぎ）3項目**

1. `## Reference runtime` の単数形を前提に改訂 → **対応済み**（`grep -c '## Reference runtime' CLAUDE.md` = 1、複数形は 0）
2. `spec/database/index.md:3` の壊れた名指し参照 + `drizzleSqlite` → **解消**（`V-6` = 0）
3. `spec/` に残る旧ランタイム参照（コメント実測 6〜7 行 / 4 ファイル）→ **解消**。コメントが「有効な設計」として挙げた5行（`database/index.md:3` / `:341` / `:349` / `:350` / `inventory/adapter.md:22`）はすべて消え、「改訂不要」とした `spec/database/review/{002,003}.md` は無改変

### スコープ超過の検証

- **`spec/design/` / `spec/issues.md` / `docs/` / `README.md` / `.adr/` / `spec/adr/` / `spec/**/review/`（`spec/usecases/review/002.md` を含む）は全件無改変。** `git diff --name-only origin/main...HEAD` に1件も現れない。
- **コード・設定は 0 行変更。** 104件の内訳は `spec/` 84 + `.thread/35/` 19 + `CLAUDE.md` 1 で、`changed.txt` と `git diff --name-status` はバイト一致。
- **新設された契約:** ユースケース3件（`revokeAllAiClientConnections` / `unlinkSsoCredential` / `linkSsoCredential`）+ テストケースファイル3件。`plan.md` スコープ節と `ADR-051` / `ADR-059` / `ADR-062` が根拠を記録済み。**scope creep ではないと判定した**（N-004 に根拠）。
- **不変条件の維持:** `UC-*` 54 行 = `spec/testcases/` 54 ファイルで**完全な1対1**（両方向の差分 0）。
- **`#44` / `#45` の射程侵犯:** 本レビューでは新規に検出していない（`terminalReason` / `poison` / operator エスカレーションまでの記述に留まり、巻き戻し手順・段構成・材料寿命・再試行上限は `spec/` に書かれていない。2R で `ADR-009` / `ADR-073` により線引き確定済み）。
- **逆向き（Issue が要求しているのに未実施）:** #10 の整合（対応項目7 / 受け入れ条件7）のみ。

### 成果物の一貫性

| 成果物 | 判定 | 実測 |
|---|---|---|
| `plan.md` | **一致**（AC は全件実測と整合） | ベースライン 21 項目を `origin/main` で再実測して全件一致。AC-16 の 103・AC-18 の 54/838/39/204 も実測どおり |
| `steps.md` | **1箇所 stale** | `:104` の「102」（W-001） |
| `adr.md` | **一致** | ADR-001〜078 が**重複 0 / 欠番 0**（連番 78 件が 001〜078 で連続）。`plan.md` / `steps.md` / `coverage.md` / `testing.md` / `step14-checklist.md` から参照される ADR 番号は**全件定義済み**（未定義参照 0）。内容として矛盾する ADR の同居は検出せず — 数値の更新（ADR-059）は「続報」追記方式で閉じており、`ADR-001`（書き込みポートを置かない）と `ADR-047`（`purgeAfter` 一括再計算の書き込み口）、`ADR-023` / `ADR-044` / `ADR-053`（`search_entries` の正本は `spec/database/index.md`）、`ADR-067`（trash は書き込みポートを持たない）と `ADR-066`（`purge-trash` の投入点5つ）はいずれも射程が分かれていて衝突しない。表題の陳腐化のみ N-002 |
| `coverage.md` | **一致** | `NO-VERDICT` **0 行**。台帳 104 行 = 改訂 80 + 新設 3 + 削除 1 + 影響なし 20（自己申告と実測が一致）。ファイル 103 とのズレ 1 は削除済みファイルの記録行で、文書内に理由が明記 |
| `testing.md` | **実行可能** | 確認項目1〜14 の全コマンドを実際に実行。構文エラー 0、期待値との不一致 0。ただし確認項目12 手順3 の「30行」は N-001 |
| `step14-checklist.md` | **一致** | 32 行。設計 第11.1節の表 30 ファイル + ステップ13 担当の2ファイルという内訳が末尾に明記され、設計の表が挙げていない 7ファイル・15行の追加適用も理由つきで記録 |

---

## カバレッジ（変更ファイル 104 件と1対1）

**確認 = 差分または全文を読んだもの / 機械確認 = 差分本文を個別には読まず検証バッテリーで覆ったもの / 参照 = 既判定の把握のために読んだレビュー記録。**
機械確認の裏づけは `V-1`〜`V-10` + `V-3b`（全 0 行）、`P-1`〜`P-11`（全通過）、`#L` 838 件の全数検証（NOTROW 0 / 重複 0）、台帳⇔`spec/testcases/` の全単射（838 = 838、54 = 54）、`P-8` のアンカー実在検査、`coverage.md` の `NO-VERDICT` 0、AC-17 の差分ホワイトリスト。

| # | ファイル | 扱い |
|---|---|---|
| 1 | `.thread/35/adr.md` | 確認（78 ADR の番号整合・参照解決・矛盾同居を機械 + 抜き取り目視） |
| 2 | `.thread/35/coverage.md` | 確認（全文 + 再走査コマンド実行） |
| 3 | `.thread/35/plan.md` | 確認（全文 + ベースライン再実測） |
| 4 | `.thread/35/review/review-001-database.md` | 参照 |
| 5 | `.thread/35/review/review-001-design-fidelity.md` | 参照 |
| 6 | `.thread/35/review/review-001-domain-usecase.md` | 参照 |
| 7 | `.thread/35/review/review-001-requirements.md` | 参照 |
| 8 | `.thread/35/review/review-001-testcases.md` | 参照 |
| 9 | `.thread/35/review/review-001.md` | 参照 |
| 10 | `.thread/35/review/review-002-database.md` | 参照 |
| 11 | `.thread/35/review/review-002-design-fidelity.md` | 参照 |
| 12 | `.thread/35/review/review-002-domain-usecase.md` | 参照 |
| 13 | `.thread/35/review/review-002-requirements.md` | 参照 |
| 14 | `.thread/35/review/review-002-testcases.md` | 参照 |
| 15 | `.thread/35/review/review-002.md` | 参照 |
| 16 | `.thread/35/review/triage.md` | 確認（全文。既判定の把握） |
| 17 | `.thread/35/step14-checklist.md` | 確認（全文 32 行） |
| 18 | `.thread/35/steps.md` | 確認（W-001 検出） |
| 19 | `.thread/35/testing.md` | 確認（全文 + 全コマンド実行） |
| 20 | `CLAUDE.md` | 確認（Key concepts / 非同期実行契約7項目 / Reference runtime を設計 第7.7節と1対1照合） |
| 21 | `spec/database/index.md` | 確認（節構成・19テーブル・tokenizer・migration・`jobs.kind` 全数表・「定義しないテーブル」節） |
| 22 | `spec/domains/export.md` | 機械確認 |
| 23 | `spec/domains/identity.md` | 確認（`linkSsoCredential` / `unlinkSsoCredential` のスコープ限定） |
| 24 | `spec/domains/index.md` | 確認（検索ドメイン記述 / 派生データの同一トランザクション更新） |
| 25 | `spec/domains/knowledge.md` | 機械確認 |
| 26 | `spec/domains/memo.md` | 機械確認 |
| 27 | `spec/domains/search.md` | 確認（`SearchIndexPort` / 検索の規則 / projection 契約 / tokenizer 機構の非漏洩） |
| 28 | `spec/domains/trash.md` | 機械確認 |
| 29 | `spec/idea.md` | 確認 |
| 30 | `spec/index.md` | 確認（件数・ADR 索引 005 行のセル形状） |
| 31 | `spec/inventory/adapter.md` | 確認（削除 ID / 残す ID の grep） |
| 32 | `spec/inventory/domain.md` | 確認（ドメインイベント 24 行削除 / 欠番規約 / `DOM-identity-023`〜`028`） |
| 33 | `spec/inventory/frontend.md` | 確認（`PAGE-password-reset-004` / `PAGE-settings-007` / `-008`） |
| 34 | `spec/inventory/test.md` | 確認（838 行・`#L` 全数検証・欠番規約ヘッダ） |
| 35 | `spec/inventory/usecase.md` | 確認（54 行・`UC-identity-015` / `-016`） |
| 36 | `spec/manual-tests/account.md` | 確認（43 TC / カバレッジ表 / `ロックアウト`） |
| 37 | `spec/manual-tests/ai.md` | 機械確認 |
| 38 | `spec/manual-tests/document.md` | 機械確認 |
| 39 | `spec/manual-tests/index.md` | 確認（件数表・内訳・合計・実行記録分母） |
| 40 | `spec/manual-tests/search.md` | 確認（`D-D1` の正当性 / FTS5 新設 TC / 23 TC） |
| 41 | `spec/manual-tests/settings.md` | 確認（シード投入手段の #38 委譲） |
| 42 | `spec/manual-tests/timeline.md` | 確認（同上） |
| 43 | `spec/manual-tests/trash.md` | 確認（`purge_after` 駆動 / Alarm 強制発火 / `D1` の正当性） |
| 44 | `spec/pages/index.md` | 確認（P-02 / P-03 / P-11 / P-13） |
| 45 | `spec/requirements.md` | 確認（4.4 / 4.5 / 5.1 / 5.3） |
| 46 | `spec/scenario/account.md` | 確認（S-AC-02 エッジケース / 所有確認 / P-03 導線） |
| 47 | `spec/scenario/ai.md` | 確認 |
| 48 | `spec/scenario/index.md` | 確認 |
| 49 | `spec/scenario/search.md` | 確認 |
| 50 | `spec/testcases/export/exportAllData.md` | 機械確認（`P-7` 第9行 + `#L` 全数） |
| 51 | `spec/testcases/identity/approveAiClientAuthorization.md` | 機械確認 |
| 52 | `spec/testcases/identity/changePassword.md` | 機械確認（`P-7` 補） |
| 53 | `spec/testcases/identity/changeTrashRetentionDays.md` | 機械確認 |
| 54 | `spec/testcases/identity/denyAiClientAuthorization.md` | 機械確認 |
| 55 | `spec/testcases/identity/executePasswordReset.md` | 確認（P-03 導線の到達可能性） |
| 56 | `spec/testcases/identity/getCurrentUser.md` | 機械確認（`P-7` 第3行） |
| 57 | `spec/testcases/identity/linkSsoCredential.md` | 確認（新設。16 ケース） |
| 58 | `spec/testcases/identity/listAiClientConnections.md` | 機械確認（`P-7` 第4行） |
| 59 | `spec/testcases/identity/loginWithPassword.md` | 機械確認（`P-7` 第1・2行） |
| 60 | `spec/testcases/identity/logout.md` | 機械確認 |
| 61 | `spec/testcases/identity/registerOrLoginWithSso.md` | 機械確認 |
| 62 | `spec/testcases/identity/registerWithPassword.md` | 機械確認 |
| 63 | `spec/testcases/identity/requestPasswordReset.md` | 機械確認（`P-7` 第5行） |
| 64 | `spec/testcases/identity/revokeAiClientConnection.md` | 確認（`TC-...-002` 欠番化 + 置き換えケース） |
| 65 | `spec/testcases/identity/revokeAllAiClientConnections.md` | 確認（新設） |
| 66 | `spec/testcases/identity/unlinkSsoCredential.md` | 確認（新設。15 ケース / 正常系の到達可能性） |
| 67 | `spec/testcases/knowledge/createDocument.md` | 機械確認 |
| 68 | `spec/testcases/knowledge/createTopic.md` | 機械確認 |
| 69 | `spec/testcases/knowledge/diffDocumentRevisions.md` | 機械確認 |
| 70 | `spec/testcases/knowledge/editDocument.md` | 機械確認 |
| 71 | `spec/testcases/knowledge/editDocumentByAi.md` | 機械確認（`V-3b` 対象） |
| 72 | `spec/testcases/knowledge/getDocument.md` | 機械確認 |
| 73 | `spec/testcases/knowledge/getTopic.md` | 機械確認 |
| 74 | `spec/testcases/knowledge/listDocumentRevisions.md` | 機械確認 |
| 75 | `spec/testcases/knowledge/listDocumentSourceMemos.md` | 機械確認 |
| 76 | `spec/testcases/knowledge/listDocumentsReferencingMemo.md` | 機械確認 |
| 77 | `spec/testcases/knowledge/rollbackDocument.md` | 機械確認 |
| 78 | `spec/testcases/knowledge/trashDocument.md` | 機械確認 |
| 79 | `spec/testcases/knowledge/trashTopic.md` | 機械確認（`V-3b` 対象） |
| 80 | `spec/testcases/knowledge/updateTopic.md` | 機械確認（`V-3b` 対象） |
| 81 | `spec/testcases/memo/delete.md` | 機械確認 |
| 82 | `spec/testcases/memo/diffMemoRevisions.md` | 機械確認 |
| 83 | `spec/testcases/memo/editMemo.md` | 機械確認 |
| 84 | `spec/testcases/memo/getTimeline.md` | 機械確認 |
| 85 | `spec/testcases/memo/postMemo.md` | 機械確認 |
| 86 | `spec/testcases/memo/post_memo.md` | 機械確認 |
| 87 | `spec/testcases/memo/rollbackMemo.md` | 機械確認 |
| 88 | `spec/testcases/memo/softDeleteMemo.md` | 機械確認 |
| 89 | `spec/testcases/memo/update_memo.md` | 機械確認 |
| 90 | `spec/testcases/search/maintainSearchIndex.md` | 確認（削除。`ls` で不在を確認、`coverage.md` に記録行あり） |
| 91 | `spec/testcases/search/search.md` | 確認（42 ケース。FTS5 / カーソル / 500 文字境界） |
| 92 | `spec/testcases/trash/emptyTrash.md` | 機械確認 |
| 93 | `spec/testcases/trash/hardDeleteTrashItem.md` | 機械確認 |
| 94 | `spec/testcases/trash/listTrash.md` | 機械確認（`P-7` 第6行） |
| 95 | `spec/testcases/trash/pruneExpiredTrashItems.md` | 機械確認 |
| 96 | `spec/testcases/trash/restoreDocument.md` | 機械確認 |
| 97 | `spec/testcases/trash/restoreMemo.md` | 機械確認 |
| 98 | `spec/testcases/trash/restoreTopic.md` | 機械確認 |
| 99 | `spec/usecases/export.md` | 機械確認 |
| 100 | `spec/usecases/identity.md` | 確認（`linkSsoCredential` / `unlinkSsoCredential` / `executePasswordReset` の出力） |
| 101 | `spec/usecases/knowledge.md` | 機械確認 |
| 102 | `spec/usecases/memo.md` | 機械確認 |
| 103 | `spec/usecases/search.md` | 確認（入力 DTO / 出力 DTO / エラーケース表） |
| 104 | `spec/usecases/trash.md` | 機械確認 |

**確認 45 件 / 機械確認 47 件 / 参照 12 件 = 104 件。スキップ 0 件。**

---

## 結論

**APPROVED でよい。**

Issue #35 の対応項目1〜6・受け入れ条件1〜6・PR #39 引き継ぎコメント3項目はすべて実測で充足しており、Blocker は 0 件。AC-1〜AC-19 は 17 充足 / 0 未充足 / 2 未実施で、未実施の 2 件（AC-14 / AC-15 = 対応項目7 / 受け入れ条件7）は triage `W-029` により「APPROVED 後にステップ18 で実施する」と合意済みの外部副作用である。残る指摘は Warning 1 件（`steps.md` の陳腐化した数値）と Note 5 件で、いずれも `spec/` の内容ではなく作業成果物・既存の軽微な体裁に閉じている。

2ラウンドで `spec/` が大きく動いた点についても、Issue 本文へ立ち返って確認した結果、当初の目的（旧前提の一掃 + #34 設計の上流から下流への一貫反映）から逸れていない。新設された `linkSsoCredential` は設計 第6.6節が全設計した saga の投入点を埋めるための必然であり、scope creep ではない（N-004）。

**マージ後（またはマージ直前）に必須の作業:** ステップ18 —— #10 本文の 13 ID 是正、#13 本文からの 3 ID 除去 + OAuth 2.1 / PKCE / `jti` の追記。合わせて W-001 を直せば `.thread/35/` は #37 の入力として完全に整合する。
