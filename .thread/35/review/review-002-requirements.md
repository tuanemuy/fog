# 要件・シナリオ・ページ整合（ラウンド2）

対象: PR #46（base `main`） / 契約: `.thread/35/plan.md` / 観点: 要件・シナリオ・ページの整合、AC-1 / AC-4 / AC-5 / AC-18

ラウンド1の指摘（`.thread/35/review/triage.md`）は再提出しない。本ラウンドは **5人並列の修正 + 追随作業2回が互いを壊していないか**に焦点を当てた。

## 受け入れ基準の判定（自観点分）

| AC | 判定 | 根拠（HEAD で実測し直した） |
|---|---|---|
| AC-1 | 満たす | `V-1` を実行して 0 行。ついでに `V-2a/2b/2c` / `V-3` / `V-3b` / `V-4` 〜 `V-10` も全件 0 行を確認した（ラウンド1の修正が負の検証を壊していない） |
| AC-4 | 満たす | `spec/requirements.md:87` が「SQLite FTS5 による全文検索を単一の検索として提供する。検索方式の選択をAIに委ねない」。`:108` が `search — 全文検索。トピックによる絞り込み可`。`P-11` の2行ともちょうど 1 行で維持されている |
| AC-5 | 満たす | `spec/requirements.md:131`（ユーザー単位 SQLite-backed Durable Object への物理分離 / 保証は列条件ではなく到達可能性）・`:143`（1 DO あたり 10 GB。本体 + 全文検索インデックスの合計）。`CLAUDE.md`「Storage limits」の 10 GB とも文言が一致する |
| AC-18 | **満たす（ラウンド1の W-002 も解消済み）** | 下記「件数の実測突き合わせ」参照。**主張されている 53 / 814 / 39 / 201 / 16・5 はすべて実測と一致した** |
| スコープ | 越境なし | `git diff --name-status origin/main...HEAD` を `spec/**/*.md`・`CLAUDE.md`・`.thread/35/**` 以外で絞ると 0 行。`spec/design/` `spec/issues.md` `docs/` `README.md` `spec/**/review/` `spec/adr/` はいずれも未変更 |

補助として `P-1`〜`P-11` も全件実行し、すべて期待どおり（`P-8` / `P-9` / `P-10` は 0 行、`P-1`〜`P-7` / `P-11` は各行 1 以上）。`spec/domains/search.md` に tokenizer の機構語（`trigram` / `NFKC` / `instr(`）が漏れていないことも確認した（0 行。ADR-004 / ADR-015 の配置が守られている）。

## 件数の実測突き合わせ（AC-18）

| 主張 | 場所 | 実測 | 一致 |
|---|---|---|---|
| 53ユースケース | `spec/index.md:15,24,26` | `grep -cE '^\| \`?UC-' spec/inventory/usecase.md` = 53。`spec/testcases/` のファイル数も 53 で 1:1 | ○ |
| 814ケース | `spec/index.md:15,26` | `grep -cE '^\| \`?TC-' spec/inventory/test.md` = 814。**さらに `spec/testcases/**/*.md` の表データ行を全 53 ファイル数え直して 814、かつ全ファイルで台帳の件数と一致**（`MISMATCH` 0 件） | ○ |
| 39シナリオ | `spec/index.md:21` | `S-XX-NN` の異なり数 39（account 7 / timeline 7 / document 9 / search 3 / trash 5 / ai 6 / settings 2）。ラウンド1 W-002 の `43シナリオ` は直っている | ○ |
| 201ケース（7カテゴリ） | `spec/manual-tests/index.md:22,41` / `spec/index.md:16,27` | `account 40 / timeline 37 / document 41 / search 23 / trash 25 / ai 23 / settings 12` = 201 | ○ |
| 件数表の各行 | `spec/manual-tests/index.md:15-21` | 全7行が上の実測と一致。種別内訳も、節見出しで分かれている4ファイル（account 13/23/4・document 19/15/7・search 11/8/4・timeline 14 + 23）で実測と一致 | ○ |
| 件数表の列合計 | `spec/manual-tests/index.md:22` | `86 / 86 / 29`。行方向（各行の3列和 = テストケース数）・列方向のどちらも整合 | ○ |
| 実行記録の分母 | `spec/manual-tests/index.md:41` | `/201件 PASS` | ○ |
| User Data DO 16 / Identity Directory DO 5 | `spec/index.md:25` | `spec/database/index.md` の `## User Data DO のテーブル` 配下 `###` が 16、`## Identity Directory DO のテーブル` 配下が 5 | ○ |
| P-01〜P-14 の14画面 | `spec/index.md:14,22` | `spec/pages/index.md` の `## P-NN` が 14 | ○ |
| spec 非 review ファイル数 102 | `.thread/35/plan.md` AC-16 | `find spec -name '*.md' \| grep -v '/review/' \| wc -l` = 102 | ○ |
| trash.md 内部の件数表 | `spec/manual-tests/trash.md:441` | 合計 25 / 異常系・境界値 12 / 正常系 13。index の `13 / 10 / 2` と整合。他ファイルに内部件数表は無い | ○ |

