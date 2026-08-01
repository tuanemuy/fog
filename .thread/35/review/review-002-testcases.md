# レビュー 002 — テストケース・台帳・マニュアルテスト

**PR:** #46 / **Issue:** #35 / **ベース:** `main`
**観点:** テストケース・台帳（`spec/inventory/`）・マニュアルテスト
**ラウンド:** 2（1ラウンド目の判定済み指摘は `.thread/35/review/triage.md` を継承し、再審議しない）

**結果:** Blocker 2 / Warning 2 / Note 3

## 機械検証のサマリ（先に結論）

本観点で最も重い検査は全件パスした。以下はすべて実行結果である。

| 検査 | 結果 |
|---|---|
| `spec/inventory/test.md` の `#L{n}` 全 814 件が実データ行を指すか（ヘッダ行・区切り行・範囲外を検出） | **814/814 適合。違反 0** |
| 同・ファイル別に行番号が単調増加・重複なしか | **53 ファイルすべて適合** |
| 同・台帳行 ⇔ testcases のテーブルデータ行が全単射か（台帳に無い行 / ファイルに無い行） | **双方向 0 件** |
| 台帳が参照するファイル ⇔ `spec/testcases/**` の実ファイル（53 件）の全単射 | **双方向 0 件** |
| `spec/inventory/usecase.md` の 53 ユースケース ⇔ testcases 53 ファイルの全単射 | **双方向 0 件** |
| `TC-*` の欠番規約（削除は欠番のまま／新設は末尾 append） | **適合**。欠番は `revokeAiClientConnection-002` / `search-006,022,028,029` / `pruneExpiredTrashItems-010` のみで、いずれも削除ケースに対応。繰り上げ 0 |
| 台帳 ID の欠番規約（`DOM-*` / `ADP-*` / `UC-*` / `PAGE-*`） | **適合**。`DOM-identity-013〜017` / `DOM-memo-007〜012` / `DOM-knowledge-015〜027`（計 24）・`DOM-search-005〜012`・`ADP-trash-004` が欠番。**`DOM-identity-023〜028` は `AiClientConnectionRepository` の6メソッドを指したまま**（AC-15 の前提が保持されている） |
| `P-8`（台帳の「定義場所」アンカーの実在検査） | **0 行** |
| 削除対象 ID の残存（`ADP-search-embeddings-001` / `ADP-occ-guard-001` / `ADP-outbox-001` / `ADP-processed-events-001` / `UC-search-002` / `TC-maintainSearchIndex-*` ほか） | **0 行** |
| `spec/manual-tests/` の TC 実測 | `account 40 / timeline 37 / document 41 / search 23 / trash 25 / ai 23 / settings 12` = **201**。`index.md` の件数表・合計・実行記録の分母（`/201件 PASS`）と完全一致。内訳列（正常/異常/境界）も各行の和・各列の和とも一致 |
| 同・TC 番号の重複・欠番 | 7 ファイルとも `1..N` で稠密。重複 0 |
| `spec/index.md` の件数 | `53ユースケース` / `814ケース` / `39シナリオ` / `201ケース` — **すべて実測と一致** |
| `.thread/35/coverage.md` の `NO-VERDICT` | **0 行**。ファイル数 102、台帳 103 行（削除1件の記録を含む）、判定内訳 改訂 80 / 新設 2 / 削除 1 / 影響なし 20 = 103 で自己申告と一致 |
| 同・判定 ⇔ 実際の差分の突き合わせ（「影響なし」なのに変更された / 「改訂」なのに未変更 / 変更されたのに台帳に無い） | **3方向とも 0 件** |
| 旧語彙の残存（`userId スコープ` / イベント名 24 件 / `Outbox` / `pruner` / `consumer` / `listExpiredItems` / `upsert*` / `page` / 無注記 ADR-005） | `spec/testcases` `spec/manual-tests` `spec/inventory` で **すべて 0 行** |
| `AC-19`（`P-7` の 10 本 + 補 1 本） | **11 本すべて 1 以上**（2/4/2/2/2/2/1/7/3/2/2） |
| `AC-10` | `maintainSearchIndex.md` 削除済み・`search.md` からベクトル統合／非同期反映ケース消滅・「投稿直後に必ずヒットする」（`TC-search-033`）新設を確認 |
| `AC-9` の「新設ケース数 = `test.md` の追加行数」 | testcases のデータ行 771 → 814（+43）、台帳行 771 → 814（+43）で**一致**（`plan.md` が baseline を `782` としているのは誤り。Note-3） |

