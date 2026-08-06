# レビュー 002 — Documentation / ADR 整合性

**対象:** PR #53（ベース `main` / ブランチ `issue/20/pbkdf2-cost-parameters`）
**契約:** `.thread/20/plan.md`（AC-12 / AC-13 / AC-15）
**ラウンド:** 2（ゼロベースで実施）

## round 1 Blocker の解消確認

**いずれも解消している。**

1. **一括訂正注記が現行値を否定していないか** — 解消。`.thread/1/adr.md:94-97` の注記はスコープを**アルゴリズム識別子だけ**に絞り、`:96` で「**反復回数 210,000 は #20 の後も現行値である**」と明示している。同ファイル内の `210,000` の残存ヒット（`:881` ADR-021 / `:1020` ADR-026 / `:1249` ADR-033 / `:1274`-`:1275` ADR-034 / `:148`-`:162` の 2026-07-25 実測記録）はいずれもこの宣言と矛盾しない。
2. **CI ランの来歴** — `gh` で実地に裏を取り、記述は**事実どおり**だった。
   - attempt 1（job 92683011306/310/326）・attempt 2（92685672055/082/110）: 全ジョブ `cancelled`。check-run annotation は両方とも `The job was not acquired by Runner of type hosted even after multiple attempts`。計測ログなし ✓
   - attempt 3: `integration` のみ `failure`（REPORT テストの故意の失敗）、`lint-typecheck-unit` / `build` は success。ログの `[#20-probe]` は `SHA-512@210000` median **116.4** / `SHA-256@600000` median **77.2** → 比 **1.5078** ✓（ADR 記載 1.508）
   - attempt 4: ログの `[#20-probe]` は `{"SHA-512@210000":{"min":126.6,"median":127.2,"max":139},"SHA-256@600000":{"min":86.2,"median":86.2,"max":86.4},"SHA-256@210000":{"min":30,"median":30.2,"max":30.2}}` → `.thread/1/adr.md:177-179` の CI 3行と**1桁まで一致**。比 127.2/86.2 = **1.4756** ✓（記載 1.476）
   - 派生値も検算済み: 4.2 倍（127.2/30.2 = 4.212）/ 97ms（127.2 − 30.2）/ ローカル比 0.974（45.6/46.8）/ Issue 参考実測の比 0.82（54.2/66.5）— すべて一致

## Blockers

