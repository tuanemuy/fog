# レビュー 008 — 引き継ぎ性・成果物制約・ドキュメント品質

**対象 PR:** #43（`issue/34/do-boundary-design`）
**対象 Issue:** #34
**ラウンド:** 8（ゼロベース）
**実施日:** 2026-07-30

## 実施した検証

すべて実際に実行した。

- 成果物制約 — `git diff --name-status main...HEAD` / `.adr/` / `spec/adr/` の実測、`.thread/1/adr.md` の `--numstat`、`spec/adr/005` の本文全文比較
- `.thread/34/testing.md` の機械検証 確認項目1〜18（18 = design.md 第1.4節 検査1〜9）を全件実行
- design.md 第11.1節の走査カバレッジ主張を `spec/` 実走査で全数検証
- 節番号参照・章参照・`F-*` 参照・リポジトリ相対パス・行番号引用の実在確認
- Issue #34 受け入れ条件（9項目）/ #35 受け入れ条件（7項目）/ #37 受け入れ条件との照合
- `pnpm lint` / `pnpm format:check`

---

### 引き継ぎ性・成果物制約・ドキュメント品質

#### Blockers

なし。

#### Warnings

- **[W-001]** design.md 第1.4節 検査7b のインライン期待値 `-> 10` が現物（12）と食い違い、testing.md 確認項目18 の期待値（`12`）とも矛盾している
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md:207`（`tbl '| 列 | テーブル | テーブル定義の外に生む作業 |' | wc -l     # 第11.2節の新設列表 -> 10`）
  - 理由: 実測は **12**（第11.2節の新設列表は12行）。本文側は正しく「下の12行」と書いており（`design.md:2340`）、`.thread/34/testing.md:526` も検査7b の期待値を `15 / 1 / 6 / 35 / 18 / 12 / 9` と正しく列挙している。食い違っているのは第1.4節のコメントだけである。
    問題は影響範囲ではなく方向で、`testing.md:527` は「**期待値の正本は本書ではなく第1.4節の側である — 食い違ったら第1.4節を読み、そちらの期待値に従う。逆に第1.4節の期待値が現物と合わなくなっていたら、それは検査の失敗ではなく I-8 の違反として design.md を直す**」と指示している。この指示どおりに読むと、改訂担当者は「I-8 違反が起きている」と結論して**存在しない不整合**（本文の「12行」と表の12行はすでに一致している）を探すことになる。第1.4節は「数を書いた箇所と表の行数の不一致」を潰すための機構であり、その検査手順自身が同じ形の陳腐化を持っている点も自己矛盾にあたる。
  - 提案: `design.md:207` のコメントを `# 第11.2節の新設列表 -> 12` に直す。あるいは（検査7b の設計意図「右側は必ずコマンドで数える」に揃えるなら）コメントから数値を落として `# 第11.2節の新設列表` にする。後者のほうが陳腐化しない。他6本のコメント（`15` / `1` / `6` / `35` / `18` / `9`）はいずれも実測と一致していたので、直すのはこの1本だけである。

#### Notes

- **[N-001] 成果物制約は全項目クリア。**
  - `.adr/` は4件（既存 `001` + 新規 `002` / `003` / `004`）。`git diff --name-status main...HEAD -- .adr/` は `A` 3行のみで `001` に `M` が付いていない。H1 書式・和文5節構成（ステータス / コンテキスト / 決定 / 検討した代替案 / 影響）は既存 `001` と厳密一致。行数は 42 / 38 / 42 でいずれも50行以内、禁止トークン（`CREATE TABLE` / `PRIMARY KEY` / `bucket` / `=>` / `): Promise<` ほか）とコードフェンスは0件。
  - `spec/adr/` は既存6件のまま。差分は `M spec/adr/005-search-index-via-outbox.md` の1行だけで、`## コンテキスト` 以降の全文比較が `本文不変 OK`。
  - `.thread/1/adr.md` は `2 0`（追加2 / 削除0）。追加は ADR-004 の `### Status` 直後の空行1行 + supersede ポインタ1行のみで、ADR-002 / ADR-015 にハンクが無い。
  - コード・コンフィグ変更0件。`git diff --name-only main...HEAD | grep -E '^(packages/core/|apps/web/app/|infra/)|\.(ts|tsx|toml|json|sql)$'` は空。未コミットも着手時点の6エントリ（`.artifacts/` / `.thread/36/` / `wrangler.{request,state}.{production,staging}.toml`）だけで、`.thread/34/` は commit 済み。`pnpm lint` / `pnpm format:check` とも exit 0。