**AC-18 に残件は無い。** ラウンド1で唯一残っていた `43シナリオ` も解消され、`spec/index.md` / `spec/manual-tests/index.md` の全数値が台帳・実ファイルの実測と一致する。

## Blockers

- **[B-001]** リセット完了画面（P-03）が必須と定めた2つの導線は、**未ログイン状態で開かれる画面**なのに、その受け皿として新設された4つのユースケースがそろって「`userId` はセッション由来の信頼済み ID」を要求している。画面の約束を、上流の契約どおりに実装する経路が存在しない
  - 場所: `spec/pages/index.md:66-69`（完了画面の必須導線） / `spec/pages/index.md:16`（P-03 のパスは `/password-reset`。共通レイアウト `:8` の「保護画面」ではない） / `spec/usecases/identity.md:12`（identity 全体の宣言）・`:224,235`（`executePasswordReset` は「未ログインでアクセス可能」「再ログインは UI 側の導線で行う」）・`:246`（`advanceSessionEpoch` で既存セッションを全部切る）・`:469`（`revokeAllAiClientConnections` の `userId`）・`:508`（`unlinkSsoCredential` の `userId`）・`:386`（`listAiClientConnections`）・`:589`（`getCurrentUser`） / `spec/inventory/frontend.md:73`（`PAGE-password-reset-004`） / `spec/scenario/account.md:74` / `spec/manual-tests/account.md:196-201`（TC-38 の前提は「TC-10 の手順1〜4 を実行し、リセット完了画面を表示していること」＝ログイン前）
  - 理由: 完了画面には (a) 保有クレデンシャル一覧 → `getCurrentUser`、(b) AI クライアント接続一覧 → `listAiClientConnections`、(c) SSO 解除 → `unlinkSsoCredential`、(d) すべて失効 → `revokeAllAiClientConnections` の4つが要る。ところが `spec/usecases/identity.md:12` が「`input` の `userId` はセッション由来の信頼済み ID（presentation 層が**認証済みセッション**から注入する）」と identity 全体に対して宣言しており、4つとも `userId` 行はその文言のままである。一方この時点で利用者はログインしておらず（`spec/pages/index.md:75` 「成功: 上の必須導線2つを提示したうえで、**ログイン画面へ誘導**」／`spec/manual-tests/account.md:170` TC-10 手順5「完了画面からログイン画面（P-01）へ進み…ログインする」／`spec/testcases/identity/executePasswordReset.md:27` 「リセットが完走した → 新しいパスワードでログインする」）、しかも `executePasswordReset` は手順6-1 で `sessionEpoch` を前進させて**残っていたセッションも全部殺す**。トークンは手順2 で消費済みなので再提示もできない。つまり4つのどれも呼べない。
    さらに同じ DTO 表の中で矛盾している — `spec/usecases/identity.md:509` は `credentialId` を「設定画面・**リセット完了画面**からの外部入力」と明記しており、リセット完了画面が呼び元であることを spec 自身が認めながら、隣の行の `userId` は認証済みセッション由来だと言っている。
    これはラウンド1の **B-002（受け皿のユースケースを新設）と B-007（リセット時に `sessionEpoch` を前進）が、それぞれ単体では正しいのに互いを壊した**形である。どちらの担当者も相手の前提を見ていないので、`.thread/34/handoff.md` 第4節が「機械検査を設計できなかった」と言った残余リスクの実例になっている。`V-*` / `P-*` はどれも認証文脈を見ないので落ちない。
  - 提案: どちらかに倒して1箇所で断定する。(a) `executePasswordReset` の出力を `void` から変え、**リセット完走時に新しいセッションを確立する**（`sessionEpoch` 前進の直後に本人のセッションだけ張り直す）と決めて、`spec/pages/index.md:75` / `spec/manual-tests/account.md` TC-10 手順5 / `spec/testcases/identity/executePasswordReset.md` の「ログインし直す」系の記述を揃える。(b) セッションを張らないなら、**完了画面専用の短命な後続トークン**（消費済みリセットトークンと引き換えに発行する1回限りの資格）を上流に定義し、4つのユースケースの `userId` 行に「セッション、またはリセット完了直後の後続資格から注入する」を書く。いずれの場合も `spec/usecases/identity.md:12` の全体宣言に例外を明記し、`spec/inventory/frontend.md:73` と `spec/scenario/account.md:74` から辿れるようにすること。**#37 に委ねる（「認証文脈は実装時に決める」）は選べない** — 画面が「必須の導線」と断定しており、材料の取得経路は実装差ではなく契約の穴だから。

