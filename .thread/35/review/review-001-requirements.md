# 要件・シナリオ・ページ整合

対象: PR #46（base `main`） / 契約: `.thread/35/plan.md` / 観点: 要件・シナリオ・ページの整合、AC-1 / AC-4 / AC-5 / AC-18

## 受け入れ基準の判定（自観点分）

| AC | 判定 | 根拠 |
|---|---|---|
| AC-1 | 満たす | `V-1` を実行して 0 行（`spec/**/*.md` から `review/` と `spec/adr/` を除く射程）。`ベクトル` / `embedding` / `ハイブリッド` / `Vectorize` / `RRF` / `意味検索` / `search_embeddings` はいずれも残っていない |
| AC-4 | 満たす | `spec/requirements.md:87` が「SQLite FTS5 による全文検索を単一の検索として提供する。**検索方式の選択をAIに委ねない**」。後半の一文は消えていない（`P-11` 第1行 1 行）。`:108` が `search — 全文検索。トピックによる絞り込み可`（`P-11` 第2行 1 行） |
| AC-5 | 満たす | `spec/requirements.md:131`（ユーザー単位 SQLite-backed Durable Object への物理分離 / 分離の保証は列条件ではなく到達可能性）・`:143`（1 DO あたり 10 GB。本体 + 全文検索インデックスの合計）。`P-4` の2行ともヒット |
| AC-18 | 満たす（1件の未同期あり → W-002） | 下記「数値の実測突き合わせ」参照。ユースケース数・テストケース数・マニュアルテスト件数・DB テーブル数はすべて実測と一致。同じ表の `43シナリオ` だけが実測 39 と不一致（改訂前からの持ち越し） |
| スコープ | 越境なし | `git diff --name-status origin/main...HEAD` を `spec/**/*.md` / `CLAUDE.md` / `.thread/35/**` 以外で絞ると 0 行。`spec/design/` `spec/issues.md` `docs/` `spec/**/review/` `spec/adr/` はいずれも未変更 |

## 数値の実測突き合わせ（AC-18）

実測はすべてこの PR の HEAD で取り直した。

| 主張 | 場所 | 実測 | 一致 |
|---|---|---|---|
| 51ユースケース | `spec/index.md:15,24` | `spec/testcases/` のファイル 51 / `spec/inventory/test.md` の `TC-{slug}` の異なり数 51 | ○ |
| 782ケース | `spec/index.md:15,26` | `spec/inventory/test.md` の `TC-` 行 782。テストケース表の実データ行も全ファイルで台帳と一致（初回集計で出た 785 は複数表を持つ `restoreDocument.md` のヘッダ3行を数えたこちらの誤り） | ○ |
| 199ケース（7カテゴリ） | `spec/manual-tests/index.md:22,39` / `spec/index.md:16,27` | `account 40 / timeline 37 / document 41 / search 21 / trash 25 / ai 23 / settings 12` = 199 | ○ |
| 件数表の内訳 | `spec/manual-tests/index.md:15-22` | 節見出しから数え直して `account 13/23/4`・`search 10/7/4`。列合計も `85 / 85 / 29` で一致 | ○ |
| 実行記録の分母 | `spec/manual-tests/index.md:39` | `/199件 PASS` | ○ |
| User Data DO 16 テーブル / Identity Directory DO 5 テーブル | `spec/index.md:25` | `spec/database/index.md` の `## User Data DO のテーブル` 配下 16 見出し（account / user_settings / credential_locators / ai_client_connections / memos / memo_revisions / topics / documents / document_revisions / source_links / search_entries / search_fts / jobs / operations / migration_progress / _meta）、`## Identity Directory DO のテーブル` 配下 5 見出し | ○ |
| 7カテゴリ・43シナリオ | `spec/index.md:12,21` | `spec/scenario/*.md` の `S-XX-NN` は 39（account 7 / ai 6 / document 9 / search 3 / settings 2 / timeline 7 / trash 5） | ✗ → W-002 |
| P-01〜P-14 の14画面 | `spec/index.md:14,22` | `spec/pages/index.md` の `## P-NN` 14 | ○ |

