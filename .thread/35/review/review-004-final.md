# レビュー4ラウンド目（最終確認） — Issue #35 / PR #46

**観点:** 収束の確認（3ラウンド目 Warning 4件の反映確認 + 新規破れの有無 + 機械ゲート全件）
**対象:** ベースブランチ `main` からの変更 106 件（`spec/**/*.md` 84 / `CLAUDE.md` 1 / `.thread/35/**` 21）
**判定:** **APPROVED**

## 結論

3ラウンド目の Warning 4件はいずれも実物に入っており、**修正が新しい矛盾を生んだ箇所は無い**。機械ゲートは `V-1`〜`V-10` / `V-3b` / `P-1`〜`P-11` / 件数 / 台帳の全単射 / スコープ / `pnpm lint` / `pnpm format:check` の**全件が期待値どおり**。

Blocker は無い。Warning 1件は `kind` 全数表の前文の分類語1語の精度（数え方が 9 ではなく 8）で、表の投入点欄そのものと核の不変条件は正しいため、**このラウンドの完了を止めない**。

## 3ラウンド目 Warning 4件の反映確認

### 修正1: `kind` 全数表の前文（cross-boundary W-001）

`spec/database/index.md:468` は全称を落とし、9 / 2 / 1 の3分類になった。**12行を1行ずつ投入点欄と突き合わせた結果:**

| # | `kind` | 所有 DO | 投入点欄の経路 | 前文の分類と一致するか |
|---|---|---|---|---|
| 1 | `purge-trash` | User Data | ソフトデリート4ユースケース + `changeTrashRetentionDays` | ○ ユースケース |
| 2 | `reindex` | User Data | migration ゲート。「usecase からは投入しない」と明記 | ○ 移行の適用側 |
| 3 | `migrate-bulk` | User Data | 同上 | ○ 移行の適用側 |
| 4 | `finalize-withdrawal` | User Data | (1) 退会の開始 / (2) 新規登録 saga の終端規則による放棄 | **× 下記 W-001** |
| 5 | `sweep-orphan-mapping` | User Data | `unlinkSsoCredential` | ○ ユースケース |
| 6 | `resume-link` | User Data | SSO 連携 saga の開始（`linkSsoCredential`） | ○ ユースケース |
| 7 | `send-mail` | Identity Dir | `requestPasswordReset` を受けたトランザクション | ○ ユースケース |
| 8 | `resume-signup` | Identity Dir | 新規登録 saga の予約行を書くトランザクション | ○ ユースケース |
| 9 | `resume-credential-change` | Identity Dir | クレデンシャル変更 saga の開始（`changePassword`） | ○ ユースケース |
| 10 | `sweep-reservations` | Identity Dir | 予約行を書く3箇所 | ○ ユースケース |
| 11 | `sweep-reset-tokens` | Identity Dir | リセットトークン行の発行トランザクション | ○ ユースケース |
| 12 | `rotate-encryption` | Identity Dir | operator 専用 maintenance 経路 | ○ operator 経路 |

**「移行の適用側2種」「operator 経路1種」は表と完全一致。** 例外3種の内訳は 3R レビュアーの提案文と同一である。所有 DO クラス別の内訳も 6 / 6 で、`:652`（Identity Directory 側 `jobs` の6種列挙）と一致する。残る不一致は 4 行目のみ（W-001）。

同ファイル `:453`（「usecase からの書き込み口は `enqueueJob` だけである」）との二文並読で生じていた「12種すべてが usecase から投入される」という読みは、この前文の限定で解消している。

### 修正2: `session_epoch` を進める操作（cross-boundary W-003）

**4箇所すべてが「4つだけ（パスワード変更 / リセット完了 / SSO 連携の解除 / 退会）」で一致。** 指示にあった3箇所に加えてアダプター台帳も確認した。

| 場所 | 記述 |
|---|---|
| `spec/database/index.md:69` | 「**進める操作は4つだけ**（パスワード変更・リセット完了・SSO 連携の解除・退会）」+「SSO 連携の追加では進めない」 |
| `spec/domains/identity.md:485` | 「**`sessionEpoch` を進める操作は4つだけである**」— 同じ4つ |
| `spec/inventory/domain.md:42`（`DOM-identity-039`） | 「**進める操作は4つだけ**」— 同じ4つ |
| `spec/inventory/adapter.md:54`（`ADP-identity-019`） | 「呼ばれるのは…4経路だけである」— 同じ4つ |