台帳の「要点」欄と実行行の内容も、`search` / `changePassword` / `requestPasswordReset` / `listAiClientConnections` / `revokeAll*` / `unlinkSso*` を全行、他ファイルを抜き取りで突き合わせたが、意味のずれは 1 件も無かった。**1ラウンド目で行番号が大きく動いたにもかかわらず台帳が完全に追随している**のは、この PR で最も品質が高い部分である。

## 受け入れ基準の判定（本観点の担当分）

| AC | 判定 | 根拠 |
|---|---|---|
| AC-9（台帳から旧要素が消え、欠番が繰り上がらず、新設ケースが全件採番されている） | **達成** | 削除対象 ID の残存 0、欠番 24 + 8 + 1 + 5 が意図どおり、`DOM-identity-023〜028` 保持、`P-8` 0 行、新設ケース数（+43）= 台帳の追加行数（+43） |
| AC-10（`maintainSearchIndex.md` 削除・ベクトル統合／非同期反映ケース消滅・投稿直後ヒットケース新設） | **達成** | 削除確認、`V-7` 0 行、`TC-search-006/022` 欠番化、`TC-search-033` 新設 |
| AC-11（manual-tests から consumer / pruner / 反映待ちの環境前提が消え、共有 DB 直 SQL が DO 前提または #38 委譲に置換） | **条件付き達成 → B-002 で未達** | 語彙の除去・SQL ブロックの撤去・#38 委譲は完了（残存 0 行）。ただし `trash.md` の期限操作が旧モデル（`trashedAt` 駆動）のまま残っており、「DO 前提の手段に置き換わっている」とは言えない |
| AC-16（`spec/` の非 review Markdown 全数に判定があり、ファイル数 102） | **達成** | `NO-VERDICT` 0 行、実ファイル 102、台帳 103 行、判定と実差分の3方向突き合わせ 0 件 |
| AC-19（手段4 の 9 ファイルが実際に改訂され `P-7` の各行がヒット） | **達成** | `P-7` 10 本 + 補 1 本すべて 1 以上。期待値の中身も9ファイルすべて目視で確認（`到達性` / `credentialVersion` / `credentialId` / `createdAtResetVersion` / `operationKey` / `purge_after` / `所有確認` / `ロックアウト` / `上限` / `PAGE-password-reset-004`） |

## Blockers

**[B-001]** 新設した2ユースケースが `spec/manual-tests/account.md` のカバレッジ表に1行も無く、UI から到達できるエラーケース（`LastCredentialRemoval` ほか）が TC も「対象外」記録も持たない

- **場所:** `spec/manual-tests/account.md`（`### ユースケースエラーケース対応表`、`:586-616` 付近）。関連: `spec/usecases/identity.md#unlinkSsoCredential` / `#revokeAllAiClientConnections`、`spec/inventory/frontend.md:73`（`PAGE-password-reset-004`）/ `:75`（`PAGE-settings-007`）
- **理由:** このファイルのカバレッジ表は identity のユースケースを**全数**列挙する自己宣言を持つ（表の末尾に「changeTrashRetentionDays は S-ST-01 のユースケースのため本ドキュメントの対象外（settings.md / trash.md で扱う）」という転送注記まで置いて、漏れが無いことを担保している）。本 PR は `unlinkSsoCredential` / `revokeAllAiClientConnections` の2ユースケースを新設し、`spec/testcases/identity/` にファイルを追加し、`spec/inventory/frontend.md` に画面の約束（P-03 の必須導線・P-13 の保有クレデンシャル一覧）まで足したにもかかわらず、**カバレッジ表にはこの2ユースケースの行が1つも無い**。実測でも `grep -rn 'unlink' spec/manual-tests/` は 0 件である。
  結果として次の穴が開いている。
  - **`unlinkSsoCredential` を実際に実行する手順が manual-tests に存在しない。** TC-38 手順2 は「解除操作が SSO の行にだけ出ている」という**表示**の確認までで、解除そのものを実行しない。`PAGE-settings-007`（設定画面 P-13 からの解除）に至っては触れる TC が皆無である。
  - **`BusinessRuleError(LastCredentialRemoval)` は UI から素直に到達できるエラーケースである**（SSO 専用アカウントが唯一の SSO 連携を解除しようとする）にもかかわらず、TC が無く、「対象外」の理由記録も無い。同表が `OCC 不一致` や `DB 例外` について律儀に対象外理由を書いていることと不揃いである。
  - TC-38 / TC-39 は `revokeAllAiClientConnections` を実行する（TC-38 手順3「すべて失効」）のに、表では `executePasswordReset` の行に紐づけられており、**ユースケースへの帰属が誤っている**。