## Warnings

- **[W-001]** P-11 に新設した「絞り込み対象のトピックが見つからない」状態が、`spec/inventory/frontend.md` に1行も降りていない。同じラウンドで足した兄弟の状態（カーソル期限切れ）は `PAGE-search-005` として台帳に載っているので、非対称が残っている
  - 場所: `spec/pages/index.md:197`（状態あり） / `spec/inventory/frontend.md:55`（`PAGE-search-001` は「初期 / 検索中 / 0件 / 結果あり」までで `TOPIC_NOT_FOUND` に触れない）/ `:74`（`PAGE-search-005` は期限切れを持つ）
  - 理由: ラウンド1の W-006（P-11 に状態を足す）と W-003（もっと読む・期限切れを降ろす）が別々に処理された結果、**W-003 側だけが台帳へ届いた**。`spec/inventory/frontend.md` は #10 型の実装チェックリストの生成元なので、載らない状態は実装計画に現れない。実際に `TOPIC_NOT_FOUND` を `spec/` 全域で grep すると domains / usecases / testcases / manual-tests / inventory{usecase,domain,adapter,test} には行があるのに、**frontend 台帳だけが 0 件**である。W-005（P-13 のロックアウト文言）は同じラウンドで `PAGE-settings-005` の要点欄にきちんと写されているので、扱いが揃っていない。
  - 提案: `PAGE-search-001` の要点欄に1文足す（「絞り込み対象のトピックが見つからない場合は空結果ではなくその旨を表示し、絞り込み解除へ誘導する」）か、`PAGE-search-003`（絞り込みの指定・解除）側に持たせる。新規 ID を採る必要はない。

- **[W-002]** `revokeAllAiClientConnections` が「設定画面からも呼べる」と書いているが、P-13 にも `spec/inventory/frontend.md` の settings 行にも「すべて失効」の導線が無い。**画面が約束していない入口をユースケース側が主張している**
  - 場所: `spec/usecases/identity.md:459` / `spec/pages/index.md:220-227`（P-13 の機能は「接続を解除」＝単体のみ） / `spec/inventory/frontend.md:64`（`PAGE-settings-002` も単体解除）
  - 理由: 設計（`.thread/34/design.md`）が #35 へ送った画面仕様は「リセット完了画面に置く」までで、設定画面への追加は要求していない。`spec/scenario/account.md` S-AC-06（`:58-68`）も一覧・単体解除までしか書かない。この一文があると、実装者は P-13 にボタンを足すべきか判断できず、足せば画面仕様に無い機能が入り、足さなければユースケースの記述が嘘になる。
  - 提案: `spec/usecases/identity.md:459` から「設定画面からも呼べる」を落として P-03 専用と断定するか、逆に P-13 の機能・状態と `spec/inventory/frontend.md` の settings 行に「すべて失効」を足す。どちらでもよいが、**片方だけの記述を残さない**。