TC 番号の採番規約も守られている。`account.md` は TC-38〜40、`search.md` は TC-18〜21 を**末尾採番**で足しており、既存 TC の番号は1つも動いていない（節内で番号が飛ぶ形になるが、plan の「既存の連番を繰り上げない」に沿う）。

## Blockers

- **[B-001]** P-13 のパスワード変更フォーム表示判定が、上流の DTO で評価できない。しかも DTO どおりに素直に読むと **SSO 専用アカウントにフォームが出てしまい、画面仕様・シナリオ・マニュアルテストの約束と反対の結果になる**
  - 場所: `spec/pages/index.md:223` / `spec/inventory/frontend.md:67` / `spec/usecases/identity.md:488,504` / `spec/domains/identity.md:52-57,83-85`
  - 理由: P-13 と `PAGE-settings-005` は判定を「保有クレデンシャル集合に **`usableForLogin = true`** の `kind = 'email'` の要素があるか」と書く。しかし画面へ渡る材料は `getCurrentUser` の出力 DTO（`spec/usecases/identity.md:504`）＝ `{ credentialId, kind, label }` の3つ組で、`usableForLogin` を**持たない**。`spec/domains/identity.md:52` の `CredentialRef` にも無く、コメントは「設定画面の一覧に出せるのはこの3つだけ」と明示的に閉じている。したがって画面はこの判定を実行できない。
    代わりに `spec/usecases/identity.md:488` が書く判定（「`kind: "email"` のログイン手段が無ければ非表示」）を DTO の語彙へ落とすと「`kind === 'email'` の要素があるか」にしかならないが、`spec/domains/identity.md:83-85` の `registerWithSso` は **SSO 専用アカウントにも `kind: "sso"` と `kind: "email"` の2件**を作る（設計 第6.1.1節 (R4) の「SSO 専用ユーザーの行数は常に2」と同じ）。この判定では SSO 専用アカウントで常に真になり、`spec/pages/index.md:223`・`spec/scenario/account.md:85`（エッジケース）・`spec/manual-tests/account.md:479`（TC-33「パスワード変更の項目が表示されない」）がすべて破れる。
    要件側の負の検証（`V-*`）にも正の検証（`P-*`）にも掛からない種類の破れで、`.thread/34/handoff.md` 第4節が警告した「正本だけを直して適用先へ届かない」形の裏返し（適用先だけが上流に無い語で書かれた形）である。
  - 提案: どちらかに揃える。(a) `getCurrentUser` の出力 DTO に判定材料を1つ足す — 個別クレデンシャルに `usableForLogin` を載せる（設計 第6.1.2節 (C5) が設定画面向けに3つ組へ絞った理由は非 PII 化なので、真偽値の追加はその制約に反しない）か、`canChangePassword: boolean` のような画面向けの導出フラグを DTO 直下に1つ置く。(b) DTO を動かさないなら、P-13 / `PAGE-settings-005` / `spec/usecases/identity.md:488` の3箇所の判定文言を DTO で評価できる形へ書き直し、**`kind: 'email'` の要素があるだけでは真にならない**ことを明記する。いずれの場合も `spec/domains/identity.md` の `CredentialRef` の注記（「出せるのはこの3つだけ」）と矛盾させないこと。