- **[N-002] `.adr/` と design.md の間に食い違いは無い。** 3件はいずれも決定・代替案・影響までで止まり、DO の分割数・saga の手順・migration の手順・スキーマ断片を持たない。design.md への参照は3件すべてに実在し（`.adr/` → design.md が11箇所、design.md → `.adr/00[234]` が26箇所）、参照先の節番号（第3章 / 第4.6節 / 第4.8節 / 第7.1〜7.3節 / 第8.2.1節 / 第8章 / 第9章 / 第3.1節 / 第5.1節 / 第2.1節）はすべて実在する見出しに解決した。supersede の分担（`.adr/003` = 根拠側 / `.adr/004` = 更新方式側）は `spec/adr/005` のステータス行の記述とも一致している。

- **[N-003] design.md 第1.4節 検査1〜9 は全項目パス。** 検査1 = `12` / `I-3 OK` / `rotate-remap` 0件、検査2 = 投入点なし0件・(A)3・(B)2・(C)7・`I-2(A) OK`・`I-2(B) OK`・分類がちょうど1つでない行0件・`I-2 重複なし OK`、検査3 = 7ストア・`MISSING in 8.2:` なし・アダプター専用1件、検査4 = `12` / `I-7 OK`、検査5 = 両方 `13`、検査6 = `16` / `MISSING in 4.1.1:` なし、検査8 = `MISSING column in 4.1.1:` なし（列一覧は実測60件）、検査9 = 候補0件。検査7a のヒットは4箇所で、期待値（新設秘密4つ / `jobs` 12列 / `kind` 各クラス6種・合計12種）と1件残らず一致。検査7b の grep は宣言どおり6行ヒットし、右側の実測は `15` / `1` / `6` / `35` / `18` / **`12`** / `9`（最後から2番目だけがコメントと食い違う = W-001）。

- **[N-004] 第11.1節の走査カバレッジ主張は全数が実測と一致した。** `spec/**/review/**` = 39ファイル（内訳の8ディレクトリも一致）、非レビュー md = **101**、語彙走査ヒット = **62**、未ヒット = 39（うち手段2 が1件 = `spec/domains/export.md`、手段3 が2件 = `spec/manual-tests/{document,settings}.md`、残り **36** が手段4 の対象）、`spec/usecases/review/002.md` の走査語ヒット = 7件。
  さらに判定の突き合わせも行った — 改訂表に現れる distinct な spec パスが **72**（+ `CLAUDE.md`）、影響なし節が列挙するのが **29**（手段1〜3 由来2 + 手段4 由来27。27 の内訳も ADR本文4 / デザイン3 / `spec/issues.md` 1 / `spec/manual-tests/index.md` 1 / シナリオ4 / 読み取り系14 で一致）。**72 + 29 = 101 で、重複0件・未判定0件**。「101ファイルすべてに判定がある」は文字どおり成立している。第4.3節の「実行数35行 / 枝番5件 / distinct `ADP-*` 53件 / 台帳85件 / 表に現れない32件」も全数実測と一致した。