- **[W-003]** P-13 に新設した「保有クレデンシャル一覧（SSO 解除つき）」に、上流のシナリオが無い
  - 場所: `spec/pages/index.md:225`（P-13 の機能） / `spec/inventory/frontend.md:75`（`PAGE-settings-007`） / `spec/usecases/identity.md:497`（`unlinkSsoCredential` は「pages P-03 / P-13」と両方を名指し） / `spec/scenario/account.md`（S-AC-06 は AI クライアントの一覧・失効まで、S-AC-07 は パスワード変更まで。クレデンシャル一覧・SSO 解除に触れる行が無い） / `spec/scenario/index.md:12-18`（「アカウントと認証」の要約にも無い）
  - 理由: 完了画面側（P-03）の一覧は `spec/scenario/account.md:74` で明示的に約束されているのに、設定画面側だけがシナリオの裏づけを持たない。`spec/pages/index.md:28` の画面一覧で P-13 に紐づく主なシナリオは `S-AC-04/06/07, S-ST-01/02` だが、そのどれもこの操作を含まない。設計が #35 へ委譲した P-13 の項目は「SSO 専用アカウントにパスワード変更フォームを出さない」判定だけなので、**シナリオ不在のまま画面機能が1つ増えている**形になっている。
  - 提案: S-AC-07 のエッジケース（`spec/scenario/account.md:83-86`）に1行足して設定画面からも解除できることを上流に置くか、P-13 の一覧を「表示のみ（解除はリセット完了画面）」に絞る。前者を採るなら `spec/scenario/index.md` の要約にも1行足す。

- **[W-004]** S-AC-07 の手順の順序が実際の体験と逆になっており、B-001 の認証文脈の曖昧さを増幅している
  - 場所: `spec/scenario/account.md:73-75`
  - 理由: 手順2 が「新しいパスワードを設定し、**ログインし直す**」で終わっているのに、手順3 が「**リセット完了画面**には…導線が2つ必ず提示される」と、手順2 より前に起きる画面を後から説明している。ラウンド1で手順3 を挿入したときに、手順2 の末尾（旧 3 番の一部だった「ログインし直す」）を分けなかったために起きた。読み手は「ログイン後の画面なのか / ログイン前の画面なのか」をここから判断できず、B-001 の混乱の入口になっている。
  - 提案: 手順2 を「届いたメールのリンクから新しいパスワードを設定する」で切り、手順3（完了画面の導線）のあとに「ログインし直す」を独立した手順として置く。B-001 を (a) 案（完了時にセッションを張る）で解決する場合は、そこも合わせて書き換わる。

## Notes