- **[B-002]** 画面・シナリオ・手順書が新たに約束した2つの操作（**SSO 連携の解除** / AI クライアント接続の**「すべて失効」**）に、対応するユースケースが `spec/usecases/` にも `spec/inventory/usecase.md` にも存在しない
  - 場所: `spec/pages/index.md:68-69,224` / `spec/scenario/account.md:74` / `spec/inventory/frontend.md:73,75`（`PAGE-password-reset-004` / `PAGE-settings-007`） / `spec/manual-tests/account.md:199,201` / `spec/usecases/identity.md`（13ユースケース。該当なし） / `spec/inventory/usecase.md`（`UC-identity-001`〜`013`）
  - 理由: 「覚えの無い SSO 連携をその場で解除できる」「一覧の全接続が失効済みになる」は利用者から観測できる振る舞いの断定であり、手順書の実行ステップにもなっている。しかし `spec/usecases/identity.md` にあるのは `revokeAiClientConnection`（単体・`connectionId` 必須）だけで一括失効の入口は無く、SSO 解除は `spec/domains/identity.md:93` に `removeCredential` があるものの、同ファイル `:389` が「登録・変更・解除の手順そのものは…**usecases/identity.md に書く**」と宣言しているその手順が書かれていない。結果として **#10 / #13 型の実装チェックリスト（`spec/inventory/` 由来）にこの2操作が1行も現れない** — 画面だけが約束し、実装計画には載らない状態になる。
    なお設計（`.thread/34/design.md:2344`）はこの2導線を「画面仕様として #35 へ送る」としており、**画面側に書いたこと自体は正しい**。欠けているのは受け皿側の宣言である。
  - 提案: 重い対応（ユースケース新設）まで踏み込まなくてよい。最小でも (a) `spec/usecases/identity.md` に「クレデンシャル解除 / 接続の一括失効はユースケース未定義であり、対応は #37 以降で定める」旨の明示的な注記を置く、または (b) 「すべて失効」は `revokeAiClientConnection` の反復適用である／SSO 解除は `removeCredential` を呼ぶ新ユースケースが要る、のどちらであるかを1行で断定する。いずれかを入れて、`spec/inventory/frontend.md` の該当2行から参照先を辿れるようにすること。

## Warnings

- **[W-001]** 読み取り専用ユースケースのテストファイルに、書き込み操作（「すべて失効」）の期待が置かれている
  - 場所: `spec/testcases/identity/listAiClientConnections.md:17` / `spec/inventory/test.md:135`（`TC-listAiClientConnections-011`）
  - 理由: `listAiClientConnections` は `spec/usecases/identity.md:366-407` で「読み取りのみ。UoW 不要」「エラーケースは DB 例外のみ」と定義されている。そのテストケース表に「リセット完了画面から**「すべて失効」を実行する** → すべて `revoked` になる」を置くと、このユースケースの契約では実行も検証もできないケースが台帳 ID 付きで固定される。設計（`design.md:2462`）がこのファイルへ指示したのは**リセット完了による自動失効の観測**（他3行はその指示どおり）であり、この1行だけが指示の外にある。
  - 提案: この行を削り、B-002 の受け皿が決まったところ（一括失効のユースケースのテストケース、または `spec/manual-tests/account.md` の TC-38 手順3）へ寄せる。台帳側は欠番のまま残す（plan の ID 規約）。

- **[W-002]** `spec/index.md` の「43シナリオ」が実測 39 と合わない
  - 場所: `spec/index.md:12`（進捗表 Phase 1）/ `:21`（成果物）
  - 理由: AC-18 で同じ表・同じ節の他の数値（ユースケース・テストケース・マニュアルテスト・テーブル構成）を全部数え直しているのに、2行上の `43シナリオ` だけが残った。改訂前からの持ち越しで本 Issue が壊した数値ではないが、「実測と突き合わせた表」の中に1つだけ嘘が混ざるのは、次に読む人が全部を疑う形になる。実測は `S-XX-NN` の異なり数で 39（account 7 / timeline 7 / document 9 / search 3 / trash 5 / ai 6 / settings 2）。
  - 提案: `39シナリオ` に直す。数え方（`grep -rhoE 'S-[A-Z]{2}-[0-9]{2}' spec/scenario/*.md | sort -u | wc -l`）を PR 本文に残しておくと次の改訂で再現できる。

- **[W-003]** P-11 に新設した「もっと読む」導線と「カーソル期限切れ」状態が、シナリオにもマニュアルテストにも降りていない
  - 場所: `spec/pages/index.md:190,197` / `spec/scenario/search.md`（記述なし） / `spec/manual-tests/search.md`（該当 TC なし）
  - 理由: 追加取得とカーソル期限切れは**利用者から見える振る舞い**（追加のボタン、拒否メッセージ、先頭からの再検索への誘導）である。上流の S-SE-01 は結果表示までしか書いておらず、手順書側も TC-01〜21 のどれもページングに触れていないので、「もっと読む」を押した先の体験は誰も検証しない。`spec/manual-tests/search.md:321` は `InvalidCursor` を「UI が前ページの応答をそのまま渡すため注入できない」として対象外にしているが、これは**不正カーソルの注入**の話であって**期限切れ**（時間経過で必ず起きる）の話ではない。
  - 提案: S-SE-01 のエッジケースに1行（続きの取得はカーソルで行い、期限が切れたら先頭から取り直す）を足し、`spec/manual-tests/search.md` に「もっと読むで続きが重複・欠落なく読める」1件を足す（期限切れの再現手段が無ければ対象外理由をカバレッジ表に書く）。件数表の同期（AC-18）も忘れないこと。