「SSO 連携の追加では進めない」という否定形も DB / ドメイン / 台帳の3箇所に揃っており、`spec/inventory/usecase.md:22` の `linkSsoCredential` 側（「`sessionEpoch` は進めない」）とも矛盾しない。退会の書き手が #37 側であることは `spec/database/index.md:81` が既に持っているので、新しい約束は増えていない。

### 修正3: `CLAUDE.md:68` の副作用登録点の DO クラス別分割（cross-boundary W-002）

**`spec/database/index.md` の実態と一致する。**

- `operations`（`:490`）/ `migration_progress`（`:508`）はいずれも `## User Data DO のテーブル`（`:60`–`:535`）の内側にあり、`## Identity Directory DO のテーブル`（`:536`–）には `credential_mappings` / `password_reset_tokens` / `jobs` / `rotation_checkpoints` / `_meta` の5つしか無い → 「`recordOperation` / `updateOperation` / `setMigrationCursor` exist only on the User Data DO」は正しい。
- `jobs` は両クラスに存在（`:426` と `:652`。テーブル一覧でも2行）→ 「both classes expose `enqueueJob`」は正しい。
- 「`operations` is the only one reached by two methods」「`_meta` has none」「`account` is not on that roster」は `spec/database/index.md:754` / `:533` / `:753` と1対1で一致（`:754` の「6ストア・7メソッド」の員数と過不足なし。ADR-054 どおり `CLAUDE.md` 側は員数を持たない）。
- ストア名簿側（User Data = `credentialLocatorStore` / Identity Dir = `resetTokenStore`・`rotationCheckpointStore`）は `:125` / `:648` / `:674` と一致。

**英文としても崩れていない。** 挿入節の em ダッシュ対は `the non-aggregate stores — whose roster differs by DO class: … — and the in-transaction side-effect registration points, …` で正しく閉じており、`A, B — … — and C` の3項列挙が壊れていない。追加された `which likewise differ by DO class:` 以下は `both classes expose X, while Y … exist only on Z, since …` の従属構造で、時制・単複（`points … differ`、`operations and migration_progress live there`）ともに一致している。

### 修正4: `.thread/35/` の件数

| 対象 | 記述 | 実測 | 一致 |
|---|---|---|---|
| `spec/` ファイル数（`plan.md` AC-16 / `steps.md:104` / `testing.md`） | 103 | `find spec -name '*.md' \| grep -v /review/ \| wc -l` = **103** | ○ |
| `step14-checklist.md` の行数（`plan.md:392` / `steps.md:319` / `steps.md:428` / `testing.md:224`） | 32 | データ行 **32**（ヘッダ1・区切り1を除く） | ○ |
| `adr.md` ADR-059 の見出し | 固定値を落として「ファイル数を増やす」 | 続報が 103 / 54=54 を持つ | ○ |
| `steps.md:101` の「101 件」 | 着手前の値 | `origin/main` 基準として正しい（完了後は 103） | ○ |

## Blockers

**なし。**

## Warnings

**[W-001]** `kind` 全数表の前文の「ユースケースから投入する 9 種」に `finalize-withdrawal` が含まれるが、退会のユースケースは `spec/` に存在しない（実数は 8）

**場所:** `spec/database/index.md:468`（前文）/ 同 `:475`（`finalize-withdrawal` の行）/ 裏づけ `spec/inventory/usecase.md`（`UC-*` 54行）/ `spec/inventory/domain.md:41`（`DOM-identity-038`）

**理由:**
前文は 12 種を「ユースケースから投入する 9 種」と「経路が違う残る3種（`reindex` / `migrate-bulk` / `rotate-encryption`）」に割っている。ところが 9 に入る `finalize-withdrawal` の投入点は2つとも**ユースケース経路ではない**:

- (1)「退会の開始（`account.status` を `deleting` にするのと同じトランザクション）」— **退会のユースケースは spec に無い。** `spec/inventory/usecase.md` の `UC-*` 54 行に退会は1件も無く（`grep -n '退会' spec/inventory/usecase.md` が 0 行）、`spec/usecases/*.md` でも `退会` は 0 行。`spec/inventory/domain.md:41`（`DOM-identity-038`）は「`status` の遷移を書くのは退会の手続きであり、**退会は要件・シナリオに存在しないためスコープ外**」と明記し、`spec/database/index.md:81` も「その書き手は #37 が DO の RPC 側で決める」としている。
- (2)「新規登録 saga の終端規則によるアカウントの放棄」— 本文自身が「その手順は #45 が定める」と書くジョブランナー側の経路。