- **[N-005] 参照の実在性はすべて解決した。**
  - 節参照66件・章参照6件が design.md / `.adr/002〜004` / testing.md 横断で全件実在する見出しに解決（未解決0）。`F-*` 参照も定義（F-1〜F-32 + F-4b / F-27b / F-32b の35行）と双方向で完全一致し、未定義参照・未参照定義ともゼロ。
  - リポジトリ相対パスの実在チェック（testing.md 確認項目17 の (b)）は空。`MISSING:` は既知3分類7件（ADR 番号の短縮表記4件 / 先行ブランチにしか無い `.thread/19/*` 2件 / 本文が不在を明示している `apps/web/app/server.state.ts` 1件）に収まっている。無修飾 `ADR-NNN` は1件で、`spec/usecases/knowledge.md:16` の逐語引用として許容範囲。
  - 行番号引用を実物と照合した。`spec/requirements.md:87` / `:108`、`spec/domains/search.md:3` / `:264`（271行）、`spec/usecases/search.md:3` / `:85` / `:93`、`spec/domains/trash.md:239`、`spec/usecases/trash.md:311` / `:315`、`spec/database/index.md:6` / `:350` / `:355-357`（403行）、`spec/index.md:38-43`、`spec/domains/export.md:249` / `:264` / `:275`、`spec/idea.md:40` / `:48`、`spec/pages/index.md:180`、`spec/adr/004-domain-boundaries.md:25`、`spec/inventory/frontend.md:50` / `:55-58`、`spec/manual-tests/account.md`（562行）、`spec/usecases/memo.md` の `collectEvents` 7箇所（`:51` / `:232` / `:359` / `:396` / `:434` / `:474` / `:572`）— すべて記述どおり。
  - 実装側も同様。`adapters/d1/`（20ファイル / 2,514行、うち非テスト非マイグレーションの `.ts` が **8ファイル / 914行**）、`eventRelayWorker.ts` 301行 / `outboxPrune.ts` 25行、`worker/cloudflare/handlers.ts` 138行（`handleQueue` :82 / `handleDlq` :120）、`domain/common/event.ts` 81行 / `identity/events.ts` 62行 / `identity/entity.ts` 227行（`:36` の判別共用体、`:52` / `:77` / `:103` / `:120` の `WithEventDrafts` 戻り値4箇所）、`application/execution/unitOfWork.ts` 19行、`d1/unitOfWork.ts:39` の "unsupported by design"、`d1/repositories/helpers.ts:55-69` の `isOccGuardViolation`、`d1/schema.ts:118` の `OCC_GUARD_CHECK_NAME`、`errors.ts:206-210` の `RETRYABLE_SYSTEM_CODES`（`NetworkError` / `ExternalApiError` の2値）と `SystemErrorCode` 6値、`currentUser.ts:17-26` / `:28-33`（"The authoritative guard"）、`authState.ts:18-23`、`sessionCodec.ts` の `issue(userId, now)` / `verify` 戻り値に epoch が無いこと、`hmacSessionCodec.ts` の `Payload = { uid; exp }`、`registerWithPassword.ts:46` / `:52` / `:56`、`valueObject.ts:47` / `EMAIL_MAX_LENGTH = 320` / `EMAIL_PATTERN`、`server.cloudflare.ts:4,33,44`、`.tpl:21` の `main = "app/server.cloudflare.ts"`、`apps/web/wrangler.toml` 162行で DO バインディング0件、`apps/web/package.json` の `db*` 10本 / `deploy*` 24本 — すべて一致。
  - `.thread/36/` が「どのブランチにも commit されていない」も実測で確認（`git log --all -- .thread/36/` 0行、`git ls-files .thread/36/` 0件）。第11.2節が H-1〜H-8 を全文再掲していることで自己完結性が保たれている。

- **[N-006] Issue #34 の受け入れ条件9項目はすべて充足。** `.adr/002〜004` の3件のみ・詳細の非流入（N-001 / N-002）、旧 ADR 2箇所の supersede 履歴と `.thread/1/adr.md` 本文不変（N-001）、`spec/adr/` 新規追加なし（N-001）、User Data DO の保持データ範囲（第4.1節の7行対応表 + 第4.1.1節のテーブル16行 / 列60件）とルーティング（第5.1節の一本道 + 第5.5節の構造的保証）、Identity Directory DO の5論点（第6.1 解決責務 (a)〜(d) / 6.2 分割方式 / 6.4 部分失敗と補償 / 6.5 冪等性 / 6.6 SSO リンク・解除 / 6.9 分散トランザクション非前提）、PII 非使用方針（第5.2節 (a)(b)(c) + 第5.2.1〜5.2.5節）、同期 FTS5 更新の可否（第7.1節 = 可）/ Alarm 適用範囲（第7.4〜7.6節）/ UoW 契約（第8.2節のインターフェース定義）/ lazy migration（第9.1〜9.5節）。

- **[N-007] #35 の担当者としての着手可能性 — 受け入れ条件7項目を1つずつ照合して合格。**
  1. ベクトル / Vectorize / embedding / RRF / D1・libSQL・Turso の除去 → 第11.1節「改訂する」6表 + 手段4 表に全対象ファイルと削除・置換内容が行として存在（第7.1節・第7.2節・`.adr/003` が根拠）。
  2. `requirements.md` 4.4 + 非機能要件 → `:87` / `:108` の2箇所を名指しし、非機能要件へ足す文の**要旨を全文で**提示（第11.1節）。
  3. `SearchIndexPort` の単純化 → Issue 本文の「query / upsert / remove」に対し「**本設計の結論は `query` 1本**」と訂正指示まで明示。訂正指示を落とさずに書いている点が重要で、`upsert*` / `remove*` はトランザクション内 projection に畳まれる（第7.1節）。
  4. `database/index.md` の DO 一本化 + schema version / lazy migration → 足す内容を (i)〜(vi) で列挙。
  5. `inventory/` / `testcases/search/` / `manual-tests/` の整合 → テストケース33行を (A)(B)(C) の3方式で1行ずつ指示、台帳5ファイル分の削除・追加を列挙。
  6. `CLAUDE.md` → 第7.7節を「正文としてそのまま写す」と指示し、UoW / Reference runtime / DB 制約の行き先も指定。
  7. #10 のチェックリスト照合 → 照合対象を `spec/inventory/frontend.md` の5行に特定し、さらに **#13 を照合対象に足す**という追加指示まで出している。
  4件の「画面仕様として送る」判断と、「#35 は再検討しない」（重複エラーの秘匿 / SSO 専用のリセット）という差し戻し禁止の明示も、往復を1回減らす形で効いている。**手が止まる箇所は見つからなかった。**