- **[W-004]** カーソルの検証責任が層をまたいで矛盾している。P-11 の「カーソル期限切れ」表示の根拠が確定していない
  - 場所: `spec/domains/search.md`（`SearchCursor` の定義「不透明。中身の解釈は `SearchIndexPort` の実装に閉じる」 vs `SearchQuery` のバリデーションルール「`cursor` が不正または期限切れなら `BusinessRuleError(InvalidCursor)`」） / `spec/usecases/search.md`「処理フロー」2（「`cursor` の妥当性の検証はここ（ドメイン）で行われる」）
  - 理由: 値オブジェクトの構築時に**期限切れ**を判定するには、カーソルの中身（発行時刻・スナップショット ID）を解釈できなければならない。同じファイルが「解釈はポート実装に閉じる」と書いているので、`SearchQuery.create` はこの判定を構造的にできない。`spec/testcases/search/search.md` の該当ケース（「不正な形式、または有効期限を過ぎた `cursor`」→ `InvalidCursor`）はどちらの層の責務としても読めてしまう。
  - 提案: 「形式（不透明値としての体裁）は `SearchQuery.create`、有効期限は `SearchIndexPort` の実装が判定し、どちらも同じ `BusinessRuleError(InvalidCursor)` を返す」と分けて書く。利用者から見た結果（先頭からやり直し）は変わらないので、P-11 の文言はそのままでよい。

- **[W-005]** 認証済み経路のロックアウトが画面仕様に降りていない。ログイン経路との**非対称**が利用者に見えるのに、どの画面仕様にも書かれていない
  - 場所: `spec/pages/index.md:226-229`（P-13 の状態に該当なし） / `spec/testcases/identity/changePassword.md:25`（「明示的に拒否される。ダミー材料へ倒すのではない」）
  - 理由: 設計 `design.md:750` は「拒否なら…UI に**「試行が制限されている」を正しく出せる**（**#35 の画面文言**）」と、画面文言を明示的に本 Issue へ渡している。ログイン（P-01）は逆に「ロックアウト中であることを応答から区別できない」（`spec/manual-tests/account.md:502`）ので、**同じ製品の中で開示方針が経路ごとに反転する**。この反転はテストケース1行にしか無く、画面仕様・シナリオ・手順書のどこにも無いため、実装者は P-01 と同じ「メールアドレスまたはパスワードが正しくない」を出す方に倒れやすい。
  - 提案: P-13 の状態に「パスワード変更の試行が制限されている場合はその旨を明示する（未認証のログイン経路とは異なり、認証済み経路では隠さない）」を1行足す。`spec/inventory/frontend.md` の `PAGE-settings-005` にも同じ要点を写す。

- **[W-006]** `TOPIC_NOT_FOUND` に対応する画面の状態が P-11 に無い
  - 場所: `spec/pages/index.md:194-197` / `spec/usecases/search.md`「エラーケース」 / `spec/manual-tests/search.md:322`
  - 理由: 本 PR が新設したエラー（未知・ゴミ箱内のトピック指定は空結果ではなく `NotFoundError(TOPIC_NOT_FOUND)`）は、利用者に見えるエラー表示になる。手順書は「ゴミ箱内トピックが絞り込みの選択肢に現れない」ことを根拠に対象外としているが、選択肢はページ読み込み時のスナップショットなので、**別タブでトピックをゴミ箱へ入れたあと絞り込みを保ったまま再検索する**と到達する。カーソル期限切れの状態は書いたのに、同じ性質のこちらだけ抜けている。
  - 提案: P-11 の状態に「絞り込み対象のトピックが見つからない: その旨を表示し、絞り込みを解除して再検索へ誘導する」を足す（1行）。手順書側は対象外のままでよいが、対象外理由を「選択肢に出ない」ではなく「別タブでの削除との競合が必要で手動再現が難しい」に直すのが正確。

