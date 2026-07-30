# レビュー 007 — 引き継ぎ性・成果物制約・ドキュメント品質

**対象:** PR #43 / ブランチ `issue/34/do-boundary-design`
**観点:** 後続 Issue への引き継ぎ性・成果物制約・ドキュメント品質
**ラウンド:** 7（前回までの指摘は前提にせず、ゼロベースで実施）
**実施内容:** Issue #34 / #35 / #37 / #38 の本文照合、`.thread/34/design.md` 全文（2,270行）通読、`.adr/002〜004` 全文、`spec/adr/005` と `.thread/1/adr.md` の差分、`.thread/34/testing.md` の機械検証**確認項目18件を全件実行**、design.md 第1.4節 検査1〜7 を実行、第11.1節の走査カバレッジを `spec/` 実走査で再現、節番号・パス・行番号引用の実在確認。

### 引き継ぎ性・成果物制約・ドキュメント品質

#### Blockers

なし。

#### Warnings

なし。

#### Notes

- **[N-001]** 成果物制約は5点すべて満たしている（機械確認済み）。
  - `.adr/` の新規追加は `002` / `003` / `004` の**3件のみ**（`git diff --name-status main...HEAD -- .adr/` が `A` 3行）。`.adr/001-integration-tests-single-workers-pool.md` は差分ゼロ（44行のまま）。
  - `spec/adr/` は `M spec/adr/005-search-index-via-outbox.md` の1行のみで `A` なし。未コミットの新規追加もなし。`## コンテキスト` 以降の本文は `git show main:` との全文 diff で完全一致。
  - `.thread/1/adr.md` は `2 0`（追加2 / 削除0）。追加は空行1行 + supersede ポインタ1行のみで、挿入位置は ADR-004 の `Status` 直後。ADR-002 / ADR-015 にハンクは無い。
  - コード・コンフィグの変更ゼロ（`git diff --name-only main...HEAD | grep -E '^(packages/core/|apps/web/app/|infra/)|\.(ts|tsx|toml|json|sql)$'` が空）。未コミット差分も着手時点の6エントリ（`.artifacts/` / `.thread/36/` / wrangler 4本）のみ。
  - `.adr/` 3件は 42 / 38 / 42行で既存 `.adr/001`（44行）と同じ粒度。禁止トークン（`CREATE TABLE` / `PRIMARY KEY` / `bucket` / `): Promise<` 等）のヒット0件、コードフェンス0件。5節構成が `.adr/001` と厳密一致。3件すべてが design.md を参照し、design.md → `.adr/00[234]` の参照は26行。`.adr/` の各参照先（第3章 / 第3.1節 / 第4.6節 / 第4.8節 / 第5.1節 / 第7.1節 / 第7.2節 / 第7.3節 / 第7.4節 / 第7.7節 / 第8.2.1節 / 第8章 / 第9章 / 第11.2節 / 第2.1.1節）はすべて実在し、内容も一致（`.adr/` と design.md の間に食い違いは検出できなかった）。

- **[N-002]** `.thread/34/testing.md` の機械検証**確認項目18件を全件実行し、すべて期待結果どおり**だった。しかも testing.md が本文に埋め込んでいる「走査時点の実測値」が現物と**1件残らず一致**する。
  - 項目1: `.adr/` 4件 / `A` 3行 / H1 4件 OK / 5節 3件 OK
  - 項目2: 禁止トークン0 / 42・38・42行 / フェンス0
  - 項目3: `.adr/002` → `.thread/1/adr.md`、`.adr/003` `.adr/004` → `spec/adr/005`、いずれもステータス節
  - 項目4: `M` 1行のみ / 未コミットなし / 「本文不変 OK」/ ステータス節が `.adr/003` `.adr/004` の両方を指す
  - 項目5: `2 0` / 削除行ゼロ / 挿入位置正常
  - 項目6: 手順1・2・3 とも出力空
  - 項目7: ラベルなし節0 / 36+25+5=66=総数 / 未決語0 / 範囲抽出969行・`暫定|見込み|次第` 0件・`従属` 1件（第5.1節の設計上の用法）
  - 項目8: 保持データ範囲7行が `| 1 |`〜`| 7 |` として実在、各行に既存ドメイン集約が対置されている
  - 項目9: 5.1〜5.5 実在 / PII 節16行 / canonical 4見出し実在
  - 項目10: 6論点すべて見出しとして実在 / 3案4軸比較で (b) を断定
  - 項目11: 台帳 **85**件 / `comm` 残り **32**件 / 表のデータ行30 + 枝番5 = 35行 / 行き先の空欄なし
  - 項目12: 「2クラス構成を採る。**Account Home DO は採用しない。**」/ 未決事項節にヒットなし
  - 項目13: 必須パス22件すべてヒット / 裏取り走査 **40**件で「判定なし」ゼロ
  - 項目14: 必須パス15件すべてヒット / 束ね確認 **2** / 実在チェック全通過 / `db 10` `deploy 24`
  - 項目15: `.thread/36/` のヒットは第11.2節の「clone から読めない／本節が唯一の入力である」1件のみ
  - 項目16: `.thread/34/adr.md` **116**件（うち ADR-020 以降 **97**件）で着手時19件から増加、主題重複なし
  - 項目17: (a) の `MISSING` は既知3分類の**7件ちょうど**、(b) は空。無修飾 `ADR-NNN` は `spec/usecases/knowledge.md:16` の逐語引用1件のみ
  - 項目18: 下記 N-003