- **[N-001]** ラウンド1で足した検索まわりの下流（`spec/scenario/search.md:8` の「もっと読む」手順4 / `:14` のカーソル期限切れ / `spec/manual-tests/search.md` TC-22・TC-23）は、上流の参照（TC-22 が「S-SE-01 手順4」、TC-23 が「P-11 / TOPIC_NOT_FOUND」）まで正しく付いている。テストデータ（TP-E / `fogpage` 連番メモ / D-A2・D-A3 / M4〜M6）も既存ケースの期待値と衝突しないよう作られており（TC-04 の「D-A2・D-A3 は `fogsearch` を含まないためヒットしない」という追記が明示的に競合を潰している）、追加が既存を壊していない。
- **[N-002]** マニュアルテストの TC 採番規約（末尾採番・繰り上げなし）と、それを読み手に伝える注記（`spec/manual-tests/index.md:33`）が揃った。`account.md` は TC-38〜40、`search.md` は TC-18〜23 を末尾採番しており、既存 TC の番号は1つも動いていない。`spec/inventory/test.md` 側も同様で、`listAiClientConnections` から1件削っても残る 001〜010 の指し先がずれていない（削ったのが末尾行だったため欠番も生じない）。
- **[N-003]** `spec/domains/identity.md:53` の「設定画面の一覧に出せるのは `credentialId` / `kind` / `label` の3つだけ」という旧注記は、直後の `:54` で「`usableForLogin` はそれ自体が識別子ではない可否フラグである」と明示的に切り分けられており、4フィールド化と矛盾しない。ラウンド1 B-001 の修正が注記まで手当てできている。
- **[N-004]** P-02 の「登録済みかどうかを秘匿しない」（列挙オラクルの受容）と P-03 の「登録有無は明かさない」の併存は、ラウンド1で N-005 として指摘した相互参照の欠落がそのまま残っている。判定対象ではないので再提出はしないが、`spec/manual-tests/account.md:429` の TC-29 が「4ケースで応答が同一」を強く検証する一方、P-02 側でメール存在が漏れる構図は変わっていない。読み手向けに P-03 側へ1行の相互参照があると親切、という程度。
- **[N-005]** マニュアルテストの環境前提の DO 化（`timeline.md` / `settings.md` / `trash.md` の生 SQL 撤去 → 「DO 単位のシード投入 / Alarm の強制発火に相当する手段。実体は #38」）は、plan の禁止事項（推測でコマンドを書かない）を守ったまま、手段が無い環境でのスキップ手順まで書けている。`trash.md` の環境前提が「常駐ワーカーの手動起動という手段は存在しない」と否定形で断っているのも、旧構成の記憶で作業する読み手への防波堤になっていて良い。

## この観点で機械検査に掛からないと判断した箇所

- **B-001**（画面の認証文脈と DTO の前提の食い違い）は、`V-*` / `P-*` のどれも「その画面がログイン済みか」を見ないので検出できない。`P-7` の対象9ファイルにも `spec/pages/index.md` は入っていない。
- **W-001 / W-002 / W-003** はいずれも「片方の層にだけ書かれた」形。`P-8` は台帳のアンカー実在しか見ず、`P-7` は特定キーワードの有無しか見ないので、**画面 ⇄ 台帳 ⇄ シナリオの双方向の対応**を測る検査は現状1本も無い。ラウンド1の B-002 と同じ構造の穴が、対象を変えて再発している。
- AC-14 / AC-15 は「#10 / #13 の ID が台帳に実在するか」しか見ないので、**新設した要素が上流の約束と対応しているか**は構造的に検出できない。

## カバレッジ

一覧 97 件に 1 対 1 で対応する（確認 36 / スキップ 61）。

### 確認（36）

`.thread/35/plan.md`, `.thread/35/review/triage.md`, `.thread/35/review/review-001-requirements.md`, `CLAUDE.md`, `spec/index.md`, `spec/idea.md`, `spec/requirements.md`, `spec/pages/index.md`, `spec/scenario/account.md`, `spec/scenario/ai.md`, `spec/scenario/index.md`, `spec/scenario/search.md`, `spec/inventory/frontend.md`, `spec/inventory/usecase.md`, `spec/inventory/test.md`, `spec/inventory/domain.md`, `spec/manual-tests/index.md`, `spec/manual-tests/account.md`, `spec/manual-tests/search.md`, `spec/manual-tests/ai.md`, `spec/manual-tests/document.md`, `spec/manual-tests/settings.md`, `spec/manual-tests/timeline.md`, `spec/manual-tests/trash.md`, `spec/usecases/identity.md`, `spec/usecases/search.md`, `spec/domains/search.md`, `spec/domains/identity.md`, `spec/database/index.md`, `spec/testcases/identity/getCurrentUser.md`, `spec/testcases/identity/listAiClientConnections.md`, `spec/testcases/identity/executePasswordReset.md`, `spec/testcases/identity/revokeAllAiClientConnections.md`, `spec/testcases/identity/unlinkSsoCredential.md`, `spec/testcases/search/search.md`, `spec/testcases/search/maintainSearchIndex.md`（削除の確認）