- **提案:** カバレッジ表に少なくとも次の行を足す。TC を新設せずに済む行は「対象外」＋理由でよいが、`LastCredentialRemoval` と設定画面からの解除は手動で再現できるので TC 化が妥当（TC は末尾採番し、`index.md` の件数表・合計・実行記録の分母を再度数え直す）。
  - `unlinkSsoCredential | 最後のログイン手段の解除（LastCredentialRemoval） | TC-NN`（SSO 専用アカウントで唯一の SSO を解除 → 拒否）
  - `unlinkSsoCredential | kind: "email" の解除（BusinessRuleError） | 対象外`（UI が解除操作を出さないため。TC-38 手順2 が出し分けを担保）
  - `unlinkSsoCredential | 対象不在 / OCC / DB 例外 | 対象外 + 理由`
  - `revokeAllAiClientConnections | 個別 OCC の部分失敗 / DB 例外 | 対象外 + 理由`、`revokeAllAiClientConnections | 一括失効の正常系 | TC-38`（TC-38 の帰属を `executePasswordReset` からこちらへ移すか、両方に書く）

**[B-002]** `spec/manual-tests/trash.md` の期限切れテストが `trashedAt` を書き換える手順のままで、本 PR 自身が「期限判定の権威は保存済み `purgeAfter`」に変えた契約と矛盾する（TC-13 手順4〜6 と TC-23 が実行不能）

- **場所:** `spec/manual-tests/trash.md` の環境前提（`:18-22`）、`TC-13` 手順4（`:214`）、`TC-23` 前提・手順1（`:333-336`）。矛盾先は `spec/domains/trash.md:21` / `:70` / `:188-190`、`spec/usecases/trash.md:10` / `:49` / `:54`
- **理由:** 改訂後の契約は「**期限は保存する**（各エンティティの `purgeAfter`）。判定の権威は保存値であり `trashedAt + retentionDays` の算出結果ではない」「ゴミ箱一覧の `expiresAt` は**保存済みの `purgeAfter` がそのまま載る**」であり、`purgeAfter` が動くのは (a) ソフトデリート時と (b) 保持日数変更に伴う一括再計算の2つだけである。ところが手順書は旧モデル（照会時に `trashedAt` から算出）のまま `trashedAt` の書き換えを期限操作の手段にしている。
  - **TC-23 は成立しない。** 手順1で `trashedAt` を「29日と23時間前」にしても、保存済み `purgeAfter` は削除時に確定した値（≒ 30日後）のままなので、手順2の期待「残り1日未満相当で表示されている」に**到達できない**（`expiresAt` は保存値をそのまま載せるため）。旧モデルではこの手順で成立していた。
  - **TC-13 の手順4→6 も同様に成立しない。** 手順2で保持期限を1日に変更した時点で再計算が走り `purgeAfter ≒ now + 1日` が保存される。その後に手順4で `trashedAt` だけを2日前にしても `purgeAfter` は再計算されないので、手順5の `purge-trash` 起床では期限切れと判定されず、手順6の期待（項目が消えている）が満たされない。括弧内の「時計を巻き戻すのに相当する手段」なら成立するが、手順の主文は `trashedAt` の操作である。
  - 環境前提（`:20`）も「削除日時（`trashedAt`）が過去のゴミ箱項目を直接投入する」と書いており、同じ前提を配っている。
  - なお **TC-24 は偶然成立している** — 手順1で `trashedAt` を40日前にしたあと手順2で保持期限を60日へ変更するので、そこで `purgeAfter = trashedAt + 60日` が再計算されるためである。3ケースのうち1つだけ成立するという不揃いも、旧モデルの手順が残っている証拠になっている。