- **[B-001]** 出荷コードの JSDoc が、ADR が明示的に「採らない」と決めた OWASP への未出典の帰属を書いている
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:57-59`
  - 理由: 当該箇所は `the two numbers differ because **the table calibrates each algorithm to roughly the same defender cost**` と、**OWASP の表がキャリブレートされたものである**と断定している。ところがこの PR が同時に入れた2本の ADR は、その言い方を名指しで禁じている。
    - `.thread/1/adr.md:132` —「チートシート自身はこれらの設定を（防御側にとって）等価な選択肢として並べているだけで、**『各アルゴリズムで防御側の所要時間が揃うようにキャリブレートした』という説明は我々の読みであり、出典の文言ではない**」
    - `.thread/20/adr.md:20` —「**ただし『各アルゴリズムで防御側の所要時間が揃うようにキャリブレートされている』という言い方も採らない**」「誤引用を正す文脈で別の未出典の断定を置けば、次に誰かがこの一文を引用したときに同じ経路で帰属が滑る」

    つまり **ADR が「これを書くと同じ失敗を再生産する」と名指しした一文が、是正対象そのものだったコメントの置き換え先に入っている**。Issue #20 の主眼が「OWASP の記述の取り違えがコードのコメントに定着した」ことの是正である以上、これは体裁ではなく成果物の中身の欠陥である。GPU/ASIC の帰属（`:60-61`）は正しく「*we* pick」と書き分けられているので、残っている誤帰属はこの1文だけ。
  - 提案: `:58-59` を出典の文言に留める。例: `the two numbers differ because SHA-512 costs more per iteration; the cheat sheet lists these as equivalent options rather than explaining how it derived them.` — `.thread/1/adr.md:132` と同じ温度に揃える。あわせて W-001（同じ断定を指示している steps.md 3箇所）も直さないと、次の実装者が同じ文を書き戻す。
  - 補足（AC-15）: この修正で `:57` の `The SHA-256 row of the same table is 600,000` の扱いも整理してほしい。AC-15 の案 A 側の文面は残存 `SHA-256` ヒットを「**旧読み取り枝の説明だけ**」と定めており、`:57` は文面上そこに収まらない（`:14` の `Digest` 型と `:35` の旧枝は収まる）。ただし内容は「600,000 と正しく組になった記述」（AC-15 の案 B 側が許している形）で誤帰属ではないので、**AC-15 の趣旨は満たしている**と判断した。B-001 の修正がこの文の周辺に入るので、そのついでに AC 文面との差を完了報告に1行残すのが安い。

## Warnings

- **[W-001]** `.thread/20/steps.md` が B-001 の断定を「事実として書け」と指示したまま残っている
  - 場所: `.thread/20/steps.md:266`, `:303`, `:359`
  - 理由: 3箇所とも「**表の2つの数字は防御側コストがおおむね揃うようにキャリブレートされたもの**」を前提として書けと指示している。`.thread/20/adr.md:20` の「その言い方も採らない」は round 1 の反映で ADR 側にだけ入り、steps.md へは伝播していない。実装がこの指示に忠実に従った結果が B-001 なので、**根本原因はこちら側**。steps.md は Phase 8 の削除対象（`review/**`）ではなく残るため、放置すると同じ文が書き戻される。
  - 提案: 3箇所の「キャリブレート」の断定を `.thread/20/adr.md:20` の言い回しへ揃える（「等価な選択肢として並べているだけで、キャリブレーションは我々の読み」）。`:266` は不採用の案 B 用の記述なので、案 A 確定を注記して丸ごと落とす選択もある。

- **[W-002]** 一括訂正注記の ADR リストが 2 本過剰で、索引として偽になっている
  - 場所: `.thread/1/adr.md:94`
  - 理由: 注記は「本ファイル内で `pbkdf2-sha256` / `PBKDF2-HMAC-SHA256` / `PBKDF2-SHA256` に言及する記述（**ADR-003 / 014 / 021 / 026 / 027 / 033 / 034**）」と書いているが、実際に該当するのは **5本**である。`grep -n "pbkdf2-sha256\|PBKDF2-HMAC-SHA256\|PBKDF2-SHA256" .thread/1/adr.md` のヒットは `94 114 118 121 124 129 167 201`（ADR-003）/ `632`（ADR-014）/ `1024`（ADR-026）/ `1058`（ADR-027）/ `1263`（ADR-034）で、**ADR-021（`:852-885`）と ADR-033（`:1225-1254`）には該当する方式名が1つも無い**（両者が持つのは `210,000` だけで、それは現行値）。7本という数は `.thread/20/plan.md` R-8 / `steps.md:355` の「`210,000` を含む union で数えた7本」から来ており、注記が対象パターンを方式名だけに絞ったときに一緒に絞られなかったもの。round 1 で「陳腐化した索引を残さない」を Blocker として直した箇所の中に、別の陳腐化した索引が残っている形になる。
  - 提案: 括弧内を `ADR-003 / 014 / 026 / 027 / 034` に直す。あるいは列挙をやめて「本ファイル内の該当箇所すべて」とする（列挙が無ければドリフトもしない）。
  - 併せて1点: 同じ注記の `:97` は「当時の観測・当時の決定を述べる行（**Context / Decision**）は原文を残し括弧書き」「今も有効な仕組みを述べる行（**Consequences など**）は本文を直した」と節名で規則を述べているが、`:632`（**ADR-014 の Context**）は本文を `pbkdf2-sha512$…` へ書き換えてある。実際の判定基準は節名ではなく**記述の性格**（`:632` は今も有効な失敗分類の定義なので本文修正が正しい）なので、節名を規則の本体のように読める書き方を緩めるか、`:632` を例外として1語添えるのが安い。

- **[W-003]** `.thread/20/adr.md` が「同じ数字をアダプター JSDoc にも渡す」と宣言しているが、JSDoc に数字は無い
  - 場所: `.thread/20/adr.md:126` ↔ `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:75-77`
  - 理由: ADR-002 は「**同じ数字を `.thread/1/progress.md` の残存制約とアダプター JSDoc の側にも渡す**」と書いている。`.thread/1/progress.md:12` は約 97ms と CI 実測の出典を実際に持っているが、JSDoc は `an earlier cost or algorithm` と向きを広げただけで、大きさの記述は無い。ADR が実施したと述べている作業が片方だけ実施されている状態。
  - 提案: 数字を JSDoc に入れないほうが正しい判断だと考える（実測値は環境依存でコメントは陳腐化しやすく、`CLAUDE.md`「Default to no comments」の方向にも合う）。したがって**ADR-002 の当該文を実態に合わせる**のを推す — 「数字は `.thread/1/progress.md` と `.thread/1/adr.md` の実測節に置き、JSDoc は向きの記述を広げるに留める」。逆に JSDoc へ数字を足す形で揃えるのでも整合はするが、AC-13 が要求する「JSDoc と progress.md の対」は既に成立しているので必要性は低い。

- **[W-004]** `hashFor` の JSDoc が、根拠の所在を示さずに「本番に行が無い」と削除許可を断定している
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:26-29`
  - 理由: `No production row carries that format, so the branch may be deleted once …, whichever comes first.` は `.thread/20/adr.md` ADR-002 の退役条件の要約だが、参照が1つも無いため、読み手はそこに付いている2つの但し書きへ到達できない。
    - `.thread/20/adr.md:142`（**限界**）— 前提確認は「リポジトリ経由のデプロイ痕跡が無い」ところまでで、**Cloudflare アカウント側の実状態は確認できていない**。JSDoc の断定形はこの限界を落としている
    - `.thread/20/adr.md:133`（**削除時に1点だけ確認する**）— 旧フィクスチャは `derive()` の外部固定ベクターも兼ねているので、削除時に `pbkdf2-sha512$` の golden vector が現存することを確認する必要がある。JSDoc だけを読んで枝を落とすと、この確認が飛ぶ
  - 提案: 断定を条件形にし（`No production row is expected to carry that format —`）、退役条件の所在を1語で指す。`.thread/20/adr.md` は Issue ローカルなので、参照先は `.thread/1/adr.md` ADR-003 の「訂正（2026-08-07 / #20）」節（`:201` が ADR-002 へ橋渡ししている）に寄せると ADR-046 の作法とも噛み合う。

- **[W-005]** 新規の ADR 参照が ADR-046 の「パスを前置する」形になっていない
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:61`
  - 理由: `ADR-003 (\`.thread/1/adr.md\`)` はパスを**後置**している。`.thread/1/adr.md` ADR-046 の Decision は `(.thread/1/adr.md ADR-008)` の形を採ると決めており、Consequences は「全ヒットが**直前のパス**によって一意に解決する」を成立している性質として書いている。`grep -rnoE '.{22}ADR-[0-9]+' packages/core/src apps/web/app infra` を流すと、この PR が入れた唯一の新規逸脱がこの行（残る `tokens.css:169` / `:185` / `theme.css:11` は main 由来の既存分で本 PR とは無関係）。
  - 提案: `(.thread/1/adr.md ADR-003)` の形へ揃える。

## その他の確認結果（指摘なし）

- **OWASP の数字の帰属** — SHA-1 = 1,300,000 / SHA-256 = 600,000 / SHA-512 = 210,000 の3行が `.thread/1/adr.md:127-130` と `.thread/20/adr.md:18` で一致し、出典 URL と参照日（2026-08-07）が両方に付いている。GPU/ASIC 耐性を「我々の採用理由であって OWASP の設定理由ではない」と書き分けているのは `.thread/1/adr.md:202` / `.thread/20/adr.md:22` / JSDoc `:60-61` の3箇所すべてで正しい（B-001 はキャリブレーションの側だけの問題）。
- **`.adr/003-sqlite-fts5-only-search.md`** — 無傷。`git diff origin/main...HEAD --stat -- .adr/ spec/` は空で、`.adr/` / `spec/` に変更は1行も無い。
- **`spec/` の更新が不要である裏取り** — 実ファイルで確認した。`spec/domains/identity.md:274`（「ハッシュ化アルゴリズム（Argon2id 等）はドメイン外の関心事」）/ `:574`（「アルゴリズム（Argon2id 等）とパラメータはアダプター実装の責務」）/ `spec/inventory/adapter.md:52` がいずれもアダプターへ明示的に委譲しており、`grep -rn "pbkdf2\|210,000\|600,000\|SHA-256" spec/ docs/ .adr/` は**ヒット0件**。方式変更は spec に触れない。
- **`.thread/1/progress.md`（AC-13）** — (a) `:83` が `PBKDF2-HMAC-SHA512（ADR-003 / 方式は #20 で SHA-256 から変更）` へ、(b) `:9-13` が見出し・ピンの範囲（反復回数＋`ALGORITHM_ID`）・残差の大きさ（97ms、出典付き）・影響範囲（根拠が「一度も上げていない」から「本番に行が無い」へ）まで揃って更新済み。アダプター JSDoc `:75-77` との対も向きの点では成立（大きさの点は W-003）。
- **`.thread/1/adr.md` の数字の整合（AC-12 (d)）** — 機械的 grep の残存ヒットを全件本文で判定した。方式名ヒットは B-001/W-002 で触れた5本の ADR に閉じ、いずれも「当時の記録＋現行値の括弧書き」か「本文修正」か「注記が明示的に覆う」のいずれかに収まっている（`:121` のコードブロックは `:134` が名指しで覆う、`:632` は本文修正＋旧形式が読める旨の追記、`:1249` は ADR-033 の当時実測＋相互参照）。矛盾する数字は残っていない。
- **`.thread/20/` の計画ドキュメントと確定結果** — `testing.md:5` / `:114` / `:207` / `:227` は案 A・127.2ms・30.2ms・97ms で `.thread/1/adr.md` の実測節と一致。`steps.md:51-54` のローカル値はレンジ表記だが `.thread/1/adr.md:188` が「同じランの丸め」と明示して橋渡ししている。重複については、OWASP の表と出典が `.thread/1/adr.md:124-134` と `.thread/20/adr.md:18` の両方にあるが、後者が前者を「表の全文と訂正は `.thread/1/adr.md` にある」と名指しで指しており、権威が一意なので重複とは見ない。「前提確認の記録」は `.thread/20/adr.md:137-142` の1箇所のみ。97ms は `.thread/20/adr.md:126` / `progress.md:12` / `testing.md:227` の3箇所だが、いずれも `.thread/1/adr.md` の実測節を出典として指しており役割が違う（決定の記録／残存制約／手動テストの判断材料）。
- **コード内 JSDoc の分量** — `loginWithPassword.ts` の `DUMMY_PASSWORD_HASH_ALGORITHM_ID` / `pbkdf2PasswordHasher.ts` の `hashFor` / `ALGORITHM_ID` / `SHIPPED_HASH` はいずれも「なぜその形なのか」（型ピンが等時間化を守る／表引きにしない理由／`null` を書き出し経路へ入れない）を述べており、`CLAUDE.md`「Default to no comments」の例外条件（隠れた制約・不変条件）と exported API の JSDoc に収まっている。過剰とは判断しない。ただし `DEFAULT_PBKDF2_ITERATIONS` の JSDoc は ADR の論証をコード側に写し取っており、その写し取りが実際にドリフトした結果が B-001 である点は記録しておく — 修正時は ADR へ寄せて JSDoc は最小限にするのが安全側。

## カバレッジ

- 確認: `.thread/1/adr.md`, `.thread/1/progress.md`, `.thread/20/adr.md`, `.thread/20/plan.md`, `.thread/20/steps.md`, `.thread/20/testing.md`, `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`, `packages/core/src/application/identity/loginWithPassword.ts`, `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`, `packages/core/src/application/identity/__tests__/identity.integration.test.ts`
- 差分外で参照: `CLAUDE.md`, `spec/domains/identity.md`, `spec/inventory/adapter.md`, `.adr/`（無変更の確認）, GitHub Actions run 31121514993（attempt 1-4 のジョブ・annotation・ログ）
- スキップ: `.thread/20/review/review-001-{adapter,docs,security,test}.md`, `.thread/20/review/triage.md` — round 1 のレビュー成果物（Phase 8 で削除予定）。指示によりまとめて1件扱い