- **[N-003]** design.md 第1.4節の不変条件 I-1〜I-8 の**検査1〜7 を実行し、全項目パス**した。`diff` 系（検査1 / 2 / 4）も `OK` を出しており、件数の偶然一致ではない。
  - 検査1（I-3）: E-3 の `kind` 12件 / E-1 の列挙と `diff` 一致（`I-3 OK`）/ `rotate-remap` 両側0件
  - 検査2（I-1 / I-2）: 投入点なし0件 / (A) 3・(B) 2・(C) 7 / `I-2(A) OK` `I-2(B) OK`
  - 検査3（I-5）: 非集約ストア7行 / 書き込み口7識別子すべて第8.2節に実在 / 「アダプター専用」1件（`_meta`）
  - 検査4（I-7）: 第7.7節 項2 の4類型が12件を重複なく覆い `diff` 一致（`I-7 OK`）
  - 検査5（I-6）: クラス (3) 13行 = (3-a)5 + (3-b)2 + (3-c)4 + (3-d)2 = 13
  - 検査6（I-4）: テーブル行16 / `MISSING in 4.1.1:` なし
  - 検査7（I-8）: ヒット5行が「新設する秘密4つ」「`jobs` 12列」「`kind` 各クラス6種・合計12種」の期待値と完全一致。第3.2節の「表は6行 / 秘密は5つ / 新設4つ」も整合。
  - 射程外の他の数値主張も個別に検証した — 第6.9節の締め出し経路「16経路」= 16行、第11.4節「9件」= 9行、第11.2節の「残り8件」= 9 − 1（trigram / `bm25` 再確認）、第4.3節の「実行数35行 / distinct `ADP-*` 53件 / 台帳85件のうち32件が非該当」（53 + 32 = 85、実測一致）。

- **[N-004]** 第11.1節の走査カバレッジ主張が**事実と完全に一致**する。`spec/` を実走査して検証した。
  - `spec/` の非レビュー md = **101**（主張どおり）、`spec/**/review/**` = **39**（内訳8ディレクトリの件数も主張どおり）。
  - 記載の走査語による語彙走査のヒット = **62**（主張どおり）。`comm -23` の残り = **39**（うち手段2・3 が拾う `spec/domains/export.md` / `spec/manual-tests/document.md` / `spec/manual-tests/settings.md` の3件を除いた **36** が手段4 の対象、主張どおり）。
  - 「改訂対象72件 / 影響なし29件」を表の第1セルから機械抽出して照合した結果、**改訂 72 / 影響なし 29 / 重複0 / 合計101 で `spec/` の実ファイル集合と過不足なく一致**した（判定漏れゼロ・実在しないパスの判定ゼロ）。

