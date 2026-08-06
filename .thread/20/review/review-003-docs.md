# レビュー 003 — Documentation / ADR

**PR:** #53 / **Issue:** #20 / **ラウンド:** 3（ゼロベース）
**日付:** 2026-08-07

## Documentation / ADR

### Blockers

なし。

過去2ラウンドの Blocker 3件はいずれも実地で解消を確認した。

- **round 1 B「一括訂正注記が `210,000` まで『#20 以前の事実』と宣言」** — 現在の注記（`.thread/1/adr.md:94-98`）は射程をアルゴリズム識別子だけに限定し、「**反復回数 210,000 は #20 の後も現行値である**」を独立した箇条として明示している。誤っていたのは帰属だけ、という切り分けも書かれている。
- **round 1 B「CI ランの来歴が事実と不一致」** — `gh run view 31121514993 --attempt {1,2,3,4}` で全 attempt を照合した。attempt 1〜2 は3ジョブとも `The job was not acquired by Runner of type hosted…` で計測なし、attempt 3 / 4 はどちらも `integration` が完走して完全な1組を出している。ADR の記載と実測 JSON が一致する（attempt 4: 126.6 / **127.2** / 139 と 86.2 / **86.2** / 86.4 と 30 / 30.2 / 30.2、attempt 3: 中央値 116.4 / 77.2）。比も 116.4÷77.2 = 1.5078、127.2÷86.2 = 1.4756 で記載どおり。`G-1`（127.2 ≤ 172.4）も成立する。
- **round 2 B「是正対象の置き換え先に同種の未出典帰属（キャリブレーション）」** — `grep -n "キャリブレー\|calibrat\|揃う\|等価"` を `.thread/1/adr.md` / `.thread/20/adr.md` / `.thread/20/steps.md` / `.thread/20/testing.md` / 出荷コード・テストへ流し、OWASP について事実として述べている記述を1件ずつ判定した。**出荷コード側に断定は残っていない** — `pbkdf2PasswordHasher.ts:58-61` は「SHA-512's resistance to GPU/ASIC parallelism is why *we* pick it, **not why OWASP set that row's count**」と我々の読みとして書き分け、出典（表・URL・参照日）は ADR へ委譲している。ADR 側（`.thread/1/adr.md:132` / `.thread/20/adr.md:20`）も「キャリブレートした、という説明は**我々の読みであり、出典の文言ではない**」と明示。版指定「(2023 cheat sheet)」も消えており、ADR 参照は `.thread/1/adr.md ADR-003` のパス前置形（ADR-046）に従っている。

そのほか本ラウンドで確認して問題が無かった点:

- **AC-12** — (a) OWASP 引用の訂正（出典 URL・参照日・3行の表つき）、(b) CPU 予算（Free 10ms / Paid 既定 30 秒 + `#34` の Paid 前提で懸念自体が失効）、(c) 実測節の追記（CI 実行 URL つき）、(d) 同一ファイル内の矛盾なし、をすべて満たす。`grep -n "210,000\|210_000\|210000\|pbkdf2-sha256\|PBKDF2-HMAC-SHA256\|PBKDF2-SHA256" .thread/1/adr.md` の残存 38 行を1行ずつ本文で確認し、**陳腐化した索引は残っていない**。内訳は (i) 新設の訂正注記・訂正ブロック・実測節・切り替え節、(ii) 反復回数のみのヒット（`:140` `:148` `:150` `:213` `:881` `:1020` `:1249` `:1274` `:1275` — 210,000 は現行値なのでそのまま正しい）、(iii) 当時の観測・当時の決定（`:114` `:121` `:159` `:161` `:162`）、(iv) 括弧書きで現行値を添えた行（`:118` `:1024` `:1058` `:1263`）、(v) 本文を現行値へ直した行（`:92` `:632` `:1037`）。
- **一括注記が列挙する ADR** — 注記の「ADR-003 / 014 / 026 / 027 / 034」は、方式名（`pbkdf2-sha256` / `PBKDF2-HMAC-SHA256` / `PBKDF2-SHA256`）を実際に含む ADR の集合と**完全に一致する**（`awk` で ADR 見出しの行番号を取って突き合わせ済み。round 2 W-002 の「021 / 033 が該当ゼロ」は解消）。
- **例外の説明** — 注記が唯一の例外として挙げる ADR-014 Context は `:632` で本文を SHA-512 へ直し、「#20 以前に書かれた `pbkdf2-sha256$…` も読める側に含まれる」を同じ行に添えている。`verify` 失敗の2分類が「今も有効な失敗分類の定義」であるという例外の理由づけも、実際の記述内容と合っている。
- **`.adr/003-sqlite-fts5-only-search.md`** — `git diff origin/main...HEAD --stat` に `.adr/` は1件も現れない。無関係な別 ADR は触られていない。
- **spec/ の更新不要** — 実ファイルを読んで裏取りした。`spec/domains/identity.md:274`（「ハッシュ化アルゴリズム（Argon2id 等）はドメイン外の関心事」「ハッシュ形式の検証はアダプターの責務」）/ `:574`（「アルゴリズム（Argon2id 等）とパラメータはアダプター実装の責務」）/ `spec/inventory/adapter.md:52` が明示的に委譲しており、`grep -rn "PBKDF2\|pbkdf2" spec/` は**0件**。反復回数もアルゴリズム識別子も spec に一切書かれていないので、更新対象は無い。
- **AC-13** — `.thread/1/progress.md` の2箇所が直っている。9-13 行はピンがアルゴリズムにも掛かった旨・残差が「旧コストまたは旧アルゴリズム」へ広がった旨・実測 97ms・根拠が「一度も上げていない」から「本番に行が無い」へ変わった旨まで書かれ、`pbkdf2PasswordHasher.ts:74-76` の JSDoc（"an earlier cost **or algorithm**"）と対で成立している（ADR-034 が要求する「JSDoc と `progress.md` の2箇所」）。83 行の spec-sync 記録も SHA-512 へ更新済み。
- **AC-15** — `grep -n "SHA-256\|SHA256\|sha256" packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` の残存は `:14`（`Digest` ユニオン）/ `:26` `:36` `:37`（旧読み取り枝とその JSDoc）/ `:203`（`verify` が読める形式のほうが広いことの説明）の5件で、すべて旧読み取り枝に由来する。誤った帰属は1件も残っていない（判定基準と実装形のズレは round 1 で「完了報告に内訳を書く」として裁定済みなので蒸し返さない）。
- **`.thread/20/testing.md`** — 案 A 確定後の版に揃っており、案 B 分岐は残っていない。CPU 予算（Free 10ms / Paid 30 秒）・127.2ms・97ms・4.2 倍が ADR-003 実測節と1桁まで一致し、いずれも出典を明示している。

### Warnings

- **[W-001]** `steps.md` ステップ8-5 の指示が、round 1 の Blocker になった文言をそのまま「こう書け」と残している
  - 場所: `.thread/20/steps.md:376`（(i) の指示文）、および `:374` / `:377-389` の付随記述
  - 理由: (i) は訂正注記の本文として **「本ファイル内で `210,000` / `pbkdf2-sha256` / `PBKDF2-HMAC-SHA256` に言及する記述（ADR-003 / 014 / **021** / 026 / 027 / **033** / 034）は… いずれも #20 以前の事実・当時の決定であって**現行値ではない**」** と書けと指示している。これは round 1 Blocker 1（`210,000` を「現行値でない」と宣言した）と round 2 W-002（ADR リストが実態より広い）の**両方の原文そのもの**である。成果物（`.thread/1/adr.md:94-98`）の側は正しく直っているが、それを生んだ指示は無傷で残っている。round 2 では同じ失敗パターンに対して steps.md の該当3箇所（`:268` / `:307` / `:365`）へ「**訂正（… レビュー round 2）**」ブロックを足すという処置が取られており、triage.md にも「**steps.md は Phase 8 以降も残るので、直さないと同じ誤りが書き戻される**」と明記されている。同じ理由がここにも等しく当てはまるのに、この1箇所だけ処置が漏れている。加えて (ii) の表（`:379-386`）は ADR-026 Decision（`:961`）と ADR-034 Context（`:1200`）を「本文修正」と指示しているが、最終的に採られた裁定3（*Context / Decision* は原文＋括弧書き）では両者とも括弧書きで実装されており、指示と成果物が食い違ったままである。
  - 提案: `:268` / `:307` / `:365` と同じ形式で、ステップ8-5 の直下に「訂正（2026-08-07 / #20 レビュー round 3）」ブロックを1つ足す。書くべきは3点 — (1) `210,000` は #20 の後も現行値であり、注記の射程はアルゴリズム識別子だけであること、(2) 方式名を実際に含む ADR は 003 / 014 / 026 / 027 / 034 の5本で 021 / 033 は該当ゼロであること、(3) (ii) の表の書き分けは最終的に「節の性格（Context / Decision は原文＋括弧書き、Consequences など今も有効な仕組みは本文修正、ADR-014 Context だけは定義なので例外）」で1本化されたこと。実際に採られた文面は `.thread/1/adr.md:94-98` にある、と参照先を添える。