（`CLAUDE.md` / `spec/database/index.md` / `spec/domains/identity.md` / `spec/inventory/{domain,test,usecase}.md` は、要件・画面の主張との突き合わせと件数実測に必要な範囲だけを読んだ。全文精査は各担当観点に委ねる。）

### スキップ（61）

- `.thread/35/adr.md`, `.thread/35/coverage.md`, `.thread/35/step14-checklist.md`, `.thread/35/steps.md`, `.thread/35/testing.md`, `.thread/35/review/review-001.md`, `.thread/35/review/review-001-database.md`, `.thread/35/review/review-001-design-fidelity.md`, `.thread/35/review/review-001-domain-usecase.md`, `.thread/35/review/review-001-testcases.md`（10件）— 作業計画・判断記録・他観点のレビュー記録であって要件・体験の成果物ではない（既出指摘の確認のため一部を参照）。
- `spec/domains/export.md`, `spec/domains/index.md`, `spec/domains/knowledge.md`, `spec/domains/memo.md`, `spec/domains/trash.md`（5件）— ドメイン層の内部記述で、要件・シナリオ・ページの主張と直接接続しない（ドメイン観点の担当）。
- `spec/inventory/adapter.md`（1件）— アダプター要素台帳。体験記述との接点が無い（`ADP-search-001` の `TOPIC_NOT_FOUND` 記載のみ grep で確認）。
- `spec/usecases/export.md`, `spec/usecases/knowledge.md`, `spec/usecases/memo.md`, `spec/usecases/trash.md`（4件）— イベント廃止に伴う同期化の書き換えが主で、画面・シナリオの主張とは接しない（ユースケース観点の担当）。
- `spec/testcases/export/exportAllData.md`（1件）— エクスポートの内部期待値（上限・実行位置）。体験側の主張は `spec/manual-tests/settings.md` 側で確認済み。
- `spec/testcases/identity/approveAiClientAuthorization.md`, `changePassword.md`, `changeTrashRetentionDays.md`, `denyAiClientAuthorization.md`, `loginWithPassword.md`, `logout.md`, `registerOrLoginWithSso.md`, `registerWithPassword.md`, `requestPasswordReset.md`, `revokeAiClientConnection.md`（10件）— ユースケース単位の期待値表。体験側の主張（S-AC-01/02/03/06/07・TC-29/33/38〜40）との突き合わせは `spec/scenario/account.md` / `spec/manual-tests/account.md` 側で実施した。
- `spec/testcases/knowledge/createDocument.md`, `createTopic.md`, `diffDocumentRevisions.md`, `editDocument.md`, `editDocumentByAi.md`, `getDocument.md`, `getTopic.md`, `listDocumentRevisions.md`, `listDocumentSourceMemos.md`, `listDocumentsReferencingMemo.md`, `rollbackDocument.md`, `trashDocument.md`, `trashTopic.md`, `updateTopic.md`（14件）— projection 期待への読み替え。テストケース観点の担当（件数の実測突き合わせにのみ使用）。
- `spec/testcases/memo/delete.md`, `diffMemoRevisions.md`, `editMemo.md`, `getTimeline.md`, `postMemo.md`, `post_memo.md`, `rollbackMemo.md`, `softDeleteMemo.md`, `update_memo.md`（9件）— 同上。
- `spec/testcases/trash/emptyTrash.md`, `hardDeleteTrashItem.md`, `listTrash.md`, `pruneExpiredTrashItems.md`, `restoreDocument.md`, `restoreMemo.md`, `restoreTopic.md`（7件）— 同上（`purge_after` / `purge-trash` の読み替え）。