- **[N-008] #37 の担当者としての着手可能性 — 手が止まる箇所は見つからなかった。** 判断材料は次のとおり。
  - 削除 / 作り直す / 改修の区分つき一覧が24行あり、各行に「何を」「なぜ」「根拠節」が入っている。新設対象も DO 2クラス・エントリ2本・アダプター群・テーブル全数（第4.1.1節を正本と明示）まで具体。
  - Issue 本文と設計が食い違う3箇所に**訂正指示**が置かれている — (i) UoW 契約は「維持」ではなく「差し替え」（第11.2節冒頭）、(ii) `new_sqlite_classes` ではなく `exports`（第9.1節。`[[migrations]]` と排他なので Issue どおりに書くと wrangler の検証で弾かれる）、(iii) `SearchIndexPort` は `query` 1本（第11.1節）。この3つは「Issue のチェックリストどおりに手を動かすと壊れる」箇所なので、明示されていることが実質的な着手条件になっている。
  - UoW は TypeScript のインターフェース定義がそのまま置かれており（第8.2節）、`run` の同期強制の型（`T extends Promise<unknown> ? never : T`）・書き込み口 (i)(ii)(iii) の全数・`_meta` を唯一の例外とする根拠まで書かれている。新旧対比表10行で D1 側の何が消えるかも読める。
  - lazy migration は「ゲート関数の置き場所（全 RPC エントリ + `alarm()`）」「`alarm()` 先頭の順序（(1) 再武装 + `sync()` → (2) ゲート → (3) 仕事）」「`blockConcurrencyWhile` を使わない理由と代わりの排他条件（`await` を1つも挟まない）」「単発適用で足りる DDL と足りない DDL の分類（公式引用つき）」「条件4（既に育ったテーブルへの `CREATE INDEX`）の回避策を (a)(b) で決め切り」まで断定形。
  - RPC エントリはクラス (2)(3) が全数（13 + (2) 側）で表になっており、(3) の守り方も (3-a)〜(3-d) の4群に本数（5 / 2 / 4 / 2 = 13）まで割り当ててある。実装者が「このエントリは何で守るのか」を表引き1回で決められる。
  - `#36` からの引き継ぎ（H-1〜H-8）が、原本が未コミットであることを明示したうえで全文再掲されている。#37 の対応項目9 は本節だけで消化できる。
  - 第11.4節の未決9件はすべて `#37` の着手時 spike に割り当てられ、7件は「本設計への影響: 無い」（保守側に倒してあるため）、2件は「#37 が根拠値 → #38 が運用値」の2段。**未決が実装のブロッカーになっていない。** 唯一「覆れば決定が成立しない」trigram / `bm25` の再確認だけは、その場合に別 Issue へ立て直すという後段も書かれている。

- **[N-009] 断定形と未決語の検査も通っている。** `##` / `###` の66見出しが全件ラベル付き（Issue 要求36 / 派生25 / 参考5 = 66）で、未決語（`検討する` / `TBD` / `要検討` / `未定` / `暫定` / `見込み` / `次第` / `保留とする`）は0件。第4〜7章の前方依存も解消済みで、残る `従属` 1件は設計上正しい用法（第5.1節の `report-login-result`）。`.thread/34/adr.md` は125件（うち ADR-020 以降が106件）で、`.adr/` へ昇格させなかった判断の記録も要件を満たしている。

---

## 判定

**Blockers: なし / Warnings: 1 / Notes: 9**

W-001 は design.md 第1.4節 検査7b のコメント1箇所の陳腐化で、直すのは1語（`10` → `12`、または数値の削除）である。成果物制約・#35 / #37 の着手可能性・カバレッジ主張の事実性はいずれも実測で裏付けられており、W-001 以外に事実との食い違い・自己矛盾は検出しなかった。