したがって 3R の W-001 が指摘した「全称が表と食い違う」という構図は縮んだが**消えてはいない**。3R レビュアー自身は「usecase の手続きが名指しで投入するのは3種」と数えており（`spec/usecases/` 全数走査で `purge-trash` / `resume-link` / `sweep-orphan-mapping` のみが名前で現れることは再実測でも一致した）、`send-mail` など5種は投入点欄が「ユースケースを受けたトランザクション」を指すので 9 側に数えて差し支えないが、`finalize-withdrawal` だけはその読み替えができない。

**影響は小さい。** 前文の核である不変条件（「そのジョブが待つ状態を書くのと同じトランザクションの中で `enqueueJob` する」）は `finalize-withdrawal` の2つの投入点でも成立しており、投入点欄そのものは 12 行すべて非空で内容も正しい。壊れているのは分類語の射程だけである。

**提案:**
`ユースケースから投入する 9 種` を、投入点の性質で切った表現に替える（1語の差し替えで足りる）。例:

> **残る 9 種は、いずれもそのジョブが待つ状態を書くのと同じトランザクション**の中で `enqueueJob` する（**うち `finalize-withdrawal` の投入点2つだけは usecase ではなく退会 saga の起点と終端規則が持つ**。書き手は #37 / #45）。

## Notes

**[N-001]** `.thread/35/adr.md:1103`（ADR-034 の続報）が `53ユースケース / 814ケース / 199マニュアルケース` のままで、確定値 `54` / `838` / `204` と食い違う。ADR-051 で2件増えた時点の実測であり、ADR-062 の3件目が反映されていない。同型の続報を持つ ADR-059 は 103 / 54=54 へ更新済みなので、更新漏れは1箇所だけである。**正本は壊れていない** — `spec/index.md` は 54 / 838 / 39 / 204 で実測と一致し、`plan.md:78` と `testing.md:236` が現行値と「基準時点を明示する」規約を持つ。作業成果物の履歴記録であり、`plan.md:78` の規約に従って基準時点（1ラウンド目完了時点）を1語足せば足りる。修正不要と判断する。

**[N-002]** 修正1 の文言は 3R レビュアーの提案文（「例外は3種で、これが全数である」）とは別の言い回しになったが、**例外3種の内訳と根拠は提案と完全一致**している。提案の逐語採用でないことは問題にしない。

**[N-003]** `spec/manual-tests/index.md` の件数表は合計だけでなく**内訳列も全て整合**していた（正常系 87 / 異常系 88 / 境界値 29、行方向も 43=14+25+4 ほか7行すべて一致）。3ラウンドを通じて指摘されていない列だったので実測して確認した。

**[N-004]** ラウンド1〜3 の判定済み事項（`triage.md`）は再提出していない。とくに `W-027`（README の `defer` → #38）、`R2-N-002`（`RevisionDocumentMismatch` / `InvalidRevisionNumber` の TC 欠落 → 別 Issue）、`W-029`（AC-14 / AC-15 はステップ18 で APPROVED 後に実行）は判定を継承した。`#44` / `#45` 由来の設計論点はスコープ外として扱った。

## 機械ゲートの実測

### 負の検証（期待 0 行）

| 検査 | 実測 | 判定 |
|---|---|---|
| `V-1` ベクトル / embedding / 埋め込み / RRF / Vectorize / ハイブリッド / 意味検索 / `search_embeddings` / `F32_BLOB` | 0 行 | ○ |
| `V-2a` libSQL / Turso / PendingBatch / occ_guard | 0 行 | ○ |
| `V-2b` `\bD1\b`（`manual-tests/{search,trash}.md` 除外） | 0 行 | ○ |
| `V-2c` 除外2ファイルの旧ランタイム語 | 0 行 | ○ |
| `V-3` Outbox / collectEvents / consumer / relay / DLQ / pruner / processed_events / IndexerReadPort / EmbeddingPort / maintainSearchIndex / EventDraft / ドメインイベント | 0 行 | ○ |
| `V-3b` ドメインイベント名 24 件の直接走査 | 0 行 | ○ |
| `V-4` `upsertMemo` / `upsertDocument` / `removeMemo` / `removeDocument` / `listExpiredItems` | 0 行 | ○ |
| `V-5` 無注記の `ADR-005` 参照 | 0 行 | ○ |
| `V-6` `Reference runtimes` / `drizzleSqlite`（2コマンド合計） | 0 + 0 = 0 行 | ○ |
| `V-7` 非同期反映を約束する記述 | 0 行 | ○ |
| `V-8` `CLAUDE.md` のランタイム中立宣言 | 0 行 | ○ |
| `V-9` Key concepts 節の Outbox / `SQLITE_BUSY` / `adapters/d1` | 0 行 | ○ |
| `V-10` 検索 API の page 番号方式 | 0 行 | ○ |