- **[N-005]** 節番号参照・パス参照・行番号引用がすべて実在する。
  - 本文が使う `第N.M節` 参照の集合と、実在する見出し番号の集合を `comm` で突き合わせた結果、**未解決参照はゼロ**。`第N章` 参照4件（第3 / 4 / 6 / 10章）もすべて実在。
  - リポジトリ相対パスの実在チェック（testing.md 確認項目17 手順1(b)）は空。
  - 行番号引用を実物と突き合わせて検証した主なもの — `currentUser.ts:17-26` / `:28-33`（"The authoritative guard" の JSDoc）、`authState.ts:18-23`、`valueObject.ts:45-62`（`Email.create`）/ `:47`（`trim().toLowerCase()`）/ `:125` / `:142`、`d1/unitOfWork.ts:39`（"Read-your-write ... unsupported by design"）、`helpers.ts:55-69`（`isOccGuardViolation`）、`schema.ts:118`（`OCC_GUARD_CHECK_NAME`）、`di/types.ts:37` / `:53` / `:70`、`errorResponse.ts:70`、`registerWithPassword.ts:46` / `:52` / `:56`、`entity.ts:36` / `:52` / `:77` / `:103` / `:120`、`handlers.ts:82`（`handleQueue`）/ `:120`（`handleDlq`）、`0000_initial.sql:46,47`、`server.cloudflare.ts:4,33,44`、`.tpl:21`（`main = "app/server.cloudflare.ts"`）、`spec/requirements.md:87` / `:108`、`spec/database/index.md:90` / `:350` / `:355`、`spec/index.md:38-43`、`spec/domains/export.md:249` / `:264` / `:275`、`spec/domains/search.md:3` / `:264`、`spec/domains/trash.md:239`、`spec/usecases/search.md:3` / `:85` / `:93`、`spec/usecases/trash.md:311` / `:315`、`spec/inventory/frontend.md:50` / `:55-58`、`spec/manual-tests/{search:17,document:25,timeline:29-33}`、`spec/pages/index.md` P-11。**すべて記述どおりの内容だった。**
  - 「実測」を名乗る件数も検証した — `spec/usecases/memo.md` の `collectEvents` は主張どおり **:51 / :232 / :359 / :396 / :434 / :474 / :572 の7箇所ちょうど**。`spec/usecases/knowledge.md`（:16 + 8箇所）と `spec/usecases/identity.md`（:10 + 7箇所）も一致。`spec/adr/005` の参照側6本も実測6件で一致。`packages/core/src/adapters/d1/` の「20ファイル / 2,514行、うちプロダクションコード8ファイル / 914行」は実測と**完全一致**（`__tests__` と `migrations/` を除いた8ファイルの合計が 914行）。`pendingBatch.ts` 98行 / `entity.ts` 227行 / `event.ts` 81行 / `identity/events.ts` 62行 / `buildDecoder.ts` 37行 / `handlers.ts` 138行 / `unitOfWork.ts` 19行 / `wrangler.toml` 162行 / `.thread/1/adr.md` 1,664行 / `spec/domains/search.md` 271行 / `spec/manual-tests/account.md` 562行 / `spec/database/index.md` 403行、いずれも一致。`db*` 10本 / `deploy*` 24本（非 dry 12本）も一致。`findBySsoIdentity` が実装に1件も無いという主張も実測0件で一致。

- **[N-006]** **#35 の担当者としてのロールプレイ — 受け入れ条件7項目すべてを design.md だけで着手できる。**
  - AC1（ベクトル / Vectorize / embedding / RRF / D1・libSQL・Turso の残存ゼロ）→ 第11.1節の判定一覧が101ファイル全件に「改訂 / 影響なし」を付けており、改訂側は削除記述と置換記述が行番号つきで指定されている。
  - AC2（4.4 のキーワード全文検索化 + 非機能要件への DO 物理分離）→ 第11.1節に**追記する文面の要旨が本文として書かれている**（分離の保証が到達可能性に依ること、10 GB を本体 + FTS 合計で見ること）。
  - AC3（`SearchIndexPort` の単純化）→ **Issue 本文の「query / upsert / remove」は誤りで `query` 1本である**、という訂正指示が明示されている。#35 が Issue 本文だけを読んで実装すると設計と食い違う箇所を、設計側が先回りして潰してある。
  - AC4（`spec/database/index.md` の一本化 + schema version / lazy migration）→ 追記6項目 (i)〜(vi) が列挙されている。
  - AC5（`spec/inventory/` / `spec/testcases/search/` / `spec/manual-tests/`）→ テストケース32行に (A)(B)(C) の書き換え方が個別に割り当てられている。
  - AC6（`CLAUDE.md`）→ **第7.7節が「そのまま写す正文」として用意されている**ので、#35 は文面を自分で起こさなくてよい。
  - AC7（#10 との照合）→ 照合対象が `spec/inventory/frontend.md` の5行（`PAGE-search-001`〜`004` / `PAGE-document-edit-002`）と特定されており、さらに **#13 も照合対象に足すべき理由**（`DOM-identity-017` / `TC-revokeAiClientConnection-002` が消える）が示されている。
  - 加えて #35 の走査を再実行するための手順（4手段 + 再現コマンド）が記録されており、実際に再実行して一致することを確認した（N-004）。`spec/usecases/review/002.md` を改訂対象から外す判断も、Issue 本文との食い違いを自覚したうえで理由つきで断定されている。**手が止まる箇所は見つからなかった。**