- **[W-002]** 本 PR が `.thread/1/adr.md` に 63 行を追記した結果、`.thread/20/` から張られている行番号参照が別の ADR を指すようになった
  - 場所: `.thread/20/adr.md:128`（`.thread/1/adr.md:1221`）、`.thread/20/adr.md:159`（`:1192`）、`.thread/20/steps.md:309`、`.thread/20/steps.md:398`、`.thread/20/plan.md:34`（AC-13 の由来欄）
  - 理由: `:1221` は origin/main では ADR-034 Consequences の「この限界は `DEFAULT_PBKDF2_ITERATIONS` の JSDoc と `progress.md` に書いた」だったが、本 PR の追記で**現在は ADR-032（`appServerErrorAdapter.test.ts` の回帰検出）を指す**（該当行は `:1284` へ移動）。同様に `:1192` は ADR-034 の見出しだったが現在は別の行で、見出しは `:1255` にある。`.thread/20/adr.md` は Phase 8 以降も残る durable な記録で、そこから「ADR-034 がこう明記している」と根拠に引いている参照が別の ADR へ解決するのは、ADR-046 が「参照が一意に解決する状態を作る」ために設けた規律の趣旨に反する。`.thread/20/plan.md` / `steps.md` は着手前の計画なので当時の行番号でよいという見方もあるが、`.thread/20/adr.md` の2件は少なくとも直す価値がある。
  - 提案: `.thread/20/adr.md:128` / `:159` の行番号を落として、`.thread/1/adr.md` ADR-034（Consequences の「残る限界」）のように**節で指す**形へ変える。同一ファイルを編集する PR で行番号参照は必ず腐るので、番号を打ち直すより節名で指すほうが再発しない。plan.md / steps.md 側も直すなら同じ扱いにする。

- **[W-003]** 一括注記が宣言する「括弧書きで現行値を添えた」が、ADR-003 Context の選択肢行には適用されていない
  - 場所: `.thread/1/adr.md:114`（「選択肢: … (d) PBKDF2-HMAC-SHA256（WebCrypto、依存ゼロ、全ランタイム共通）」）
  - 理由: 注記の2つ目の箇条は「**当時の観測・当時の決定を述べる行は原文を残し、括弧書きで現行値を添えた。**」と完了形で宣言しているが、`:114` は原文のままで括弧書きが無い。すぐ下の Decision（`:118`）には添えてあるので不揃いになっている。実害は小さい — 注記の第1段落（「本ファイル内で `pbkdf2-sha256` … に言及する記述は、いずれも #20 以前の方式名である」）がこの行を覆っているため、読み手が現行値と取り違える経路は塞がっている。宣言の自己記述が実態より1段強いだけである。
  - 提案: どちらか。(a) `:114` に `（当時の選択肢。→ SHA-512 へ変更）` 相当を添える、または (b) 注記の箇条を「原文を残し、**必要な行には**括弧書きで現行値を添えた」に緩める。選択肢の列挙という性格上、(b) のほうが自然に見える。