- **提案:** 期限操作の手段を「`trashedAt` を過去にする」から「**`purgeAfter` が過去（または期限直前）である状態を作る**」へ言い換える。具体値は #38 のままでよい。
  - 環境前提: 「対象ユーザーの Durable Object へ、保存済みの保持期限（`purge_after`）が過去のゴミ箱項目を直接投入する（DO 単位のシード投入）か、時計を巻き戻すのに相当する手段」
  - TC-13 手順4: 「当該項目の保存済みの保持期限が既に過ぎている状態を作る（…実体は #38）」
  - TC-23 前提・手順1: 「保存済みの保持期限が1時間後である状態を作る」。あわせて確認ポイントに「残り日数の表示は保存値そのものであり、`trashedAt` を動かしても変わらない」を足すと、B-002 の再発防止になる（同じ趣旨の注記は TC-13 の確認ポイントに既にある）

## Warnings

**[W-001]** `spec/inventory/test.md` のヘッダ宣言「連番はテーブルの行順（上から下）に対応する」が欠番の導入で偽になり、欠番規約そのものが台帳に記録されていない

- **場所:** `spec/inventory/test.md:5`
- **理由:** 本 PR は削除ケースの連番を欠番のまま残す方針を採り（正しい判断であり、`.thread/35/plan.md` のリスク節と `step14-checklist.md` が根拠を持っている）、実際に `TC-search-006/022/028/029` などが欠番になっている。その結果、`TC-search-007` はテーブルの7行目ではなく6行目を指すようになり、**ヘッダの宣言が字義どおり偽**になった。同じ問題に対して `spec/manual-tests/index.md` には「追加したケースは既存の番号を繰り上げないよう末尾採番するため…番号が飛ぶことがある」という注記が本 PR で追加されている（W-021 の対応）のに、**台帳側には同じ注記が無い**。ID の意味が静かに取り違わることを #10 / #13 が参照する台帳で許すのは、`plan.md` が最大級の危険として名指しした形そのものである。
- **提案:** ヘッダを「連番は**採番時の**テーブルの行順に対応する。**削除したケースの連番は欠番のまま残し、後続を繰り上げない。新設は各ユースケースの末尾に append する**」へ改める。`spec/inventory/domain.md` にも同じ規約（`DOM-identity-013〜017` ほかが欠番であること）を1行足すと、24 行の削除跡が意図的なものだと読める。

**[W-002]** `spec/manual-tests/account.md` TC-40 の確認ポイント「先送り幅には上限がある」が、`spec/` のどこにも契約を持たない

- **場所:** `spec/manual-tests/account.md:508`（TC-40 確認ポイント）。関連: `spec/domains/identity.md:412`（`failedAttempts` / `nextAttemptAllowedAt` の定義）
- **理由:** 濫用抑止の3規則（**天井**を置く／**時間減衰**を置く／ロックアウト中の試行は `failedAttempts` を**進めない**）は `.thread/34/design.md` 第6.2.2節 (a) が「**3つの存在自体は #38 へ送らず、本節で固定する**」と明記した設計の制約である。ところが `spec/` 側にはこの3つが1つも写されていない — `grep -rn '天井\|減衰' spec/` は 0 行で、`spec/domains/identity.md` に載っているのは列の存在（`failedAttempts` / `nextAttemptAllowedAt`）と `promoteVerifier` による脱出経路だけである。その状態で手順書だけが「先送り幅には上限がある」を検証項目として要求しているため、**実装者は `spec/` を読んでもこの要件に到達できず、テスターは根拠のない期待を確認させられる**。手順書が契約より先に進んでいる形であり、`plan.md` が警告した「正本だけを直して適用先へ届けない」の逆向きの破れである。
- **提案:** どちらかに揃える。(a) `spec/domains/identity.md` の `CredentialMapping` の項に「先送り幅には上限があり一定時間で頭打ちになる／最後の失敗からの経過で `failedAttempts` は減衰する／`nextAttemptAllowedAt` 未到達の試行はカウンタを進めない（具体値は運用側）」の3行を足して手順書の裏づけにする（設計が `spec` 側に固定すると決めた項目なので、こちらが素直）。(b) 3規則を `spec/` に置かない判断なら、TC-40 の確認ポイントからこの1行を落とす。**「脱出経路2本」（リセット完走でのリセット／`credential` 単位なので SSO を巻き込まない）は `spec/domains/identity.md:426` に根拠があるので、そのままでよい。**