## Notes

- **[N-001]** 上流（要件）→ 下流（シナリオ・ページ・手順書）の置換は、検索まわりについては一貫している。`spec/requirements.md:87` の定義 → `spec/scenario/search.md:6` / `spec/scenario/index.md:42` / `spec/scenario/ai.md:19` / `spec/pages/index.md:185` / `spec/idea.md:40` / `spec/manual-tests/{search,ai,document}.md` の環境前提まで、「ハイブリッド」「ベクトル」の語が残らず、かつ**シナリオ層に実装語彙（FTS5）を持ち込んでいない**（`spec/scenario/search.md` は「全文検索」止まり、`spec/idea.md` と `spec/manual-tests/search.md` だけが FTS5 に触れる）。ADR-015 の意図どおり。
- **[N-002]** 「投稿直後に必ずヒットする」の根拠が上流に揃っている。`spec/scenario/search.md:16`（体験）→ `spec/domains/search.md`「検索の規則」末尾・「インデックスの維持」（同一トランザクションでの projection 更新）→ `spec/usecases/search.md`「補足」→ `spec/testcases/search/search.md`（投稿直後ケース）→ `spec/manual-tests/search.md` TC-07（待ち時間なし + 「反映待ちの案内が UI に一切出ない」の確認ポイント）。嘘のある約束にはなっていない。旧記述（`V-7`: 「ヒットしない場合がある」「1〜2分待つ」等）は 0 行。
- **[N-003]** マニュアルテストの環境前提の置き換えが、plan の禁止事項（「具体的なコマンドを推測で書かない」）を守っている。`spec/manual-tests/{timeline,settings,trash}.md` の生 SQL は削除され、「DO 単位のシード投入 / Alarm の強制発火に相当する手段。実体は #38」までで止めている。`V-2c` も 0 行。
- **[N-004]** `spec/manual-tests/search.md` の追加ケース（TC-18〜21）は、tokenizer の機構（trigram / NFKC / 短語フォールバック）を**利用者から観測できる形**（日本語の部分一致がヒットする / 全角半角のどちらでも 2 件ヒットする / スニペットが入力したままの表記で返る / 1文字でもヒットしエラーにならない）に翻訳して書けている。手順書に実装語彙を持ち込みすぎず、確認可能性も落ちていない。
- **[N-005]** `spec/pages/index.md` P-02 の「登録済みかどうかを秘匿しない」と P-03 の「登録有無は明かさない」は、製品としては前者が後者を無効化する（signup が列挙オラクルになるので、リセット依頼側の秘匿は実効を失う）。ただし P-02 は「列挙オラクルであることを承知のうえでの受容判断」と自認しており、設計 `design.md:2347` の断定どおりなので指摘としては立てない。読み手のために P-02 か P-03 の一方に相互参照（「リセット側の秘匿はこの受容の影響を受ける」）を1行置くと親切、という程度。
- **[N-006]** `spec/idea.md:40` の「メモ・ドキュメント横断の全文検索（SQLite FTS5））」は括弧の入れ子で読みにくい。`markdown-style` の「不自然な記述をしない」に照らすと「メモ・ドキュメント横断の全文検索（SQLite FTS5）」で足りる。

## 補足: この観点で「機械検査に掛からない」と判断した箇所

plan の `V-*` / `P-*` はいずれも本レビューの Blocker 2件を検出しない。理由を記録しておく。

- B-001 は「上流に存在しない語（`usableForLogin`）を下流が使っている」形なので、**下流から上流へ向かう検査が1本も無い**（`P-8` は台帳のアンカー実在だけを見る）。`P-7` の対象9ファイルにも `spec/pages/index.md` は入っていない。
- B-002 は「画面が約束した操作にユースケースが無い」形で、`spec/inventory/frontend.md` に行が**足された**ことは `P-7` の最終行（`PAGE-password-reset-004`）が確認するが、その行が指す操作の受け皿があるかは誰も見ていない。
- AC-14 / AC-15 は「#10 / #13 のチェックリスト ID が台帳に実在するか」しか見ないので、**台帳に無い新操作**は構造的に検出できない。

## カバレッジ