- **[W-004]** ピンの数え方が2つの JSDoc で食い違っている
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:34-36` と `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:67-69`
  - 理由: 前者は「**The same pin** covers the algorithm」、後者は「The algorithm identifier is covered by **a second pin of the same shape**」と書いている。実装は `DEFAULT_PBKDF2_ITERATIONS: typeof DUMMY_PASSWORD_HASH_ITERATIONS` と `ALGORITHM_ID: typeof DUMMY_PASSWORD_HASH_ALGORITHM_ID` の**独立した2本**なので、後者が正しい。「the same pin」は「1本の `typeof` が両方を覆っている」と読めてしまい、片方だけ外しても検出されるという誤解を生みうる。本 Issue が是正しているのが「言い方のずれが定着する」ことである以上、揃えておく価値がある。
  - 提案: `loginWithPassword.ts:34` を `A second pin of the same shape covers the algorithm — see {@link DUMMY_PASSWORD_HASH_ALGORITHM_ID}` 相当へ直す。

- **[W-005]** 「型ピン / 往復テスト / 統合テストの3層」という同じ説明が3箇所に書かれている
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:297-306`、同 `:316-327`、`packages/core/src/application/identity/__tests__/identity.integration.test.ts:647-654`
  - 理由: 3つとも「何がどのドリフトを捕まえ、何は捕まえないか」を説明しており、内容が重なっている。`CLAUDE.md`「Default to no comments. Add one only when the WHY is non-obvious」に照らすと、各コメントに WHY はあるので削除対象ではないが、**同じ層構造を3回述べていること自体が将来のドリフト源**になる（1箇所だけ更新されると残り2つが偽になる）。round 1 でこの手の「成立しない根拠の文言」が指摘されていることも踏まえると、重複を減らすほうが安全側である。
  - 提案: 層の全体像は `pbkdf2PasswordHasher.test.ts:316-327`（`ALGORITHM_ID` の describe）1箇所に置き、他の2箇所は「自分が何を見ているか」だけに絞る。`identity.integration.test.ts` 側は「リテラルを `ALGORITHM_ID` から組み立てないこと」という現地固有の禁止だけ残せば足りる。

### カバレッジ

- 確認:
  - `CLAUDE.md`
  - `.thread/20/plan.md`（AC-12 / AC-13 / AC-15 を含む全文）
  - `.thread/1/adr.md`（diff 全量 + ADR-003 全節 + 対象 grep の残存 38 行を本文で判定 + ADR 見出し一覧との突き合わせ + ADR-046 本文）
  - `.thread/1/progress.md`（diff 全量）
  - `.thread/20/adr.md`（全文）
  - `.thread/20/steps.md`（全文）
  - `.thread/20/testing.md`（全文）
  - `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`（JSDoc 全量）
  - `packages/core/src/application/identity/loginWithPassword.ts`（JSDoc 全量）
  - `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`（diff 全量）
  - `packages/core/src/application/identity/__tests__/identity.integration.test.ts`（diff 全量）
  - `spec/domains/identity.md` / `spec/inventory/adapter.md`（spec 更新不要の裏取り。`grep -rn "PBKDF2\|pbkdf2" spec/` は0件）
  - `.adr/003-sqlite-fts5-only-search.md`（`git diff --stat` に `.adr/` のヒットが無いことで未変更を確認）
  - `.thread/34/adr.md` / `.thread/34/design.md`（`210,000` の残存が当時の前提の引用であること、CF Paid 前提の裏取り）
  - CI ラン `31121514993` の attempt 1〜4（`gh run view --attempt N` で来歴と実測 JSON を照合）
- スキップ: `.thread/20/review/**`（9ファイル） — 過去ラウンドのレビュー成果物。ただし `triage.md` の `## 裁定メモ`（裁定1〜6）は読み、決着済み事項（表引きを採らない / ファクトリ引数のピンはテストで塞がない / 書き分けは節の性格で1本化 / `.adr/` 昇格は Phase 8 / 前提確認は「確認済み」と書いてよい / #18 へのコメントはメイン）は再指摘していない。

## 判定

**マージ可能。** Blocker なし。Warning 5件はいずれも成果物の正確性を損なうものではなく、W-001（steps.md の指示が round 1 Blocker の原文を保持）だけは round 2 で確立した処置パターンとの一貫性のためにこの PR 内で閉じることを推奨する。残る4件はフォローアップでよい。