### 正の検証（期待 1 以上、`P-8` / `P-9` / `P-10` は 0 行）

| 検査 | 実測 | 判定 |
|---|---|---|
| `P-1` | `requirements FTS5=1` / `domains/search FTS5=3` / `database/index FTS5=11` / `manual-tests/search FTS5=4` / `scenario/search 全文検索=2` / `usecases/search 全文検索=3` | ○ 全6ファイル 1 以上 |
| `P-2` | `database`: `trigram=6` `NFKC=3` `不透明カーソル=1` `instr(=2`。`domains/search`: `不透明カーソル=1` `bm25\|timestamp DESC=3` `TOPIC_NOT_FOUND=3`。`usecases/search`: `TOPIC_NOT_FOUND=1` | ○ 全行 1 以上 |
| `P-3` | `schema_version=14` / `migration_progress=9` / `forward-only\|fail-closed\|PITR=18` | ○ |
| `P-4` | `Durable Object=2` / `到達可能性\|10 GB=2` | ○ |
| `P-5` | `Durable Object=7` / `at-least-once\|Alarm\|transactionSync=8` | ○ |
| `P-6` | `SearchIndexPort` は `query(query: SearchQuery): SearchPage;` の1メソッドのみ | ○ |
| `P-7`（10本 + 補1本） | `2 / 4 / 2 / 2 / 2 / 2 / 1 / 7 / 3 / 2`、補 `2` | ○ 全11本 1 以上 |
| `P-8` 台帳アンカーの実在 | 0 行（`NOFILE` / `DANGLING` とも 0） | ○ |
| `P-9` `jobs.kind` 12種が `CLAUDE.md` と `spec/database/index.md` の両方に | 0 行（`KIND-MISSING` なし） | ○ |
| `P-10` 第4.1.1節のテーブル 19 名 | 0 行（`TABLE-MISSING` なし） | ○ |
| `P-11` | `検索方式の選択をAIに委ねない=1` / `search — 全文検索=1` | ○ |

### 件数・台帳・スコープ

| 検査 | 期待 | 実測 | 判定 |
|---|---|---|---|
| `spec/inventory/usecase.md` の `UC-*` | 54 | **54** | ○ |
| `spec/inventory/test.md` の `TC-*` | 838 | **838** | ○ |
| シナリオ ID の異なり数 | 39 | **39** | ○ |
| マニュアルテスト合計 | 204 | **204**（43/37/41/23/25/23/12。表の合計行・内訳3列とも一致） | ○ |
| `spec/` の非 review Markdown | 103 | **103** | ○ |
| `spec/index.md` の転記数値 grep | 0 行 | **0 行**（`54ユースケース` / `838ケース` / `39シナリオ` / `204ケース` を保持） | ○ |
| `coverage.md` の `NO-VERDICT` | 0 行 | **0 行** | ○ |
| 台帳 → 実ファイルの逆向き（全単射） | 削除1件のみ | `coverage.md` のパス行 **104**、うち実在しないのは `spec/testcases/search/maintainSearchIndex.md` 1件（`削除` と明記された行）。103 + 削除1 = 104 で全単射成立 | ○ |
| ユースケース数 = `spec/testcases/` ファイル数 | 一致 | 54 = **54** | ○ |
| ID 欠番規約（`DOM-identity-023`〜`028`） | `AiClientConnectionRepository` の6メソッドを指し続ける | 023〜028 の6行がすべて `AiClientConnectionRepository`（save 初回 / OCC 更新 / findById / listByUserId / 認可用 / `lastUsedAt`） | ○ |
| ADR 番号の重複 | なし | `## ADR-NNN` **78 件**、`uniq -d` **0 件**、001〜078 の連番 | ○ |
| スコープ逸脱 | 0 行 | `git diff --name-status main...HEAD \| grep -vE '^[AMD]\s+(spec/.*\.md\|CLAUDE\.md\|\.thread/35/.*)$'` = **0 行**。コード変更 0 | ○ |
| `pnpm lint` | exit 0 | **exit 0**（150 files / 0 fixes / 2 infos） | ○ |
| `pnpm format:check` | exit 0 | **exit 0**（167 files / 0 fixes） | ○ |