- **[N-007]** **#37 の担当者としてのロールプレイ — 「ここで手が止まる」箇所は見つからなかった。**
  - 削除 / 作り直す / 改修の区分が全パスに付き、実在チェックも通る。新設対象（2 DO クラス / 2エントリ / `adapters/cloudflare/*` / DO 側合成ルート / テーブル群 / spike）が列挙されている。
  - UoW は新旧対比表10行で契約差が読め、`transactionSync` の完全同期制約との噛み合わせ（`T extends Promise<unknown> ? never : T` で `async` を型で排除し、コールバック内の `await` を構文エラーにする）が第8.2節に、`ctx.storage.transaction()` を採らない理由が第8.2.1節に、F-27b の spike 結果に依存しないことまで含めて書かれている。
  - DO クラス数（2）・saga の phase 数（signup 0〜4 / credential 変更 0〜3 / link 1〜4 / unlink 1〜3 / 退会 1〜4）・session 検証の形（`{ typ: "session", uid, ep, exp }` と `ep` 欠落の fail closed）はいずれも断定されている。
  - **#37 の Issue 本文の誤り2箇所に先回りの訂正指示がある** — 対応項目8 の `new_sqlite_classes` は `exports` と排他（第2.1節 F-21）なので `exports` へ訂正、対応項目3 の「UoW 契約は維持したまま」は「契約ごと差し替える」へ訂正。どちらも Issue どおりに着手すると設定検証で弾かれる / 誤った前提で書き始める箇所である。
  - 着手時に必要な spike が第11.4節に9件（全件 #37 着手時）としてまとまり、trigram / `bm25` の再現手順は第2.1.1節に3ステップで書かれている。
  - #36 の作業ログが untracked で clone から読めないことを本文が明示し、H-1〜H-8 を全文再掲している。#37 の対応項目9 はこの表だけで消化できる。
  - 唯一「本書では確定させない」テーブル（OAuth 認可コードの `jti` 一回性テーブル）は #13 へ明示的に委譲され、`gh issue view 13` で引き取り先の実在を確認済みである旨まで書かれている。**#37 の対応項目1〜9 に OAuth は含まれないので、#37 が着手中にここへ突き当たることはない。**
  - 値が未確定のもの（チェックポイント予算の中間 20チャンク / 内側 1,000行、export の読み出し上限、予約 TTL、レート制限係数、prune 保持期間）はすべて**出発点の値か不等式のいずれかが設計側で固定されている**ので、#37 が判断を差し戻される形にはなっていない。

- **[N-008]** 自己矛盾の探索結果 — 検出できなかった。とくに本設計が過去に自ら矛盾を検出した箇所（`enqueueJob` の「早める方向にのみ」と再武装規則の関係、`operationKey` の収束の意味、`rotate-remap` を Alarm ジョブから外す判断、`credential_locators` の一意性キー、`credential_mappings.credentialId` の bucket 内 UNIQUE、`usableForLogin` の false → true 遷移の不在、`spec/adr/005` の supersede が根拠側と方式側に分かれること、`cancel-reservation` の `status` 非依存削除と `operationId` のログ露出の衝突）は、いずれも「初版はこう書いていたが誤りである」という形で旧記述の撤回と新結論が併記されており、旧記述が本文の別箇所に取り残されていないことを確認した。第7.5節・第7.4節・第4.1節 行5 の3箇所が同じ「遅らせる更新は再武装だけが行う」を述べていることも本文が自ら明示している。

- **[N-009]** 未決・暫定表現の扱いも問題なし。`検討する` / `TBD` / `要検討` / `未定` / `暫定` / `保留とする` の全文走査がゼロ件で、第11.4節の9件はすべて「決める主体」「いつ」「本設計への影響」の3欄が埋まっている（9件中7件が「本設計への影響: **無い**」、1件が再確認、1件が値の2段決定）。第7.2.1節の検索 API 仕様は「未決事項ではなく #35 への明示的な委譲」と本文が区別している。