一覧 80 件に 1 対 1 で対応する（確認 33 / スキップ 47）。

### 確認（33）

`.thread/35/plan.md`, `CLAUDE.md`, `spec/database/index.md`, `spec/domains/identity.md`, `spec/domains/search.md`, `spec/idea.md`, `spec/index.md`, `spec/inventory/domain.md`, `spec/inventory/frontend.md`, `spec/inventory/test.md`, `spec/inventory/usecase.md`, `spec/manual-tests/account.md`, `spec/manual-tests/ai.md`, `spec/manual-tests/document.md`, `spec/manual-tests/index.md`, `spec/manual-tests/search.md`, `spec/manual-tests/settings.md`, `spec/manual-tests/timeline.md`, `spec/manual-tests/trash.md`, `spec/pages/index.md`, `spec/requirements.md`, `spec/scenario/account.md`, `spec/scenario/ai.md`, `spec/scenario/index.md`, `spec/scenario/search.md`, `spec/testcases/identity/changePassword.md`, `spec/testcases/identity/getCurrentUser.md`, `spec/testcases/identity/listAiClientConnections.md`, `spec/testcases/search/maintainSearchIndex.md`（削除の確認）, `spec/testcases/search/search.md`, `spec/testcases/trash/restoreDocument.md`, `spec/usecases/identity.md`, `spec/usecases/search.md`

（`CLAUDE.md` / `spec/database/index.md` / `spec/inventory/{domain,usecase,test}.md` / `spec/testcases/identity/{changePassword,getCurrentUser}.md` / `spec/testcases/trash/restoreDocument.md` は、要件・画面の主張との突き合わせに必要な範囲だけを読んだ。全文精査は各担当観点に委ねる。）

### スキップ（47）

- `.thread/35/adr.md`, `.thread/35/coverage.md`, `.thread/35/step14-checklist.md`, `.thread/35/steps.md`, `.thread/35/testing.md` — 作業計画・判断記録であって要件・体験の成果物ではない（判断根拠の確認のため一部を参照）。
- `spec/domains/export.md`, `spec/domains/index.md`, `spec/domains/knowledge.md`, `spec/domains/memo.md`, `spec/domains/trash.md` — ドメイン層の内部記述で、要件・シナリオ・ページの主張と直接接続しない（ドメイン観点の担当）。
- `spec/inventory/adapter.md` — アダプター要素台帳。体験記述との接点が無い。
- `spec/testcases/export/exportAllData.md` — エクスポートの内部期待値（上限・実行位置）。体験側の主張は `spec/manual-tests/settings.md` 側で確認済み。
- `spec/testcases/identity/approveAiClientAuthorization.md`, `changeTrashRetentionDays.md`, `denyAiClientAuthorization.md`, `executePasswordReset.md`, `loginWithPassword.md`, `logout.md`, `registerOrLoginWithSso.md`, `registerWithPassword.md`, `requestPasswordReset.md`, `revokeAiClientConnection.md` — ユースケース単位の期待値表。体験側の主張（S-AC-01/02/07・TC-29/33/38〜40）との突き合わせは `spec/scenario/account.md` / `spec/manual-tests/account.md` 側で実施した。
- `spec/testcases/knowledge/createDocument.md`, `createTopic.md`, `editDocument.md`, `editDocumentByAi.md`, `rollbackDocument.md`, `trashDocument.md`, `trashTopic.md`, `updateTopic.md` — projection 期待への読み替え。テストケース観点の担当。
- `spec/testcases/memo/delete.md`, `editMemo.md`, `postMemo.md`, `post_memo.md`, `rollbackMemo.md`, `softDeleteMemo.md`, `update_memo.md` — 同上。
- `spec/testcases/trash/emptyTrash.md`, `hardDeleteTrashItem.md`, `listTrash.md`, `pruneExpiredTrashItems.md`, `restoreMemo.md`, `restoreTopic.md` — 同上（`purge_after` / `purge-trash` の読み替え）。
- `spec/usecases/export.md`, `spec/usecases/knowledge.md`, `spec/usecases/memo.md`, `spec/usecases/trash.md` — イベント廃止に伴う同期化の書き換えが主で、画面・シナリオの主張とは接しない（ユースケース観点の担当）。