## カバレッジ（106 件）

### 確認（94 件）

**修正の直接対象・1行ずつ照合（2件）**

1. `CLAUDE.md` — `:68` を `spec/database/index.md` の DO クラス別実態および `:754` の員数と突合。英文構造も確認。`V-8` / `V-9` / `P-5` / `P-9` の射程。
2. `spec/database/index.md` — `:69`（`session_epoch`）と `:468`（`kind` 前文）を実物確認。`kind` 全数表 12 行を1行ずつ投入点欄と突合（上表）。節構成（`:60` / `:536`）で DO クラス帰属を確認。`P-1`〜`P-3` / `P-9` / `P-10` の射程。

**修正の伝播先として明示的に突合（8件）**

3. `spec/domains/identity.md` — `:485` の `sessionEpoch` 4操作。
4. `spec/inventory/domain.md` — `:42` の4操作、`:41` の退会スコープ宣言、`DOM-identity-023`〜`028` の欠番規約。
5. `spec/inventory/adapter.md` — `:54` の4経路、非集約ストアの書き込み口3件。
6. `spec/inventory/usecase.md` — `UC-*` 54 行、退会ユースケースの不在、`linkSsoCredential` の `sessionEpoch` 非前進。
7. `spec/usecases/identity.md` — `advanceSessionEpoch` の3呼び出し点、`resume-link` / `sweep-orphan-mapping` の投入。
8. `spec/usecases/trash.md` / 9. `spec/usecases/memo.md` / 10. `spec/usecases/knowledge.md` — `purge-trash` 投入点の実在（`kind` 表の投入点欄の裏づけ）。

**機械ゲートで全面確認（84 件）**

11–94. 残る `spec/**/*.md`（`domains/{export,index,knowledge,memo,search,trash}.md`、`idea.md`、`index.md`、`inventory/{frontend,test}.md`、`manual-tests/` 8件、`pages/index.md`、`requirements.md`、`scenario/` 4件、`testcases/` 49件（新設3・削除1を含む）、`usecases/{export,search}.md`）と `.thread/35/{plan,steps,testing,adr,coverage,step14-checklist}.md` および `.thread/35/review/{triage,review-003-acceptance,review-003-cross-boundary}.md`。
`V-1`〜`V-10` / `V-3b` / `P-1`〜`P-11` / 件数・台帳の全単射 / `NO-VERDICT` / スコープ / lint / format をこの全量に対して実行し、すべて期待値どおりであることを確認した。3ラウンド目のコミット `4ca6219` はこれらのファイルを1件も触っていない（差分は `CLAUDE.md` 1行・`spec/database/index.md` 2行・`.thread/35/` 5ファイル）ため、新規の破れが入る経路が無いことも差分側から裏づけた。

### スキップ（12 件）

95–106. `.thread/35/review/review-001-*.md`（6件）/ `.thread/35/review/review-002-*.md`（6件）。
**理由:** ラウンド1・2 のレビュー記録そのもので、`triage.md` が全指摘の判定を継承済み。記録の本文を書き換えないという `plan.md`「含まれないもの」の方針（レビュー記録は過去の判断の履歴）に従い、内容の再審議は行わない。`triage.md` は読んで既判定を把握した（確認側に計上）。

**合計: 確認 94 + スキップ 12 = 106 件。**

## APPROVED の理由

Blocker 0。3ラウンド目の Warning 4件はすべて実物に入り、伝播先（`session_epoch` は 4 箇所、UoW 名簿は `spec/database/index.md` の DO クラス別実態と員数）まで一致している。機械ゲートは全件が期待値どおりで、コード変更 0・スコープ逸脱 0。残る W-001 は表の分類語1語の射程の問題で、投入点欄と核の不変条件は正しく、#37 の実装判断を誤らせる性質のものではない（退会の書き手が #37 側であることは同じファイルの `:81` が別途持つ）。**このラウンドで収束と判断する。**