## Notes

**[N-001]** 終端後の観測結果を書いた2ケースは ADR-009 の線引きの縁にある（対応不要。#45 の設計判断に踏み込むため指摘に留める）

`spec/testcases/identity/changePassword.md:27`（`TC-changePassword-021`）と `executePasswordReset.md:26`（`TC-executePasswordReset-020`）は「中間状態のまま前進不能が確定し、**終端で中間状態が解除された**」を前提に「旧パスワードでログインできる」と書いている。`.thread/34/design.md` 第6.5.1節の終端規則は (i)（`changeState = 'pending'` → 巻き戻す）と (ii)（`'advanced'` → 巻き戻さず operator へ）の2モードを持ち、この期待値が成立するのは (i) だけである。**前提節が「解除された」と条件付けているので字義的には偽ではなく**、`.thread/35/adr.md` ADR-009 が「終端後の観測結果」として明示的に許容した範囲でもあるため指摘として立てない。ただし手順が #45 に委ねられている以上、このケースは当面**実行不能**（PASS/FAIL を付けられない）である点は、実装フェーズで `実装ステータス` 欄に反映されると読み手が助かる。

**[N-002]** 既存の 3 件、ユースケースのエラーケースに対応するテストケースが無い（本 PR 由来ではない）

`spec/usecases/knowledge.md` のエラーケース表にある `RevisionDocumentMismatch`（`editDocumentByAi`）と `InvalidRevisionNumber`（`editDocumentByAi` / `getDocument`）が、対応するテストケースファイルに現れない。`origin/main` でも同じ状態であり本 PR の改訂とは無関係なので、修正は別 Issue が妥当。

**[N-003]** `.thread/35/plan.md` の baseline 実測値 `782` が実際と食い違う（成果物の正確性のみの問題）

`plan.md:332` は `grep -cE '^\| \`?TC-' spec/inventory/test.md # 814（旧 782）` と書いているが、`origin/main` の実測は **771** である（同じコマンドで確認）。完了値 `814` は正しく、`spec/index.md` もそれに揃っているので実害は無いが、`.thread/` を後から読む担当者が「+32 のはず」と数え違える材料になる。`step14-checklist.md` は同種の数え違い（ADR-028 の「4ファイル11行」）を末尾で自己訂正しているので、同じ形で1行足しておくと整合する。

## カバレッジ（変更ファイル 97 件と 1 対 1）

判定は **確認**（本観点の成果物として差分・内容を検査した）/ **参照のみ**（テストケース整合の照合先として必要箇所を読んだが、その成果物自体はレビューしていない）/ **スキップ**（本観点の担当外）。

