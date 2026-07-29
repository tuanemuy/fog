# 実装計画 — Issue #34: [設計] Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**Issue:** #34
**作成日:** 2026-07-29
**複雑度:** 中〜大規模

---

## 目的

本番構成を「Cloudflare Workers + ユーザー単位 SQLite-backed Durable Objects」へ集約する意思決定を永続 ADR 3件として `.adr/` に確定させ、その決定を実装可能な粒度まで落とした DO 境界・ルーティング設計を `.thread/34/design.md` に書き切る。後続の #35（spec 改訂）と #37（D1 → DO 実装）が、この2種類の成果物だけを入力に着手できる状態を作る。

本 Issue はコードを1行も変更しない。成果物はすべてドキュメントである。

## 受け入れ基準

Issue 本文「受け入れ条件」9項目を、検証可能な単位へ分解した。`# 検証` 欄はレビュー・PR レビューがそのまま実行できる形で書く。

**AC が design.md を指すときは節タイトル（論点名）で指し、節番号は括弧付きの参考に留める。** 執筆中に章立てを1つ足し引きしただけで機械的検証（実装ステップ10）が全滅するのを避けるため。検証の実体は「その論点に結論があるか」であって節番号ではない。**AC 番号（AC-1〜AC-23）は動かさない** — レビューファイルと指摘台帳がこの番号を参照している。追加が必要になったら AC-24 以降を末尾に足す。

| # | 基準（検証可能な形で） | 検証 | 由来 | 対応ステップ |
|---|---|---|---|---|
| AC-1 | `.adr/` に `002`（ランタイム・データ配置）/ `003`（検索方式）/ `004`（非同期処理）の3ファイルが存在し、各ファイルが「ステータス / コンテキスト / 決定 / 検討した代替案 / 影響」の5節を持つ | `ls .adr/` が `001` + `002` + `003` + `004` の4件ちょうど。各ファイルに5つの `##` 見出し。**H1 が `# 00N. <和文タイトル>` 形式**（既存 `.adr/001` の `# 001. 統合テストを Workers プール1本に集約する` に揃える。`##` の5節見出しも和文） | 受け入れ条件1・対応項目1 | 4, 5, 6, 10 |
| AC-2 | `.adr/` に上記3件以外の新規 ADR が増えていない（`005` 以降が存在しない） | `ls .adr/ \| wc -l` が 4。`git diff --name-status main...HEAD` の `.adr/` 配下が `A` 3行のみ | 受け入れ条件1・間違えやすい点 | 4, 5, 6, 10 |
| AC-3 | 採番が `001` の続きから始まっており、既存の `001-integration-tests-single-workers-pool.md` を上書き・改番していない | `git diff --name-status main...HEAD` に `.adr/001-*.md` の行が現れない（commit 前後どちらでも空振りしないよう、実装ステップ10 の統一手順に従う） | 間違えやすい点「`.adr/001` は既に存在する」 | 4, 10 |
| AC-4 | 対応項目3（User Data DO / Identity Directory DO / DO ID と PII）の設計が `.thread/34/design.md` に書かれている | design.md に「User Data DO」「ルーティング」「Identity Directory DO」の3章が存在し、後述「design.md 構成案」がそれらの下に挙げた全節（論点）に本文がある（参考: 第4〜6章） | 受け入れ条件2・5・6・7 | 2 |
| AC-5 | 対応項目4（FTS5 同期更新の可否 / trash retention の Alarm / 外部 I/O だけを永続ジョブに残す境界 / UoW 契約 / lazy migration）の方針が `.thread/34/design.md` に書かれ、いずれも「決めた」と読める断定形になっている（「検討する」で終わっていない） | **対象はラベルで定義する** — 見出しに `［Issue 要求］` または `［派生］` が付いた節**すべて**（後述「節のラベル付け」）。節の列挙では定義しない（列挙と構成案がずれると射程から漏れる節が出る）。対象外は `［参考］` ラベルの節と、明示的に委譲を宣言している「検索 API の仕様 → #35 へ委譲」（参考: 第7.2.1節）の1節のみ。したがって次はいずれも**対象に含まれる** — 「FTS5 の同期更新」「Outbox / relay / consumer / DLQ の廃止範囲」「Alarm ジョブ」「trash retention の期限処理」「外部 I/O を永続ジョブに残す境界」「UoW 契約」章・「スキーマバージョン管理と lazy migration」章（参考: 第7.1 / 7.3 / 7.4 / 7.5 / 7.6節・第8章・第9章）、**「FTS5 のみで日本語全文検索が成立する根拠」**（`.adr/003` の妥当性そのものがここに懸かる。正規化 / トークナイザ / 短語フォールバックが結論に至らないと ADR が宙に浮く。参考: 第7.2節）、**「分割方式」**（#37 の前提。「(b) が有力だが最終決定は #37」で終わらせない。参考: 第6.2節）。「今後検討」「TBD」が結論位置に無い | 受け入れ条件8・対応項目4 | 1, 2, 3, 10 |
| AC-6 | `.adr/` の3件に、DO の分割数・saga 手順・migration 手順・スキーマ断片・テーブル定義といった実装レベルの詳細が流れ込んでいない | 3ファイルに `bucket` 数の具体値・SQL・テーブル定義・関数シグネチャが出現しない。各50行以内を目安 | 受け入れ条件2・原則「`.adr/` を薄く保つ」 | 4, 5, 6, 10 |
| AC-7 | `spec/adr/005-search-index-via-outbox.md` の本文が保持されたまま、ステータス行に新 ADR への superseded ポインタが付いている | `git diff main...HEAD -- spec/adr/005-*.md` の差分が **`## ステータス` 節の範囲に収まり、`## コンテキスト` 以降に一切変更が無い**（`## ステータス` 節の1行を書き換えるので削除行は伴う。禁じているのは本文の改変であって削除行そのものではない）。ポインタ先が `.adr/003`（ベクトル検索の不採用）と `.adr/004`（更新方式を同期 commit へ）の**両方**を指している | 受け入れ条件3・対応項目2 | 7, 10 |
| AC-8 | `.thread/1/adr.md` の ADR-004 に「`.adr/002` に supersede された」の1行ポインタが追記され、それ以外の本文が1文字も変わっていない | `git diff --name-status main...HEAD` で `.thread/1/adr.md` が `M`。`git diff main...HEAD -- .thread/1/adr.md` の**削除行がゼロ**、かつ**追加が supersede ポインタ1行のみ（前後の空行を除く）**。**挿入書式を固定する** — ADR-004 の `### Status`（`:162`）の本文 `Proposed`（`:164`）の直後に、空行1行 + ポインタ1行を挿入する。したがって追加行は2（空行1 + ポインタ1）。Markdown の空行規約（ブロック要素の前後に空行）を守った結果なので、この2行を上限とする | 受け入れ条件3・原則「本文は改変しない」 | 8, 10 |
| AC-9 | `spec/adr/` にファイルが追加されていない | `git diff --name-status main...HEAD` の `spec/adr/` 配下が `M spec/adr/005-*.md` の1行のみ（`A` が無い）。加えて `git status --porcelain` に `spec/adr/` の `??` が無い（未 commit の新規追加も塞ぐ） | 受け入れ条件4・間違えやすい点 | 7, 10 |
| AC-10 | supersede の正本が新 ADR 側にある。`.adr/002` / `.adr/003` / `.adr/004` のステータス節または影響節に「何を supersede したか」が明記されている | `.adr/002` が `.thread/1/adr.md` ADR-004 を、`.adr/003` と `.adr/004` が `spec/adr/005` を名指ししている | 対応項目2「supersede の正本は新しい `.adr/` 側」 | 4, 5, 6 |
| AC-11 | User Data DO が保持するデータ範囲が、Issue 列挙の7項目（ユーザー単位設定 / AI client connections / memos・memo revisions / topics・documents・document revisions・source links / trash・retention 状態 / FTS5 インデックス / 冪等化・非同期処理状態）をすべて含む形で列挙され、既存ドメイン集約との対応が取られている | design.md 第4章に対応表があり、7項目すべてが行として現れる | 受け入れ条件5・対応項目3 | 2 |
| AC-12 | 認証済み UI / REST / MCP リクエストを `userId` から対象 DO へルーティングする方式が書かれ、「他ユーザーの DO を指定できる入力面を公開しない」ことの構造的な担保が説明されている | design.md 第5章に、session / token → `userId` → DO locator の経路と、外部入力が locator に到達しない根拠がある | 受け入れ条件5・対応項目3 | 2 |
| AC-13 | Identity Directory DO について、解決責務・分割方式・部分失敗・リトライ時の冪等性・SSO リンク／解除時の整合性の5点すべてが設計として書かれている。**解決責務は Issue が列挙した4サブ項目に分解されている** — (a) 正規化メール → `userId`、(b) SSO provider + subject → `userId`、(c) メール・SSO 主体の一意性、(d) パスワード認証・パスワードリセットで必要な認証情報の所有境界 | 「解決責務」の節に (a)〜(d) が**個別の結論**として現れる（Account Home へ委譲する場合は委譲先の節タイトルを明記）。「分割方式」「部分失敗と補償」「リトライ時の冪等性」「SSO リンク / 解除の整合性」にもそれぞれ節がある（参考: 第6.1〜6.6節）。「単一グローバル DO」を無条件採用していない | 受け入れ条件6・対応項目3 | 2 |
| AC-14 | DO ID / routing key に生メールアドレス・SSO subject を使わず、正規化値の HMAC / hash を用いる方針と、ログ・URL・エラーメッセージへ PII を出さない方針が明記されている | 「DO ID / routing key と PII」の節に、(a) 生値を DO ID / routing key に使わない、(b) 正規化値の HMAC / hash を使う、(c) ログ・URL・エラーへ PII を出さない、の3点が結論として書かれている（参考: 第5.2節）。**鍵の所有者・世代管理は必須要件ではない**（Issue 未要求＝ラベル「参考」）が、書く場合は「Worker 分割」の結論と整合していること | 受け入れ条件7・対応項目3 | 2 |
| AC-15 | DO 間の分散トランザクションを前提としない旨が明示され、代替（saga + 冪等な補償）が示されている | design.md 第6章に宣言と代替手段がある | 対応項目3 | 2 |
| AC-16 | #35 が着手できる。改訂対象の spec ファイルと改訂内容が一覧化されており、**design.md 単体で意味が通る**（自己完結性の本体判定は AC-19） | design.md 最終章に「#35 への引き継ぎ」表があり、**次をすべて含む**（列挙の網羅性はステップ3 の機械走査で担保する） — `spec/requirements.md`（**`:87` の「キーワード検索とベクトル検索のハイブリッド」と `:108` の「search — ハイブリッド検索」の2箇所**）/ `spec/domains/search.md` / `spec/domains/{memo,knowledge,identity,trash}.md` / `spec/domains/index.md`（テナント分離規約の例外条項）/ `spec/database/index.md`（`:355-357` のスコープ外宣言を含む）/ **`spec/usecases/search.md`**（`maintainSearchIndex` = `:85-` の consumer 側ユースケース。FTS5 同期更新でユースケースごと消える）/ **`spec/usecases/trash.md`**（`pruneExpiredTrashItems` = `:311-`。Alarm 化で置き換わる。`:315` の pruner 専用 WorkerContainer を含む）/ **`spec/testcases/search/maintainSearchIndex.md`** / **`spec/testcases/trash/pruneExpiredTrashItems.md`** / **`spec/inventory/{domain,adapter,usecase,test}.md`**（`UC-search-002` / `UC-trash-007` / `TC-maintainSearchIndex-*` 28件 / `TC-pruneExpiredTrashItems-*` 17件を持つ台帳。「ポート契約が変われば台帳も変わる」は usecase / test の台帳にも等しく効く）/ **`spec/index.md`**（`:38-43` の ADR 一覧表。`spec/adr/005` の行）/ **`spec/scenario/search.md`**（`:6` / `:25` のハイブリッド検索前提）/ **`spec/manual-tests/search.md`**（`:5` / `:17`「検索インデックス更新用のワーカー（非同期 consumer）が起動している」/ `:69` / `:266`。`spec/manual-tests/trash.md` の pruner 起動口とまったく同じ性質の前提）/ `spec/manual-tests/trash.md` / **`spec/pages/index.md`**（`:180` の P-11 検索）/ `CLAUDE.md`。加えて #35 の担当者になったつもりで読み、`issue/19/cloudflare-do-fts` / `.thread/19/` / `.thread/1/adr.md` を開かずに改訂対象と改訂方針が特定できる | 受け入れ条件9 | 3, 10 |
| AC-17 | #37 が着手できる。削除対象・新設対象のモジュールが一覧化され、UoW 契約の新旧対比が読め、**design.md 単体で意味が通る**（自己完結性の本体判定は AC-19） | design.md 最終章に「#37 への引き継ぎ」表があり、次をすべて含む — `adapters/d1/` / `application/workers/` / `application/execution/unitOfWork.ts` / **`application/ports/{outboxRepository,relayTrigger,idempotencyStore}.ts`** / `di/serverCloudflare.ts` / `application/di/{types.ts,containerStore.ts}` / **`application/di/types.ts:70` の `WorkerContainer` と、そこから拡張する2種類の専用コンテナ — indexer 専用（`spec/domains/search.md:264` / `spec/usecases/search.md:89-96`）と pruner 専用（`spec/usecases/trash.md:315`）** / `apps/web/app/presentation/` / `infra/cloudflare/pulumi/resources/index.ts` / **`apps/web/scripts/render-wrangler.ts` + `apps/web/wrangler.{staging,production}.toml.tpl`（`.gitignore:14-17` によりレンダリング生成物は直接編集禁止）** / **ローカル開発用 `apps/web/wrangler.toml`（162行。DO バインディングが1つも無い）** / **`apps/web/package.json` の deploy 系（非 dry 12本 = `deploy:{staging,production}` + `:relay` / `:consumer` / `:pruner` / `:dlq` / `:all`。`:dry` 変種を含めると全24本）と D1 前提の db 系7本（`db:migrate:cf` / `db:apply:{local,staging,production}` / `db:execute:{local,staging,production}`。これらに委譲する `db:migrate` も道連れになる）** / `vitest.config.integration.ts`。加えて #37 の担当者になったつもりで読み、先行ブランチを開かずに削除対象・新設対象と UoW の新旧契約が読み取れる | 受け入れ条件9 | 3, 10 |
| AC-18 | 実装中に下した「`.adr/` へ昇格させなかった」判断が `.thread/34/adr.md` に記録されている | `.thread/34/adr.md` は着手時点で ADR-001〜019 が既存（計画立案 + レビュー3周で作成済み）。ステップ2〜8 の実行中に下した判断が **ADR-020 以降として追記されている**（＝件数が着手時点の19件から増えている）か、増えなかった場合は「昇格を見送った判断が無かった」旨が明記されている。追記分が `.adr/` の3件と内容重複しない | やること6・原則 | 9, 10 |
| AC-19 | **成果物の自己完結性** — design.md と `.adr/002〜004` が、先行ブランチのコミット番号・ブランチ名・`.thread/19/` のファイル名を参照して内容を代替していない | 「先行案との差分」の節（参考: 第1.3節）の各行が『採用 / 棄却 / 保留』のラベルだけでなく**採用した内容の要旨**を持つ。`git show` / ブランチ名 / 先行 ADR 番号への言及は「出自の注記」に留まり、それを開かないと設計が読めない箇所が無い。同じ検査を `.thread/1/adr.md`（1662行の作業ログ）・#35 で書き換わる `spec/domains/search.md` への参照にも適用する | 受け入れ条件9 | 1, 2, 3, 10 |
| AC-20 | **本 Issue はコードもコンフィグも変更しない** — 差分がドキュメントのみに収まっている | `git diff --name-status main...HEAD` の結果が `.adr/00{2,3,4}-*.md` / `.thread/34/**` / `spec/adr/005-*.md` / `.thread/1/adr.md` に限られ、`packages/core/` / `apps/web/app/` / `infra/` / `*.toml` / `*.ts` が1件も現れない。**かつ `git status --porcelain` に、既知の untracked 以外の未コミット変更がゼロ**（commit 漏れによる空振りを塞ぐ）。**既知の untracked は着手時点の実測（`git status --porcelain` を実行して得た全6エントリ）で定義する** — `.artifacts/` / **`.thread/36/`** / `apps/web/wrangler.{request,state}.{production,staging}.toml` の4本。`.thread/34/` は本 Issue の成果物として commit されるので、ここには残らない | 目的節「コードを1行も変更しない」・スコープ外 #37 | 10 |
| AC-21 | **Account Home DO の採否が結論づけられている** — 未決事項に落としていない | 「クラス構成と責務分界」の節に「採用する / しない」の断定と理由がある（参考: 第3.1節）。「未決事項」の節（参考: 第11.4節）に Account Home が現れない | 受け入れ条件9（#37 が成果物だけで着手できる） | 2, 10 |
| AC-22 | ユーザー境界に閉じない処理が**全数**棚卸しされ、各行に行き先が割り当てられている | **主判定（網羅性そのものを見る）**: `spec/inventory/adapter.md` の `ADP-*` 全85件（`ADP-users-001` 〜 `ADP-export-002`）を走査して下記の述語を当て直し、**該当する全件が「ユーザー境界に閉じないものの帰属」の節（参考: 第4.3節）の表に行として存在し**、各行に「User Data DO に閉じる / Directory・Account Home の関心事 / 不要になる」のいずれかが入っている。走査で新たに見つかったものは表に足す。**述語の定義（何をもって「ユーザー境界に閉じない」とするか）**: (a) **`userId` を第一引数に取らないポート**（引数オブジェクトの中に `userId` があるものも含む — 型レベルで境界が保証されないため）、(b) **`user_id` 列を持たない、または当該の引き方の経路に `user_id` が入っていないテーブル**（全テーブルが単一列 TEXT の `id` を PK にしているので、「PK に含まない」では全件が該当してしまう。見るのは列の有無ではなく**引き方の経路**）、(c) 台帳の粒度で捕まらない次元（DI 構成・ジョブ・spec 上の未設計領域）。**補助（主判定から導かれる結果であって判定基準ではない）**: 行数29 / カテゴリ数8。括り方や台帳の更新で数が動いても検証が壊れないよう、数を主判定にしない | 受け入れ条件5・6 | 2, 10 |
| AC-23 | 認証情報の canonical 化まわりの前提が決着している — (a) canonical 正規化規則、(b) locator 鍵の2系統分離（`userId` 由来 / credential 由来）、(c) canonical credential（メール原本）の保持場所と保護方式、(d) HMAC 由来 routing key のハッシュ衝突の扱い | 「canonical 化の定義」「locator 鍵の分離」「衝突の扱い」の節に (a)(b)(d)、「canonical credential の保持と保護」の節に (c) があり、いずれも断定形（参考: 第5.2節配下・第6.2.1節）。(b) は「鍵ローテーションの対象が credential 由来 locator に限られ、User Data DO の同一性に波及しない」ことが読み取れる | 受け入れ条件6・7（一意性と PII 非露出の前提） | 2 |

## スコープ

### 含まれないもの

- `spec/` 本体の改訂（`spec/requirements.md` の「ハイブリッド検索」記述、`spec/domains/search.md`、`spec/database/index.md`、`spec/domains/index.md` のテナント分離規約、`spec/inventory/*`）と `CLAUDE.md` の改訂 → #35。本 Issue では「何をどう直すか」を design.md の引き継ぎ表に書くところまで
- `spec/adr/` への新規ファイル追加 → 恒久的に行わない。005 のステータス行への supersede ポインタのみ
- Node / AWS / GCP ランタイムの撤去 → #36 で完了済み。やり直さない
- D1 → DO の実装、DO クラスの実装、wrangler 設定の追加・改訂、テストの追加 → #37
- ドキュメント（`docs/runtime_cloudflare.md`）・セキュリティ・運用手順の整備 → #38
- ベクトル検索・意味検索・Vectorize・embedding・RRF の設計 → 採用しないことを `.adr/003` で決定するのみ。再検討は将来の別 Issue と ADR
- **検索 API の仕様設計（topic filter / trash 除外 / 安定順位 / snippet / ページング）** → #35（`spec/domains/search.md` の改訂）と #37。本 Issue が検索について決めるのは「FTS5 を本体更新と同一 SQLite transaction で同期更新できるか」（対応項目4）と「FTS5 のみで日本語全文検索が成立する根拠」（`.adr/003` を支える範囲＝正規化・トークナイザ・短語フォールバック）まで。design.md では第7.2.1節を立て、これらを**決着させる節ではなく #35 への入力**として書く（AC-5 の対象外）
- 共有・共同編集・テナント横断検索
- 作業ツリーに残っている未コミットの `apps/web/wrangler.{state,request}.{staging,production}.toml` 4本の commit / 削除 → 本 Issue はコードもコンフィグも変更しない。扱いは「調査結果」に記録するのみ
- **`.thread/36/`（#36 の作業ログ）の commit / 削除** → 同じく本 Issue では触らない。#36 は完了済みで、その作業ログの commit 要否は本 Issue の判断対象ではない。AC-20 の既知 untracked として記録するだけに留める

## 調査結果

### 関連ファイル

**ADR の3系統（書き先の取り違えが最大の失敗要因なので最初に確定させる）**

| パス | 実態 | 本 Issue での操作 |
|---|---|---|
| `/Users/hikaru/github.com/tuanemuy/fog/.adr/001-integration-tests-single-workers-pool.md` | 44行。永続台帳の唯一の既存エントリ。5節構成（ステータス / コンテキスト / 決定 / 検討した代替案 / 影響）。本文中に既に「永続化は今後さらに Cloudflare 側（Workers プール + DO SQLite）へ寄っていく」と本 Issue の方針を前提として書いている | 読み取りのみ。フォーマットの手本にする |
| `/Users/hikaru/github.com/tuanemuy/fog/spec/adr/001〜006` | 24 / 23 / 23 / 31 / 28 / 25 行。`spec/index.md:38-43` の表と `spec/database/index.md:6` から参照されている。`spec/domains/` 側で `spec/adr/` への相対リンクを持つのは `index.md:3` / `identity.md:5` / `memo.md:6` / `knowledge.md:6` / `search.md:3` の5ファイルのみで、`trash.md` は ADR 言及ゼロ、`export.md` はリンクを持たない。**`005` を参照している相対リンクは実測6本** — `spec/index.md:42` / `spec/database/index.md:6` / `spec/domains/search.md:3` / `spec/domains/memo.md:6` / `spec/domains/knowledge.md:6` / `spec/usecases/search.md:3`。**いずれもファイル自体を指すのでステータス節の書き換えでは壊れない**（AC-9 / ステップ7 の安全性の裏付け）。ただし `spec/index.md:42`（ADR 一覧表）と `spec/usecases/search.md:3`（`maintainSearchIndex` の上流参照）は #35 の改訂対象なので AC-16 の必須一覧に入れる | `005` のステータス節のみ更新 |
| `/Users/hikaru/github.com/tuanemuy/fog/.thread/{1,19,30,36}/` | Issue 単位の作業ログ。`.thread/1/adr.md` は 169k / 1662行、ADR-001〜053。**tracked なのは `1` と `30` のみ。`19` は先行ブランチ `issue/19/cloudflare-do-fts` 上にしか無く（`git show` 経由で読む）、`36` は untracked のまま作業ツリーに残っている**（AC-20 の既知 untracked に含める理由） | `.thread/1/adr.md` の ADR-004 に1行追記。それ以外は読み取りのみ |

**現行実装（D1 + Outbox）**

- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/adapters/d1/` — 20ファイル / 2,514行。プロダクションコードは8ファイル / 914行
  - `unitOfWork.ts`（130行）— D1 に interactive transaction が無いための **deferred-batch モデル**。`run()` の中で `PendingBatch` を作ってリポジトリに注入し、コールバック完走後に `db.batch(pending.build())` で一括フラッシュする。JSDoc に「Read-your-write within the same UoW is unsupported by design」と明記
  - `pendingBatch.ts`（98行）— 未 await の Drizzle クエリビルダ（`BatchItem<"sqlite">`）を配列に溜めるバッファ。`addOcc(write, onConflict)` が OCC 付き書き込みを扱う
  - `schema.ts:139-145` の `_occ_guard` — `CHECK(n > 0)` を持つ空テーブル。OCC 書き込みの直後に `INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0` を挟み、0行マッチ時に CHECK 違反でバッチ全体を abort させる仕掛け。**D1 が「`UPDATE ... WHERE version = ?` の 0行マッチ」を正常成功として扱うことへの回避策**であり、interactive transaction があれば不要
  - `repositories/helpers.ts:55-69` の `isOccGuardViolation` — D1 が CHECK 違反をエラーメッセージ文字列でしか返さないため、`CHECK constraint failed: occ_guard_positive` の**部分一致**で判定している。同ファイルのコメントが「メッセージから CHECK 名が落ちると `ConflictError("CONSTRAINT_VIOLATION")` に degrade する」と脆さを自認している
  - `repositories/outboxRepository.ts`（227行）— UoW 内モード（`PendingBatch` 必須）と relay worker モードの2態。`claimPending` は単文 `UPDATE ... WHERE id IN (SELECT ...) RETURNING` で lease を取る。D1 が `UPDATE ... ORDER BY ... LIMIT ... RETURNING` を拒否する制約への対処コメントあり
  - `migrations/0000_initial.sql`（**47行**。末尾に改行が無いため `wc -l` は46 を返すが、`:47` に行が実在する）— テーブルは `users` / `outbox_events` / `processed_events` / `_occ_guard` の4つのみ。`users_email_uq`（`:46`）と `users_sso_identity_uq`（`:47`。`WHERE sso_provider IS NOT NULL` の部分ユニーク）を含む。**spec 側のテーブル名は `outbox`（`spec/database/index.md:31,335,339`）で、実装は `outbox_events`** — 残存課題5 が記録しているとおりの乖離
- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/application/execution/unitOfWork.ts` — **19行**。`UnitOfWorkContext { userRepository; collectEvents(drafts) }` と `UnitOfWorkProvider { run<T>(fn) }` のみ。`run<T>(fn: (ctx) => Promise<T>): Promise<T>` はコールバックだけを受け、**テナント／ユーザーのスコープを受け取る引数が構造上存在しない**
- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/application/ports/` — 7ファイル / **186行**（clock 7 / idGenerator 32 / idempotencyStore 9 / logger 23 / outboxRepository 69 / relayTrigger 22 / sessionCodec 24）
- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/application/workers/eventRelayWorker.ts`（301行）— claim → decode → dispatch（バッチ1回） → finalize。`RELAY_WORKER_ID = crypto.randomUUID()` が**モジュールスコープ**にあり、これが `pnpm start` / `pnpm preview` の起動不能（#40）の原因。lease は `claimed_at <= now - leaseMs` の SQL 条件で再 claim 可能にしている
- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/application/workers/outboxPrune.ts`（25行）— 7日より古い processed 行を削除
- `/Users/hikaru/github.com/tuanemuy/fog/apps/web/app/worker/cloudflare/{relay,consumer,pruner,dlq}.ts` + `handlers.ts`（138行）— consumer（`handleQueue`）は `markProcessed` してログを出すだけで、**検索インデックス更新の実処理は未実装**
- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/application/di/serverCloudflare.ts`（164行）— `ServerEnv = { DB: D1Database; APP_URL; RELAY?; SESSION_SECRET?; OUTBOX_* }`。DO バインディングは存在しない。`createRequestContainer` はリクエスト先頭で `D1UnitOfWorkProvider` を組み立て、**`userId` を一切知らない**
- `/Users/hikaru/github.com/tuanemuy/fog/apps/web/app/server.cloudflare.ts:37-46` — `createRequestContainer` → `AsyncLocalStorage.run(container, ...)`。ここでも `userId` は未登場

**ドメインと認証**

- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/domain/` — 実装済みは `common/` と `identity/` のみ。**エンティティは `User` 1つだけ**。memo / knowledge / search / trash / export のディレクトリは存在しない
- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/domain/identity/entity.ts:14-36` — `User = PasswordUser | SsoUser`。`email` がグローバル一意、`(provider, providerSubject)` の組もグローバル一意
- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/domain/identity/valueObject.ts:19-35` — `UserId.create` は trim + 空文字チェックのみ。`:21-23` のコメントが「ドメインは id を不透明な非空文字列として扱う。id フォーマット（ここでは UUIDv7）は `IdGenerator` の責務で、rehydration 時にストレージアダプターが検証する」と明言しており、**UUIDv7 であることをドメインは保証していない**
- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/domain/identity/valueObject.ts:45-62` — `Email.create` が `trim().toLowerCase()` で**正規化済み**。DO routing key の canonical 値としてそのまま使える
- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/domain/identity/ports/userRepository.ts:16-19` — 「The other identity repositories additionally need `(userId, id)` signatures for tenant scoping, which the base contract cannot express」と、userId スコープの必要性を既に自認
- `/Users/hikaru/github.com/tuanemuy/fog/apps/web/app/presentation/currentUser.ts:17-26` — `getCurrentUserId()` が `sessionCodec.verify(token, now)` で **DB を触らずに** `userId` を確定する。同 `:34-54` の `requireUserId()` が権威点
- `/Users/hikaru/github.com/tuanemuy/fog/packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` — ステートレス HMAC（`{uid, exp}` を HMAC-SHA256 署名、TTL 7日）。**サーバー側失効の手段が無い**ことを ADR-002（`.thread/1/adr.md:47`）がトレードオフとして受け入れている
- 未実装領域の内訳（**実測。「認証まわりは何も実装されていない」は誤り**）:
  - **パスワードリセット / MCP・REST OAuth / `TokenScope`** — 実装が1行も無い。`apps/web/app/routes/password-reset.tsx` はプレースホルダー画面
  - **SSO — ユースケースとルートだけが無い。** 値オブジェクト（`domain/identity/valueObject.ts` の `SsoProvider`）、エンティティ（`domain/identity/entity.ts:29-34` の `SsoUser`）、スキーマ（`adapters/d1/schema.ts` と `migrations/0000_initial.sql:33-34,41-42` の `sso_provider` / `sso_provider_subject` 列 + CHECK 3本、`:47` の `users_sso_identity_uq` 部分ユニーク）、リポジトリ（`adapters/d1/repositories/userRepository.ts`）、`application/identity/{view,eventDecoders}.ts`、`apps/web/app/components/settings/CurrentUserPanel/` まで実装済み
  - **`AiClientConnection` — 値オブジェクトと `Actor` 判別共用体だけが実装済み。** `domain/identity/valueObject.ts:125-140`（`AiClientConnectionId`）/ `:142-161`（`ClientName`）/ `:191-196`（`AiClientActor`）/ `:206-214`（`Actor = UserActor | AiClientActor`）、`domain/identity/errorCode.ts:8`、`valueObject.test.ts:135-142,192`。エンティティ・リポジトリ・`ai_client_connections` テーブルは無い
- この内訳は2箇所に効く。(a) **#37 の作業量見積り** — 「実装済みドメインは `identity/User` 1つだけなので既存コードの書き換えコストはほぼゼロ」は正しくない。`Actor` 判別共用体（memo / knowledge のリビジョンが全部これを持つ）と SSO 列・部分ユニーク索引は DO 境界の再設計で書き換わる。(b) **design.md の「SSO リンク / 解除の整合性」「MCP / REST の認可経路」の入力が既に存在する** — とくに `users_sso_identity_uq` は Identity Directory が引き受けるグローバル一意制約の**既に動いている実装**であり、「これから設計する」ではなく「既存実装をどう移すか」の話になる

**未コミットの残骸**

**着手時点の `git status --porcelain` を実際に実行した結果は次の6エントリ**（AC-20 の既知 untracked ホワイトリストはこの実測から作る。`-uall` ではディレクトリが展開されるので、判定は既定の縮約表示で行う）。

```
?? .artifacts/
?? .thread/34/          ← 本 Issue の成果物。commit されるのでホワイトリストに入れない
?? .thread/36/
?? apps/web/wrangler.request.production.toml
?? apps/web/wrangler.request.staging.toml
?? apps/web/wrangler.state.production.toml
?? apps/web/wrangler.state.staging.toml
```

**`.thread/36/` も untracked のまま残っている。** #36（Node / AWS / GCP ランタイムの撤去）はマージ済みだが、その作業ログ（`adr.md` / `plan.md` / `testing.md` / `manual-test/`）が commit されていない。**本 Issue では触らない** — #36 は完了済みであり、その作業ログを commit すべきかどうかは本 Issue の判断対象ではない。ただし **AC-20 の既知 untracked に含めないと、ステップ10 の検査が誤検知で必ず落ちる**（3周目 cov P-001 / arch S-003）。放置すれば AC-20 後半が偽陽性で落ち、commit すれば AC-20 前半（差分は `.adr/00{2,3,4}` / `.thread/34/**` / `spec/adr/005-*` / `.thread/1/adr.md` に限る）を破るという詰みになるため、**ホワイトリストへの追加以外に逃げ場が無い**。

作業ツリーに `apps/web/wrangler.{state,request}.{staging,production}.toml` の4本が untracked で残っている。内容は `UserDataDurableObject` / `IdentityDirectoryDurableObject` / `AccountHomeDurableObject` の3クラスを `storage = "sqlite"` で宣言する DO 構成で、`DIRECTORY_ROUTING_SECRET_ACTIVE` / `DIRECTORY_ROUTING_GENERATION_ACTIVE` / `PITR_OPERATOR_TOKEN` / `IDENTITY_MAIL_ENCRYPTION_KEY` を含む。これらが指す `apps/web/app/server.state.ts` は現ブランチに存在しない。後述の先行ブランチの成果物が切り替え時に残ったもので、**本 Issue では触らない**（設計の裏取り資料としてのみ使う）。

### Cloudflare プラットフォームの確定事実（design.md 第2.1節の材料）

**正本は design.md 第2.1節。** この表は執筆前のスナップショットであり、ステップ1の差分確認の結果は design.md 側に反映する。#35 / #37 が読むのは design.md である。

設計の土台になるので、公式ドキュメントで裏取り済みの事実をここに固定する。実装ステップ1はこの表を**再取得するのではなく差分だけを確認する**。

| 事実 | 値 | 出典 | 設計上の効き先 |
|---|---|---|---|
| DO あたりストレージ上限 | 10 GB（2025-04-07 GA で 1GB→10GB）。Free はアカウント合計 5 GB。上限到達時は書き込みだけ `SQLITE_FULL`、読みと DELETE は継続 | `/durable-objects/platform/limits/`、`/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/` | 4.6（容量）・S-008 のエラー翻訳 |
| Alarm | 1 DO につき同時1本。`setAlarm` は既存を上書き。at-least-once、指数バックオフ（初回2秒から）で最大6回。**handler の wall time 15分は alarms ページには無く、limits ページの "Wall time limits by invocation type" 表にある**（alarms ページは duration / wall time を一切述べていない） | 同時1本・上書き・リトライ: `/durable-objects/api/alarms/`。wall time 15分: `/durable-objects/platform/limits/` | 7.4 / 7.5 |
| **CPU 時間** | **既定30秒（リクエストあたり）/ 設定で最大5分の active CPU。wall time とは別枠。** さらに**「リセット」の意味論**が重要 — 公式は「Each incoming HTTP request or WebSocket message **resets** the remaining available CPU time to 30 seconds」「If you consume more than 30 seconds of compute between incoming network requests, there is a **heightened chance that the individual Durable Object is evicted and reset**」と定めている。つまり30秒は固定の総量ではなく**着信ごとに戻る枠**であり、着信リクエストが無い **Alarm 駆動の処理では戻す契機が無い**。しかも超過の帰結は「エラーで失敗」ではなく**エビクションとリセット** | `/durable-objects/platform/limits/` | 7.4 / 9.2。**bulk migration や FTS5 全件再インデックスで先に当たるのは wall time ではなく CPU 予算**。`blockConcurrencyWhile` の30秒と数値が偶然同じだが別物なので混同しない。**リセット意味論は 9.2 の失敗モードを変える** — Alarm 駆動の bulk migration は「途中まで進んで黙ってリセットされる」形で失敗しうるので、部分適用の記録（9.3）が無いと復帰できない |
| **DO namespace の列挙** | **実行時に namespace を列挙する手段が無い。** Worker からの列挙 API は存在せず、REST の List Objects が返すのは16進の object ID と `hasStoredData` だけ。`listDurableObjectIds()` は `@cloudflare/vitest-pool-workers` のテスト専用ユーティリティで本番では使えない。**ただし DO の内側からは `ctx.id.name` で自分の名前を読める（公式 API）** — 「`idFromName` に渡した名前は復元できない」は誤りだった（3周目 arch P-001 で訂正）。公式が明記する制約は4つ: `newUniqueId()` 由来は `undefined` / `idFromString()` 経由で得た stub も `undefined` / 1,024 バイトを超える名前は `ctx.id` に渡らない / 2026-03-15 より前に作られた Alarm には名前が保存されていない | 列挙: `/api/resources/durable_objects/.../objects/methods/list/`。`name`: `/durable-objects/api/id/` | 6.2（分割方式の (c) 不採用理由）・6.8（旧世代 locator が0件であることの証明）。**この2つが依っているのは「namespace を実行時に列挙できない」という別の（確認済みで正しい）事実なので、`ctx.id.name` の訂正で結論は再オープンしない。** 一方で 6.3 / 6.8 / 7.4 の「DO に自分の routing key を明示的に渡す」配線は `ctx.id.name` があるなら不要になるので、そこは設計に反映する。5.2（PII）にも効く — 名前は DO の内側から可読で、かつ 2026-06-12 の changelog がダッシュボードのメトリクスを「by an individual Durable Object's ID or name」で絞り込めるようにしたため、生クレデンシャルを DO 名に使うとルーティング経路の外側（運用面）にも露出する |
| `transactionSync` | コールバックは**完全同期**（`async` 不可・Promise 返却不可）。同期ストレージ操作のみ参加。ネスト可否は公式記載なし | `/durable-objects/api/sqlite-storage-api/` | 8.2（新 UoW 契約） |
| **`sql.exec()` とトランザクション文** | **`sql.exec()` は `BEGIN TRANSACTION` / `SAVEPOINT` といったトランザクション文を実行できない**（公式原文: 「Note that `sql.exec()` cannot execute transaction-related statements like `BEGIN TRANSACTION` or `SAVEPOINT`」）。トランザクションは `ctx.storage.transaction()` / `transactionSync()` を使う | 同上 | 8.2（ネストした UoW を型で禁じるか）・9.3（1回で完了しない migration の部分適用の記録）。**「`transactionSync` のネスト可否は公式記載なし」の機械的な裏側**であり、SAVEPOINT による回避路が最初から無いことを意味する。#37 が SAVEPOINT で回避しようとして詰む経路を先に塞ぐ |
| SQL カーソル | **`await` を跨ぐとスナップショット分離の保証がない**。`.toArray()` 等で同期的に消費すべき | 同上 | 8.2 の「構造的保証」の直接の根拠 |
| FTS5 | **公式に明記されているのは FTS5 モジュール本体と `fts5vocab` のみ**（原文: 「Durable Objects support a subset of SQLite extensions for added functionality, including: FTS5 module for full-text search (including `fts5vocab`)」）。**`bm25` / `snippet` / `highlight` は公式ドキュメントに一語も現れず、トークナイザ（trigram 等）の可用性も記載が無い** — これらは下段「公式に記載が無い事項」側の扱いにする。**「仮想テーブルは原則禁止だが FTS5 のみ例外」は出典が無かったので削除した**（3周目 arch P-002。同ページで仮想テーブルに触れるもう一箇所は課金の一文で、むしろ一般に使える前提の書き方になっている） | 同上 | 2.1 / 7.1。`bm25` / `snippet` / `highlight` / trigram の裏は実測（`.thread/19/spike/fts5.integration.test.ts`）と workerd の allowlist ソース（`src/workerd/util/sqlite.c++`。実装ソースであってドキュメントではない）でしか取れない。**第7.2節と `.adr/003` は snippet を前提に書くので、「公式にサポート明記」と書いてはいけない** |
| **仮想テーブルへの書き込みの課金** | **「Writing data to SQLite virtual tables also counts towards rows written」と公式に明記。** trigram トークナイザは1ドキュメントあたりのインデックス行数が最も多い部類で、本体1行の書き込みが FTS 側の多数行書き込みを伴う | `/durable-objects/api/sqlite-storage-api/` | 4.6（容量は「本体 + FTS インデックスの合計で 10 GB」）・7.1（同期更新可否の判断入力）・`.adr/003` の影響節（費用面のトレードオフ）。ユーザー単位 DO は 10 GB を1人で使う構成なので増幅が直に効く |
| LIKE / GLOB パターン | 50 バイト上限 | `/durable-objects/platform/limits/` | 短語フォールバックの制約 |
| その他 SQL 制限 | 1テーブル100列 / 行 2MB / SQL 文 100KB / bind パラメータ100 | 同上 | 4.4（スキーマ方針） |
| 同時実行 | DO は single-threaded。input/output gates。SQLite 操作は同期でイベントループを譲らないため原子的。非ストレージ I/O（`fetch` 等）では interleave する | `/durable-objects/best-practices/rules-of-durable-objects/`、`/durable-objects/api/state/` | 8.2 / 8.4（OCC の去就） |
| スループット | 1オブジェクト soft limit 1,000 req/s（実務目安 500〜1,000）。超過で `overloaded`。**`overloaded` はリトライ禁止**と明記 | `/durable-objects/platform/limits/`、`/durable-objects/best-practices/error-handling/` | 6.2（bucket 数）・エラー翻訳表 |
| PITR | SQLite backend 限定 / 過去30日 / オブジェクト単位で DB 全体（SQL + KV 両方）/ **ローカル開発では利用不可**。`ctx.abort()` も `wrangler dev` で不可 | `/durable-objects/api/sqlite-storage-api/`、`/durable-objects/api/state/` | 9.5（ロールバック）・10.1（#38） |
| 宣言的 `exports` | 実在（2026-06-30 changelog）。`[[migrations]]` 配列とは**排他**。`exports` で作る namespace は SQLite のみ。ストレージ種別は不変。tombstone 削除に Trash 無し | `/durable-objects/reference/durable-objects-migrations/` | 9.1 |
| `waitUntil` | DO 内では効果なし | `/durable-objects/api/state/` | 現行 `ServiceBindingRelayTrigger` が `waitUntil` 前提。7.4 の Alarm 化と整合 |
| `blockConcurrencyWhile` | **30秒でタイムアウトし DO がリセットされる**。全並行性をブロックするのでスループットを大きく下げる | `/durable-objects/api/state/` | 9.2 / 9.3（lazy migration の実行機構） |
| 課金 | DO は Free / Paid 両方で利用可（Free は SQLite backend のみ）。`setAlarm` 1回 = 1 row written | `/durable-objects/platform/pricing/` | Issue の「Workers（Paid）」前提と矛盾しない |

**公式に記載が無い事項**（design.md では「実測で確認した」または「未確定」と明示して扱う）: `transactionSync` のネスト可否 / **FTS5 トークナイザ（trigram）の可用性** / **FTS5 の補助関数 `bm25` / `snippet` / `highlight` の可用性** / 1クエリの結果セット合計サイズ上限 / Free プランの「1オブジェクトあたり」上限（同一ページ内で表と FAQ が食い違う）。

このうち **trigram / `bm25` / `snippet` / `highlight` の4つは、ステップ1 で `.thread/19/spike/fts5.integration.test.ts` を workerd 上の実測結果として読み、「実測で確認済み」か「未確定」かを確定させる**。spike が触れていない関数があれば「未確定」のまま design.md 第2.1節に残し、第7.2節と `.adr/003` はその関数に依存しない書き方にする。**裏取りの種別（公式記載 / 実測 / 未確定）を取り違えたまま書くと、#35 / #37 が公式保証だと誤認する** — 計画が自ら立てた「公式に記載が無い事項は『実測』または『未確定』と明示して区別する」という規律を、トークナイザ以外にも等しく適用する。

### ユーザー境界に閉じない処理の全数（8カテゴリ・29行）

**正本は design.md の「ユーザー境界に閉じないものの帰属」の節（参考: 第4.3節）。** この表は執筆前のスナップショットで、行き先の列を持たない。#35 / #37 が読むのは design.md 側である。

design.md のその節はこの全数を対象にする（AC-22）。

**述語の定義（何をもって「ユーザー境界に閉じない」とするか）。** この定義が表の内容を決めるので、表より先に置く。

- **(a) `userId` を第一引数に取らないポート。** 引数オブジェクトの中に `userId` があるものも該当する — `spec/domains/index.md:32` の規約が求めているのは「第一引数の `userId` による構造的保証」であり、オブジェクトの中に埋まっていると型レベルで境界が保証されないため。この扱いにより `SearchIndexPort.query(query: SearchQuery)` と `upsertMemo(entry)` / `upsertDocument(entry)` は同じ判定になる（2周目までは前者だけが除外されていた）
- **(b) `user_id` 列を持たない、または当該の引き方の経路に `user_id` が入っていないテーブル。** 「`user_id` を PK に含まない」では判定にならない — 設計上**すべてのテーブル**が単一列 TEXT の `id` を PK にしているので全件が該当してしまう。見るのは列の有無ではなく**引き方の経路**（ユニーク索引 / 期限切れ索引 / PK 素引きに `user_id` 述語が入っているか）である
- **(c) 台帳の粒度では捕まらない次元** — DI 構成・ジョブ・spec 上の未設計領域。カテゴリ D の一部と G / H がこれにあたる

**取り方**: 手作りの列挙ではなく `spec/inventory/adapter.md`（`ADP-*` の要素台帳。実測でユニーク85件 = スキーマ14件 + ポート実装 identity 16 / memo 13 / knowledge 27 / search 9 / trash 4 / export 2）を全件走査し、上の述語を機械的に当てた。台帳は `spec/database/` と `spec/domains/`（ポート定義）から生成されているので、spec 側の追加は台帳の更新として現れる。**表を更新するときは台帳を再走査する。行数（29）とカテゴリ数（8）は走査の結果であって判定基準ではない**（AC-22 の主判定は走査そのもの）。

| # | カテゴリ | 箇所 | 台帳 ID / 出典 | 性質 |
|---|---|---|---|---|
| 1 | A. 引き方の経路に `user_id` を持たないスキーマ制約・索引 | `users_email_uq`（メールアドレスの一意性） | `ADP-users-001`、`migrations/0000_initial.sql:46` | userId 未確定の経路から引かれる |
| 2 | | `users_sso_identity_uq`（SSO provider + subject の部分ユニーク） | `ADP-users-001`、`migrations/0000_initial.sql:47` | 同上。**既に実装済み**なので「設計する」ではなく「移す」 |
| 3 | | `password_reset_tokens.token_hash` のグローバル UNIQUE | `ADP-password-reset-tokens-001`、`spec/database/index.md:77-100` | userId 未確定で検索する |
| 4 | | `ai_client_connections` の `findActiveById(id)` 経路（PK 素引き + `status = 'active'`。`user_id` 述語が無い） | `ADP-ai-client-connections-001`、`spec/database/index.md:134` | 行8 のポートに対応する**スキーマ側の行**。3周目 arch P-003 で追加。行1〜3 と同じ形（`user_id` を経路に持たない引き） |
| 5 | B. `userId` を第一引数に取らない解決ポート（読み） | `UserRepository.findByEmail(email)` | `ADP-identity-004`、`spec/domains/identity.md:358` | 全ユーザー横断の解決。Directory の中核 |
| 6 | | `UserRepository.findBySsoIdentity(provider, providerSubject)` | `ADP-identity-005`、`spec/domains/identity.md:361-364` | 同上 |
| 7 | | `PasswordResetTokenPort.verifyAndConsume(token, now): Promise<UserId \| null>` | `ADP-identity-015`、`spec/domains/identity.md:453` | **グローバルなトークン空間から user を解決する**。Issue 対応項目3「パスワードリセットで必要な認証情報の所有境界」に直結 |
| 8 | | `AiClientConnectionRepository.findActiveById(id)` | `ADP-identity-010`、`spec/domains/identity.md:399-407` | 認可ミドルウェア専用のグローバル引き |
| 9 | | `IndexerReadPort` 4本（`findMemoById` / `findDocumentById` / `listSourceLinksByMemo` / `listSourceLinksByDocument`） | `ADP-search-006〜009` | spec が「userId スコープなし（信頼済み内部 ID）」と明記。非同期 indexer 前提 |
| 10 | | `SearchIndexPort.query(query: SearchQuery)` | `ADP-search-001`、`spec/domains/search.md` | **3周目 arch P-003 で追加。** `userId` は引数オブジェクトの中にあり第一引数ではない — 行16 の `upsertMemo(entry)` / `upsertDocument(entry)` とまったく同じ形なので、述語 (a) の下で扱いを揃える（2周目までは片方だけが除外されていた） |
| 11 | C. `userId` を第一引数に取らない書き込みポート | `UserRepository.insert(user)` / `save(user, expectedVersion)` | `ADP-identity-001,002`、`spec/domains/identity.md:351-352` | 集約自身が userId を持つので引数に無い |
| 12 | | `AiClientConnectionRepository.insert(connection)` / `save(connection, expectedVersion)` | `ADP-identity-006,007`、`spec/domains/identity.md:382-383` | 同上 |
| 13 | | `AiClientConnectionRepository.recordUsage(id, lastUsedAt)` | `ADP-identity-011`、`spec/domains/identity.md:414` | AI API 全リクエストのホットパス。OCC なしのベストエフォート単独 UPDATE |
| 14 | | `MemoRepository.insert` / `insertRevision` / `save` / `hardDelete` | `ADP-memo-001〜004`、`spec/domains/memo.md:287-290` | 読み取り側だけが userId 第一引数。DO ルーティングの型レベル保証がここで切れる |
| 15 | | `TopicRepository.insert` / `save` / `delete`、`DocumentRepository.insert` / `save` / `delete` / `insertRevision` / `insertSourceLinks` | `ADP-knowledge-001,002,003,009,010,011,019,022`、`spec/domains/knowledge.md:409-412,456-459,494,507` | 同上 |
| 16 | | `SearchIndexPort.upsertMemo(entry)` / `upsertDocument(entry)` / `removeMemo(memoId)` / `removeDocument(documentId)` | `ADP-search-002〜005`、`spec/domains/search.md:161-164` | upsert 側も userId を取らず、`spec/usecases/search.md:117` が「`IndexEntry.userId` には読み直した対象自身の `userId` を採用する」とデータ側でしか境界を担保していない |
| 17 | D. 全ユーザー横断ジョブ | `TrashQueryPort.listExpiredItems(now, limit)` | `ADP-trash-004`、`spec/domains/trash.md:213-215`、`spec/usecases/trash.md:311-337`（`pruneExpiredTrashItems`） | `users` と JOIN して期限判定 |
| 18 | | 期限切れ列挙用の `user_id` なし部分インデックス3本 — `memos_expired_idx` / `topics_expired_idx` / `docs_expired_idx`（+ `users` PK との全ユーザー JOIN） | `ADP-memos-001` / `ADP-topics-001` / `ADP-documents-001`、`spec/database/index.md:168,237,277,395` | 17 の**スキーマレベルの実現手段**。ポート1本だけを見ていると落ちる |
| 19 | | `password_reset_tokens` の期限切れ行掃除（`prt_expires_idx` は `user_id` を含まない） | `ADP-password-reset-tokens-001`、`spec/database/index.md:92,100` | もう1つの横断 cron。**`spec/usecases/` にユースケース定義が無い未設計領域** |
| 20 | | Outbox relay / consumer / DLQ / pruner | `application/workers/`、`apps/web/app/worker/cloudflare/` | cron 単発の drain モデル |
| 21 | | 認証アダプターの**トークン失効 consumer**（`identity.aiClientRevoked` を購読） | `spec/domains/identity.md:330`、`spec/database/index.md:343,357` | indexer 以外にもう1つ outbox 購読者がいる。**書き込み先（セッション / OAuth トークンストア）が `spec/database/index.md:355-357` で「スコープ外」とされ、スキーマが存在しない** |
| 22 | E. `user_id` 列を持たない共有基盤テーブル | **3テーブル** — `outbox`（spec 表記。実装の実テーブル名は `outbox_events`。同一テーブルの表記ゆれ）/ `processed_events` / `_occ_guard` | `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-occ-guard-001`、`spec/database/index.md:335-341`、`migrations/0000_initial.sql` | 名前の乖離は残存課題5 のとおり。**項目数と `ADP-*` の本数を3で揃えた**（3周目 arch P-003） |
| 23 | | `search_fts`（`user_id` が UNINDEXED） | `ADP-search-fts-001`、`spec/database/index.md:349` | 物理的には全ユーザー混在の単一インデックス |
| 24 | | `search_embeddings`（PK は (type, entity_id) で `user_id` を含まない） | `ADP-search-embeddings-001`、`spec/database/index.md:350` | `.adr/003` で不採用になるので「不要になる」側の候補 |
| 25 | F. `user_id` 列を持たない従属テーブル（JOIN でスコープ） | `memo_revisions` / `document_revisions` / `source_links` | `ADP-memo-revisions-001` / `ADP-document-revisions-001` / `ADP-source-links-001`、`spec/database/index.md:200,305,319-320` | 「`user_id` 列を残すか落とすか」の材料 |
| 26 | G. `userId` を引数に取らない副作用・変換ポート | `MailSender.sendPasswordResetMail(to: Email, ...)` | `ADP-identity-016`、`spec/domains/identity.md:468` | Email をキーにした外部副作用。canonical credential の原本が可逆に必要。**userId 未確定の経路から始まるのでジョブの所有者が User Data DO ではない** |
| 27 | | `ArchiveWriter.write(archive: ExportArchive): Promise<ArchiveBinary>` | `ADP-export-002`、`spec/domains/export.md:269-278` | **3周目 arch P-003 で追加。** userId をどこにも取らず、行26 と構造的に同型。ただし**行き先は「外部 I/O」ではない** — `spec/domains/export.md:282` が「同期生成とする。ユースケースはリクエスト内で『読み出し → レンダリング → zip 化』を行い、レスポンスとしてバイナリを返す」と生成方式を確定させており、`ExportSourceReader.readAll` が「単一トランザクション（またはスナップショット読み）」（`:267`）を要求する以上、読み出しは User Data DO の中でしか成立せず、read → render → zip の連鎖ごと DO の中に入る。**最大 10 GB を持ちうる DO で zip エンコードを回す = 全数表で最大級の CPU ワークロード**であり、single-threaded な DO ではその間そのユーザーの全リクエストが止まる。行き先は「User Data DO に閉じる。ただし**実行位置と CPU 予算の判断対象**」として第8.3節 (a) の入力に接続する |
| 28 | H. DI 次元（ポート／テーブル単位の列挙では捕まらない） | **indexer 専用**の拡張 `WorkerContainer` | `spec/domains/search.md:264`、`spec/usecases/search.md:89-96`、`application/di/types.ts:70` | テンプレート既定の `WorkerContainer`（`outboxRepository` + `idempotencyStore`）では賄えず専用 DI を組む前提。FTS5 同期更新でこの構成が丸ごと不要になる |
| 29 | | **pruner 専用**の拡張 `WorkerContainer` | `spec/usecases/trash.md:315`、`application/di/types.ts:70` | **3周目 arch P-003 で追加。カテゴリ H は1行ではなく2行だった。** 原文は「依存（UnitOfWork・`TrashQueryPort`・memo / knowledge の各リポジトリ）はテンプレート既定の `WorkerContainer` では賄えないため、pruner 専用の拡張ワーカーコンテナを DI で組む」。indexer 側と同型なので AC-17 の #37 引き継ぎリストにも両方を挙げる |

**横断調査で否定された懸念**（DO 化を妨げる要素は無い、の裏取り）。

- 管理者用クエリ・統計・集計・ランキング・admin 画面は `spec/` 全体に存在しない。根拠はページ定義が P-01〜P-14 のユーザー向けのみで、管理者向け画面・統計の定義が無いこと（「集計」「全ユーザー」という語自体は `spec/manual-tests/trash.md:428` / `spec/domains/trash.md:213` / `spec/database/index.md:168` / `spec/domains/identity.md:43,108,111` にヒットするが、いずれも管理者機能ではなく上表 D の retention 横断ジョブ由来）。「1ユーザー = 1 DO」と矛盾する機能要件が無い
- export ドメインの**読み出し**は `ExportSourceReader.readAll(userId)` 1本でユーザー内に閉じ、`spec/domains/export.md:267` が「単一トランザクション（またはスナップショット読み）で読み出す」ことを要求している。DO ではむしろ自然に満たせる。**ただし同ドメインの `ArchiveWriter.write`（`ADP-export-002`）は userId を取らず、全数表の行27 として拾ってある** — 「export はユーザー内に閉じるので論点なし」で片付けられるのは読み出しだけで、生成方式（`:282` の同期生成）と CPU 予算は別途 8.3 で判断する
- `TrashRetentionDays` は `User` の属性（`spec/domains/identity.md:254-260`）、`RetentionPolicy` は期限を保存せず毎回算出する純関数（`spec/domains/trash.md:168-185`）。retention の入力がすべて同じ DO 内にある
- `spec/adr/001/002/003/006` は DO 移行と無関係。影響するのは 004（境界の切り方、変更不要）と 005（Outbox）だけ

### `.thread/1/progress.md` の残存課題の扱い

Issue の「参照」節が残存課題 4 / 5 を挙げているので、本計画での扱いを明示する。

- **残存課題4（未採用ランタイムの撤去）** — #36 で完了済み。本 Issue では扱わない
- **残存課題5（テンプレート残滓の名称: wrangler の D1 データベース名が `tanstack-start-template-d1` のまま / outbox の実テーブル名 `outbox_events` と spec 表記 `outbox` の乖離）** — 「CF ランタイムを本採用する際にリネームが必要」と記録されており、本 Issue がまさに CF 本採用を決める。ただし**本 Issue ではリネームを行わない**（コードもコンフィグも変更しないため）。D1 廃止で D1 データベース名の課題は対象消滅、outbox テーブル名の乖離は Outbox 廃止範囲（design.md 第7.3節）の決定に吸収される。design.md 第11.2節（#37 引き継ぎ）に「残存課題5 は D1 / Outbox 廃止に伴い対象消滅する。DO binding / namespace の命名として読み替える」の1行を残す

### 既存 D1 データのカットオーバー

**正本は design.md 第11.2節。** ここは判断の根拠を記録するに留め、結論は design.md 側に断定形で置く。

`infra/cloudflare/pulumi/resources/index.ts` の D1 リソースには「D1 is the system of record — refuse accidental destroy」というコメント付きの destroy 保護がかかっており、staging / production に実データがある前提の作りになっている。一方、実装済みドメインは `identity/User` だけで、本番稼働しているサービスは無い。

したがって design.md 第11.2節で**「既存 D1 データは移行しない。DO 側で作り直す」を結論として断定する**（空欄にしない）。明示しないと #37 が移行ツールを作りかねない。Pulumi の destroy 保護の解除手順が必要になることも同節に1行残す。

### 先行ブランチ `issue/19/cloudflare-do-fts` の存在と扱い

これは計画上もっとも重要な発見であり、扱いを誤ると受け入れ条件 AC-2 を機械的に破る。

分割元の Issue #19 のブランチには、**DO 実装一式と `.adr/` 8件が既に存在する**。

```
.adr/001-cloudflare-workers-and-user-data-durable-objects.md
.adr/002-sqlite-fts5-only-search.md
.adr/003-semantic-commit-and-alarm-jobs.md
.adr/004-sharded-identity-directory-and-sagas.md
.adr/005-declarative-durable-object-exports.md
.adr/006-value-only-worker-rpc.md
.adr/007-staging-pitr-verification.md
.adr/008-account-home-authentication-authority.md
apps/web/app/durable-objects/{UserData,IdentityDirectory,AccountHome}DurableObject.ts
apps/web/app/server.state.ts
packages/core/src/adapters/cloudflare/identity-directory/{schema.ts,store.ts}
packages/core/src/domain/identity/accountIdentity.ts
```

`git show issue/19/cloudflare-do-fts:.adr/00N-*.md` で全文が読める。#19 は「クローズ済み」として #34〜#38 に分割されたので、**このブランチは採用済みの決定ではなく、本 Issue が引き受けるか棄却するかを判断すべき先行案**である。

**一次資料は `.adr/` 8件だけではない。** 同じブランチに、要約である `.adr/` より情報量の多い資料が残っている。いずれも `git show issue/19/cloudflare-do-fts:<path>` で読める。再取得コストが高い（消えたら復元できない）ので、design.md の執筆前に一括で読む。

| 資料 | 内容 | design.md での効き先 |
|---|---|---|
| `.thread/19/adr.md`（ADR-001〜010） | `.adr/` 版は各30〜40行の要約だが、こちらは Alarm の budget（25件 / 10秒）、`nextRunAt` の clamp 規則、rotation の checkpoint、login の dummy verify、退会 tombstone の順序まで書き込まれている。`.adr/` に昇格したのは10件中8件で、ADR-007（#19 の command harness）と ADR-009（#19 のスコープ限定）は Issue 固有として残された | 第6〜9章の直接の下敷き。1.3 の差分表は `.adr/` 8件単位ではなく**この10件 + レビュー指摘単位**で作る |
| `.thread/19/spike/fts5.integration.test.ts` | workerd 上で FTS5 の trigram トークナイザ・短語・snippet（`<mark>`）・安定ページングが実際に動くことを日本語テキストで実測したテスト | **trigram の可用性は公式ドキュメントに記載が無い**ため、この実測が第2.1節 / 第7.1節の結論の唯一の根拠になる |
| `.thread/19/review/*`（#33 の6ラウンド分。最終コミットで削除済み、`git show da775f3^:.thread/19/review/...` で読める） | とくに最終ラウンドの B-IDDS6-001 が「Directory の page 走査だけでは旧世代 locator の 0 件を証明できない」（Directory 側に active row がない Account Home reverse locator が集計から漏れる / 同一ユーザーの複数 locator を重複加算する / checkpoint が加算更新で snapshot 置換していない）を記録している | 第6.8節（鍵ローテーション）で同じ設計をすれば確実に踏む落とし穴。「全 bucket を checkpoint scan する」だけでは足りないことが既に判明している |
| `.thread/19/plan.md` / `.thread/19/progress.md` | #19 当時の計画と進捗 | 背景の把握 |

**ただし成果物は先行ブランチ抜きで読めなければならない**（AC-19）。これらは design.md を書くための入力であって、design.md から「先行 ADR-004 を参照」で内容を代替してよいという意味ではない。

**「先行案との差分」の正本は design.md 第1.3節。** 以下は計画時点で判明している差分であり、design.md 側では `.thread/19/adr.md` の10件 + #33 のレビュー指摘単位まで細かくした上で、各行に採用内容の要旨を書く（AC-19）。

本 Issue の指示と先行ブランチの差分は次のとおりで、そのまま流用すると受け入れ条件を破る。

| 先行ブランチ | 本 Issue の指示 | 本計画の扱い |
|---|---|---|
| `.adr/` を `001` から採番（既存の統合テスト ADR と衝突） | `002` から採番 | 採番をずらす。先行 `001` → 新 `002`、先行 `002` → 新 `003`、先行 `003` → 新 `004` |
| `.adr/` に8件（004〜008 に分割方式・DO exports・RPC 契約・PITR・認証権威を含む） | `.adr/` は3件のみ。それ以外は `.thread/34/` | 先行 004〜008 の内容は **`.thread/34/design.md` に吸収**する。`.adr/` へ昇格させない |
| `spec/adr/005` の supersede を新 ADR の末尾1行で表明 | supersede の正本は新 `.adr/` 側 + `spec/adr/005` 側にもポインタ | 双方向にする（新 ADR の影響節に明記 + `spec/adr/005` のステータス行に追記） |
| `.thread/1/adr.md` ADR-004 への supersede ポインタが無い | 1行ポインタを追記 | 追記する |
| 実装コードが同一ブランチに同居 | 本 Issue は設計のみ | コードは持ち込まない |

先行ブランチの ADR は**設計の裏取り資料としては極めて価値が高い**（Account Home が必要な理由、Directory の分割方式、値のみを運ぶ RPC 契約、PITR の検証境界などが既に言語化されている）。design.md はこれを出発点にしつつ、本 Issue の指示（薄い `.adr/`・詳細は thread）に沿って再構成する。design.md には「先行案との差分」を1節設けて、採用／棄却／保留を明示する。

### あるべきアーキテクチャ

`CLAUDE.md` と `spec/` から読み取れる、本 Issue が守るべき制約。

- **依存方向は内向き固定**（presentation → application → domain、adapters は内側で定義されたポートを実装する）。ランタイム差し替えが触るのは **adapters と entry point だけ**で、`domain` / `application` / `presentation` は無傷であるべき、と `CLAUDE.md`「Reference runtime」が明言している。DO 移行がこの原則を守れるかは設計の主要な検証項目になる
- **Unit of Work** — 全トランザクショナルユースケースは `UnitOfWorkProvider.run(fn)` の中で走り、ctx がリポジトリとイベント登録の唯一の発行点。この契約自体は保つべき資産で、置き換わるのは D1 固有の実現手段（`PendingBatch` / `_occ_guard`）である
- **Outbox / ドメインイベント** — 現行は「トランザクショナルに永続化 → relay が out-of-band で配信、at-least-once・順序保証なし」。`.adr/004` はこの適用範囲を「外部 I/O を伴う処理だけ」に絞る決定になる
- **リトライ戦略** — D1 アダプターは独自リトライを持たず、OCC 不一致は `ConflictError("OPTIMISTIC_LOCK_FAILURE")` として呼び出し元まで届く。DO でもこの「握り潰さない」方針は維持対象
- **入力検証は2点のみ** — トランスポート境界（形状 / DoS）と値オブジェクト構築（業務不変条件）。DO ルーティングキーの導出は前者の直後に置かれるべきで、検証済みの値だけが locator の材料になる構造にする
- **エラーは構造的にシリアライズ** — `kind` タグ付きの `toSerialized()`。`instanceof` による列挙をしない。DO を跨ぐ RPC でもこの契約が壊れないことが要件になる
- **テナント分離は構造的保証**（`spec/domains/index.md:32`）— 「外部入力の ID を受けるメソッドは `userId` を第一引数に取る。ユースケース層の追加検証に依存しない構造的保証とする」。**この規約は「1ユーザー = 1 DO」と極めて相性が良く、第一引数の `userId` がそのまま DO 選択キーに昇格する**。ただし規約が明示する例外（Outbox 経由の信頼済み内部イベントを契機とするワーカー）は DO 化で前提が変わるため、design.md で読み替えを決着させる必要がある
- **`.adr/` の記録基準** — 寿命テスト（本 Issue を見ていない人にも意味を持つか）と波及テスト（覆すと複数モジュール・レイヤー・データに波及するか）の両方 Yes のときだけ

### 既存実装の状態

**一致している箇所**

- `spec/domains/index.md:32` のテナント分離規約が既に「userId 第一引数」を構造的保証として定めており、DO 境界と自然に一致する。実装済みの `UserRepository` も `findById(id)` / `findByEmail(email)` と、User 自身が境界であることを反映した形になっている
- `Email.create` の正規化（`trim().toLowerCase()`）が既にドメイン側にあり、routing key の canonical 値の出所として使える
- セッションが**ステートレス HMAC で DB を触らずに `userId` を確定する**ため、「リクエスト先頭で userId → DO を引く」ルーティングと構造的に噛み合う
- `.adr/001` が既に「永続化は今後さらに Cloudflare 側（Workers プール + DO SQLite）へ寄っていく」ことを前提に書かれており、`.adr/002` はその延長として矛盾なく置ける
- 実装済みドメインは `identity` のみで、memo / knowledge / search / trash / export は**コードが存在しない**。DO 前提で設計し直しても既存コードの書き換えコストは小さい。**ただしゼロではない** — `Actor` 判別共用体（`valueObject.ts:206-214`。memo / knowledge のリビジョンが全部これを持つ）と SSO 列・`users_sso_identity_uq` は実装済みで、DO 境界の再設計で書き換わる（前掲「未実装領域の内訳」）

**乖離している箇所（design.md で決着させる対象）**

| 乖離 | 現状 | DO 前提での問題 | 本 Issue での扱い |
|---|---|---|---|
| `UnitOfWorkProvider.run(fn)` が引数を取らない | `application/execution/unitOfWork.ts:19行` | DO 選択キー（`userId`）を渡す口が構造上無い。コンテナ構築（リクエスト先頭）が userId 確定（`requireUserId()`）より**先**に起きている | design.md 第8章で新 UoW 契約を決める。#37 で実装 |
| `PendingBatch` / `_occ_guard` / メッセージ部分一致の OCC 検出 | `adapters/d1/` 3ファイル | 存在理由が「D1 に interactive transaction が無い」ことだけ。DO の同期 SQLite API では丸ごと不要 | design.md 第8章で廃止対象として明記。`.adr/004` の影響節に1行 |
| UNIQUE 違反の翻訳点がユースケースに漏れている | `application/identity/registerWithPassword.ts:61-79`（`catch` ブロック。コメント `:62-74` / 判定 `:75-77`） | 遅延バッチで違反が `insert` フレーム外に出るための回避策。`.thread/1/adr.md` ADR-008 と `progress.md` の spec-sync 項目に記録済み | design.md の「UNIQUE 違反翻訳点の是正」の節で「同期 commit なら翻訳点をアダプターに戻せる」ことを明記し、#35 の spec-sync 解消候補として引き継ぐ |
| `spec/adr/005`（Outbox 経由の非同期インデックス更新） | 承認済み | FTS5 を本体と同一 SQLite に置けるなら、consumer 経由の維持そのものが不要 | `.adr/003` が supersede。`spec/adr/005` にポインタを付ける |
| `spec/requirements.md:87` の「キーワード検索とベクトル検索のハイブリッド」 | 要件として記載 | ベクトル検索を必須とする根拠が記録されていない | `.adr/003` で FTS5 のみと決定。`spec/requirements.md` の改訂は #35 |
| `spec/domains/search.md` の `SearchIndexPort` / `IndexerReadPort` / インデックス更新フロー（271行の大半） | 非同期 consumer 前提で詳細に設計済み | 同期更新になると `IndexerReadPort`（userId スコープなし）・ファンアウトの読み直し・冪等 upsert の前提が総崩れ | design.md 第7章で「同期更新後の search ドメイン契約はどうなるか」を骨子として決め、詳細改訂は #35 |
| `TrashQueryPort.listExpiredItems(now, limit)`（`spec/domains/trash.md:213-215`） | **全ユーザー横断**で `users` と JOIN して期限判定する前提 | ユーザー単位 DO では全ユーザー横断クエリが原理的に書けない | design.md 第7章の主要論点。各 DO の Alarm が自分の retention を処理する形へ置き換える |
| `AiClientConnectionRepository.findActiveById(id)`（`spec/domains/identity.md:399-407`） | userId を取らないグローバル引き。認可ミドルウェア専用 | ユーザー単位 DO では userId 無しに引けない | design.md 第5章で MCP / REST トークン経路の設計として決着させる |
| `password_reset_tokens.token_hash` のグローバル UNIQUE（`spec/database/index.md:77-100`） | userId 未確定の状態で検索する | User Data DO に置けない | design.md 第6章で Directory / Account Home 側の関心事として位置づける |
| `outbox_events` / `processed_events` / `_occ_guard` が `user_id` 列を持たない | 共通基盤テーブル | ユーザー単位 DO に分割すると relay の claim 対象が分散し、cron 単発の drain モデルが成立しない | design.md 第7章で Alarm ベースの永続ジョブへ置き換える |
| `eventRelayWorker.ts` のモジュールスコープ `crypto.randomUUID()` が `pnpm start` を壊している（#40） | 既知の不具合 | DO 移行で relay worker 自体が消えるなら #40 も自然消滅する | design.md の引き継ぎ表に「#37 完了時に #40 が解消される見込み」として記録 |
| `spec/database/index.md` 全体が「共有 SQLite + `user_id` 列による論理分離」前提 | 403行 | 物理分離では `user_id` 列の要否・インデックス設計・UNION 射影が変わる | design.md の #35 引き継ぎ表に改訂範囲を列挙 |

### 依存関係

- **本 Issue → #35（spec 改訂）** — design.md の「#35 への引き継ぎ」表が入力になる。ここが空だと #35 が着手できない（AC-16）
- **本 Issue → #37（実装）** — `.adr/002〜004` の決定 + design.md 第4〜9章が入力（AC-17）
- **#37 → #38（ドキュメント・運用）** — 本 Issue の直接の下流ではないが、PITR / export / delete / 容量の運用論点は design.md に「#38 で扱う」と明記して取りこぼしを防ぐ
- **#36 は完了済み** — Node / AWS / GCP ランタイムと libSQL アダプターは撤去済み。`.adr/001` がその副産物。本 Issue で撤去をやり直さない
- **#40（`pnpm start` / `pnpm preview` が起動しない）** — 原因が `eventRelayWorker.ts` のモジュールスコープ副作用なので、#37 で relay worker が消えれば解消する。design.md で言及するが、本 Issue では触らない

## 設計

本 Issue はコード変更を伴わないため、テンプレートの各レイヤー節は **「本 Issue で決めるべき設計内容の骨子」** として読み替える。すなわち「実装で何を書くか」ではなく「design.md のどの節で何を決着させるか」を書く。

### 読み替えの宣言

| テンプレートの節 | 本 Issue での読み替え |
|---|---|
| ドメインモデルへの影響 | DO 境界と既存ドメイン集約の対応。ユーザー境界に閉じないものの帰属先の決定 |
| ユースケース / アプリケーションロジック | UoW 契約の再定義、ユースケースの実行位置、非同期処理の境界 |
| アダプター / 永続化 / 外部連携 | DO ごとの SQLite スキーマ、FTS5、Alarm ジョブ、lazy migration、Worker RPC 契約 |
| UI / プレゼンテーション | 認証済み／未認証リクエストのルーティング、locator の非公開性、MCP / REST の経路 |

### ドメインモデルへの影響（決着させる論点）

`spec/adr/004-domain-boundaries.md` が定めたドメイン境界（identity / memo / knowledge / search / trash / export）は**変更しない**。変わるのは「その集約がどの物理境界に置かれるか」である。

決着させる論点は3つ。

1. **`User` 集約の分裂** — 現行の `User`（`PasswordUser | SsoUser`）は「認証情報の所有者」と「ユーザー単位設定（`trashRetentionDays`）の所有者」を兼ねている。前者は userId 未確定の経路から引かれるので User Data DO に置けず、後者は User Data DO に置くのが自然。この分裂を「1つの集約を2つの DO に分ける」と表現するのか、「認証権威（Account Home）とユーザーデータを別集約に切る」と表現するのかを決める。先行ブランチは後者を採り、`accountIdentity.ts` に `status` / `sessionEpoch` / `credentials[]` を持つ新集約を導入している。この採否を design.md で判断する
2. **ユーザー境界に閉じないものの帰属** — 調査結果「ユーザー境界に閉じない処理の全数」で **8カテゴリ・29行**を洗い出した（`spec/inventory/adapter.md` の `ADP-*` 台帳の全件走査による）。それぞれを「User Data DO に閉じる」「Directory / Account Home の関心事」「そもそも不要になる」のいずれかに割り当てる（AC-22）。とくに memo / knowledge の**書き込み系メソッドが userId を取らない**点は、`spec/domains/index.md:32` の「userId 第一引数」規約が読み取り側にしか効いていないことを意味し、DO ルーティングの型レベル保証がそこで切れる。論点3と対で決着させる
3. **リポジトリポートの契約変化** — `spec/domains/index.md:32` の「外部入力 ID を受けるメソッドは `userId` を第一引数に取る」規約が、DO 化で「`userId` が DO 選択に消費され、DO 内のリポジトリは userId を取らない」形に変わるのか、「型上は残す」のかを決める。同規約の**例外条項**（Outbox 経由の内部イベント）は同期更新化で消える可能性が高く、その場合「例外なし」に単純化できる。これは #35 が `spec/domains/index.md` をどう直すかを直接決める

### ユースケース / アプリケーションロジック（決着させる論点）

1. **ユースケースの実行位置** — `UnitOfWorkProvider` を DO の外（request Worker）から使うと、リポジトリ・UoW コールバック・SQLite transaction capability が Worker RPC 境界を越えられないため、アプリケーションのトランザクション境界と実際の DO トランザクションが一致しない。先行ブランチはこれを「usecase は状態を所有する DO 内で実行し、RPC は値だけを運ぶ」と決着させている。この採否と、採る場合の DI 分割（request 側 / state 側）を決める
2. **新しい UoW 契約** — `run(fn)` に何を渡すか（`userId`? DO stub? 何も渡さず DO 内なので自明?）、同期 commit をどう型で表現するか（`transactionSync` に Promise を持ち込ませない構造的保証）、OCC の `Version` / `ConflictError` を残すか（単一 DO の直列実行なら並行更新自体が起きにくいが、複数リクエストの読み書き間隔での競合は残る）
3. **同期 commit と既存ドメインポートの Promise 契約の整合** — `ctx.storage.transactionSync()` のコールバックは完全同期で Promise を返せない。一方 `packages/core/src/domain/common/transactionalRepository.ts` の `TransactionalRepository` と `packages/core/src/domain/identity/ports/userRepository.ts` の `UserRepository` は**全メソッドが `Promise` を返すドメイン層のポート**である。同期 commit に移ると (a) これらの署名を同期に変える、(b) 書き込みをポートから外して commit command 側へ寄せる、のどちらかになる（先行 `.thread/19/adr.md` ADR-003 / ADR-006 は (b) を採り、「usecase は async prepare で typed command を作り、`SemanticCommitPort` だけが `transactionSync` で書く」としている）。**ここは `CLAUDE.md`「Reference runtime」の「ランタイム swap で domain / application / presentation は無傷」という明言が実際に破れる箇所**なので、既存ドメインポート（`TransactionalRepository` / `Versioned` / `ExpectedVersion` / `UserRepository`）の去就まで決着させ、`CLAUDE.md` の当該記述の改訂を #35 へ引き継ぐ。加えて「SQL カーソルを `await` を跨いで保持するとスナップショット分離の保証がない」（公式）が、同期性を型で強制する構造的保証の直接の根拠になる
4. **presentation → application の呼び出し経路の変化** — 現行は `apps/web/app/server.cloudflare.ts:37-46` が `createRequestContainer` を作って AsyncLocalStorage に載せ、server component / server function が `getContainer()` 経由で usecase を直接呼ぶ。usecase を DO 内で実行すると request 側は RPC facade を呼ぶことになり、`RequestContainer` / `containerStore` / 全ルートのデータ取得経路に波及する。(a) usecase の実行位置、(b) request 側 DI に残るもの（`sessionCodec` / `clock` / config / DO stub factory）、(c) server component / server function から DO を呼ぶ経路と `getContainer()` の去就、(d) `SerializedError` を RPC 越しに維持する方法、の4点に分けて決着させる
4.1. **DO stub factory と `application/di/types.ts` の不変条件の緊張**（論点4(b)(c) の一部） — `application/di/types.ts:30-52` の JSDoc は「**リポジトリはコンテナに載せない。`UnitOfWorkContext` が唯一の発行点**」という不変条件を明文化している（これが全集約アクセスを UoW の中に閉じ込めている根拠）。DO stub は「その DO 内の全リポジトリへの入口」なので、コンテナに載せると実質的にリポジトリを載せたのと同じ到達性を与える。さらに `application/di/containerStore.ts:39-57` の `getContainer()` は `globalThis` の `Symbol.for` スロット（`:11-27` に定義されている install / read ヘルパ）+ ALS の二段構えで、**DO インスタンス内にはリクエストスコープの ALS が無いため `:49-55` で必ず throw する**（＝ DO 側は別の合成ルートが要る）。結論に「`types.ts` の不変条件を維持するのか、DO stub factory を例外として明記するのか」を1行加え、#37 が JSDoc と実装の食い違いに突き当たらないようにする
5. **非同期処理の境界** — 「DO ローカル SQLite + Alarm で完結できる処理」と「外部 I/O を伴うため永続ジョブに残す処理」の線引き。後者の具体例は現時点でメール送信（パスワードリセット）のみ
6. **ドメインイベントの位置づけ** — Outbox を transport として使わなくなった後、ドメインイベントを「業務・監査の表現」として残すのか、`collectEvents` ごと廃止するのかを決める。`spec/domains/*.md` のイベント定義が広範に存在するため #35 の改訂量に直結する

### アダプター / 永続化 / 外部連携（決着させる論点）

1. **FTS5 を本体と同一トランザクションで同期更新できるか** — Issue が最初に問うている項目。SQLite-backed DO は FTS5 を提供し、本体テーブルと FTS 仮想テーブルは同じ SQLite なので `transactionSync` 内で同時に確定できる。**できると結論した場合、`spec/adr/005` の Outbox 経由インデックス維持は不要になり、`.adr/003` がそれを supersede する**。トークナイザ（日本語 → trigram）・正規化（NFKC）・短語（1〜2文字）のフォールバック・インデックス容量の上限管理までを設計として書く。**判断の入力に「仮想テーブルへの書き込みも rows written に算入される」（公式）を含める** — trigram はインデックス行数が最も多い部類で、本体1行の書き込みが FTS 側の多数行書き込みを伴う。ユーザー単位 DO は 10 GB を1人で使う構成なので、増幅は容量（論点 2.1）と rows written 課金の両方に直接効く
1.1. **容量方針への反映** — 「本体 + FTS インデックスの合計で 10 GB」であることを容量の節に明記する。`.adr/003` の影響節にも「Vectorize / embedding の費用は消えるが、trigram インデックスの書き込み行数と容量が本体の数倍になるトレードオフを負う」の1行を置き、代替案比較が費用の面でも成立するようにする
2. **Alarm ジョブテーブル** — DO ごとに1本の Alarm しか持てない制約下で、複数種類のジョブ（retention 期限、外部 I/O）をどう多重化するか。ジョブ行が持つべき列（operation key / payload digest / attempt / `nextRunAt` / lease / owner token / provider idempotency key / poison reason）、claim と完了の CAS、期限切れ lease の reclaim、Alarm の bounded 処理（件数・時間）と再設定規則。**bounded 処理の予算は wall time ではなく CPU 予算（既定30秒 / 最大5分の active CPU）で書く**
2.1. **User Data DO 以外の Alarm 所有者** — 「1 DO につき Alarm は1本」はどの DO クラスにも効く。Directory bucket / Account Home 側にも少なくとも (a) 予約の期限切れ掃除、(b) saga 補償の再開駆動、(c) 鍵ローテーションの再写像バッチ、(d) `password_reset_tokens` 相当の期限切れ行掃除（`spec/database/index.md:92`。ユースケース定義が `spec/usecases/` に無い未設計領域）が要る。**同じジョブ機構を Directory / Account Home にも適用するか**を1行決める
2.2. **メール送信ジョブの所有者** — 外部 I/O は現時点でメール送信のみだが、パスワードリセットメールは **userId 未確定の経路から始まる**ので所有者は User Data DO ではありえない。未コミットの `apps/web/wrangler.state.production.toml:9-11` が `IDENTITY_MAIL_PROVIDER` サービスバインディングを state Worker 側に置いているのは、先行実装がこれを認識していた証拠。**どの DO がジョブを所有するか**を1行決める
3. **trash retention の置き換え** — 全ユーザー横断の `listExpiredItems` を各 User Data DO 内の Alarm に置き換える。retention 設定変更時に Alarm を張り直す規則、DO が長期間アクセスされない場合でも Alarm が起きる保証
4. **DO ごとのスキーマバージョンと lazy migration** — `schema_version` の持ち方、migration の起動タイミング（最初のアクセス時 / Alarm）、forward-only 方針の宣言、失敗時の再実行、「コードより新しい version の DB」に遭遇したときの fail-closed、ロールバック方針（= データのロールバックはしない、という宣言を含む）。DO class の lifecycle（Wrangler の宣言的 `exports`）と object 内 schema version を**別物として扱う**ことの明示。加えて**実行機構がプラットフォーム制約に当たるか**を突き合わせる — 「最初のアクセス時に migration」は実装上ほぼ確実に constructor + `blockConcurrencyWhile` になるが、これは30秒でタイムアウトし DO がリセットされる（公式）。10 GB まで育った DO のスキーマ変更を1回のコールバックで完了させられる保証はない。Alarm 経由にしても handler の wall time は15分。「1回の入力で完了しない migration をどう分割・再開するか（部分適用の記録、途中状態でのリクエスト受付可否）」を決着させるか、「本 Issue 時点のスキーマ規模では単発適用で足りる。何が起きたら分割が必要になるか」を前提付きで断定するかのどちらかにする
5. **Worker RPC 契約** — state Worker と request Worker を分けた場合の DTO 形状（`{ ok: true, value } | { ok: false, error: SerializedError }`）、`CLAUDE.md` の「構造的シリアライズ」契約を RPC 越しに壊さない方法、片側デプロイ時の互換ウィンドウ
6. **既存 D1 資産の廃止リスト** — `adapters/d1/` 全体、`application/workers/`、`di/serverCloudflare.ts` の Queue / D1 部分、`wrangler.toml` の `[env.relay|consumer|pruner|dlq]`、`infra/cloudflare/pulumi/resources/index.ts` の D1 / Queue リソース（destroy 保護の解除手順を含む）、`vitest.config.integration.ts` の `readD1Migrations` / `d1Databases` / `queueProducers` / `queueConsumers`
7. **DO プラットフォームエラーの翻訳表** — `CLAUDE.md`「adapter → application: アダプターが driver 固有エラーを共有エラー契約へ翻訳する」の適用先。少なくとも3件を既存の `CodedError` 系へ写す規則を決める。**`overloaded`**（1オブジェクト soft limit 1,000 req/s 超過。公式が**リトライ禁止**と明記しているので、`ConflictError("OPTIMISTIC_LOCK_FAILURE")` のようなリトライ可能系に写してはいけない）、**`SQLITE_FULL`**（10 GB 到達。書き込みだけ失敗し読みと DELETE は通るという半死状態）、**`ctx.abort()` によるリセット**。容量（第4.6節）と RPC 契約（第8.3節）にまたがるので、どちらかに明示的な項を置く

### UI / プレゼンテーション（決着させる論点）

1. **認証済みリクエストのルーティング** — `getCurrentUserId()` が返す `userId` から DO locator を導出する位置。現行はコンテナ構築（リクエスト先頭）が userId 確定より先なので、**この順序をどうするか**（遅延解決 / コンテナの2段構え / DO stub の遅延取得）を決める
2. **未認証リクエストの経路** — login / signup / password reset は userId 未確定で始まる。Directory → Account Home → User Data の順にどう解決していくか
3. **DO locator の非公開性** — 「他ユーザーの DO を指定できる入力面を公開しない」ことの構造的担保。URL・フォーム・API パラメータのいずれにも DO 名 / partition key を出さない、という設計上の保証をどう書くか
4. **MCP / REST の認可経路** — AI クライアントトークンから userId を得る方法。現行 spec は `findActiveById(id)`（userId なし）を前提にしているので、トークン自体に userId を埋めるか、Directory に token → userId の写像を持つかを決める
4.1. **セッション / OAuth トークンストアの所在** — `spec/database/index.md:355-357` は「認証インフラテーブル（Cookie セッションストア・OAuth 2.1 のアクセス／リフレッシュトークン・認可コード・PKCE 検証子）は認証・認可アダプターの責務でスコープ外」とだけ書き、**スキーマが存在しない**。ところが同 `:357` と `spec/domains/identity.md:330` は `identity.aiClientRevoked` イベントを「認証アダプターのトークン失効 consumer」が購読して**そのストアを書き換える**と定めている。つまり「本質的にグローバル（トークン → user 解決）で、かつスキーマ未定義」のストアが Outbox consumer の書き込み先として設計に組み込まれている（前掲の全数表 行21）。DO 化ではこれが最も厄介な部類で、User Data DO には置けず、Directory に置くなら credential 由来 locator の系統が1つ増える。決着させるのは (a) トークン → userId の解決を Directory に置くか、トークン自体に userId を埋める自己完結トークンにするか、(b) 失効の到達手段（Outbox 前提が第7.3節で消えるので決め直しが要る）、(c) セッションストアは現行の HMAC ステートレスのままでよいか（Account Home 採否と連動）、の3点。決めきれない部分は「未決事項」ではなく「#35 が `spec/database/index.md:355-357` のスコープ外宣言ごと見直す」として引き継ぎ表に送る
5. **canonical 正規化の定義** — HMAC 分割の入力が canonical 値である以上、正規化規則が未定義だと Directory が担保するはずのグローバル一意性が**静かに壊れる**（1バイト違う正規形が別 bucket に落ち、「重複アカウントが2つできる」という例外の出ない形で破れる）。現行の `Email.create`（`domain/identity/valueObject.ts:45-62`）は `trim().toLowerCase()` **だけ**で、NFKC も Unicode case folding も IDN / punycode 正規化もしない。決着させるのは (a) 正規化手順（NFKC → case folding → domain 部の punycode 化の可否）、(b) `Email.create` を canonical 化の唯一の出所にするか（するならドメイン層の変更が必要で、その旨を #35 / #37 へ引き継ぐ）、(c) SSO subject は provider 由来の opaque 値なので正規化しない（するとしても trim のみ）という provider 別の扱い、(d) 規則変更は鍵ローテーションと同格の移行作業（全 mapping の再写像）であることの明記、の4点
6. **locator 鍵の分離（`userId` 由来 / credential 由来）** — DO の名前が変われば別オブジェクトであり、データは付いてこない。両者を区別しないまま「世代付き secret で HMAC して locator を導出する」と書くと、鍵ローテーション（第6.8節）が**全ユーザーのデータ本体を移送する作業**になる。`userId` を HMAC する理由が無い根拠は「ドメインが UUIDv7 を保証しているから」**ではない** — `UserId.create`（`domain/identity/valueObject.ts:19-35`）は trim + 空文字チェックのみで、コメント（`:21-23`）が明言するとおり id フォーマットは `IdGenerator` の責務であり、ドメインは不透明な非空文字列としてしか扱わない。正しい根拠は (i) 値を採番するのは `IdGenerator` であって外部入力ではないこと、(ii) `idFromName(userId)` に渡す `userId` は署名済みセッション由来で、外部入力から来ることが構造的にありえないこと（論点3の保証）の2つである。この上で (a) `userId` → User Data / Account Home locator は鍵に依存させない（ローテーション対象外）、(b) canonical credential → Directory bucket は世代付き secret で HMAC（ローテーション対象）、の2系統に分けて決着させる
6.1. **HMAC 由来 routing key のハッシュ衝突**（論点6と表裏） — 鍵管理・ローテーション・ログ非露出は論点にあるが、衝突の扱いが無い。分割方式の案ごとに衝突の意味が違い、それぞれに結論が要る。**固定 bucket 分割**では衝突は設計上必然（多対1）で、bucket 内で canonical credential を突き合わせて初めて一意性が確定する — つまり論点7（canonical credential の原本を持つか）が「持たない」に倒れると**一意性そのものが壊れる**。**credential 1件 = DO 1個**（DO 名 = HMAC(canonical)）では、HMAC を切り詰めると衝突が「別人のアカウントに解決する」という認証境界の破れになる。決着させるのは (a) HMAC 出力を切り詰めるか否か（切り詰める場合は bucket index にのみ使い、識別には使わない）、(b) 「bucket index は衝突しうる / 識別は canonical 突き合わせで確定する」という2段構造の明記、の2点。あわせて論点7の動機リストに「bucket 内の識別子として必要」を3つ目として足す
7. **canonical credential（メール原本）の保持場所と保護方式** — HMAC は一方向なので locator からメールアドレスは復元できない。しかし (a) パスワードリセットメールの宛先（`spec/domains/identity.md:468` の `MailSender.sendPasswordResetMail(to: Email, ...)`）、(b) 鍵ローテーション時の再 HMAC、の2つで**原本が可逆に必要**になる。未コミットの `apps/web/wrangler.state.production.toml` に `IDENTITY_MAIL_ENCRYPTION_KEY` があるのは、先行実装がこれを暗号化保持していた証拠。決着させるのは保持場所（Directory bucket / Account Home / User Data のどれか。User Data に複製しない方針の可否）、暗号化鍵の所有者と配布境界（routing secret とは別鍵にするか）、復号が許される経路（ローテーションとメール送信ジョブに限る等）、退会時の消去範囲
8. **PII のログ非露出** — routing key の材料（正規化メール・SSO subject）と HMAC 値・locator を、ログ・エラーメッセージ・URL・トレースに出さない方針
9. **DO の location hint / jurisdiction** — `idFromName()` で作った DO の物理配置は最初のアクセス地点で決まり、後から移せない。ユーザーの全データが1オブジェクトに載る構成では、これがそのままそのユーザーの全リクエストのレイテンシになる。EU 居住性が要るなら `jurisdiction` を ID 生成時に指定する必要があり、これも後から変えられない。Issue はレイテンシもデータ居住性も要求していないので必須ではないが、**ID 導出方式と同時にしか決められず不可逆**なので、「今は既定のまま。将来変えるならオブジェクト再作成が必要」という1行の決着を置く

### `.thread/34/design.md` の構成案

これが本 Issue の中心成果物である。見出しレベルの目次と、各節で**決着させるべき論点**を以下に定める。「検討する」で終わる節を作らない — すべての節は結論の断定形で終える。

#### 節のラベル付け（スコープの逆方向チェック）

Issue の対応項目3・4 が求めているのは 12 項目程度だが、以下の構成案は11章・約50節ある。個々には #37 の着手に効くので削らないが、**全部を同じ重みで断定形にすると根拠の薄い断定が混ざる**。そこで各節の見出しに次の3ラベルのいずれかを付ける。**肥大の可視化が目的**なので、ラベルは執筆時に付け、レビュー時に「これは根拠が要る断定か」の判定に使う。

| ラベル | 意味 | AC-5 の対象 |
|---|---|---|
| **［Issue 要求］** | Issue 本文の対応項目・受け入れ条件に直接対応する | ○ |
| **［派生］** | Issue は要求していないが、#37 が着手するのに必要 | ○ |
| **［参考］** | どちらでもない。書いておくと役に立つが、断定を要求しない | ✗ |

以下の構成案では各節の見出し行末に `［Issue 要求］` / `［派生］` / `［参考］` を付記してある。**AC-5 の検証対象は前2つに限る。**

「決めない」ことを決めた節は2つで、いずれもラベルとは別に本文へ委譲先・任意である旨を明記する。**第7.2.1節**（検索 API の仕様 → #35 へ委譲）と**第5.2.3節**（鍵の所有者・世代管理 → Issue 未要求）。

#### 目次と各節の決着項目

```
1. この文書の位置づけ
   1.1 読者と入力・出力（#35 / #37 が何をここから読むか）［派生］
   1.2 .adr/002〜004 との分担（決定は .adr、詳細はここ）［Issue 要求］
   1.3 先行案（issue/19/cloudflare-do-fts）との差分 — 採用 / 棄却 / 保留の一覧［派生］

2. 前提と制約
   2.1 Cloudflare SQLite-backed DO のプラットフォーム制約［派生］
       → 決着: 調査結果「Cloudflare プラットフォームの確定事実」の18項目を、設計が依拠する
         事実として確定させる（出典 URL 付き）。とくに 10 GB 上限 / 単一 Alarm /
         CPU 既定30秒・最大5分（wall time とは別枠）/ transactionSync の完全同期 /
         sql.exec が BEGIN TRANSACTION・SAVEPOINT を実行できないこと /
         カーソルの await 跨ぎ / FTS5 可用性 / 仮想テーブル書き込みの rows written 算入 /
         LIKE 50 バイト / 1,000 req/s と overloaded リトライ禁止 / PITR /
         宣言的 exports / waitUntil 無効 / blockConcurrencyWhile 30 秒 /
         DO namespace を実行時に列挙できないこと。
         **次の3点は plan.md の表を 3周目で訂正した箇所なので、転記時に取り違えない。**
         (i) **ctx.id.name は公式 API として実在する**（「idFromName に渡した名前は
             復元できない」は誤りだった）。公式が明記する制約4つも落とさない —
             newUniqueId() 由来は undefined / idFromString() 経由の stub も undefined /
             1,024 バイト超の名前は ctx.id に渡らない / 2026-03-15 より前に作られた
             Alarm には名前が保存されていない。**列挙できないのは namespace であって
             自分の名前ではない**（6.2 (c) と 6.8 の結論はこの「列挙不可」の側に依るので
             変わらない。一方 6.3 / 6.8 / 7.4 の「DO に routing key を明示的に渡す」
             配線は不要になりうる）
         (ii) **CPU 予算の「リセット」意味論** — 30秒は固定の総量ではなく
             「着信 HTTP リクエスト / WebSocket メッセージごとに戻る枠」であり、
             着信の無い Alarm 駆動では戻す契機が無い。超過の帰結はエラーではなく
             **エビクションとリセット**（9.2 / 7.4 の失敗モードが変わる）
         (iii) **FTS5 で公式に明記されているのは モジュール本体と fts5vocab だけ。**
             bm25 / snippet / highlight / トークナイザ（trigram）は公式ドキュメント
             未記載なので「公式にサポート明記」と書かない。「仮想テーブルは原則禁止だが
             FTS5 のみ例外」は出典が無いので書かない
         公式に記載が無い事項（transactionSync のネスト可否 / FTS5 トークナイザ /
         bm25・snippet・highlight / 結果セット合計サイズ / Free の1オブジェクト上限）は
         「実測で確認した」または「未確定」と明示して区別する。
         **正本はこの節**（plan.md の同名の表は執筆前のスナップショット）
   2.2 fog のデータ特性［派生］
       → 決着: 「共有・共同編集・テナント横断検索なし」を設計前提として固定する。
         根拠は「ページ定義が P-01〜P-14 のユーザー向けのみで、管理者向け画面・統計の
         定義が spec に無い」こと
   2.3 現行実装の到達点［派生］
       → 決着: 実装済みは identity のみ、という事実を #37 の作業量見積りの基礎にする。
         ただし「書き換えコストはゼロ」ではない — Actor 判別共用体・SsoUser・
         sso_provider 系の列と users_sso_identity_uq は実装済みで、DO 境界の
         再設計で書き換わる（plan.md「未実装領域の内訳」）

3. DO トポロジー
   3.1 クラス構成と責務分界［Issue 要求］
       → 決着: User Data / Identity Directory / Account Home の3クラス構成を採るか、
         Account Home を Directory に畳んだ2クラスにするか。畳まない場合の理由
         （Directory mapping だけでは signup 部分失敗・退会中・古い PITR mapping・
         credential 変更後の session を区別できない）を明記する。
         **この節は「未決事項」に落とさない**（AC-21）。DO クラス数・saga の phase 数・
         session 検証が per-request RPC になるか・PITR の restore 対象境界のすべてが
         ここに依存するため、未決のままでは #37 が1行も書けない。
         Account Home を採る場合は、session が「発行時 sessionEpoch を署名し、
         protected execution point ごとに Account Home と照合」になり、
         .thread/1/adr.md ADR-002 の「DB を触らずに検証する / サーバー側失効の手段が無い」
         というトレードオフが実質的に覆ることを 5.1 に明記する。
         **Account Home を採る場合、「.thread/1/adr.md ADR-002 を supersede する別 ADR を
         起こす必要があるか」の判断も本節の結論が出た時点でここで下し、結果を 5.1 に書く**
         （#37 へ投げない。.thread/34/adr.md ADR-004 参照）
   3.2 Worker 分割（request Worker / state Worker）［派生］
       → 決着: 分けるか単一にするか。分ける場合の理由（request-only secret と
         state class の配布境界）とデプロイ順序（state 先 / request 後）。
         **結論と対で「DO 設定を apps/web/scripts/render-wrangler.ts の .tpl
         レンダリング経路に乗せるか、手書き実ファイルにするか」を1行決め切る** —
         .gitignore:14-17 が wrangler.{staging,production}.toml を生成物として
         ignore しているので、先行ブランチの手書き4本をそのまま持ち込むと
         ignore 対象でないファイルが commit され二重管理になる（実作業は #37）
   3.3 binding 構成の概念図［参考］
       → 決着: 何が何を参照するか。実 toml は #37

4. User Data DO
   4.1 保持データ範囲 — Issue 列挙7項目の対応表［Issue 要求］
       → 決着: 7項目すべてが同一 SQLite に載ることの確認と、テーブル群の列挙（AC-11）
   4.2 ドメイン集約との対応表［Issue 要求］
       → 決着: Memo / MemoRevision / Topic / Document / DocumentRevision / SourceLink /
         AiClientConnection / ユーザー単位設定 / trash 状態 / FTS5 / job の帰属
   4.3 ユーザー境界に閉じないものの帰属（全数）［Issue 要求］
       → 決着: 調査結果「ユーザー境界に閉じない処理の全数（8カテゴリ・29行）」の
         各行に「User Data DO に閉じる / Directory・Account Home の関心事 /
         そもそも不要になる」を割り当てる（AC-22）。**節の冒頭に述語の定義
         （(a) userId を第一引数に取らないポート＝引数オブジェクト内の userId も該当 /
         (b) user_id 列が無い、または引き方の経路に user_id が入っていないテーブル /
         (c) 台帳の粒度で捕まらない次元）を置いてから表を出す** — 述語が緩いと
         「全数」が全数でなくなる（3周連続で漏れが出た原因）。**執筆前に
         spec/inventory/adapter.md の ADP-* 台帳を再走査し、表に無いものが
         出たら足す**（表は台帳走査の結果であって手作りの列挙ではない）。
         行27（ArchiveWriter.write）の行き先は「User Data DO に閉じるが、
         実行位置と CPU 予算の判断対象」として 8.3 (a) へ接続する。
         **正本はこの節**（plan.md の同名の表は執筆前のスナップショット）
   4.4 スキーマ方針［派生］
       → 決着: user_id 列を残すか落とすか。残す場合の理由（export / 移送 / 検証）。
         source_links / memo_revisions / document_revisions が user_id 列を持たず
         JOIN でスコープする現行設計をどう読み替えるか。
         1テーブル100列 / 行 2MB / bind パラメータ100 の制約に抵触しないこと
   4.5 リポジトリ契約の変化［派生］
       → 決着: spec/domains/index.md:32 の「userId 第一引数」規約を DO 化後どう読むか。
         例外条項（Outbox 経由の内部イベント）が消えるかどうか。
         memo / knowledge の書き込み系が userId を取らない（規約が読み取り側にしか
         効いていない）ことの是正方針
   4.6 容量とライフサイクル［派生］
       → 決着: DO あたり 10 GB の上限に対する監視・逼迫時の方針。
         **上限は「本体 + FTS インデックスの合計」で見る** — 仮想テーブルへの書き込みも
         rows written に算入され（公式）、trigram はインデックス行数が最も多い部類なので
         本体の数倍に増幅する。深掘りは #38
   4.7 DO プラットフォームエラーの翻訳表［参考］
       → 決着: overloaded（リトライ禁止。リトライ可能系の ConflictError に写さない）/
         SQLITE_FULL（書き込みだけ失敗し読みと DELETE は通る半死状態）/
         ctx.abort() によるリセット を、既存の共有エラー契約（CodedError 系）の
         どの kind に写すか。CLAUDE.md「adapter → application はアダプターが
         driver エラーを翻訳する」の適用先。8.3 の RPC 契約と対で読めるようにする。
         **CPU 予算超過は「エラー」ではなくエビクションとリセットで現れる**（2.1）ため、
         翻訳表に写す先が無い — この失敗モードは翻訳の対象外であることを1行明記し、
         代わりに 7.4 の「DO 内で回す大きな CPU 仕事の扱い」で予防する
   4.8 DO 内で回す大きな CPU 仕事の扱い［派生］
       → 決着: 分割 / 上限 / 拒否のどれを採るか。対象は少なくとも
         (i) export の zip エンコード（4.3 の行27 ArchiveWriter.write。
             spec/domains/export.md:282 が同期生成と確定させており、
             読み出しが単一トランザクションを要求する以上 read → render → zip の
             連鎖ごと DO の中に入る。最大 10 GB を持ちうる DO で回すことになる）、
         (ii) FTS5 の全件再インデックス（9.2）、(iii) bulk migration（9.2）。
         **DO は single-threaded なので、この間そのユーザーの全リクエストが止まる。**
         判定基準は wall time ではなく CPU 予算で書き、Alarm 駆動では
         「着信ごとにリセット」が効かないこと（2.1）も入力に含める

5. ルーティング
   5.1 認証済みリクエスト（UI / REST / MCP）［Issue 要求］
       → 決着: session / token → userId → locator の経路。コンテナ構築と userId 確定の
         順序問題（現行は構築が先）をどう解くか
   5.2 DO ID / routing key と PII［Issue 要求］
       → 決着: 生メール・SSO subject を DO ID / routing key に使わない。正規化値の
         HMAC-SHA-256 を使う。canonical 値・HMAC 値・locator を公開入力・URL・ログ・
         エラーへ出さない規則（AC-14。Issue が求める3点はここで閉じる）。
         **非露出の範囲に「運用面」を含める1行を足す** — DO 名は ctx.id.name で
         DO の内側から可読であり（2.1）、さらに 2026-06-12 の changelog 以降
         ダッシュボードのメトリクスを「by an individual Durable Object's ID or name」で
         絞り込めるようになった。つまり生クレデンシャルを DO 名に使うと、
         ルーティング経路の外側（運用画面）にも露出する。これは HMAC を使う理由を
         1つ増やす（PII 方針の根拠が強まる）
   5.2.1 canonical 化の定義［派生］
       → 決着: (a) 正規化手順（NFKC → case folding → domain 部の punycode 化の可否）、
         (b) Email.create（現状は trim().toLowerCase() のみ）を canonical 化の唯一の
         出所にするか、(c) SSO subject は provider 由来の opaque 値として正規化しない
         （するとしても trim のみ）、(d) 規則変更は鍵ローテーションと同格の移行作業である
         ことの明記。未定義のままだと HMAC 分割下で一意性が静かに壊れる（AC-23）
   5.2.2 locator 鍵の分離［派生］
       → 決着: (a) userId → User Data / Account Home locator は鍵に依存させない
         （ローテーション対象外）、(b) canonical credential → Directory bucket は
         世代付き secret で HMAC（ローテーション対象）。鍵ローテーションが
         データ本体（User Data DO の同一性）に波及しないことを構造として示す（AC-23）。
         **(a) の論拠は「UserId が UUIDv7 だから」ではない** — UserId.create
         （valueObject.ts:19-35）は trim + 空文字チェックのみで、コメント :21-23 が
         「id フォーマットは IdGenerator の責務、ドメインは不透明文字列として扱う」と
         明言しており、ドメインは UUIDv7 を保証していない。正しい論拠は
         (i) 値を採番するのは IdGenerator であって外部入力ではない、
         (ii) idFromName(userId) に渡す userId は署名済みセッション由来で
         外部入力から来ることが構造的にありえない（5.5 の保証）、の2つ
   5.2.3 鍵の所有者と世代管理［参考］
       → 決着: 3.2 の Worker 分割の結論と整合する範囲で書く。単一 Worker に決着した
         場合は「所有者を request Worker に限る」は成立しないので、その旨を書く。
         Issue の必須要件ではない
   5.2.4 location hint / jurisdiction［参考］
       → 決着: idFromName() で作った DO の物理配置は最初のアクセス地点で決まり不可逆。
         jurisdiction も ID 生成時にしか指定できない。「今は既定のまま。将来変えるなら
         オブジェクト再作成が必要」を1行で決め切る
   5.2.5 ハッシュ衝突の扱い［派生］
       → 決着: (a) HMAC 出力を切り詰めるか否か。切り詰める場合は bucket index に
         のみ使い、識別には使わない（credential 1件 = DO 1個 の案で切り詰めると、
         衝突が「別人のアカウントに解決する」という認証境界の破れになる）。
         (b) 「bucket index は衝突しうる / 一意性は bucket 内で canonical credential を
         突き合わせて初めて確定する」という2段構造の明記。固定 bucket 分割では
         衝突は設計上必然（多対1）なので、6.2.1 で原本を持たない結論に倒すと
         一意性そのものが壊れる — 6.2.1 の動機リストに「bucket 内の識別子として
         必要」を3つ目として足すこと（AC-23）
   5.3 未認証リクエスト（login / signup / password reset）［Issue 要求］
       → 決着: userId が確定するまでの解決順序
   5.4 MCP / REST（AI クライアント）の認可経路［Issue 要求］
       → 決着: findActiveById(id) のグローバル引きをどう置き換えるか
   5.4.1 セッション / AI クライアントトークンストアの所在［派生］
       → 決着: spec/database/index.md:355-357 は認証インフラテーブル（Cookie セッション
         ストア・OAuth 2.1 のアクセス／リフレッシュトークン・認可コード・PKCE 検証子）を
         「スコープ外」とだけ書き、スキーマが存在しない。ところが同 :357 と
         spec/domains/identity.md:330 は identity.aiClientRevoked を
         「認証アダプターのトークン失効 consumer」が購読して**そのストアを書き換える**と
         定めている（4.3 の全数表 行21）。決着させるのは
         (a) トークン → userId の解決を Directory に置くか、トークン自体に userId を
             埋める自己完結トークンにするか
         (b) 失効の到達手段（Outbox 前提が 7.3 で消えるので決め直しが要る）
         (c) セッションストアは現行の HMAC ステートレスのままでよいか（3.1 と連動）
         決めきれない部分は 11.4「未決事項」ではなく 11.1 へ送り、
         「#35 が spec/database/index.md:355-357 のスコープ外宣言ごと見直す」と明記する
   5.5 他ユーザーの DO を指定させない構造的保証［Issue 要求］
       → 決着: 外部入力が locator に到達し得ないことの根拠（AC-12）

6. Identity Directory DO
   6.1 解決責務（4項目を個別に結論づける）［Issue 要求］
       → 決着: (a) 正規化メール → userId、(b) SSO provider+subject → userId、
         (c) メール・SSO 主体の一意性、(d) パスワード認証・パスワードリセットで必要な
         認証情報の所有境界。3.1 で Account Home を採る場合、(d) の権威が Account Home へ
         移る可能性があるので、移す場合は委譲先の節タイトルをここに明記する（AC-13）。
         **(a)(b)(c) は「これから設計する」ではなく「既存実装をどう移すか」である** —
         users_email_uq / users_sso_identity_uq（migrations/0000_initial.sql:46-47）と
         UserRepository.findByEmail / findBySsoIdentity は実装済み
   6.2 分割方式［Issue 要求］
       → 決着: 次の3案を比較して決める（構成案の段階では結論を先取りしない）。
         **この節は AC-5 の断定形要求の射程に入る**（ラベルが［Issue 要求］であり、
         #37 の前提になる）。「(b) が有力だが最終決定は #37」で終えない。
         (a) 単一グローバル DO — 1オブジェクト 1,000 req/s の soft limit と
             overloaded（リトライ禁止）に直撃するので無条件採用しない
         (b) 固定 bucket 数のハッシュ分割 — bucket 数を後から変えられない。
             世代 + 再写像で対処する
         (c) credential 1件 = DO 1個（DO 名 = HMAC(canonical)）— (b) 最大の難点である
             「bucket 数を後から変えられない」が原理的に消え、一意性も
             「その credential の DO が唯一の権威」で自明になる
         **判断軸は次の4つで、3案すべてに当てる。**
         (i) 列挙可能性（ローテーションと retirement 証明。6.8 と同じ根）
         (ii) bucket 数の不変性
         (iii) 衝突の意味（5.2.5）
         (iv) **未認証経路からの DO 生成** — login / signup / password reset は
              userId 未確定の**未認証入力**から始まる（5.3）。(c) を採ると、
              未認証の任意文字列を HMAC して新しい DO 名を引く構造になり、
              総当たりが毎回コールドな DO インスタンス化を誘発する。
              固定 bucket 分割は bucket 数が天井になるのでこの性質を持たない。
              (c) を採るなら未認証経路での生成をどう抑えるかを同時に決める
         (b) を選ぶなら、(c) の不採用理由を (i) と (iv) の両方で書く
         （(i) 単独に寄りかからせない — 支えは複数あるほうが強い）。
         逆に (c) を選ぶなら 6.8 の列挙をどう成立させるかを同時に決める。
         **(i) が成り立つ土台は「DO namespace を実行時に列挙する手段が無い」という
         プラットフォーム事実**（2.1）であり、6.8 の「旧世代 locator が0件であることの
         証明」と同じ根に立つ。**この事実は 3周目の ctx.id.name の訂正では動かない**
         — 訂正されたのは「DO の内側から自分の名前を読めるか」であって
         「外から namespace を列挙できるか」ではない（AC-13）
   6.2.1 canonical credential の保持と保護［派生］
       → 決着: HMAC は一方向なので locator から原本を復元できないが、原本が可逆に
         必要になる動機が**3つ**ある — (i) パスワードリセットメールの宛先
         （MailSender.sendPasswordResetMail(to: Email)）、(ii) 鍵ローテーション時の
         再 HMAC、(iii) **固定 bucket 分割を採る場合、bucket 内で credential を
         識別して一意性を確定させるため**（5.2.5）。
         (a) 保持場所（Directory bucket / Account Home / User Data のどれか。
         User Data に複製しない方針の可否）、(b) 暗号化鍵の所有者と配布境界
         （routing secret とは別鍵にするか）、(c) 復号が許される経路
         （ローテーションとメール送信ジョブに限る等）、(d) 退会時の消去範囲（AC-23）
   6.3 アカウント作成 saga［Issue 要求］
       → 決着: Directory 予約 → User Data 初期化 → mapping 有効化 → Account Home 有効化の
         phase 遷移と、各 phase の再開可能性。
         **ctx.id.name が使えることを前提に配線を組み直す**（2.1 の訂正） — 先行案
         （.thread/19）は「DO に自分の routing key を明示的に渡す」形になっているが、
         DO は ctx.id.name で自分の名前を読めるので、少なくとも
         「呼び出し側が名前を渡さないと DO が自分を識別できない」という制約は無い。
         とくに Alarm ハンドラには渡す相手のクライアントが居ないため公式が用例に
         挙げている経路そのものである。ただし newUniqueId 由来 / idFromString 経由 /
         1,024 バイト超 / 2026-03-15 より前の Alarm では読めない（2.1）ので、
         **明示的に渡すのをやめるか冗長に持つかを1行決める**（6.8 / 7.4 も同じ判断に従う）
   6.4 部分失敗と補償［Issue 要求］
       → 決着: 各 phase の失敗時に何が残り、誰がいつ片付けるか（AC-13）。
         「誰がいつ」の実行機構は 7.4 の Alarm ジョブ（Directory 側にも適用するか）と対
   6.5 リトライ時の冪等性［Issue 要求］
       → 決着: operation key の設計、同時競合の勝者決定規則
         （active mapping 優先 / 最小 operation ID）、敗者の冪等補償（AC-13）
   6.6 SSO リンク / 解除の整合性［Issue 要求］
       → 決着: link / unlink の順序、最後のクレデンシャル解除の禁止、
         epoch の前進タイミング、解除途中の失敗で「解除済みだが mapping が残る」状態を
         作らない方法（AC-13）。**既存の SsoUser（entity.ts:29-34）と
         users_sso_identity_uq をどう読み替えるかを明示する** — 現行は
         User = PasswordUser | SsoUser の判別共用体で「1ユーザー1認証方式」であり、
         link / unlink（複数クレデンシャル）はこの形のままでは表現できない
   6.7 退会［派生］
       → 決着: tombstone 先行 → User Data 削除確認 → mapping 削除、の順序と理由。
         **PITR の復旧単位が DO 1個である**（10.1）ことに耐える設計であること
   6.8 鍵ローテーション［派生］
       → 決着: 世代付き secret、旧鍵の破棄条件、そして「旧世代 locator が 0 件である」
         ことをどう証明するか。**全 bucket の checkpoint scan だけでは足りない**ことが
         先行レビュー（#33 最終ラウンド B-IDDS6-001）で判明している —
         Directory 側に active row がない Account Home reverse locator が集計から漏れる /
         同一ユーザーの複数 locator を重複加算する / checkpoint が加算更新で
         snapshot 置換になっていない、の3つを踏む。権威ある locator inventory を
         別途持つかどうかを 6.2 の分割方式と対で決める。
         ローテーション対象が credential 由来 locator に限られること（5.2.2）を再掲する
   6.9 DO 間分散トランザクションを前提としない宣言［Issue 要求］
       → 決着: 宣言と、代替（再開可能 saga + 冪等な補償）の対応（AC-15）

7. 非同期処理
   7.1 FTS5 の同期更新［Issue 要求］
       → 決着: 本体更新と同一 transaction で FTS5 を更新できる／できない、の結論。
         できる場合、Outbox consumer 経由のインデックス維持が不要になることの明記（AC-5）。
         **判断の入力に「仮想テーブルへの書き込みも rows written に算入される」（公式）と
         trigram の増幅を含める** — 同期更新は書き込み1回あたりのコストを本体の数倍にする
   7.2 FTS5 のみで日本語全文検索が成立する根拠（.adr/003 を支える範囲）［派生］
       → 決着: 正規化（NFKC）、トークナイザ（trigram）、短語フォールバック
         （LIKE / GLOB パターンの 50 バイト上限が制約になる）。
         trigram の可用性は公式ドキュメントに記載が無いため、
         .thread/19/spike/fts5.integration.test.ts の実測を根拠として引く
         （実測結果の要旨を本文に書く。ファイル名の参照で代替しない — AC-19）
   7.2.1 検索 API の仕様 → #35 へ委譲［参考］
       → **本 Issue では決めない。** topic filter / trash 除外 / 安定順位 / snippet /
         ページングは spec/domains/search.md の改訂（#35）と実装（#37）の領分。
         先行実装が既に決めている内容があれば「#35 への入力」として 11.1 に送る。
         この節は AC-5（断定形で終える）の対象外
   7.3 Outbox / relay / consumer / DLQ の廃止範囲［Issue 要求］
       → 決着: 何を消し、何を残すか。ドメインイベントを業務・監査の表現として残すか。
         **消える購読者は indexer だけではない** — 認証アダプターのトークン失効 consumer
         （identity.aiClientRevoked）の到達手段も決め直す必要がある（5.4.1）
   7.4 Alarm ジョブ［Issue 要求］
       → 決着: ジョブテーブルの列、claim / 完了の CAS、lease reclaim、backoff、
         poison、bounded 処理、Alarm 再設定規則（AC-5）。
         **bounded 処理の「1回で完了するか」の判定基準は wall time（15分）ではなく
         CPU 予算（既定30秒 / 設定で最大5分の active CPU）で書く。**
         **さらに「リセット」の意味論を入力に含める**（2.1） — 30秒は着信 HTTP
         リクエスト / WebSocket メッセージごとに戻る枠であり、**着信の無い
         Alarm 駆動では戻す契機が無い。** しかも超過の帰結はエラーではなく
         エビクションとリセットなので、bounded 処理は「失敗して再試行される」
         のではなく「途中まで進んで黙って落ちる」形になる。したがって
         **1回の Alarm で処理する量は、進捗をコミットしてから次の Alarm を張る
         単位（チェックポイント）で切る**ことを結論に含める。
         wall time 15分の出典は alarms ページではなく limits ページの
         "Wall time limits by invocation type" 表である（2.1）。
         加えて **同じジョブ機構を Identity Directory / Account Home にも適用するか**を
         1行決める — 「1 DO につき Alarm は1本」はどのクラスにも効き、Directory 側にも
         (a) 予約の期限切れ掃除、(b) saga 補償の再開駆動（6.4）、
         (c) 鍵ローテーションの再写像バッチ（6.8）、
         (d) password_reset_tokens 相当の期限切れ行掃除（spec/database/index.md:92。
             ユースケース定義が spec/usecases/ に無い未設計領域）が要る
   7.5 trash retention の期限処理［Issue 要求］
       → 決着: 全ユーザー横断の listExpiredItems を各 DO の Alarm に置き換える方式。
         retention 変更時の Alarm 張り直し（AC-5）。置き換え対象には
         listExpiredItems 1本だけでなく、その実現手段である user_id なし部分インデックス
         3本（memos/topics/docs_expired_idx）と users との全ユーザー JOIN も含む
   7.6 外部 I/O を永続ジョブに残す境界［Issue 要求］
       → 決着: 残すのは何か（現時点ではメール送信のみ）。provider 冪等キーの扱い（AC-5）。
         **メール送信ジョブをどの DO が所有するかを1行決める** — パスワードリセットメールは
         userId 未確定の経路から始まるので所有者は User Data DO ではありえない
         （未コミットの wrangler.state.production.toml:9-11 が IDENTITY_MAIL_PROVIDER を
         state Worker 側に置いているのは、先行実装がこれを認識していた証拠）

8. UoW 契約
   8.1 現行契約と D1 固有物の棚卸し［派生］
       → 決着: PendingBatch / _occ_guard / メッセージ部分一致 OCC 検出 / 遅延バッチの廃止
   8.2 新しい UoW 契約［Issue 要求］
       → 決着: run() のシグネチャ、同期 commit の型表現、
         transaction コールバックに Promise / 暗号 / RPC / メールを持ち込ませない構造（AC-5）。
         根拠として「SQL カーソルを await を跨いで保持するとスナップショット分離の
         保証がない」（公式）を引く
   8.2.1 既存ドメインポートの Promise 契約との整合［派生］
       → 決着: transactionSync のコールバックは完全同期で Promise を返せない。一方
         domain/common/transactionalRepository.ts の TransactionalRepository と
         domain/identity/ports/userRepository.ts の UserRepository は全メソッドが
         Promise を返す**ドメイン層**のポートである。(a) 署名を同期に変える、
         (b) 書き込みをポートから外して commit command 側へ寄せる、のどちらを採るか。
         Versioned / ExpectedVersion の去就も同時に決める。
         **ここは CLAUDE.md「ランタイム swap で domain / application / presentation は
         無傷」という明言が実際に破れる箇所**なので、CLAUDE.md 該当記述の改訂を
         11.1（#35 引き継ぎ）へ、変わる domain / application のファイル一覧を
         11.2（#37 引き継ぎ）へ落とす
   8.3 ユースケースの実行位置と Worker RPC［派生］
       → 決着: 次の4点に分ける。
         (a) usecase を DO 内で実行するか（実行位置）。**判断材料に 4.3 の行27
             （ArchiveWriter.write）を必ず入れる** — export は
             spec/domains/export.md:282 が同期生成と確定させ、`:267` が読み出しに
             単一トランザクション（スナップショット読み）を要求しているので、
             usecase を DO 内で実行する結論に倒すと read → render → zip の連鎖ごと
             DO の中に入る。最大 10 GB を持ちうる single-threaded な DO で
             zip エンコードを回すことになり、CPU 予算（2.1）に正面から当たる。
             全数表で最大級のワークロードなので、これを入力に入れずに (a) を
             結論づけない。扱い（分割 / 上限 / 拒否）は 4.8 で決める
         (b) request 側 DI に残るもの（sessionCodec / clock / config / DO stub factory）
         (c) server component / server function から DO を呼ぶ経路と getContainer() の去就。
             application/di/{types.ts,containerStore.ts} と apps/web/app/presentation/ が
             どう変わるか。@repo/core/application/* を request Worker から
             import しなくなるのか
         (d) SerializedError を RPC 越しに維持する方法（kind タグ付き構造的シリアライズを
             壊さない）と、4.7 のプラットフォームエラー翻訳表との接続
         **(b)(c) の結論に、application/di/types.ts:30-52 の JSDoc が明文化している
         不変条件「リポジトリはコンテナに載せない。UnitOfWorkContext が唯一の発行点」を
         維持するのか、DO stub factory を例外として明記するのかを1行加える** —
         DO stub は「その DO 内の全リポジトリへの入口」なので、コンテナに載せると
         実質的にリポジトリを載せたのと同じ到達性を与える。あわせて
         containerStore.ts:39-57 の getContainer() が globalThis の Symbol.for スロット
         （install / read ヘルパは :11-27）+ ALS の二段構えで、DO インスタンス内には
         リクエストスコープの ALS が無いため :49-55 で必ず throw する
         （= DO 側は別の合成ルートが要る）ことを明記する
   8.4 OCC と Version の去就［派生］
       → 決着: 残すか落とすか。残す場合の実現手段（条件付き UPDATE の 0 行検出）
   8.5 UNIQUE 違反翻訳点の是正［参考］
       → 決着: 同期 commit で翻訳点をアダプターへ戻せるか。戻せるなら
         .thread/1/progress.md の spec-sync 項目が1件解消されることを #35 へ引き継ぐ

9. スキーマバージョン管理と lazy migration
   9.1 DO class lifecycle と object 内 schema version の分離［派生］
       → 決着: Wrangler の宣言的 exports で class を管理し、
         object 内 migration とは別レイヤーとして扱う
   9.2 schema_version の持ち方と migration の起動タイミング［Issue 要求］
       → 決着: どこに持ち、いつ走らせるか。**実行機構をプラットフォーム制約と
         突き合わせる** — 「最初のアクセス時」は実装上ほぼ確実に constructor +
         blockConcurrencyWhile になるが、これは30秒でタイムアウトし DO がリセットされる
         （公式）。Alarm 経由にしても handler の wall time は15分。
         **ただし bulk migration や FTS5 の全件再インデックスで先に当たるのは
         wall time ではなく CPU 予算（既定30秒 / 設定で最大5分の active CPU）である。**
         「Alarm 経由なら15分あるので単発適用で足りる」という結論を wall time だけで
         導かない — 10 GB まで育った DO では CPU 側で先に落ちる。
         blockConcurrencyWhile の30秒と CPU 既定30秒は偶然同値なので書き分けること。
         **失敗モードは「リセット」の意味論で決まる**（2.1） — CPU 予算は着信ごとに
         戻る枠で、Alarm 駆動には戻す契機が無い。しかも超過の帰結はエラーではなく
         **エビクションとリセット**なので、bulk migration は**途中まで進んで黙って
         リセットされる**。「例外が上がるから検出できる」を前提にした設計にしない。
         これは 9.3 の「部分適用の記録」を任意ではなく必須にする方向に効く。
         「本 Issue 時点のスキーマ規模では単発適用で足りる。何が起きたら分割が
         必要になるか」を前提付きで断定するか、分割・再開方式を決めるかのどちらかにする
   9.3 forward-only と失敗時の再実行［Issue 要求］
       → 決着: 冪等な適用、途中失敗した migration の再実行規則、
         1回の入力で完了しない migration の部分適用の記録と途中状態での
         リクエスト受付可否（9.2 の結論が「分割が要る」場合）（AC-5）
   9.4 「コードより新しい version」への遭遇［派生］
       → 決着: fail-closed にするかどうか
   9.5 ロールバック方針［Issue 要求］
       → 決着: データのロールバックを行わない／行う。行わない場合の代替（PITR）（AC-5）

10. 運用上の論点（本 Issue では方針だけ、詳細は #38）
   10.1 PITR / export / 退会削除の関係［派生］
       → 決着（**運用手順ではなく設計上の結論としてここに置く**）: PITR の復旧単位は
         DO 1個であり（公式: restore は object 単位で SQL + KV の DB 全体）、
         **複数 DO を同一時点へ戻す手段は無い**。したがって 3.1 が3クラス構成を採る場合、
         「User Data を昨日へ戻したが Directory の mapping は今日のまま」という状態が
         原理的に作れる。{Directory mapping / Account Home} は User Data の restore に
         追随しない前提で 6.3 の saga と 6.7 の退会 tombstone を設計する。
         復旧手順そのものは #38
   10.2 監視・容量・コスト［参考］
       → 決着: いずれも「#38 で詰める」と明示し、設計が依存する前提だけ固定する

11. 影響範囲と引き継ぎ
   11.1 #35 への引き継ぎ — 改訂対象の spec ファイルと改訂内容の一覧（AC-16）［Issue 要求］
       → **一覧の取り方**: 手作りの列挙にしない。表を書く前に
         `grep -rlE 'Outbox|outbox|consumer|ベクトル|埋め込み|ハイブリッド' spec` を走らせ、
         ヒットしたファイルすべてに「改訂する / 影響なし」の判定を付ける
         （`spec/*/review/**` と `spec/idea.md` は履歴文書なので除外してよい）。
         4.3 の台帳走査と同じ手で網羅性を担保する。
       → 少なくとも次を含む（実測で確認済み。落とすと #35 が改訂対象の再探索から始まる）:
         **要件・体験側** — spec/requirements.md（**:87 の「キーワード検索とベクトル検索の
         ハイブリッド」と :108 の「search — ハイブリッド検索」の2箇所**）/
         spec/scenario/search.md:6,25 / spec/pages/index.md:180（P-11 検索）
         **ドメイン** — spec/domains/search.md / spec/domains/index.md（テナント分離規約の
         例外条項）/ spec/domains/{memo,knowledge,identity,trash}.md
         **ユースケース** — **spec/usecases/search.md（maintainSearchIndex = :85-。
         FTS5 同期更新に倒すとユースケースごと消える。4.3 の行9 / 16 の出典でもある）**、
         **spec/usecases/trash.md（pruneExpiredTrashItems = :311-。Alarm 化で置き換わる。
         :315 の pruner 専用 WorkerContainer を含む）**
         **テストケース** — **spec/testcases/search/maintainSearchIndex.md**（対象消滅）/
         **spec/testcases/trash/pruneExpiredTrashItems.md**（Alarm 前提へ書き換え）
         **DB** — spec/database/index.md（**:355-357 の「認証インフラテーブルはスコープ外」
         宣言を 5.4.1 の結論に合わせて見直すことを含む**）
         **台帳** — **spec/inventory/{domain,adapter,usecase,test}.md**（DOM-* / ADP-* /
         UC-* / TC-* の要素台帳。「ポート契約が変われば台帳も変わる」は usecase / test にも
         等しく効く — UC-search-002 / UC-trash-007 / TC-maintainSearchIndex-* 28件 /
         TC-pruneExpiredTrashItems-* 17件が対象。本 Issue の 4.3 は adapter 台帳を
         入力にしている）
         **索引・ADR 表** — **spec/index.md:38-43 の ADR 一覧表**（spec/adr/005 の行。
         表の書き換え自体は #35 のスコープ）
         **マニュアルテスト** — **spec/manual-tests/search.md:5,17,69,266**
         （とくに :17「検索インデックス更新用のワーカー（非同期 consumer）が起動している」は
         trash.md の pruner 起動口とまったく同じ性質の前提）/
         spec/manual-tests/trash.md:18,204,212,351 が前提にしている
         「pruner ワーカーの手動起動口」が Alarm 化でどう変わるか（Alarm の強制発火 /
         時計の巻き戻しに相当する手段）
         **リポジトリ規約** — CLAUDE.md（「ランタイム swap で domain / application /
         presentation は無傷」の記述、8.2.1 の結論次第で嘘になる）
       → 7.2.1 の検索 API 仕様（topic filter / trash 除外 / 安定順位 / snippet /
         ページング）を「#35 で決める論点」として送る
   11.2 #37 への引き継ぎ — 削除対象 / 新設対象のモジュール一覧と UoW 契約の新旧対比（AC-17）［Issue 要求］
       → 少なくとも: adapters/d1/ 全体 / application/workers/ /
         application/execution/unitOfWork.ts /
         **application/ports/{outboxRepository,relayTrigger,idempotencyStore}.ts**
         （Outbox を transport から外す（7.3）とこの3本の去就が決まる）/
         application/di/serverCloudflare.ts /
         application/di/{types.ts,containerStore.ts} /
         **application/di/types.ts:70 の WorkerContainer（JSDoc は :61-69）と、
         そこから拡張する2種類の専用コンテナ** —
         **(i) indexer 専用**（spec/domains/search.md:264 /
         spec/usecases/search.md:89-96。FTS5 同期更新でこの DI 構成が丸ごと不要になる）、
         **(ii) pruner 専用**（spec/usecases/trash.md:315。依存が
         UnitOfWork・TrashQueryPort・memo / knowledge の各リポジトリで既定の
         WorkerContainer では賄えない。retention の Alarm 化で置き換わる）/
         apps/web/app/presentation/ /
         apps/web/app/worker/cloudflare/{relay,consumer,pruner,dlq,handlers}.ts /
         **apps/web/scripts/render-wrangler.ts + apps/web/wrangler.{staging,production}.toml.tpl**
         （.gitignore:14-17 が「.tpl から render-wrangler.ts でレンダーされる」ため
         wrangler.{staging,production}.toml を ignore している。**staging / production の
         wrangler 設定は生成物であり直接編集してはいけない。** 3.2 の Worker 分割の
         結論に .tpl の本数が従属する。未コミットの wrangler.{state,request}.* 4本は
         .tpl を通さない手書き実ファイルでこの運用に乗っていない）/
         **ローカル開発用 apps/web/wrangler.toml（162行。DO バインディングが1つも無い。
         pnpm dev が唯一動く実行手段（CLAUDE.md / #40）なので DO を足すのは必須項目）** /
         **apps/web/package.json の deploy 系（非 dry 12本）**（deploy:{staging,production} +
         :relay / :consumer / :pruner / :dlq / :all。--env relay 等で Queue ワーカーを
         個別デプロイする前提。:dry 変種を含めると**全24本**）**と D1 前提の db 系7本**
         （db:migrate:cf / db:apply:{local,staging,production} /
         db:execute:{local,staging,production}。いずれも
         `wrangler d1 ...` なので D1 廃止で全滅する。これらに委譲する db:migrate も
         道連れになる）/
         infra/cloudflare/pulumi/resources/index.ts（D1 と events / DLQ Queue。
         D1 リソースには「D1 is the system of record — refuse accidental destroy」の
         destroy 保護があり解除手順が要る）/ vitest.config.integration.ts
         （readD1Migrations / d1Databases / queueProducers / queueConsumers。
         .adr/001 が「include はディレクトリの明示的な許可リスト」と決めているので
         apps/web/app/durable-objects/ を include に足す判断も要る。テスト境界は
         「usecase を DO 内で実行するか」（8.3）と直結する）。
       → 決着: 既存 D1 データのカットオーバー方針。実装済みドメインが identity だけで
         本番稼働サービスが無いので「移行しない。DO 側で作り直す」を断定する（空欄にしない）。
         **正本はこの節**（plan.md の同名の節は執筆前のスナップショット）
       → 記録: .thread/1/progress.md 残存課題5（D1 データベース名 tanstack-start-template-d1 /
         実装の outbox_events と spec 表記 outbox の乖離）は D1 / Outbox 廃止に伴い対象消滅。
         DO binding / namespace の命名として読み替える。
       → 記録: #40（pnpm start / pnpm preview の起動不能）は relay worker の消滅で解消する見込み
   11.3 #38 への引き継ぎ — 運用ドキュメント化が必要な事項［参考］
       → PITR の**手順**（ローカル workerd で使えない。復旧単位が DO 1個であることの
         設計上の帰結は 10.1 で決着済みなので、ここへ送るのは手順だけ）/ export /
         退会削除 / 容量監視（本体 + FTS の合計）/ コスト。
         retention を Alarm 化した後の「手動での期限到達再現手段」（11.1 の pruner 手動
         起動口に対応する運用手順）
   11.4 未決事項 — 本 Issue で決めきれなかった論点と、誰がいつ決めるか［派生］
       → **Account Home の採否をここに落とさない**（3.1 で決着させる。AC-21）。
         **5.4.1（セッション / トークンストアの所在）もここに落とさない** —
         決めきれない部分は 11.1 の #35 引き継ぎへ送る
```

### `.adr/002〜004` に書く内容の骨子

3件とも `.adr/001` と同じ5節構成（`## ステータス` / `## コンテキスト` / `## 決定` / `## 検討した代替案` / `## 影響`）で、H1 は `# 00N. <和文タイトル>` 形式に揃える（`.adr/001` は `# 001. 統合テストを Workers プール1本に集約する`）。**各50行以内を目安**とし、実装レベルの詳細は書かない（AC-6）。

**ADR 参照は必ずパス付きで書く。** `.thread/1/adr.md` ADR-046（`:1428`、Status: Accepted）が「無修飾の `ADR-NNN` は既に `spec/adr/NNN` を意味する語彙として確立している」として出荷コードの参照を `.thread/1/adr.md ADR-NNN` の形に統一している。本 Issue で `.adr/` に 002 / 003 / 004 が生まれると、**`ADR-004` が3つの異なる文書（`spec/adr/004-domain-boundaries.md` / `.thread/1/adr.md` ADR-004 / 新 `.adr/004`）を指しうる**。design.md 第4章はドメイン境界（`spec/adr/004`）に言及し、`.adr/002` の影響節は `.thread/1/adr.md` ADR-004 を supersede すると書くので、同一文書内で3つが混在する。これは `.adr/` 3件と design.md の両方に適用する。

**`.adr/002-cloudflare-workers-and-user-data-durable-objects.md` — ランタイム・データ配置**

- ステータス: 承認済み
- コンテキスト: fog のデータが利用者単位で完結し、共有・共同編集・テナント横断検索を持たないこと。共有 DB の論理分離を保守するより物理分離が特性に合うこと
- 決定: Cloudflare Workers + ユーザー単位 SQLite-backed Durable Objects を本番構成とする。認証済みリクエストは `userId` から対象 DO へルーティングし、公開入力から DO を選ばせない。**加えて「DO トポロジー（何クラス構成か）と認証権威の所在、Worker を request / state に分けるか」は design.md 第3章で確定する、という1文をここに置く**（S-009）。実装詳細を書かないので AC-6 を破らず、`.adr/` しか読まない読み手（architecture-audit / spec-sync）に「何を見に行けばよいか」が伝わる。影響節の design.md へのポインタと対にする
- 検討した代替案: 複数ランタイム維持 / D1 共有 DB の継続 / 論理分離のまま Workers に寄せる
- 影響: 利用者データの物理分離、`user_id` による論理分離と D1 固有 OCC ガードの不要化、Cloudflare へのロックイン、object 単位の migration / 容量 / PITR / export / delete を運用する必要。**`.thread/1/adr.md` の ADR-004（Node + libSQL 主ターゲット・4ランタイム構成）を supersede する**ことを明記（AC-10）。**加えて1行**: 「認証権威の所在によっては、`.thread/1/adr.md` ADR-002 のステートレスセッション（DB を触らずに検証する / サーバー側失効の手段が無い）のトレードオフが変わる。所在の決定と、別 ADR を要するかの判断は `.thread/34/design.md` 第3.1節 / 第5.1節」（P-006。波及が最大の帰結の1つが `.adr/` しか読まない読み手に見えなくなるのを防ぐ。仕組みは書かないので AC-6 を破らない）

**`.adr/003-sqlite-fts5-only-search.md` — 検索方式**

- ステータス: 承認済み
- コンテキスト: `spec/requirements.md:87` の「キーワード検索とベクトル検索のハイブリッド」に、ベクトル検索を必須とする利用上の根拠が記録されていないこと。User Data DO の SQLite が FTS5 を提供し、本体と索引を同一トランザクションで更新できること
- 決定: SQLite FTS5 による全文検索のみを採用し、Vectorize / embedding / RRF / ハイブリッド結果統合を設計と実装から除外する
- 検討した代替案: FTS5 + ベクトル検索の統合 / 外部全文検索エンジン / 空白トークナイザのみ
- 影響: 検索の整合性・説明可能性・運用・費用が単純になる。意味類似検索を提供しない。**Vectorize / embedding の費用は消えるが、trigram インデックスの書き込み行数と容量が本体の数倍になるトレードオフを負う**（仮想テーブルへの書き込みも rows written に算入される。詳細は design.md 第4.6節 / 第7.1節）— これがあって初めて代替案比較が費用の面でも成立する。将来、全文検索では満たせない具体的な利用要求と評価データが得られた場合は別 Issue と ADR で再検討する。**`spec/adr/005-search-index-via-outbox.md` を `.adr/004` と共同で supersede する**ことを明記（AC-10）。`spec/adr/005` の決定は「検索インデックスの更新を Outbox 経由の consumer で非同期に行う」で、その根拠は**「埋め込み生成は外部API呼び出しを伴い、書き込みトランザクション内で同期実行すると投稿の快適さを損なう」**（`spec/adr/005:9`。代替案節 `:21` も「同期更新は外部APIの遅延・障害が投稿の成否に直結する」）だった。本 ADR が覆すのは**根拠側**（ベクトル検索をやめるので外部 API が不要になる）であり、更新方式そのものを置き換えるのは `.adr/004` である

**`.adr/004-*.md` — 非同期処理**（ファイル名は「DO ローカル同期 commit と Alarm ジョブ」の意を表すものにする）

- ステータス: 承認済み
- コンテキスト: 本体と FTS 索引が同じ SQLite にある一方、外部 I/O と retention は要求処理から分離して再起動後も回復させる必要があること。Outbox を全更新の transport に使うと同一保存領域の整合まで非同期化してしまうこと
- 決定: DO のローカル SQLite トランザクションと Alarm で完結できる処理は D1 Outbox + relay / consumer / DLQ から移行する。外部 I/O と retention だけを永続ジョブとして残し、単一の DO Alarm で処理する
- 検討した代替案: 全更新を Outbox 経由にする / トランザクション内で外部 I/O する / インメモリキューを使う
- 影響: 本体と検索が commit 成功時にだけ同時に変わる。外部副作用は at-least-once となり provider 冪等キー・lease 監視・poison 運用が必要。D1 固有の `PendingBatch` / `_occ_guard` / 遅延バッチ UoW が不要になる。ドメインイベントを transport として扱わない。**`spec/adr/005-search-index-via-outbox.md` の「更新方式」部分を supersede する**ことを明記（AC-10）。`spec/adr/005` のステータス行のポインタは `.adr/003` と `.adr/004` の両方を指す。**加えて1行**: 「DO のローカル同期 commit を採る帰結として、ドメイン層のリポジトリポートの `Promise` 契約が変わりうる。ランタイム swap で domain / application / presentation が無傷という前提（`CLAUDE.md`「Reference runtime」）は成立しなくなる。具体は `.thread/34/design.md` 第8.2.1節」（P-006。寿命テスト・波及テストを最も明確に通る帰結であり、`.adr/` しか読まない読み手 — architecture-audit / spec-sync — に見えないのは穴。仕組みを書かないので AC-6 を破らない）

## 実装ステップ

成果物単位に並べる。ステップ1で設計が依拠する事実を固定し、2〜3（design.md）を書き、そこで固まった決定だけを 4〜6（`.adr/`）へ抽出する。ADR を先に書くと詳細が `.adr/` に流れ込みやすく、AC-6 を破りやすい。

### 1. Cloudflare プラットフォーム事実と先行資料の確定

- **対象ファイル:** なし（確認のみ。結果は次ステップの design.md 第2.1節へ）
- **変更内容:**
  - 調査結果「Cloudflare プラットフォームの確定事実」の16項目を公式ドキュメントで**差分確認する**（ゼロから調べ直さない。表は裏取り済み）。値が変わっていた項目だけを更新する
  - **CPU 予算を wall time と別枠として扱うことを design.md へ持ち込む** — 第9.2節（lazy migration）と第7.4節（Alarm ジョブの bounded 処理）の「1回の入力で完了するか」の判定基準は、wall time（Alarm handler 15分）ではなく **CPU 予算（既定30秒 / 設定で最大5分の active CPU）** で書く。`blockConcurrencyWhile` の30秒と CPU 既定30秒が偶然同値なので、別項目として書き分ける
  - 公式に記載が無い4点（`transactionSync` のネスト可否 / FTS5 トークナイザの可用性 / 1クエリの結果セット合計サイズ上限 / Free プランの「1オブジェクトあたり」上限）は「未確定」として区別したまま扱う。とくに **trigram トークナイザの可用性は公式に記載が無く、`.thread/19/spike/fts5.integration.test.ts` の実測が唯一の根拠**になるので、この spike を読む
  - 先行ブランチの一次資料を一括で読む — `git show issue/19/cloudflare-do-fts:.thread/19/adr.md`（ADR-001〜010）、同 `.thread/19/spike/fts5.integration.test.ts`、`git show da775f3^:.thread/19/review/*`（#33 の6ラウンド）、`.adr/001〜008`
- **理由:** 事実の誤認は全成果物に波及し、`.adr/` に書かれると後続 Issue まで汚染する。design.md の中の1節として扱うと「書きながら調べる」ことになり、誤認が混ざりやすい。独立したステップとして先頭に置き、design.md の執筆はここで固定した事実の上で行う
- **満たす AC:** AC-5（第7.2節の trigram 実測根拠と、第7.4 / 9.2節の CPU 予算基準の土台）/ AC-19（先行資料を読んだ上で design.md に要旨を書く。ファイル名参照で代替しない）
- **注意:** ここで読む先行資料は design.md の**入力**であって、design.md から番号参照で内容を代替してよいという意味ではない（AC-19）

### 2. `.thread/34/design.md` — DO 境界とルーティングの設計（対応項目3）

- **対象ファイル:** `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md`（新規）
- **変更内容:** 上記「design.md の構成案」の第1〜6章を執筆する。各節は結論の断定形で終える。**各節の見出しに `［Issue 要求］` / `［派生］` / `［参考］` のラベルを付ける**（構成案の「節のラベル付け」に従う。AC-5 の対象は前2つ）。
  - 第1章で `.adr/` との分担と、先行ブランチ `issue/19/cloudflare-do-fts` の採用／棄却／保留を一覧化する。**各行に採用した内容の要旨を書く**（ラベルだけにしない — AC-19）。差分表は `.adr/` 8件単位ではなく `.thread/19/adr.md` の10件 + #33 のレビュー指摘単位で作る
  - 第2章のプラットフォーム制約は、ステップ1で確定した18項目を出典 URL 付きで書く。公式に記載が無い項目は「実測」または「未確定」と明示する。**CPU 予算（リセット意味論を含む）と DO namespace の非列挙性を落とさない。3周目で訂正した3点（`ctx.id.name` は実在する / CPU 予算は着信ごとにリセットされる / FTS5 で公式明記なのはモジュール本体と `fts5vocab` だけ）を取り違えない**
  - 第3.1節で **Account Home DO の採否を理由付きで結論づける**（未決事項に落とさない — AC-21）。採用する場合は「`.thread/1/adr.md` ADR-002 を supersede する別 ADR を起こす必要があるか」の判断も**ここで**下し、結果を第5.1節に書く（#37 に投げない）
  - 第4章に Issue 列挙の7項目をすべて行として持つ対応表を置く（AC-11）。第4.3節はユーザー境界に閉じないものを**全数（8カテゴリ29行）**扱い、**節の冒頭に述語の定義を置いてから表を出す**。**執筆前に `spec/inventory/adapter.md` の `ADP-*` 台帳（85件）を再走査して漏れを足す**（AC-22。行数は走査の結果であって目標値ではない）。第4.6節の容量方針は「本体 + FTS インデックスの合計で 10 GB」。第4.7節に DO プラットフォームエラーの翻訳表を置き、**第4.8節に「DO 内で回す大きな CPU 仕事の扱い」（export の zip / FTS5 全件再インデックス / bulk migration）**を置く
  - **前方依存の扱い（3周目 arch S-001）。** 第4.3節で「そもそも不要になる」に倒れる行（行9 / 16 / 20 / 22 / 23 / 24 / 28 / 29 — IndexerReadPort / SearchIndexPort の upsert・remove / Outbox ワーカー群 / 共有基盤テーブル3本 / `search_fts` / `search_embeddings` / indexer・pruner の専用コンテナ。行21 のトークン失効 consumer は「消える」ではなく「到達手段を決め直す」なので第5.4.1節 (b) 側で扱う）は、**第7.1節（FTS5 同期更新の可否）と第7.3節（Outbox 廃止範囲）の結論が出るまで確定しない**。同様に第5.4.1節 (b)（失効の到達手段）は第7.3節に、第6.4節の「誰がいつ」は第7.4節に従属する。単一ファイルを1人で書くので往復で吸収できるが、**順序としては逆流している**ので次の手順で解消する — (1) ステップ2 ではこれらの行・項目を「7.1 / 7.3 の結論に従属。暫定判定: 不要になる見込み」と**明示的に暫定と分かる形**で書く、(2) ステップ3 で第7章を書き終えた**直後に**第4.3節 / 第5.4.1節 / 第6.4節へ戻り、暫定を確定に置き換える、(3) ステップ10 の自己検証で「暫定」「見込み」「〜次第」という語が第4〜6章に残っていないことを確認する。ステップ7 が同種の従属を「前提: 第7.1節が肯定的結論を出した場合に実施する」と扱えているのと同じ扱いをステップ2 にも与える
  - 第5章に session / token → `userId` → locator の経路、および HMAC 由来 locator と PII 非露出の方針を書く（AC-12 / AC-14）。第5.2.1〜5.2.5 で canonical 化の定義・locator 鍵の2系統分離（**論拠は「UUIDv7 だから」ではなく「IdGenerator 採番 + 外部入力から来ない」**）・鍵の所有者（参考）・location hint / jurisdiction（参考）・**ハッシュ衝突の扱い**を決着させる（AC-23）。第5.4.1節で**セッション / AI クライアントトークンストアの所在**を決着させる（決めきれない部分は第11.1節へ送り、未決事項には落とさない）
  - 第6章に Identity Directory DO の5論点（解決責務・分割方式・部分失敗・冪等性・SSO リンク解除）と、分散トランザクション非前提の宣言を書く（AC-13 / AC-15）。第6.1節は解決責務を4サブ項目に分解し、**既存実装（`users_email_uq` / `users_sso_identity_uq` / `findByEmail` / `findBySsoIdentity`）をどう移すかとして書く**。第6.2節は3案（単一 / 固定 bucket / credential 単位 DO）を**4つの判断軸（列挙可能性 / bucket 数の不変性 / 衝突の意味 / 未認証経路からの DO 生成）**で比較してから**決め切る**（AC-5 の断定形要求の射程内。「最終決定は #37」で終えない）。第6.2.1節に canonical credential の保持と保護を置き、**動機を3つ（メール宛先 / 再 HMAC / bucket 内識別）挙げる**（AC-23）。第6.6節に「既存の `SsoUser` 判別共用体をどう読み替えるか」を含める
- **理由:** Issue の対応項目3が要求する成果物そのもの。#35 / #37 の唯一の設計入力になる
- **注意:** ADR 参照は必ずパス付きで書く（`.thread/1/adr.md` ADR-046 の規約。無修飾の `ADR-004` は3つの文書を指しうる）

### 3. `.thread/34/design.md` — 非同期処理・migration・引き継ぎの追記（対応項目4）

- **対象ファイル:** `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md`（追記）
- **変更内容:** 構成案の第7〜11章を執筆する。**各節にラベル（`［Issue 要求］` / `［派生］` / `［参考］`）を付ける。**
  - 第7章で FTS5 同期更新の可否を**結論として**書き、Outbox consumer 経由のインデックス維持が不要になるかを断定する。判断の入力に **trigram の rows-written 増幅**を含める。trash retention の Alarm 化、外部 I/O を残す境界を書く。第7.2節は `.adr/003` を支える範囲（正規化・トークナイザ・短語）に絞り、**検索 API の仕様（topic filter / trash 除外 / 安定順位 / snippet / ページング）は第7.2.1節で #35 へ委譲する**（AC-5 の対象外）。第7.3節では **indexer 以外の outbox 購読者（トークン失効 consumer）の到達手段**も決め直す。第7.4節は **bounded 処理の判定基準を CPU 予算で書き、Directory / Account Home 側の Alarm 所有者**を1行決める。第7.6節は**メール送信ジョブの所有者**を1行決める（userId 未確定の経路から始まるので User Data DO ではない）
  - 第8章で新 UoW 契約と、D1 固有物（`PendingBatch` / `_occ_guard` / 遅延バッチ）の廃止を書く。`registerWithPassword.ts` に漏れている UNIQUE 違反翻訳点の是正可否も結論づける。第8.2.1節で既存ドメインポート（`TransactionalRepository` / `Versioned` / `ExpectedVersion` / `UserRepository`）の Promise 契約の去就を決着させ、第8.3節を (a)〜(d) に分けて presentation → application の経路変化まで書く。第8.3節 (b)(c) に **`application/di/types.ts:30-52` の不変条件（リポジトリをコンテナに載せない）と DO stub factory の関係**を1行加える
  - 第9章で lazy migration の方針（forward-only / 再実行 / 新しすぎる version / ロールバック）を書く。第9.2節で実行機構を `blockConcurrencyWhile` の30秒制約・Alarm handler の15分（**出典は alarms ページではなく limits ページの "Wall time limits by invocation type" 表**）・**CPU 予算（既定30秒 / 最大5分）**と突き合わせる。「Alarm なら15分あるので足りる」を wall time だけで導かない。**あわせて CPU 予算の「着信ごとにリセット」意味論を失敗モードの記述に反映する** — Alarm 駆動には戻す契機が無く、超過の帰結はエラーではなくエビクションとリセットなので、bulk migration は「途中まで進んで黙って落ちる」。「例外が上がるから検出できる」を前提にした設計にしない（第9.3節の部分適用の記録が必須になる）
  - 第10.1節に **PITR の復旧単位が DO 1個**であることの設計上の帰結を**結論として**置く（#38 へ送るのは手順だけ）
  - **ステップ2 の暫定判定を確定に置き換える**（前掲「前方依存の扱い」の (2)） — 第7章を書き終えた直後に第4.3節 / 第5.4.1節 (b) / 第6.4節へ戻る
  - 第11章に #35 / #37 / #38 への引き継ぎ表と未決事項を書く（AC-16 / AC-17）。
    - **#35 引き継ぎ表を書く前に `grep -rlE 'Outbox|outbox|consumer|ベクトル|埋め込み|ハイブリッド' spec` を走らせ、ヒットしたファイルすべてに「改訂する / 影響なし」の判定を付ける**（`spec/*/review/**` と `spec/idea.md` は履歴文書なので除外してよい）。手作りの列挙にしないのは 4.3 の台帳走査と同じ理由。表には少なくとも **`spec/requirements.md`（`:87` と `:108` の2箇所）・`spec/usecases/{search,trash}.md`・`spec/testcases/search/maintainSearchIndex.md`・`spec/testcases/trash/pruneExpiredTrashItems.md`・`spec/inventory/{domain,adapter,usecase,test}.md`・`spec/index.md`（ADR 一覧表）・`spec/scenario/search.md`・`spec/manual-tests/search.md`・`spec/pages/index.md`・`spec/database/index.md:355-357` のスコープ外宣言の見直し**を含める（構成案 11.1 の一覧に対応）
    - #37 引き継ぎには `infra/cloudflare/pulumi/resources/index.ts`・`apps/web/wrangler*.toml`・`vitest.config.integration.ts`・`application/di/{types.ts,containerStore.ts}`・`apps/web/app/presentation/` に加え、**`application/ports/{outboxRepository,relayTrigger,idempotencyStore}.ts`・`scripts/render-wrangler.ts` + `.tpl` レンダリング運用・ローカル `wrangler.toml`（DO binding が無い）・`package.json` の deploy 系（非 dry 12本 / 全24本）と D1 前提の db 系7本・`application/di/types.ts:70` の `WorkerContainer` から拡張する2種類の専用コンテナ（indexer 専用 + pruner 専用）** を含める
    - 既存 D1 データのカットオーバー方針（移行しない、を断定）、残存課題5 の対象消滅、pruner 手動起動口の扱いも書く
- **理由:** 対応項目4の要求。ここが埋まらないと #37 が UoW とスキーマ管理を自分で設計し直すことになる
- **注意:** ADR 参照は必ずパス付きで書く（`.thread/1/adr.md` ADR-046 の規約）

### 4. `.adr/002` — ランタイム・データ配置

- **対象ファイル:** `/Users/hikaru/github.com/tuanemuy/fog/.adr/002-cloudflare-workers-and-user-data-durable-objects.md`（新規）
- **変更内容:** 上記「`.adr/002〜004` に書く内容の骨子」に従い5節を執筆。影響節に「`.thread/1/adr.md` の ADR-004 を supersede する」と明記する。**決定節に「DO トポロジー（クラス構成・Worker 分割）と認証権威の所在は design.md 第3章で確定する」の1文を置き**、影響節の design.md ポインタと対にする
  - **影響節にもう1行**: 「認証権威の所在によっては、`.thread/1/adr.md` ADR-002 のステートレスセッションのトレードオフが変わる。所在の決定と、別 ADR を要するかの判断は `.thread/34/design.md` 第3.1節 / 第5.1節」
- **理由:** 対応項目1の1件目。寿命テスト・波及テストをどちらも満たす（ランタイム選定を覆せば adapters / entry point / DI / インフラ / テスト基盤に波及する）
- **注意:** 採番は `002`。`.adr/001` を上書きしない（AC-3）。H1 は `# 002. <和文タイトル>` 形式（AC-1）。トポロジーの1文は「何クラス・何 Worker かを design.md で確定する」という所在の宣言に留め、具体的な構成やその理由は書かない（AC-6）。**ADR 参照はパス付きで書く**（`.thread/1/adr.md` ADR-004 / `spec/adr/005-*.md` / `.adr/003`。無修飾の `ADR-004` は3つの文書を指しうる — `.thread/1/adr.md` ADR-046 の規約）

### 5. `.adr/003` — 検索方式

- **対象ファイル:** `/Users/hikaru/github.com/tuanemuy/fog/.adr/003-sqlite-fts5-only-search.md`（新規）
- **変更内容:** 5節を執筆。影響節に「`spec/adr/005-search-index-via-outbox.md` を `.adr/004` と共同で supersede する」と明記し（本 ADR が覆すのは**根拠**側 — `spec/adr/005:9` の「埋め込み生成は外部API呼び出しを伴い、書き込みトランザクション内で同期実行すると投稿の快適さを損なう」。引用は原文どおりにする）、ベクトル検索の再検討条件（具体的な利用要求と評価データ）を書く。**影響節に「trigram インデックスの書き込み行数と容量が本体の数倍になる」トレードオフの1行を入れる**
- **理由:** 対応項目1の2件目。検索方式は search ドメイン・DB 設計・要件・インフラ（Vectorize の要否）に波及する
- **注意:** H1 は `# 003. <和文タイトル>` 形式（AC-1）。ADR 参照はパス付きで書く

### 6. `.adr/004` — 非同期処理

- **対象ファイル:** `/Users/hikaru/github.com/tuanemuy/fog/.adr/004-do-local-commit-and-alarm-jobs.md`（新規。ファイル名は決定内容を表す範囲で調整可）
- **変更内容:** 5節を執筆。影響節に D1 固有の `PendingBatch` / `_occ_guard` / 遅延バッチ UoW が不要になることを1〜2行で書く（**仕組みの説明は書かない** — 詳細は design.md 第8章）。影響節に「`spec/adr/005` の**更新方式**部分を supersede する」も明記する。**影響節にもう1行**: 「DO のローカル同期 commit を採る帰結として、ドメイン層のリポジトリポートの `Promise` 契約が変わりうる。ランタイム swap で domain / application / presentation が無傷という前提（`CLAUDE.md`「Reference runtime」）は成立しなくなる。具体は `.thread/34/design.md` 第8.2.1節」
- **理由:** 対応項目1の3件目。Outbox / relay / consumer / DLQ の去就は application / adapters / entry point / wrangler 設定に波及する。**ドメインポートの同期化は本 Issue の帰結のうち波及が最大の部類**なので、仕組みを書かない1行で `.adr/` に残す（AC-6 を破らずに、`.adr/` しか読まない読み手に見えるようにする）
- **注意:** H1 は `# 004. <和文タイトル>` 形式（AC-1）。ADR 参照はパス付きで書く

### 7. `spec/adr/005` — supersede ポインタの追記

- **対象ファイル:** `/Users/hikaru/github.com/tuanemuy/fog/spec/adr/005-search-index-via-outbox.md`
- **変更内容:** `## ステータス` 節（`:3-5`）の「承認済み」を、承認済みであった事実を保持したまま superseded ポインタ付きに書き換える。**ポインタは `.adr/003` と `.adr/004` の両方を指す** — `spec/adr/005` の決定「検索インデックスの更新を Outbox 経由の consumer で非同期に行う」を覆すには、根拠（埋め込み生成が外部 API を伴う → `.adr/003` がベクトル検索をやめる）と更新方式そのもの（→ `.adr/004` が同期 commit に置き換える）の両方が要る。**`## コンテキスト` 以降（本文 = コンテキスト / 決定 / 検討した代替案 / 影響）には一切手を入れない**
  - AC-7 との整合: この操作は `## ステータス` 節の1行を**書き換える**ので、`git diff` には削除行が伴う。AC-7 が禁じているのは本文の改変であって削除行そのものではない。AC-7 の検証欄も「差分が `## ステータス` 節の範囲に収まり、`## コンテキスト` 以降に一切変更が無い」と機械判定できる形に揃えてある
- **理由:** 対応項目2。`spec/index.md:38-43` と `spec/database/index.md:6` と `spec/domains/{search,memo,knowledge}.md` から相対リンクで参照されているファイルなので、削除も移動もせずステータスだけを更新する。実測でこれらのリンクはいずれもファイル自体を指しており、ステータス節の書き換えでは壊れない
- **注意:** `spec/adr/` に**新規ファイルを作らない**（AC-9）。`spec/index.md` の表の書き換えは #35 のスコープ
- **前提:** design.md 第7.1節が「FTS5 を本体と同一トランザクションで同期更新できる」と結論した場合に実施する。否定的結論になった場合は `spec/adr/005` の supersede 対象と AC-7 / AC-10 を見直す（Issue の対応項目2 も「同期更新する設計に変える場合」と条件付きで書いている）。調査結果からは肯定的結論がほぼ確実だが、依存関係は明示しておく

### 8. `.thread/1/adr.md` — ADR-004 への1行ポインタ

- **対象ファイル:** `/Users/hikaru/github.com/tuanemuy/fog/.thread/1/adr.md`（実測: `:160` が `## ADR-004: ...` の見出し、`:161` 空行、`:162` `### Status`、`:163` 空行、`:164` `Proposed`、`:165` 空行、`:166` `### Context`）
- **変更内容（挿入書式まで固定する）:** **`Proposed`（`:164`）の直後に、空行1行 + 「→ `.adr/002-*.md` に supersede された」のポインタ1行を挿入する。** つまり `git diff` 上は**削除行0 / 追加行2（空行1 + ポインタ1）**になる。既存の本文・`Proposed`・Context / Decision / Consequences は1文字も変えない
  - AC-8 との整合: 初版は「追加行が1」を要求していたが、Markdown の空行規約（ブロック要素の前後に空行）を守るとポインタ段落の挿入は必ず2行になる。空行を足さずに1行だけ挿すのは CommonMark 上は有効だが、リポジトリの Markdown スタイルに反する書き方を強いることになる。**AC-8 の判定は「削除行がゼロ、かつ追加が supersede ポインタ1行のみ（前後の空行を除く）」に統一済み**（3周目 cov S-002。判断は `.thread/34/adr.md` ADR-016）
- **理由:** 対応項目2。`.thread/1/` は #1 当時の作業ログであり改変対象ではないが、supersede の履歴が残っていることは受け入れ条件
- **注意:** `git diff main...HEAD -- .thread/1/adr.md` の削除行がゼロであることを確認する（AC-8）。ADR-002（セッション）・ADR-015（AWS の SESSION_SECRET）にはポインタを付けない — 前者はセッション方式の決定でランタイム集約とは独立、後者は #36 で撤去済みの AWS 固有事項であり、本 Issue の3件が supersede する対象ではない。この判断理由は `.thread/34/adr.md` に記録する

### 9. `.thread/34/adr.md` — 実装中に下したメタな判断の追記

- **対象ファイル:** `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/adr.md`（**既存・追記**）
- **前提:** このファイルは**着手時点で既に存在し、ADR-001〜019 が記録されている**（計画立案とそのレビュー3周で作成済み）。ステップ9 は新規作成ではなく、**既存連番の続き（ADR-020 以降）への追記**である。既存分の内訳:

  | # | 主題 |
  |---|---|
  | ADR-001 | 先行ブランチの `.adr/` 8件を3件へ縮約し、残りを design.md に吸収する |
  | ADR-002 | design.md を先に書き、`.adr/` の3件を後から抽出する |
  | ADR-003 | supersede の正本は新 ADR 側に置き、旧側は1行ポインタだけにする |
  | ADR-004 | `.thread/1/adr.md` の ADR-002 / ADR-015 にはポインタを付けない |
  | ADR-005 | Account Home DO の採否は本 Issue で決着させ、未決事項に落とさない |
  | ADR-006 | `spec/adr/005` の supersede 先を `.adr/003` と `.adr/004` の両方にする |
  | ADR-007 | 検索方式の設計詳細は本 Issue の決着対象から外し、#35 への入力にする |
  | ADR-008 | プラットフォーム事実の確定を独立した先頭ステップに置く |
  | ADR-009 | AC の design.md 参照を節番号ではなく節タイトルで書く |
  | ADR-010 | design.md の各節に3ラベルを付け、AC-5 の対象を絞る |
  | ADR-011 | 境界に閉じない処理の網羅性を `spec/inventory/adapter.md` の `ADP-*` 台帳走査で担保する |
  | ADR-012 | plan.md と design.md で重複する記述の正本を design.md 側に置く |
  | ADR-013 | AC 表を統合せず23件のまま維持する |
  | ADR-014 | AC-22 の主判定を台帳走査に置き、行数・カテゴリ数を補助へ降格する |
  | ADR-015 | AC-5 の対象を節の列挙ではなくラベルで定義する |
  | ADR-016 | AC-8 の判定を「追加はポインタ1行のみ（空行を除く）」にし、挿入書式を固定する |
  | ADR-017 | AC-20 の既知 untracked を実測で作り、`.thread/36/` を含める |
  | ADR-018 | ステップ2 → ステップ3 の前方依存を「暫定判定 + ステップ3 で確定」で解消する |
  | ADR-019 | プラットフォーム事実は「裏取り済み」でも主張の実在と裏付けの種別から点検する |

- **変更内容:** ステップ2〜8 の**実行中に**下した、`.adr/` の3件には含めない判断を **ADR-020 以降**として追記する。典型的には次の種類:
  - design.md を単一ファイルにするか分割するか（構成案は単一ファイル前提だが、その判断は未記録）
  - `.adr/` への昇格を検討したが見送った判断と、その理由（リスク節「`.adr/` の肥大化」に対応）
  - 執筆中に「Issue 要求 / 派生 / 参考」のラベル付けで迷った節と、その決着
  - 先行ブランチの ADR / レビュー指摘のうち、採用も棄却もせず「保留」にしたものとその扱い
- **理由:** やること6の指示。`.adr/` を薄く保つために、メタな判断はここに隔離する
- **注意:** 無理に埋めない。**ただし「1件も追記が無い」で終える場合は、その旨（昇格を見送った判断が無かった）を明記する**（AC-18。存在チェックだけでは着手前に空振りで充足してしまう）

### 10. 成果物の相互整合と受け入れ条件の自己検証

- **対象ファイル:** なし（検証のみ）
- **前提:** **成果物を commit した後に実行し、置き場所の検査はすべて `main` 起点の committed diff に統一する。** 作業ツリー比較（`git diff <path>`）と commit 済み比較（`git diff main...HEAD`）を混ぜると、commit 前は `git diff main...HEAD` が空になって AC-20 が空振りで通り、commit 後は逆に `git diff <path>` が空になって AC-3 / AC-7 / AC-8 / AC-9 が「証明ではなく空振り」で通る。どちらのタイミングでも検出装置が死なないよう、次の2コマンドの出力だけで判定する。

  ```
  git diff --name-status main...HEAD
  git status --porcelain
  ```

- **変更内容（置き場所の機械検証 — 上の2コマンドの出力から判定する）:**
  - `git diff --name-status main...HEAD` の出力に対して:
    - `.adr/` 配下が `A .adr/002-*.md` / `A .adr/003-*.md` / `A .adr/004-*.md` の3行のみ。**`.adr/001-*.md` の行が現れない**（AC-2 / AC-3）
    - `spec/adr/` 配下が `M spec/adr/005-*.md` の1行のみ（**`A` が無い**）（AC-9）
    - `.thread/1/adr.md` が `M`（AC-8）
    - 全体が `.adr/00{2,3,4}-*.md` / `.thread/34/**` / `spec/adr/005-*.md` / `.thread/1/adr.md` に限られ、`packages/core/` / `apps/web/app/` / `infra/` / `*.toml` / `*.ts` が1件も現れない（AC-20）
  - `git diff main...HEAD -- .thread/1/adr.md` の**削除行がゼロ、追加が supersede ポインタ1行のみ（前後の空行を除く）**。ステップ8 の挿入書式（`Proposed` の直後に空行1 + ポインタ1）に従えば追加行は2になる（AC-8）
  - `git diff main...HEAD -- spec/adr/005-*.md` の差分が **`## ステータス` 節の範囲に収まり、`## コンテキスト` 以降に一切変更が無い**。ポインタ先が `.adr/003` と `.adr/004` の両方を指している（AC-7）
  - `git status --porcelain` に、**既知の untracked 以外の未コミット変更がゼロ**（AC-20。commit 漏れによる空振りを塞ぐ。commit し忘れた成果物があればここで出る）。**既知の untracked は着手時点の実測どおり `.artifacts/` / `.thread/36/` / `apps/web/wrangler.{request,state}.{production,staging}.toml` の4本の計6エントリ。** `.thread/36/` を落とすとこの検査は**必ず1件多く出て誤検知で止まる**（3周目 cov P-001 / arch S-003）。`.thread/34/` は成果物として commit 済みなので、この時点では現れない
  - `ls .adr/` が4件ちょうど。各ファイルの H1 が `# 00N. <和文タイトル>` 形式で、5つの `##` 見出しを持つ（AC-1 / AC-2）
  - `.adr/` 3件に SQL / テーブル定義 / bucket 数の具体値 / 関数シグネチャが出現しない。各50行以内（AC-6）
  - `.adr/` 3件と design.md の ADR 参照がすべて**パス付き**（無修飾の `ADR-NNN` が無い）
- **変更内容（内容の検証）:**
  - **design.md の自己完結性を確認（AC-19）** — 「先行案との差分」の節の各行が採用内容の要旨を持ち、`issue/19/cloudflare-do-fts` / `.thread/19/` / `.thread/1/adr.md` / #35 で書き換わる `spec/domains/search.md` を開かないと読めない箇所が無い
  - **後続 Issue 担当者のロールプレイ確認（AC-16 / AC-17）** — #35 の担当者になったつもりで design.md の引き継ぎ表だけから改訂対象ファイルと改訂方針が特定できるか、#37 の担当者になったつもりで削除対象・新設対象と UoW の新旧契約が読み取れるかを実際に読み下す。AC-16 の追加項目（`spec/usecases/{search,trash}.md` / `spec/testcases/*` 2件 / `spec/inventory/{usecase,test}.md` / `spec/index.md` / `spec/scenario/search.md` / `spec/manual-tests/search.md` / `spec/pages/index.md` / `spec/requirements.md:108`）と AC-17 の追加項目（`application/ports/` 3本 / `render-wrangler.ts` + `.tpl` / ローカル `wrangler.toml` / `package.json` の deploy 系12本・db 系7本 / indexer 専用と pruner 専用の2つの WorkerContainer）が表にあることも見る
  - **「クラス構成と責務分界」の節に Account Home の採否の結論があり、「未決事項」の節に現れないことを確認（AC-21）**
  - **網羅性の確認（AC-22。主判定は台帳走査）** — `spec/inventory/adapter.md` の `ADP-*` 全85件を走査して述語（(a) userId を第一引数に取らないポート / (b) 引き方の経路に `user_id` が入っていないテーブル / (c) 台帳で捕まらない次元）を当て直し、**該当する全件が「ユーザー境界に閉じないものの帰属」の節の表にあり**、各行に行き先が入っていることを確認する。表の行数（29）とカテゴリ数（8）は走査の結果として一致するかを見る補助であって、主判定にしない。**節の冒頭に述語の定義が書かれていることも確認する**
  - **前方依存の解消を確認（ステップ2 の (3)）** — 第4〜6章に「暫定」「見込み」「〜次第」といった語が残っていない。とくに第4.3節の行き先・第5.4.1節 (b)・第6.4節がステップ3 の結論で確定に置き換わっている
  - **`.thread/34/adr.md` の件数が着手時点の19件から増えているか、増えなかった理由が記録されていることを確認（AC-18）**
  - **各節にラベル（`［Issue 要求］` / `［派生］` / `［参考］`）が付いており、AC-5 の対象（前2つ）がすべて断定形で終わっていることを確認**
  - **plan.md と design.md で重複する4箇所の正本が design.md 側であることを確認** — 「Cloudflare プラットフォームの確定事実」（design.md 第2.1節）/「ユーザー境界に閉じない処理の全数」（第4.3節）/「既存 D1 データのカットオーバー」（第11.2節）/「先行案との差分」（第1.3節）。plan.md 側の該当箇所には「**正本は design.md 第N節**」の1行が入っている（放置すると2版が食い違い、#35 / #37 がどちらを読むべきか分からなくなる）
  - design.md → `.adr/` の参照と `.adr/` → design.md の参照が双方向に成立し、リンク切れが無いことを確認
  - 受け入れ基準表の AC-1〜AC-23 を1件ずつ突き合わせる
- **理由:** Issue が「書き先の取り違えが最大の失敗要因」と明示しているため、機械的に検証できる形で最後に通す。その検出装置自体が commit 状態によって空振りしないよう、判定を単一の committed diff に寄せる

## 設計判断

`.adr/` に置く3件（ランタイム・データ配置 / 検索方式 / 非同期処理）が本 Issue の成果物そのものなので、それらは `.thread/34/adr.md` には書かない。`.thread/34/adr.md` に記録するのは実装ステップ9に挙げたメタな判断のみ（着手時点で ADR-001〜019）。計画段階で確定させた主なものは次の16。

- **先行ブランチの8 ADR を3件へ縮約する** — `issue/19/cloudflare-do-fts` の `.adr/001〜008` のうち、`004`（Directory 分割と saga）/ `005`（宣言的 DO exports）/ `006`（値のみの Worker RPC）/ `007`（PITR 検証境界）/ `008`（Account Home 認証権威）は、Issue の判断基準に照らすと寿命テストは通るが「`.adr/` を薄く保つ」という明示的な指示と衝突する。内容は捨てずに design.md 第3・5・6・8・10章へ吸収し、`.adr/` は3件に留める。将来これらを昇格させる必要が生じたら、そのときに別 ADR として起こす
- **design.md を先に書き、ADR を後から抽出する** — 逆順にすると設計の詳細が `.adr/` へ流れ込み、AC-6 を機械的に破る。ただしプラットフォーム事実の確定だけはさらに前（ステップ1）に置く。事実の誤認は全成果物に波及するため、「書きながら調べる」構造にしない
- **Account Home DO の採否は本 Issue で決着させる** — 「決めきれなければ未決事項に落とす」という逃げ道を計画から削る。DO クラス数・saga の phase 数・session 検証が per-request RPC になるか・PITR の restore 対象境界のすべてがここに依存し、未決のままでは #37 が着手できない。受け入れ条件9 と直接衝突する
- **`spec/adr/005` の supersede 先は `.adr/003` と `.adr/004` の両方** — `spec/adr/005` の決定を覆すには、根拠（ベクトル検索の不採用）と更新方式（同期 commit への置き換え）の両方が要る。`.adr/003` 単独に固定すると非同期処理側の決定を取りこぼす
- **検索方式の設計詳細は本 Issue で決着させない** — トークナイザ・正規化・短語フォールバックは `.adr/003`（FTS5 のみで足りる）を支える根拠なので本 Issue の範囲だが、topic filter / trash 除外 / 安定順位 / snippet / ページングは検索 API の仕様設計であり #35 / #37 の領分。先取りすると #35 と二重管理になる
- **AC は design.md の節番号ではなく節タイトル（論点名）で参照する** — 節番号に強結合させると、執筆中に章立てを1つ足し引きしただけで機械的検証が全滅する。検証の実体は「その論点に結論があるか」であって節番号ではない。節番号は括弧付きの参考に落とす（`.thread/34/adr.md` ADR-009）
- **design.md の各節に「Issue 要求 / 派生 / 参考」の3ラベルを付け、AC-5 の対象を前2つに絞る** — 構成案は Issue の要求（12項目程度）に対して11章・約50節と大きく、全部を同じ重みで断定形にすると根拠の薄い断定が混ざる。ラベルは削減のためではなく**肥大の可視化**のために付ける（ADR-010）
- **境界に閉じない処理の網羅性は `spec/inventory/adapter.md` の `ADP-*` 台帳走査で担保する** — 手作りの列挙は必ず漏れる（7件 → 16行 → 25行 → 29行と3周にわたって拡大した）。台帳は `spec/database/` + `spec/domains/` のポート定義から生成されているので、spec 側の追加が台帳の更新として現れる（ADR-011）
- **plan.md と design.md で重複する記述の正本は design.md 側** — 4箇所（プラットフォーム事実 / 境界に閉じない処理 / D1 カットオーバー / 先行案との差分）が両方に書かれる。plan.md はレビューで更新され続けるので、正本を明示しないと2版が食い違い #35 / #37 がどちらを読むべきか分からなくなる（ADR-012）
- **AC 表は23件のまま統合しない** — 重複3組（AC-1/2、AC-4 と下位群、AC-16/17 と AC-19）を19件へ統合する案を検討したが、検証粒度を落とす損失が大きく、番号の付け替えがレビューファイル・指摘台帳の参照を壊す。冗長性はラベル付けで解消する（ADR-013）
- **AC-22 の主判定を「行数」から「台帳走査」へ入れ替え、述語を明文化する** — 主判定が「25行すべてに行き先が入っている」である限り、**表そのものが不完全なケースは主判定では捕まらない**。行数・カテゴリ数は走査の結果として導かれる補助へ降格する。あわせて述語 (b) を「`user_id` 列が無い、または引き方の経路に `user_id` が入っていないテーブル」に言い直す（ADR-014）
- **AC-5 の対象を節の列挙ではなくラベルで定義する** — 列挙と構成案がずれると射程から漏れる節が出る（実際に「FTS5 のみで足りる根拠」と「分割方式」が漏れていた）。`［Issue 要求］`/`［派生］` の全節を対象にし、例外は `［参考］` と第7.2.1節（#35 へ委譲）だけにする（ADR-015）
- **AC-8 は「追加行が1」ではなく「追加が supersede ポインタ1行のみ（前後の空行を除く）」で判定し、挿入書式を固定する** — Markdown の空行規約と両立しない基準を残すと、実装フェーズが規約違反の書き方を強いられる（ADR-016）
- **AC-20 の既知 untracked ホワイトリストは実測で作り、`.thread/36/` を含める** — 否定形（特定ディレクトリに変更が無いこと）へは切り替えず、ホワイトリスト方式を維持したまま実データで更新する（ADR-017）
- **ステップ2 → ステップ3 の前方依存は「暫定判定 + ステップ3 で確定」で解消する** — 第4.3節の行き先・第5.4.1節 (b)・第6.4節は第7章の結論に従属する。ステップの順序を入れ替えるのではなく、依存を明示して確定タイミングを決める（ADR-018）
- **プラットフォーム事実は「裏取り済み」でも主張の実在から点検する** — 2周目に全件一致を確認した表から3周目に3件の誤りが出た。ステップ1 の差分確認は値の変化だけでなく「その主張が出典ページに実在するか」と「裏付けの種別（公式記載 / 実測 / 未確定）」を見る（ADR-019）

## リスクと注意点

- **書き先の取り違え** — 最大の失敗要因として Issue 本文が名指ししている。`.adr/` は3件のみ、詳細は `.thread/34/`、`spec/adr/` は新規追加なし。実装ステップ10の機械的検証を必ず通す
- **`.adr/` の肥大化** — DO 設計は論点が多く、書いているうちに「これも永続 ADR では」と昇格させたくなる。寿命テストと波及テストの両方 Yes でも、Issue が3件と明示している以上は増やさない。判断に迷ったものは `.thread/34/adr.md` に「昇格を見送った判断」として記録する
- **先行ブランチの `.adr/` をそのまま採用してしまう** — 採番が `001` から始まっており、機械的にコピーすると `.adr/001-integration-tests-single-workers-pool.md` を上書きし、かつ ADR が8件になる。AC-2 / AC-3 を同時に破る。必ず内容を読み替えて再構成する
- **`.thread/1/adr.md` の意図しない書き換え** — 1662行の巨大ファイルで、編集ツールの操作を誤ると本文が壊れる。追加は1行だけに限定し、`git diff` の削除行ゼロを確認する
- **design.md が「検討する」で終わる節を残す** — 受け入れ条件は「方針が決まっている」ことを要求している。特に FTS5 同期更新の可否・UoW 契約・lazy migration のロールバック方針は、結論を出さないと #37 が着手できない
- **Cloudflare プラットフォームの事実誤認** — DO のストレージ上限、Alarm が1 object あたり1本であること、`transactionSync` の制約、SQLite-backed DO での PITR 可否は設計の土台になる。Issue 本文が挙げた2つの公式ドキュメントを確認して出典付きで書く。とくに **PITR がローカル workerd で利用できない**点は #38 の運用設計に直結するので、確認して design.md 第10章に記録する
- **`spec/domains/search.md` の 271行が総崩れになる規模感** — FTS5 同期更新に切り替えると `IndexerReadPort`・ファンアウトの読み直し・冪等 upsert・インデックス更新フローの表がまるごと不要になる。#35 の作業量が大きいので、design.md の引き継ぎ表で「どの節が消え、何に置き換わるか」まで書いておく
- **`spec/domains/index.md:32` のテナント分離規約の読み替え漏れ** — 「例外は Outbox 経由の信頼済み内部イベントを契機とするワーカーのみ」という条項が、Outbox 廃止で宙に浮く。design.md 第4.5節で結論を出さないと #35 が判断できない
- **未コミットの wrangler 4本の扱い** — 本 Issue で commit も削除もしない。ただし #37 の担当者が「既にあるから使える」と誤認しないよう、design.md 第1.3節で「先行ブランチの残骸であり、`app/server.state.ts` が無いため現ブランチでは動かない」と明記する
- **Account Home を導入するかどうかで設計の複雑度が大きく変わる** — 2クラス構成（User Data + Directory）に畳めれば saga も epoch も軽くなるが、signup 部分失敗・退会中・古い PITR mapping・credential 変更後の session を区別できなくなる。**design.md 第3.1節で理由付きで必ず決着させる。「未決事項」に落とさない**（AC-21）。DO クラス数・saga の phase 数・session 検証が per-request RPC になるか・PITR の restore 対象境界のすべてがこの分岐に依存するため、未決のままでは #37 は1行も書けず、受け入れ条件9「#37 が成果物だけを見て着手できる」と直接衝突する。Account Home を採る場合は、`.thread/1/adr.md` ADR-002 の「DB を触らずに検証する / サーバー側失効の手段が無い」というトレードオフが実質的に覆ることを第5.1節に明記する。**「セッション方式そのものを扱う別 ADR を起こす必要があるか」の判断も、第3.1節の結論が出た時点で本 Issue が下し、結果を第5.1節に書く**（#37 の着手前に誰かが決める、という形にしない — 判断の実行主体と場所が誰にも割り当てられなくなる。`.thread/34/adr.md` ADR-004 参照）
- **canonical 正規化の未定義による一意性の静かな破壊** — `Email.create` は `trim().toLowerCase()` のみで NFKC も case folding も IDN 正規化もしない。canonical 値を HMAC して bucket を選ぶ設計では、1バイト違う正規形が別 bucket に落ち、「重複アカウントが例外なしに2つできる」という検出しにくい形で一意性が破れる。しかも規則を後から変えると全 mapping の再写像が必要になり事実上一方通行。design.md 第5.2.1節で決着させる
- **鍵ローテーションがデータ本体の移送になる** — `userId` 由来 locator と credential 由来 locator を区別せずに「世代付き secret で HMAC」と書くと、鍵ローテーションが全ユーザーの User Data DO を移送する作業になる（DO の名前が変われば別オブジェクトで、データは付いてこない）。第5.2.2節で2系統に分ける
- **プラットフォームエラーの翻訳を落とす** — `overloaded` は公式が**リトライ禁止**と明記しているので、リトライ可能系のエラーに写すと過負荷を増幅する。`SQLITE_FULL` は「書き込みだけ失敗し読みと DELETE は通る」半死状態で、通常の失敗と同じ扱いにすると復旧手段（DELETE）を塞ぐ。第4.7節で翻訳表を決める
- **lazy migration が `blockConcurrencyWhile` の30秒制約に当たる** — 「最初のアクセス時に migration」は実装上ほぼ確実に constructor + `blockConcurrencyWhile` になるが、30秒でタイムアウトし DO がリセットされる。10 GB まで育った DO で単発適用が成立する保証はない。第9.2節で前提付きで断定する
- **wall time だけで「1回で完了する」と結論してしまう** — bulk migration や FTS5 の全件再インデックスで先に当たるのは **CPU 予算（既定30秒 / 設定で最大5分の active CPU）** であって Alarm handler の wall time（15分）ではない。「Alarm 経由なら15分あるので単発適用で足りる」と書くと、10 GB まで育った DO で実際には30秒 CPU で落ちる。第9.2節と第7.4節の判定基準を CPU 予算で書く
- **調査の「全数」が全数でない** — 手作りの列挙は必ず漏れる（1周目に7件 → 16行、2周目に16行 → 25行、**3周目に25行 → 29行**と3周連続で拡大した）。3周目の漏れ（`ADP-export-002` / pruner 専用 WorkerContainer / `ai_client_connections` のスキーマ行 / `ADP-search-001`）は**述語が緩かったこと**が原因で、とくに「`user_id` 列を持たない・PK に含まないテーブル」は全テーブルが単一列 TEXT の `id` を PK にしている以上、判定として機能していなかった。**是正は3点** — (1) 述語を「引き方の経路に `user_id` が入っているか」に言い直し、表より先に節へ書く、(2) 引数オブジェクトの中の `userId` も「第一引数ではない」として扱いを揃える、(3) **AC-22 の主判定を行数から台帳走査そのものへ入れ替える**（行数を主判定にする限り、表自体が不完全なケースは主判定では捕まらない）。第4.3節は執筆前に `ADP-*` 台帳を機械走査し直す。台帳の粒度で捕まらない次元（DI・ジョブ・未設計領域）だけを手で補う
- **プラットフォーム事実の「裏取り済み」を過信する** — 2周目のレビューで「14項目は公式ドキュメントで全件一致」と確認したにもかかわらず、3周目に**3件の誤りが見つかった**（`idFromName` の名前は復元できない → `ctx.id.name` は公式 API として実在 / 「仮想テーブルは原則禁止だが FTS5 のみ例外」は出典なし / `bm25`・`snippet`・`highlight` は公式未記載なのに「公式にサポート明記」と書いていた）。**表を「裏取り済み」と宣言していること自体が再点検を止める作用を持つ**ので、ステップ1 の差分確認では「値が変わったか」だけでなく**「その主張が出典ページに実在するか」**を各行について見る。とくに**裏付けの種別（公式記載 / 実測 / 未確定）の取り違え**は、#35 / #37 に「公式保証」と誤認させる形で波及する
- **AC-20 の既知 untracked ホワイトリストが実データとずれる** — 3周目に `.thread/36/` の欠落で「必ず誤検知で落ちる検査」になっていた。ホワイトリストは**着手時点で `git status --porcelain` を実際に実行して作り直す**。検査を書くときに実データを見ないと、検出装置そのものが壊れる
- **セッション / OAuth トークンストアが未定義のまま締まる** — `spec/database/index.md:355-357` が「スコープ外」と宣言しているのに、`identity.aiClientRevoked` の consumer がそこを書き換える前提で設計が組まれている。DO 化では「本質的にグローバルでスキーマ未定義」なストアが最も厄介な部類になる。ここを空欄のまま design.md を締めると、#37 が MCP 認可経路を実装しようとした時点で設計を自分で起こすことになり、受け入れ条件9 を破る。第5.4.1節で決着させる
- **`.adr/` に残らない波及最大の帰結** — ドメインポートの同期化（第8.2.1節）と、Account Home 採用時の session 方式の変更（第3.1節 / 第5.1節）は、寿命テスト・波及テストを最も明確に通る帰結でありながら `.adr/` の骨子から抜けていた。**`.adr/` のファイル数は増やさずに**、`.adr/004` と `.adr/002` の影響節に1行ずつ入れて閉じる（仕組みを書かないので AC-6 は破らない）
- **design.md の分量が Issue の要求を超えて制御されない** — 構成案は11章・約50節あり、Issue の対応項目3・4 が求める12項目程度を大きく超える。全部を同じ重みで断定形にすると根拠の薄い断定が混ざる。各節に3ラベルを付け、AC-5 の対象を「Issue 要求 / 派生」に絞る

## テスト方針

コード変更が無いため、自動テストは追加も変更もしない（`pnpm typecheck` / `pnpm lint` / `pnpm test` はいずれも本 Issue の差分に反応しない）。品質の担保はドキュメントレビューと機械的検証で行う。

**機械的検証（実装ステップ10）**

成果物を commit した後に、**`git diff --name-status main...HEAD` と `git status --porcelain` の2コマンドの出力だけで**置き場所を判定する（作業ツリー比較と committed 比較を混ぜると、commit 前後のどちらかで必ず空振りする）。

- `git diff --name-status main...HEAD`:
  - `.adr/` 配下が `A` 3行のみで `.adr/001-*.md` が現れない（AC-1 / AC-2 / AC-3）
  - `spec/adr/` 配下が `M spec/adr/005-*.md` の1行のみ、`A` が無い（AC-9）
  - `.thread/1/adr.md` が `M`（AC-8）
  - 全体が `.adr/00{2,3,4}-*.md` / `.thread/34/**` / `spec/adr/005-*.md` / `.thread/1/adr.md` のみ。`packages/core/` / `apps/web/app/` / `infra/` / `*.toml` / `*.ts` が0件（AC-20）
- `git diff main...HEAD -- .thread/1/adr.md` の削除行 = 0、追加は supersede ポインタ1行のみ（前後の空行を除く。ステップ8 の書式に従えば追加行 = 2）（AC-8）
- `git diff main...HEAD -- spec/adr/005-*.md` の差分が `## ステータス` 節に収まり `## コンテキスト` 以降が不変。ポインタ先が `.adr/003` と `.adr/004` の両方（AC-7）
- `git status --porcelain` に、**既知の untracked 以外**の未コミット変更がゼロ（AC-20。commit 漏れ検出）。**既知の untracked = 着手時点の実測6エントリ** — `.artifacts/` / **`.thread/36/`** / `apps/web/wrangler.{request,state}.{production,staging}.toml`（4本）
- `ls .adr/` = 4件、各 H1 が `# 00N. <和文タイトル>`、各5節（AC-1）
- `.adr/` 3件に SQL / DDL / bucket 数 / 関数シグネチャが出現しない、各50行以内（AC-6）
- `.adr/` 3件と design.md の ADR 参照がすべてパス付き（無修飾の `ADR-NNN` が無い）
- `spec/inventory/adapter.md` の `ADP-*` 全85件を走査し、述語に該当する全件が design.md 第4.3節の表にある（AC-22 の主判定）
- `grep -rlE 'Outbox|outbox|consumer|ベクトル|埋め込み|ハイブリッド' spec` のヒット全件に「改訂する / 影響なし」の判定が付いている（AC-16 の網羅性。`spec/*/review/**` と `spec/idea.md` は除外可）
- 文書間の相互リンクがすべて実在ファイルを指す

**なお、`spec/manual-tests/trash.md:18,204,212,351` は「pruner ワーカーを手動起動できること、またはテスト環境の DB で `trashedAt` を直接更新できること」を前提にしている。** retention を各 DO の Alarm へ移すとこの手動起動口の形が変わる（Alarm の強制発火 / 時計の巻き戻しに相当する手段が要る）。本 Issue ではマニュアルテストを書き換えないが、design.md 第11.1節（#35 のマニュアルテスト改訂）と第11.3節（#38 の運用手順）の両方に1行ずつ拾って取りこぼしを防ぐ。

**レビュー観点**

- **要件カバレッジ** — 受け入れ基準表の AC-1〜AC-23 が1件ずつ検証できるか。Issue 本文の受け入れ条件9項目に取りこぼしが無いか
- **書き先の妥当性** — `.adr/` に書かれた各段落が寿命テスト・波及テストの両方を満たすか。満たさないものが混ざっていないか。逆に design.md に書かれた内容のうち、`.adr/` に昇格すべきものが漏れていないか
- **設計の完全性** — design.md の各節が断定形で終わっているか。「検討する」「今後決める」で終わる節が第7〜9章に無いか（第7.2.1節は #35 への委譲を明示する節なので対象外）。第11.4節「未決事項」に Account Home が現れていないか
- **後続 Issue の着手可能性** — AC-16 / AC-17 / AC-19 の検証欄に格上げ済み。ロールプレイ確認（#35 / #37 の担当者になったつもりで読み下す）は実装ステップ10 の必須項目として実行する。ここでは加えて、design.md が先行ブランチ・`.thread/19/`・`.thread/1/adr.md` 抜きで読めるか（自己完結性）を見る
- **事実の正確性** — 現行実装への言及（`PendingBatch` / `_occ_guard` / `listExpiredItems` / `IndexerReadPort` / `findActiveById` など）が実際のコード・spec と一致しているか。Cloudflare のプラットフォーム制約に出典があるか
- **PII 方針の一貫性** — routing key の導出・ログ・URL・エラーメッセージのすべてで PII 非露出が貫かれているか。設計上「ここだけ生値が出る」箇所が残っていないか

## レビュー履歴

### 1周目

2視点（要件カバレッジ / アーキ整合・リスク）で計26件の指摘。台帳の判定はすべて `fix`、`wont-fix` / `defer` はゼロ。

**修正した点**（問題点 P-xxx）:

- coverage P-001: 受け入れ条件9「後続 Issue が成果物だけを見て着手できる」を検証可能にした。AC-16 / AC-17 の検証欄に「design.md 単体で意味が通る」ロールプレイ確認を格上げし、AC-19（自己完結性 — 先行ブランチのコミット番号・ブランチ名・`.thread/19/` のファイル名で内容を代替していない）を新設。実装ステップ10 の必須検証項目にも追加
- coverage P-002: AC-20（`git diff main...HEAD --name-only` がドキュメントのみ）を新設。実装ステップ10 と「機械的検証」にも同じ検査を追加。untracked の wrangler 4本が誤判定されないことを注記
- arch P-001: design.md 第5.2.1節「canonical 化の定義」を独立した決着項目として新設（正規化手順 / `Email.create` を唯一の出所にするか / SSO subject の provider 別扱い / 規則変更は鍵ローテーションと同格）。AC-23 で担保。リスク節にも「一意性の静かな破壊」として追加
- arch P-002: 第5.2.2節「locator 鍵の分離」を新設。`userId` 由来（鍵に依存させない・ローテーション対象外）と credential 由来（世代付き secret・ローテーション対象）の2系統に分け、ローテーションがデータ本体に波及しないことを構造として示す
- arch P-003: 第6.2.1節「canonical credential の保持と保護」を新設（保持場所 / 暗号化鍵の所有者と配布境界 / 復号が許される経路 / 退会時の消去範囲）
- arch P-004: ユーザー境界に閉じない処理の棚卸しを7件から**6カテゴリ16箇所**へ拡張。調査結果に全数の表を追加し、AC-22 で「各行に行き先が割り当てられている」ことを担保。あわせて横断調査で否定された懸念（admin 画面が存在しない等）も記録
- arch P-005: 第8.2.1節「既存ドメインポートの Promise 契約との整合」を新設。`transactionSync` の完全同期と `TransactionalRepository` / `UserRepository` の Promise 契約の衝突を決着項目にし、`CLAUDE.md`「domain / application / presentation は無傷」の記述改訂を #35 引き継ぎへ送る
- arch P-006: 第8.3節を (a) 実行位置 / (b) request 側 DI に残るもの / (c) `getContainer()` の去就 / (d) `SerializedError` の維持 の4点に分割。AC-17 の検証項目に `application/di/{types.ts,containerStore.ts}` と `apps/web/app/presentation/` を追加
- arch P-007: Account Home 採否の「未決事項に落とす」逃げ道をリスク節から削除。AC-21 を新設し、design.md 第3.1節で必ず結論づけることを要求。`.thread/34/adr.md` ADR-004 の Decision を条件付きに書き直し、ADR-005 として判断を記録

**取り込んだ改善提案**（S-xxx）:

- coverage S-001 / arch S-010: 第7.2節を「FTS5 のみで日本語全文検索が成立する根拠」に絞り、検索 API の仕様（topic filter / trash 除外 / 安定順位 / snippet / ページング）は第7.2.1節で #35 へ委譲。AC-5 の対象から外し、スコープ「含まれないもの」にも明記
- coverage S-002: AC-13 の解決責務を Issue 列挙の4サブ項目（正規化メール→userId / SSO provider+subject→userId / 一意性 / 認証情報の所有境界）へ下ろし、Account Home へ委譲する場合は委譲先を明記する形にした
- coverage S-003: AC-14 の必須部分を Issue の3点に揃え、鍵の所有者・世代管理は第5.2.3節の任意論点へ降格（第3.2節の Worker 分割の結論と整合すればよい）
- coverage S-004: AC-3 / AC-7 / AC-8 の対応ステップ列に自己検証ステップを追加
- coverage S-005: AC-7 の「前提」として design.md 第7.1節が肯定的結論を出した場合に実施すること、否定的結論なら supersede 対象と AC-7 / AC-10 を見直すことを実装ステップ7に明記
- coverage S-006: 調査結果に「`.thread/1/progress.md` の残存課題の扱い」を新設。残存課題5（D1 データベース名 / outbox テーブル名の乖離）は本 Issue でリネームせず、D1 / Outbox 廃止に伴う対象消滅として #37 引き継ぎに1行残す方針を記録
- arch S-001: 先行ブランチの一次資料の棚卸しを `.adr/` 8件から拡張。`.thread/19/adr.md`（10件）/ FTS5 実測 spike / #33 の6ラウンドレビュー（B-IDDS6-001 の落とし穴を含む）を表で追加し、実装ステップ1で一括して読む
- arch S-002: 実装ステップ1「Cloudflare プラットフォーム事実と先行資料の確定」を新設し、以降を2〜10 にリナンバー。裏取り済み14項目を調査結果に表として取り込み、ステップでは差分確認に留める。公式に記載が無い4項目は「未確定」として区別
- arch S-003: `spec/adr/005` の supersede 先を `.adr/003` と `.adr/004` の両方に変更。AC-7 / AC-10・実装ステップ5〜7・ADR 骨子を更新。判断は `.thread/34/adr.md` ADR-006 に記録
- arch S-004: 第6.2節を「固定 bucket の先取り」から3案比較（単一グローバル / 固定 bucket / credential 単位 DO）へ変更。credential 単位 DO を採らない理由は「ローテーションと retirement 証明のための列挙可能性」に求める形にした
- arch S-005: 第11.2節（#37 引き継ぎ）に `infra/cloudflare/pulumi/resources/index.ts`（destroy 保護の解除手順を含む）/ `apps/web/wrangler*.toml` / `vitest.config.integration.ts`（`include` への `durable-objects/` 追加判断を含む）を追加。AC-17 の検証欄にも反映
- arch S-006: 調査結果に「既存 D1 データのカットオーバー」を新設。「移行しない。DO 側で作り直す」を第11.2節で断定することを明記（空欄にしない）
- arch S-007: 第9.2節に `blockConcurrencyWhile` の30秒タイムアウト・Alarm handler の15分との突き合わせを追加。第9.3節に分割・再開方式を条件付きで追加。リスク節にも記載
- arch S-008: 第4.7節「DO プラットフォームエラーの翻訳表」を新設（`overloaded` はリトライ禁止・`SQLITE_FULL` の半死状態・`ctx.abort()`）。第8.3節 (d) から参照
- arch S-009: `.adr/002` の決定節に「DO トポロジーと認証権威の所在は design.md 第3章で確定する」の1文を置く指示を実装ステップ4に追加。所在の宣言に留め AC-6 を破らないことも注記
- arch S-011: 第5.2.4節「location hint / jurisdiction」を新設。「今は既定のまま。将来変えるならオブジェクト再作成が必要」を1行で決め切る
- arch S-012: `spec/manual-tests/trash.md` の pruner 手動起動口を「テスト方針」に明記し、第11.1節（#35 のマニュアルテスト改訂）と第11.3節（#38 の運用手順）へ1行ずつ拾う指示を追加

**見送った提案とその理由**:

- なし（台帳の判定は26件すべて `fix`）

### 2周目

2視点（要件カバレッジ / アーキ整合・リスク）で計25件の指摘。台帳の判定は `fix` 24件・`wont-fix` 1件。プラットフォーム事実14項目は公式ドキュメントで全件一致が再確認され、**プラットフォーム制約の誤認はゼロ**。指摘は「抜け」と「現行実装についての事実誤認」に集中した。

**修正した点**（問題点 P-xxx）:

- coverage P-001: 実装ステップ10 の検証が commit 状態に依存し、単一パスで AC-3/7/8/9 と AC-20 を同時検証できなかった（commit 前は AC-20 が空振り、commit 後は他4つが空振り）。**置き場所の検査を `git diff --name-status main...HEAD` と `git status --porcelain` の2コマンドに統一**し、AC-3 / AC-7 / AC-8 / AC-9 / AC-20 の検証欄もそれに合わせた。既知の untracked 4本以外の未コミット変更がゼロであることの確認を追加し、commit 漏れによる空振りも塞いだ
- coverage P-002 / arch P-002: 「ユーザー境界に閉じない処理の全数（6カテゴリ16箇所）」が全数でなく、AC-22 の件数表現も調査結果の表と不一致だった。**`spec/inventory/adapter.md` の `ADP-*` 台帳（スキーマ14件 + ポート実装71件）を全件走査して表を取り直し、8カテゴリ・25行に更新**。2周目で足りたのは `PasswordResetTokenPort.verifyAndConsume` / `UserRepository.findByEmail`・`findBySsoIdentity` / `UserRepository.insert`・`save` / `SearchIndexPort.upsertMemo`・`upsertDocument` / `AiClientConnectionRepository.insert`・`save` / 期限切れ列挙用インデックス3本と `users` 全ユーザー JOIN / `password_reset_tokens` の期限切れ掃除（`spec/usecases/` に定義が無い未設計領域）/ トークン失効 consumer の書き込み先が未定義であること / indexer 専用 WorkerContainer。AC-22 の検証を「25行の網羅」＋「`ADP-*` 全件走査で漏れゼロ」の2段にし、カテゴリ数は補助へ降格。`.thread/34/adr.md` ADR-011 に記録
- coverage P-003: ステップ10 で検証される AC-1 / AC-16 / AC-17 / AC-21 / AC-22 の対応ステップ列に `10` を追加。どの AC にも紐づいていなかったステップ1 に「満たす AC: AC-5 / AC-19」を明記
- coverage P-004: 実装ステップ9 が `.thread/34/adr.md` を「新規」扱いしていたが、実物は ADR-001〜008 が既存だった。**「既存・追記」に改め、既存分の内訳表を置き、ADR-014 以降への追記であることを明示**。AC-18 の検証欄を「着手時点の件数から増えている、または増えなかった理由が記録されている」に強化し、着手前に空振りで充足しない形にした
- arch P-001: プラットフォーム事実表に **DO の CPU 時間上限（既定30秒 / 設定で最大5分の active CPU）** を追加。第9.2節（lazy migration）と第7.4節（Alarm ジョブの bounded 処理）の「1回の入力で完了するか」の判定基準を **wall time ではなく CPU 予算で書く**ことを実装ステップ1・3 に明記。`blockConcurrencyWhile` の30秒と CPU 既定30秒が偶然同値なので書き分ける旨も追記。リスク節にも追加
- arch P-003: 「パスワードリセット・SSO・MCP / REST OAuth・`AiClientConnection`・`TokenScope` は実装が1行も無い」が事実誤認だった。**実測に基づき内訳へ訂正** — SSO は値オブジェクト・エンティティ（`entity.ts:29-34` の `SsoUser`）・スキーマ（`migrations/0000_initial.sql:33-34,41-42,47` の `users_sso_identity_uq` 含む）・リポジトリ・view / eventDecoders・UI まで実装済みでユースケースとルートだけが無い。`AiClientConnection` は値オブジェクトと `Actor` 判別共用体（`valueObject.ts:125-140,142-161,191-196,206-214`）だけが実装済み。あわせて「既存コードの書き換えコストはほぼゼロ」を訂正し、第6.1節 / 第6.6節を「これから設計する」ではなく「既存実装をどう移すか」として書くよう指示を追加
- arch P-004: design.md 第5.2.5節「ハッシュ衝突の扱い」を新設。(a) HMAC 出力の切り詰めの可否（credential 単位 DO で切り詰めると「別人のアカウントに解決する」認証境界の破れになる）、(b) 「bucket index は衝突しうる / 一意性は bucket 内で canonical を突き合わせて確定する」の2段構造。第6.2.1節の動機リストに「bucket 内の識別子として必要」を3つ目として追加（原本を持たない結論に倒すと一意性が壊れるため）。AC-23 に (d) として追加
- arch P-005: design.md 第5.4.1節「セッション / AI クライアントトークンストアの所在」を新設。`spec/database/index.md:355-357` が「スコープ外」と宣言してスキーマが存在しない一方、`identity.aiClientRevoked` の consumer がそこを書き換える前提になっている構造を決着項目に立てた。(a) トークン → userId の解決先、(b) 失効の到達手段、(c) セッションストアの去就の3点。決めきれない部分は未決事項ではなく #35 引き継ぎへ送る。リスク節にも追加
- arch P-006: 波及が最大の2帰結を **`.adr/` のファイル数を増やさずに**1行ずつ入れる指示を追加。`.adr/004` の影響節に「ドメイン層のリポジトリポートの `Promise` 契約が変わりうる。`CLAUDE.md` の『ランタイム swap で domain / application / presentation は無傷』が成立しなくなる」、`.adr/002` の影響節に「認証権威の所在によっては `.thread/1/adr.md` ADR-002 のトレードオフが変わる」。あわせて `.thread/34/adr.md` ADR-004 の「#37 の着手前に判断する」を **「design.md 第3.1節の結論が出た時点で本 Issue が判断し、結果を第5.1節に書く」** に改めた（判断の実行主体と場所が誰にも割り当てられない状態を解消）
- arch P-007: AC-17（#37 引き継ぎ）に5件を追加 — `application/ports/{outboxRepository,relayTrigger,idempotencyStore}.ts` / `scripts/render-wrangler.ts` + `.tpl` レンダリング運用（`.gitignore:14-17` により staging / production の wrangler 設定は生成物で直接編集禁止）/ ローカル `wrangler.toml`（162行・DO バインディングゼロ）/ `package.json` の deploy 系10本と D1 前提の db 系7本 / indexer 専用 WorkerContainer（`application/di/types.ts:65-68`）。第3.2節の結論と対で「DO 設定を `.tpl` 経路に乗せるか」を1行決める指示も追加

**取り込んだ改善提案**（S-xxx）:

- coverage S-002 / arch S-010: design.md の各節に **`［Issue 要求］` / `［派生］` / `［参考］` の3ラベル**を付け、AC-5 の検証対象を前2つに絞る運用を新設（構成案に「節のラベル付け」の表を追加し、全節にラベルを付記）。目的は削減ではなく**肥大の可視化**。既にあった2つの例外扱い（第7.2.1節 / 第5.2.3節）を一般化した形。2周目で追加した決着項目にも同じラベルを付けた。`.thread/34/adr.md` ADR-010 に記録
- coverage S-003: AC-7 の「追記のみ」と実装ステップ7 の「書き換える」の不整合を解消。検証欄を「差分が `## ステータス` 節の範囲に収まり、`## コンテキスト` 以降に一切変更が無い」に統一し、ステップ7 に「`## ステータス` 節の1行書き換えなので削除行は伴う。禁じているのは本文の改変であって削除行そのものではない」の注記を追加
- coverage S-004: AC-1 に `.adr/` 新規3件の **H1 タイトル書式（`# 00N. <和文タイトル>`）** を検証項目として追加。既存 `.adr/001` の `# 001. 統合テストを Workers プール1本に集約する` に揃える。ADR 骨子とステップ4〜6 にも明記
- arch S-001: AC が design.md の**節番号**に強結合していた問題を、**節タイトル（論点名）での参照**に変更（AC-4 / 5 / 13 / 14 / 19 / 21 / 22 / 23）。節番号は `（参考: 第N節）` の形に落とし、構成変更で AC が壊れないようにした。AC 番号自体は動かしていない。`.thread/34/adr.md` ADR-009 に記録
- arch S-002: 第7.4節に「同じジョブ機構を Identity Directory / Account Home にも適用するか」（Directory 側にも予約の期限切れ掃除・saga 補償の再開駆動・鍵ローテーションの再写像・`password_reset_tokens` 相当の掃除が要る）、第7.6節に「メール送信ジョブをどの DO が所有するか」（パスワードリセットは userId 未確定の経路から始まるので User Data DO ではありえない）を各1行の決着項目として追加
- arch S-003: 第10.1節に「**PITR の復旧単位は DO 1個で、複数 DO を同一時点へ戻す手段は無い**。{Directory mapping / Account Home} は User Data の restore に追随しない前提で saga と退会 tombstone を設計する」を**検討ではなく結論として**追加。#38 へ送るのは手順だけにした。第6.7節からも参照
- arch S-004: プラットフォーム事実表に「**仮想テーブルへの書き込みも rows written に算入される**」を追加。第7.1節（同期更新可否の判断入力）、第4.6節（容量は「本体 + FTS インデックスの合計で 10 GB」）、`.adr/003` の影響節（「trigram インデックスの書き込み行数と容量が本体の数倍になるトレードオフ」）の3箇所に反映
- arch S-005: 第5.2.2節の論拠を訂正。「`UserId` は UUIDv7 の不透明文字列だから HMAC 不要」は実装と一致しない — `UserId.create`（`valueObject.ts:19-35`）は trim + 空文字チェックのみで、コメント `:21-23` が明言するとおり**ドメインは UUIDv7 を保証していない**。論拠を (i)「`IdGenerator` が採番し外部入力ではない」(ii)「`idFromName(userId)` に渡す値は署名済みセッション由来で、外部入力から来ることが構造的にありえない（第5.5節の保証）」の2つに置き直した。結論（HMAC 不要）は変わらない
- arch S-006: 「**ADR 参照は必ずパス付きで書く**」を ADR 骨子と実装ステップ2〜6・10 に追加。`.thread/1/adr.md` ADR-046（`:1428`）の既存規約に従う。本 Issue で `.adr/004` が生まれると無修飾の `ADR-004` が3文書（`spec/adr/004-domain-boundaries.md` / `.thread/1/adr.md` ADR-004 / 新 `.adr/004`）を指しうるため
- arch S-007: 第8.3節 (b)(c) に「`application/di/types.ts:30-52` の不変条件（**リポジトリはコンテナに載せない。`UnitOfWorkContext` が唯一の発行点**）を維持するのか、DO stub factory を例外として明記するのか」を追加。あわせて `containerStore.ts` の `getContainer()` が `globalThis` の `Symbol.for` スロット + ALS の二段構えで、**DO インスタンス内には ALS が無いため必ず throw する**（= DO 側は別の合成ルートが要る）ことも決着項目に含めた
- arch S-008: プラットフォーム事実表に「**DO namespace の名前を実行時に列挙する手段が無い**」を追加（Worker からの列挙 API は無く、REST の List Objects が返すのは object ID と `hasStoredData` だけ。`listDurableObjectIds()` はテスト専用）。第6.2節の (c) 不採用理由と第6.8節の「旧世代 locator 0件の証明」が同じ根に立つことを明示
- arch S-009: plan.md と design.md で重複する**4箇所の正本を design.md 側**と明示（プラットフォーム事実 → 第2.1節 / 境界に閉じない処理 → 第4.3節 / D1 カットオーバー → 第11.2節 / 先行案との差分 → 第1.3節）。plan.md 側の該当箇所に「正本は design.md 第N節」の1行を置き、ステップ10 に確認項目を追加。`.thread/34/adr.md` ADR-012 に記録
- arch 補足表（結論を変えない事実誤り一式）: 全件訂正した。`application/ports/` は 190行 → **186行**（内訳付き）/ `unitOfWork.ts` の `run` は「引数を取らない」→「**スコープを受け取る引数が無い**」（コールバックは取る）/ `UserId` の行範囲 `:19-34` → **`:19-35`** / `registerWithPassword.ts` の catch は `:62-79` → **`:61-79`** / `spec/adr/001〜006` は「各25〜30行」→ **24 / 23 / 23 / 31 / 28 / 25 行** / `spec/domains/*.md` の ADR 相対リンクは5ファイルのみで `trash.md`・`export.md` には無い（`spec/adr/005` を触っても壊れるリンクは無いことの裏付けとして記録）/ `.adr/003` 骨子の `spec/adr/005` 根拠の引用を原文（`:9` 「外部API呼び出しを伴い、書き込みトランザクション内で同期実行すると投稿の快適さを損なう」）に修正 / 共有基盤テーブルは「spec: `outbox` / 実装: `outbox_events`」と併記 / 管理者機能不在の根拠を「grep 0ヒット」から「ページ定義が P-01〜P-14 のユーザー向けのみで管理者向け画面・統計の定義が無い」に置き換え / 実装ステップ9 の `.thread/34/adr.md`「新規」→「既存・追記」

**見送った提案とその理由**:

- **coverage S-001（AC 表を23件 → 19件へ統合する）— `wont-fix`。** 指摘自体は正確で、重複3組（AC-1/AC-2、AC-4 と下位 AC 群、AC-16/AC-17 と AC-19）はそのとおり。それでも統合しない理由は2つ。(1) **AC 番号の付け替えがレビュー記録を壊す** — `.thread/34/plan-review/round-{1,2}-*.md` と `triage.md` は AC 番号で指摘を特定しており、統合すると AC-5 以降が全部ずれて過去2周のレビューがどの基準を指していたのか追えなくなる。(2) **検証粒度が落ちる** — AC-1（3件が存在するか）と AC-2（3件を超えていないか）は失敗モードが違い（書き忘れ / 先行ブランチからの流入）、Issue が「書き先の取り違えが最大の失敗要因」と名指ししている以上、同じ `ls` の出力でも判定を分ける価値がある。冗長性そのものは coverage S-002 / arch S-010 のラベル付けで解消した。判断は `.thread/34/adr.md` ADR-013 に記録。なお突き合わせコストへの懸念には、置き場所ガード（AC-2/3/6/7/8/9/20）を単一の `git diff --name-status main...HEAD` の出力から一括判定できる形に整理することで応えている（coverage P-001）

### 3周目

2視点（要件カバレッジ / アーキ整合・リスク）で計14件の指摘。台帳の判定は**14件すべて `fix`**、`wont-fix` / `defer` はゼロ。今回は「**裏取りしていない記述**」に指摘が集中した — 検証コマンドを実データで走らせていない（AC-20 のホワイトリスト）、公式ドキュメントを再取得していない（プラットフォーム事実表の3件）、実ファイルの行番号・本数を測っていない（引用のずれ7件）。今周のレビューは `git status --porcelain` の実行、公式ドキュメント4ページの再取得、`spec/inventory/adapter.md` 85件の全件走査を伴っており、指摘はすべて実測との突き合わせで出ている。

**修正した点**（問題点 P-xxx）:

- coverage P-001 / arch S-003: **AC-20 の既知 untracked ホワイトリストに `.thread/36/` が無く、この検査が現在の作業ツリーでは必ず誤検知で落ちる状態だった。** 放置すれば AC-20 後半が偽陽性で落ち、commit すれば AC-20 前半（差分の限定）を破るという詰みになる。`git status --porcelain` を**実際に実行**して全6エントリを実測し、ホワイトリストを `.artifacts/` / **`.thread/36/`** / `apps/web/wrangler.{request,state}.{production,staging}.toml`（4本）に作り直した（AC-20 / 実装ステップ10 / テスト方針の3箇所）。あわせて調査結果「未コミットの残骸」に実測出力そのものと「`.thread/36/` は #36 の作業ログ。完了済み Issue の作業ログの commit 要否は本 Issue の判断対象ではないので触らない」を記録し、スコープ「含まれないもの」にも1行足した。ADR 3系統の表には `.thread/{1,19,30,36}/` の tracked / untracked の別を明記。判断は `.thread/34/adr.md` ADR-017 に記録
- coverage P-002: **AC-16（#35 引き継ぎ）の必須ファイル一覧が、FTS5 同期更新 + Alarm 化で確実に無効化される spec 群を落としていた。** 実際に `spec/` を走査して、`spec/usecases/{search,trash}.md`（`maintainSearchIndex` = `:85-` / `pruneExpiredTrashItems` = `:311-`。前者はユースケースごと消える）・`spec/testcases/{search/maintainSearchIndex,trash/pruneExpiredTrashItems}.md`・`spec/inventory/{usecase,test}.md`（`UC-search-002` / `UC-trash-007` / `TC-maintainSearchIndex-*` 28件 / `TC-pruneExpiredTrashItems-*` 17件）・`spec/index.md:38-43`（ADR 一覧表）・`spec/scenario/search.md:6,25`・`spec/manual-tests/search.md:5,17,69,266`・`spec/pages/index.md:180`・`spec/requirements.md:108` を追加した（AC-16 と構成案 11.1 の両方）。**列挙の網羅性は 4.3 と同じ手（機械走査）で担保する** — 実装ステップ3 と構成案 11.1 に「引き継ぎ表を書く前に `grep -rlE 'Outbox|outbox|consumer|ベクトル|埋め込み|ハイブリッド' spec` を走らせ、ヒット全件に『改訂する / 影響なし』の判定を付ける（`spec/*/review/**` と `spec/idea.md` は履歴文書なので除外可）」を追加し、テスト方針の機械的検証にも項目を足した
- arch P-001: **プラットフォーム事実表の「`idFromName` に渡した名前は復元できない」が誤りだった。** 公式ドキュメント `/durable-objects/api/id/` を再取得して確認 — `name` は `DurableObjectId` の optional property として実在し、公式が「especially useful inside alarm handlers, where there is no calling client to pass the name as an argument」と本 Issue が設計する Alarm ジョブそのものを用例に挙げている。事実表を「実行時に **namespace** を列挙する手段は無い。ただし DO の内側からは `ctx.id.name` で自分の名前を読める（公式）」に書き直し、公式が明記する4つの制約（`newUniqueId()` 由来は `undefined` / `idFromString()` 経由も `undefined` / 1,024 バイト超は渡らない / 2026-03-15 より前の Alarm には名前が無い）も足した。**第6.2節 (c) の不採用理由と第6.8節の結論は再オープンしない** — そこで効いているのは「namespace を実行時に列挙できない」という別の（確認済みで正しい）事実なので、その旨を事実表と第6.2節の両方に1行添えた。一方、第6.3 / 6.8 / 7.4節の「DO に自分の routing key を明示的に渡す」配線は不要になりうるので、第6.3節に「明示的に渡すのをやめるか冗長に持つかを1行決める」を追加。PII 側（第5.2節）には「DO 名は `ctx.id.name` で内側から可読であり、かつ 2026-06-12 の changelog 以降ダッシュボードのメトリクスを『by an individual Durable Object's ID or name』で絞り込めるので、生クレデンシャルを DO 名に使うと運用面にも露出する」を追加した（HMAC を使う理由が1つ増える）
- arch P-002: **「仮想テーブルは原則禁止だが FTS5 のみ例外」は公式ドキュメントに存在しない記述だった。** `/durable-objects/api/sql-storage/` を再取得したところ、公式にあるのは「Durable Objects support a subset of SQLite extensions ... FTS5 module for full-text search (including `fts5vocab`)」だけで、仮想テーブルに言及するもう一箇所は課金の一文（実在）であり、むしろ一般に使える前提の書き方だった。`bm25` / `snippet` / `highlight` も**一語も現れない**。FTS5 行を「公式に明記されているのはモジュール本体と `fts5vocab` のみ」に縮め、`bm25` / `snippet` / `highlight` / トークナイザ（trigram）を**まとめて**「公式未記載。根拠は `.thread/19/spike/fts5.integration.test.ts` の workerd 上での実測（および workerd の allowlist ソース）」側へ移した。「仮想テーブルは原則禁止」の一文は削除。裏取りできない4つは**ステップ1 で実測して「実測で確認済み」か「未確定」かを確定させる**項目に落とし、spike が触れていない関数があれば第7.2節と `.adr/003` はその関数に依存しない書き方にすることを明記した。判断は ADR-019 に記録
- arch P-003: **「ユーザー境界に閉じない処理の全数」に `ADP-export-002` と pruner 専用 WorkerContainer が抜けていた。** `spec/inventory/adapter.md` の全85件を再走査して**25行 → 29行**に更新。追加は (1) **`ADP-export-002`（`ArchiveWriter.write`）** — userId をどこにも取らず行26 の `MailSender` と同型だが行き先は外部 I/O では**ない**。`spec/domains/export.md:282` が同期生成と確定させ `:267` が単一トランザクション読みを要求する以上、read → render → zip の連鎖ごと DO の中に入り、最大 10 GB を持ちうる single-threaded な DO で zip エンコードを回すことになる。行き先を「User Data DO に閉じるが、実行位置と CPU 予算の判断対象」として第8.3節 (a) の入力に接続し、**第4.8節「DO 内で回す大きな CPU 仕事の扱い（分割 / 上限 / 拒否）」を新設**した、(2) **pruner 専用の拡張 WorkerContainer**（`spec/usecases/trash.md:315`。カテゴリ H は1行ではなく2行だった。AC-17 の #37 引き継ぎにも追加）、(3) `ai_client_connections` のスキーマ行（`spec/database/index.md:134` が `findActiveById(id)` を `user_id` 述語なしの PK 素引きと定めており、行1〜3 と同型）、(4) `ADP-search-001`（`SearchIndexPort.query`。userId が引数オブジェクトの中にある点で行16 の `upsertMemo(entry)` と同じなので扱いを揃えた）。行22（旧行20）は「4項目挙げて `ADP-*` を3つしか持たない」不整合を3項目に整理。**述語そのものも言い直した** — (b)「`user_id` 列を持たない・PK に含まないテーブル」は全テーブルが単一列 TEXT の `id` を PK にしている以上全件が該当してしまうので、「`user_id` 列が無い、または**引き方の経路**に `user_id` が入っていないテーブル」に修正し、述語の定義を表より先に置いた。**AC-22 の主判定と再走査を入れ替え**、主判定を「`ADP-*` 全85件に述語を当て直し、該当する全件が表にある」、行数（29）とカテゴリ数（8）を走査結果から導かれる補助に降格した（判断は ADR-014）

**取り込んだ改善提案**（S-xxx）:

- coverage S-001 / arch S-002: **AC-5 の断定形要求の対象を、節の列挙ではなくラベルで定義し直した。** 列挙から2つの節が漏れていた — 「FTS5 のみで日本語全文検索が成立する根拠」（第7.2節。AC-5 が明示的に除外していたため `.adr/003` の根拠に結論を要求する AC が1つも無い状態だった。trigram の可用性は実測だけが根拠という最も結論の明記が要る部類）と「分割方式」（第6.2節。#37 の前提なのに「(b) が有力だが最終決定は #37」で通ってしまう状態だった）。対象を `［Issue 要求］`/`［派生］` の全節とし、例外は `［参考］` と第7.2.1節（#35 へ委譲を明示宣言）だけにした。ADR-007 の「範囲の限定」と「断定形要求の免除」は別物である旨も明記。構成案の第6.2節にも「AC-5 の射程内。最終決定は #37 で終えない」を書き込んだ（判断は ADR-015）
- coverage S-002: **AC-8 の「追加行が1」が Markdown の空行規約と両立しない**問題を、判定の書き換えと挿入書式の固定で解消した。実測（`.thread/1/adr.md` は `:160` 見出し / `:162` `### Status` / `:164` `Proposed`）に基づき、ステップ8 に「`Proposed`（`:164`）の直後に空行1行 + ポインタ1行を挿入する」と書式を固定し、AC-8 の判定を「**削除行がゼロ、かつ追加が supersede ポインタ1行のみ（前後の空行を除く）**」に書き換えた（`git diff` 上の追加行は2）。テスト方針・ステップ10 も同じ表現に揃えた（判断は ADR-016）
- coverage S-003 / arch S-005: **数値・行番号・出典のずれ7点を実測で訂正した。** (a) deploy 系は10本ではなく**非 dry 12本 / 全24本**（`deploy:{staging,production}:all` の2本が漏れていた。`grep` で実測）、(b) `getContainer()` は `containerStore.ts:11-27` ではなく**`:39-57`**（`:11-27` は `Symbol.for` スロットと install / read ヘルパ。2つ目の throw が `:49-55` である点は正しかった）、(c) `WorkerContainer` は `types.ts:65-68` ではなく**`:70`**（`:61-69` は JSDoc）、(d) `spec/adr/005` を参照している相対リンクは3本ではなく**実測6本**（`spec/index.md:42` / `spec/database/index.md:6` / `spec/domains/{search,memo,knowledge}.md` / `spec/usecases/search.md:3`。いずれもファイル自体を指すので「ステータス節の書き換えで壊れない」という結論は不変。うち2本は #35 の改訂対象なので AC-16 へ回した）、(e) **Alarm handler の wall time 15分の出典は alarms ページではなく limits ページの "Wall time limits by invocation type" 表**（alarms ページは duration / wall time を一切述べていないことを再取得で確認）、(f) D1 前提の db 系7本は正しいが `db:migrate` も道連れになる旨を追記、(g) `0000_initial.sql` は末尾改行が無いため `wc -l` が46 を返すが `:47` に `users_sso_identity_uq` が実在する（表記は据え置き、`:46`/`:47` の引用はいずれも実測と一致）
- arch S-001: **実装ステップ2 の前方依存**（第4.3節の行き先・第5.4.1節 (b)・第6.4節がステップ3 の第7章の結論に従属する）を明記し、解消手順を3段階で定めた — (1) ステップ2 では「7.1 / 7.3 の結論に従属。暫定判定: 〜の見込み」と暫定と分かる形で書く、(2) ステップ3 で第7章を書き終えた直後に戻って確定に置き換える、(3) ステップ10 で「暫定」「見込み」「〜次第」が第4〜6章に残っていないことを確認する。順序を入れ替えないのは、第7.5節が第4.3節に、第7.4節が第3.1節 / 第6.4節に依存する**相互依存**だからである（判断は ADR-018）
- arch S-004: **CPU 予算の「リセット」意味論**を事実表に追記した。公式原文「Each incoming HTTP request or WebSocket message **resets** the remaining available CPU time to 30 seconds」「If you consume more than 30 seconds of compute between incoming network requests, there is a **heightened chance that the individual Durable Object is evicted and reset**」を再取得で確認 — 30秒は固定の総量ではなく**着信ごとに戻る枠**であり、**着信の無い Alarm 駆動では戻す契機が無い**。しかも超過の帰結はエラーではなく**エビクションとリセット**。第9.2節（lazy migration）に「bulk migration は途中まで進んで黙ってリセットされる。『例外が上がるから検出できる』を前提にした設計にしない（第9.3節の部分適用の記録が必須になる）」を、第7.4節（Alarm ジョブ）に「1回の Alarm で処理する量は進捗をコミットしてから次の Alarm を張る単位（チェックポイント）で切る」を追加。第4.7節（エラー翻訳表）にも「CPU 予算超過は翻訳の対象外。予防は第4.8節」を1行足した
- arch S-006: **第6.2節の3案比較に「未認証経路からの DO 生成」の判断軸を追加した。** (c) credential 1件 = DO 1個 を採ると、login / signup / password reset という**未認証の入力**が任意文字列を HMAC して新しい DO 名を引く構造になり、総当たりが毎回コールドな DO インスタンス化を誘発する。固定 bucket 分割は bucket 数が天井になるのでこの性質を持たない。判断軸を4つ（列挙可能性 / bucket 数の不変性 / 衝突の意味 / 未認証経路からの DO 生成）に整理し、「(b) を選ぶなら (c) の不採用理由を列挙可能性と未認証生成の**両方**で書く（1本に寄りかからせない）」と明記した
- arch S-007: **`sql.exec()` が `BEGIN TRANSACTION` / `SAVEPOINT` を実行できない**事実を事実表に追加した（公式原文「Note that `sql.exec()` cannot execute transaction-related statements like `BEGIN TRANSACTION` or `SAVEPOINT`」を再取得で確認）。これは「`transactionSync` のネスト可否は公式記載なし」という未確定項目の**機械的な裏側**であり、第8.2節（ネストした UoW を型で禁じるか）と第9.3節（1回で完了しない migration の部分適用の記録）の実現手段に直結する。#37 が SAVEPOINT で回避しようとして詰む経路を先に塞いだ

**見送った提案とその理由**:

- なし（台帳の判定は14件すべて `fix`）