| # | ファイル | 判定 | 備考 |
|---|---|---|---|
| 1 | `.thread/35/adr.md` | 参照のみ | ADR-009 のみ（N-001 の根拠確認） |
| 2 | `.thread/35/coverage.md` | 確認 | `NO-VERDICT` 0 / 103 行 / 判定と実差分の3方向突き合わせ |
| 3 | `.thread/35/plan.md` | 確認 | AC-9/10/11/16/19 の検証条件と `P-7` / `P-8` の実行（N-003） |
| 4 | `.thread/35/review/review-001-database.md` | スキップ | 1R レビュー記録・別観点 |
| 5 | `.thread/35/review/review-001-design-fidelity.md` | スキップ | 同上 |
| 6 | `.thread/35/review/review-001-domain-usecase.md` | スキップ | 同上 |
| 7 | `.thread/35/review/review-001-requirements.md` | スキップ | 同上 |
| 8 | `.thread/35/review/review-001-testcases.md` | スキップ | 既出指摘は `triage.md` で把握（記録の改変不要） |
| 9 | `.thread/35/review/review-001.md` | スキップ | 同上 |
| 10 | `.thread/35/review/triage.md` | 確認 | 既判定 37 件を継承。再提出なし |
| 11 | `.thread/35/step14-checklist.md` | 確認 | 32 行と (A)/(B)/(C) の適用を testcases 実物と照合 |
| 12 | `.thread/35/steps.md` | スキップ | 手順書・別観点 |
| 13 | `.thread/35/testing.md` | スキップ | 検証コマンドは `plan.md` 側を実行して代替 |
| 14 | `CLAUDE.md` | スキップ | AC-12・別観点（本文は通読したが差分は未レビュー） |
| 15 | `spec/database/index.md` | 参照のみ | trigram / `instr()` / NFKC / スニペット原文 / `purge_after` / `jobs.kind` をテストケースの照合に使用 |
| 16 | `spec/domains/export.md` | 参照のみ | 総バイト上限・実行位置（exportAllData の新設2ケースの根拠） |
| 17 | `spec/domains/identity.md` | 参照のみ | `CredentialMapping` の列・`promoteVerifier`・LastCredentialRemoval（W-002 / B-001 の根拠） |
| 18 | `spec/domains/index.md` | 参照のみ | 「テナント分離」「ポートの同期契約」（到達可能性表現の照合） |
| 19 | `spec/domains/knowledge.md` | 参照のみ | 不変条件 5 / 7 / 10（knowledge テストケースの照合） |
| 20 | `spec/domains/memo.md` | 参照のみ | 不変条件 8（`trashed ⇔ purgeAfter`）の存在確認 |
| 21 | `spec/domains/search.md` | 確認 | 全文精読。`SearchIndexPort.query` 1本・bm25 とタイトル重み・tie-breaker・カーソル契約・`TOPIC_NOT_FOUND` を search 系テストと1対1照合 |
| 22 | `spec/domains/trash.md` | 参照のみ | 「保持期限」節・`listItemsToPurge` / `recalculatePurgeAfter`（B-002 の根拠） |
| 23 | `spec/idea.md` | スキップ | 別観点（要件） |
| 24 | `spec/index.md` | 確認 | 件数（53 / 814 / 39 / 201）を台帳実測と照合 |
| 25 | `spec/inventory/adapter.md` | 確認 | ID 欠番規約・`P-8`・削除対象 ID の残存検査 |
| 26 | `spec/inventory/domain.md` | 確認 | イベント 24 行の欠番化と `DOM-identity-023〜028` の保持を機械検証（W-001） |
| 27 | `spec/inventory/frontend.md` | 確認 | `PAGE-password-reset-004` / `PAGE-settings-007`（B-001 の根拠）・ID 連番 |
| 28 | `spec/inventory/test.md` | 確認 | `#L` 全 814 件の機械検証・全単射・要点欄の突き合わせ（W-001） |
| 29 | `spec/inventory/usecase.md` | 確認 | 53 件とテストケースファイルの全単射 |
| 30 | `spec/manual-tests/account.md` | 確認 | 全差分精読。TC 数 40・内訳 13/23/4（B-001 / W-002） |
| 31 | `spec/manual-tests/ai.md` | 確認 | 反映待ち前提の除去・TC 数 23 |
| 32 | `spec/manual-tests/document.md` | 確認 | 同上・TC 数 41 |
| 33 | `spec/manual-tests/index.md` | 確認 | 件数表・合計 201・実行記録の分母を実測と照合。番号飛びの注記追加を確認 |
| 34 | `spec/manual-tests/search.md` | 確認 | 全差分精読。TC-18〜23 の新設と推測コマンドの不在（0 件）・テストデータ整合 |
| 35 | `spec/manual-tests/settings.md` | 確認 | 直接 SQL の除去と #38 委譲を確認 |
| 36 | `spec/manual-tests/timeline.md` | 確認 | 同上 |
| 37 | `spec/manual-tests/trash.md` | 確認 | 全差分精読（B-002） |
| 38 | `spec/pages/index.md` | スキップ | 別観点（画面仕様） |
| 39 | `spec/requirements.md` | スキップ | 別観点（要件） |
| 40 | `spec/scenario/account.md` | 参照のみ | `P-7` の第7行（`所有確認\|verification`）の確認のみ |
| 41 | `spec/scenario/ai.md` | スキップ | 別観点 |
| 42 | `spec/scenario/index.md` | スキップ | 別観点（`39シナリオ` の実測のみ使用） |
| 43 | `spec/scenario/search.md` | スキップ | 別観点 |
| 44 | `spec/testcases/export/exportAllData.md` | 確認 | 新設2ケースを `domains/export.md:269` / `usecases/export.md:62` と照合 |
| 45 | `spec/testcases/identity/approveAiClientAuthorization.md` | 確認 | (B) 適用・`createdAtResetVersion` の補記 |
| 46 | `spec/testcases/identity/changePassword.md` | 確認 | 新設8ケースを全行照合（N-001） |
| 47 | `spec/testcases/identity/changeTrashRetentionDays.md` | 確認 | `purgeAfter` 再計算・チャンク分割を `usecases/trash.md:334` と照合 |
| 48 | `spec/testcases/identity/denyAiClientAuthorization.md` | 確認 | (B) 適用 |
| 49 | `spec/testcases/identity/executePasswordReset.md` | 確認 | 新設5ケース（N-001） |
| 50 | `spec/testcases/identity/getCurrentUser.md` | 確認 | `credentials` 4フィールド・`credentialId` 露出をユースケース処理フローと照合 |
| 51 | `spec/testcases/identity/listAiClientConnections.md` | 確認 | `createdAtResetVersion` 3ケース・`011` の欠番化 |
| 52 | `spec/testcases/identity/loginWithPassword.md` | 確認 | 到達性検査・`credentialVersion`・`changeState`・ロックアウトの6ケース |
| 53 | `spec/testcases/identity/logout.md` | 確認 | (B) 適用 |
| 54 | `spec/testcases/identity/registerOrLoginWithSso.md` | 確認 | 予約2本・中間状態ケースの追加 |
| 55 | `spec/testcases/identity/registerWithPassword.md` | 確認 | 予約獲得への読み替え |
| 56 | `spec/testcases/identity/requestPasswordReset.md` | 確認 | `operationKey` / 送る側・送らない側の経路一致（全行照合） |
| 57 | `spec/testcases/identity/revokeAiClientConnection.md` | 確認 | `002` の欠番化と末尾 append を確認 |
| 58 | `spec/testcases/identity/revokeAllAiClientConnections.md` | 確認 | **新設。** `usecases/identity.md:455-492` の入出力・エラー2件・処理フロー4段をすべて被覆。既存の書式・粒度に一致。設計に無い振る舞いの発明なし |
| 59 | `spec/testcases/identity/unlinkSsoCredential.md` | 確認 | **新設。** `usecases/identity.md:494-537` のエラー6件を全被覆＋順序・中間状態・冪等性・`usableForLogin` の数え方まで反映。終端は「一様な終端 + #45」に留めており ADR-009 の線を守っている |
| 60 | `spec/testcases/knowledge/createDocument.md` | 確認 | (A)/(B) と到達可能性表現 |
| 61 | `spec/testcases/knowledge/createTopic.md` | 確認 | (B)・トピックはエントリを持たない旨 |
| 62 | `spec/testcases/knowledge/diffDocumentRevisions.md` | 確認 | 到達可能性表現 |
| 63 | `spec/testcases/knowledge/editDocument.md` | 確認 | (A)/(B) |
| 64 | `spec/testcases/knowledge/editDocumentByAi.md` | 確認 | B-001（1R）の取り残し `:7` の (A) 化を確認（N-002） |
| 65 | `spec/testcases/knowledge/getDocument.md` | 確認 | 到達可能性表現（N-002） |
| 66 | `spec/testcases/knowledge/getTopic.md` | 確認 | 同上 |
| 67 | `spec/testcases/knowledge/listDocumentRevisions.md` | 確認 | 同上 |
| 68 | `spec/testcases/knowledge/listDocumentSourceMemos.md` | 確認 | 同上 |
| 69 | `spec/testcases/knowledge/listDocumentsReferencingMemo.md` | 確認 | 同上 |
| 70 | `spec/testcases/knowledge/rollbackDocument.md` | 確認 | (A)/(B) |
| 71 | `spec/testcases/knowledge/trashDocument.md` | 確認 | `purgeAfter` 保存ケースの追加 |
| 72 | `spec/testcases/knowledge/trashTopic.md` | 確認 | `:9` の (B) 化と `purgeAfter` ケース |
| 73 | `spec/testcases/knowledge/updateTopic.md` | 確認 | `:8` / `:12` を含む全 (B) 化・join によるトピック名解決の補記 |
| 74 | `spec/testcases/memo/delete.md` | 確認 | (A)/(B)・`purgeAfter` ケース |
| 75 | `spec/testcases/memo/diffMemoRevisions.md` | 確認 | 到達可能性表現 |
| 76 | `spec/testcases/memo/editMemo.md` | 確認 | (A)/(B) |
| 77 | `spec/testcases/memo/getTimeline.md` | 確認 | 到達可能性表現 |
| 78 | `spec/testcases/memo/postMemo.md` | 確認 | (A)/(B) |
| 79 | `spec/testcases/memo/post_memo.md` | 確認 | (A) |
| 80 | `spec/testcases/memo/rollbackMemo.md` | 確認 | (A)/(B) |
| 81 | `spec/testcases/memo/softDeleteMemo.md` | 確認 | (A)/(B)・`purgeAfter` ケース |
| 82 | `spec/testcases/memo/update_memo.md` | 確認 | (A)/(B) |
| 83 | `spec/testcases/search/maintainSearchIndex.md` | 確認 | 削除（AC-10）。台帳から `TC-maintainSearchIndex-*` 28 件が消えていることを機械検証 |
| 84 | `spec/testcases/search/search.md` | 確認 | 全 41 ケースを台帳・`domains/search.md`・`usecases/search.md` と3点照合 |
| 85 | `spec/testcases/trash/emptyTrash.md` | 確認 | (A)・`purge-trash` ジョブ・同期 UoW |
| 86 | `spec/testcases/trash/hardDeleteTrashItem.md` | 確認 | 設計表外5行の (A)/(B) を含む |
| 87 | `spec/testcases/trash/listTrash.md` | 確認 | `expiresAt` = 保存済み `purgeAfter` への読み替え（B-002 の対比） |
| 88 | `spec/testcases/trash/pruneExpiredTrashItems.md` | 確認 | `chunkLimit` / `hasMore` / 再計算フェーズ優先を `usecases/trash.md:311-341` と全行照合 |
| 89 | `spec/testcases/trash/restoreDocument.md` | 確認 | (A) 3行 + `purgeAfter` 落下ケース |
| 90 | `spec/testcases/trash/restoreMemo.md` | 確認 | (A)/(B) + `purgeAfter` 落下ケース |
| 91 | `spec/testcases/trash/restoreTopic.md` | 確認 | (A) 2行 + `purgeAfter` 落下ケース |
| 92 | `spec/usecases/export.md` | 参照のみ | エラーケース表（総バイト上限） |
| 93 | `spec/usecases/identity.md` | 参照のみ | 新設2ユースケース節と `getCurrentUser` / `changePassword` の処理フロー・エラーケース |
| 94 | `spec/usecases/knowledge.md` | 参照のみ | エラーケース表の機械照合（N-002） |
| 95 | `spec/usecases/memo.md` | 参照のみ | 同上 |
| 96 | `spec/usecases/search.md` | 確認 | 入出力 DTO・エラーケース表を search テストケースと1対1照合 |
| 97 | `spec/usecases/trash.md` | 参照のみ | `listTrash` / `pruneExpiredTrashItems` の DTO・処理フロー（B-002 の根拠） |

**確認 68 件 / 参照のみ 14 件 / スキップ 15 件 = 97 件。**

スキップ 15 件の内訳は、1ラウンド目のレビュー記録 6 件（`.thread/35/review/review-001*.md`。記録なので改変対象外、既判定は `triage.md` で継承）、`.thread/35/{steps,testing}.md`（手順書・検証コマンド。実行は `plan.md` 側で代替）、`CLAUDE.md`（AC-12・別観点）、`spec/{idea,requirements,pages/index}.md` と `spec/scenario/{ai,index,search}.md`（要件・画面・シナリオ層で別観点）である。**本観点の受け入れ基準（AC-9 / AC-10 / AC-11 / AC-16 / AC-19）の検証に必要なファイルはすべて「確認」または「参照のみ」で押さえてある。**
