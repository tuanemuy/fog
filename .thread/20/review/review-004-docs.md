# レビュー 004 — Documentation / ADR 整合性（PR #53 / Issue #20 / round 4）

対象: `git diff 06bb663..HEAD`（round 3 の修正）を主眼に、`git diff origin/main...HEAD` の全体も確認。

## Documentation / ADR

### Blockers

なし。

### Warnings

- **[W-001]** round 3 で直した「`.thread/1/adr.md` への行番号参照」が、同じ行を指す他の3箇所に適用されていない
  - 場所: `.thread/20/plan.md:34`（AC-13 の「由来」列）、`.thread/20/steps.md:309`、`.thread/20/steps.md:404`
  - 理由: round 3 の Docs W-002 は「本 PR が `.thread/1/adr.md` に追記した結果 `:1221` が別 ADR を指すようになった。**行番号ではなく節名で参照する形に変える**（また同じことが起きるため）」という指摘で、triage でも `fix` と裁定されている。実際に直ったのは `.thread/20/adr.md:128` の1箇所だけで、**同じ ADR-034 の同じ一文（「この限界は JSDoc と `progress.md` の2箇所に書いた」）を指す残り3箇所は `.thread/1/adr.md:1221` のまま**である。この PR 適用後の 1221 行は ADR-032（`AppServerError` の構造判定）の Consequences であり、ADR-034「残る限界」は **1284 行**へ移動している。3箇所とも「（`.thread/1/adr.md:1221` が…と明記）」という**読み手に辿らせる引用**の形なので、辿ると無関係な ADR に着地する。
    - なお `.thread/20/steps.md:385-392` の (ii) の表が持つ `:569` / `:961` / `:1200` 等の行番号は**編集前のファイルのスナップショット**として書かれた作業表であり、これらは対象外（表自体が「どの行を直すか」の台帳なので、当時の番号であることに意味がある）。問題は台帳ではなく本文中の引用3件。
  - 提案: 3箇所の `.thread/1/adr.md:1221` を `.thread/20/adr.md:128` と同じ形（`.thread/1/adr.md` の ADR-034（Consequences の「残る限界」））へ置き換える。文書の実体（JSDoc と `progress.md` の対）は正しく揃っているので、**直すのは参照形式だけ**であり、内容の書き換えは発生しない。

- **[W-002]**（低優先）テストコメントの「ゲートの分業」表が、分割として読むとアダプター側の値のドリフトを取りこぼしているように読める
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:304-316`
  - 理由: `How the gates divide the work` という前置きは各項が排他的な分担であることを含意するが、2つ目の項「drift in the adapter's own value: the unit tests in this file」は**型検査でも止まる**（`DEFAULT_PBKDF2_ITERATIONS: typeof DUMMY_PASSWORD_HASH_ITERATIONS` の注釈が付いている限り、アダプター側の値だけを動かすと宣言行が型エラーになる）。項の記述自体は偽ではない（`declares the OWASP count for the algorithm it ships` が実際に `210_000` をピンしている）が、「分業」の枠に入れると「アダプター側の値のドリフトは型検査では止まらない」と読める余地が残る。round 1 の triage が「誤ったコメントは将来の実装者に最後の砦を壊させる」として同種の過大／過小主張を潰してきた流れに照らすと、ここだけ精度が一段緩い。
  - 提案: 2つ目の項を `drift in the adapter's own value (once the annotation above is gone): the unit tests in this file` のように**前提を1つ足す**だけでよい。他の4項（型ピン2本 / 往復テスト / 統合テストの正規表現 / 「注釈の除去そのものはどのゲートも検出しない」）は実地照合の結果と一致しており、書き換え不要。

### 観測（指摘ではない）

- `.thread/1/adr.md:94` の一括宣言は「本ファイル内で `pbkdf2-sha256` / `PBKDF2-HMAC-SHA256` / `PBKDF2-SHA256` に言及する記述（…）は、いずれも **#20 以前の方式名**である」と書いているが、厳密には `:124` / `:129`（OWASP の表の SHA-256 の行）と `:167`（不採用の案 B の名前）は「#20 以前の**我々の**方式名」ではない。**ただしこの3行はいずれも #20 の訂正ブロック・実測節の内部にあり、読み手が現行値と取り違える経路が構造的に無い**ので、注記をこれ以上細かくしても読み手の利得はなく、むしろ注記を書き足すたびに新しい不正確さが混入する（round 1〜3 の失敗パターンそのもの）。**指摘しない。**
- `.thread/1/adr.md:132` / `.thread/20/adr.md:20` の「回数がこの順に少なくなるのは、1反復あたりの CPU コストがこの順に高くなるからである」は、round 2 の裁定（`.thread/20/steps.md:307`「**書いてよいのは『1反復あたりの CPU コストがこの順に高くなるから回数がこの順に少ない』までで、それを超える意図を OWASP に帰属させない**」）が明示的に許容した線そのものであり、決着済み。**蒸し返さない。**

### 過去3ラウンドの失敗パターンの再発判定

1. **訂正を書く過程で新しい未出典の断定を作る（round 2 Blocker）— 再発なし。**
   `06bb663..HEAD` の差分は OWASP について新しい事実主張を1つも足していない。アダプター JSDoc（`pbkdf2PasswordHasher.ts:61-64`）は `SHA-512's resistance to GPU/ASIC parallelism is why *we* pick it, not why OWASP set that row's count` と帰属を書き分けたままで、`.thread/1/adr.md:202` の「チートシートは行ごとの回数の理由を述べていない」とも一致する。`grep -i "キャリブレ\|calibrat"` の残存ヒットは全件が**「その言い方は採らない」と否定形で述べている行**（`.thread/1/adr.md:132` / `.thread/20/adr.md:20` / `.thread/20/steps.md:268,307,365`）で、断定形は1件も無い。

2. **訂正注記が自分の処置を不正確に述べる（round 1 Blocker / round 3 W-003）— 再発なし。** round 3 が新設・修正した自己記述を1件ずつ実地照合し、すべて一致した。
   - `.thread/20/steps.md:378-382` の3点 — (a) 210,000 を現行値として扱っている ✓（`.thread/1/adr.md:96`）、(b) 方式名を実際に含むのは ADR-003 / 014 / 026 / 027 / 034 の5本で ADR-021 / 033 はゼロ ✓（grep の実ヒットは `:114,118,121,124,129,167,201`（003）/ `:632`（014）/ `:1024`（026）/ `:1058`（027）/ `:1263`（034）で、ADR-021（852-885）と ADR-033（1225-1254）には1件も無い）、(c) ADR-026 Decision（`:1024`）と ADR-034 Context（`:1263`）が**実際に括弧書き**である ✓、例外の ADR-014 Context（`:632`）が**本文修正＋旧形式も読める旨を同じ行に併記**である ✓。
   - `.thread/1/adr.md:97` の「取り違えの経路が無い行には添えていない（例: Context の選択肢の列挙）」— `:114` に括弧書きが無く、`:118`（Decision）には有る ✓。
   - `.thread/20/adr.md:161` の参照先「ADR-034（見出し「ダミーハッシュの反復回数をアダプター既定値と型で結び、握り潰しに警告を足す」）」— `.thread/1/adr.md:1255` に実在 ✓。`.thread/20/adr.md:128` の「ADR-034（Consequences の「残る限界」）」— `.thread/1/adr.md:1284` に実在し、引用文言「この限界は `DEFAULT_PBKDF2_ITERATIONS` の JSDoc と `progress.md` に書いた」も一致 ✓。

3. **一方を直して対になる他方を取り残す — 狭い形で再発（W-001）。**
   実体レベルの対はすべて揃っている: (a) 退役条件は JSDoc（`pbkdf2PasswordHasher.ts:26-34`）と ADR-002（`.thread/20/adr.md:131-136`）が同じ結論（「旧形式の行が残っていない時点」／「#18 の着地 ≠ その時点。旧枝は #18 より長生きさせる」）で一致 ✓、(b) 残余チャネルの「コストまたはアルゴリズム」は JSDoc（`:77-79`）と `.thread/1/progress.md:9-14` の**両方**で広がっており ADR-034 が要求する対が成立 ✓、(c) `loginWithPassword.ts:34` の「A second pin of the same shape」と `:46-49`／`:77-80` の記述も相互に矛盾しない ✓。取り残されたのは**参照形式の統一だけ**（W-001）で、内容の対ではない。

### 受け入れ基準

- **AC-12: 充足。** (a) 訂正ブロックが出典 URL と参照日つきで `.thread/1/adr.md:124-134` にある。(b) CPU 予算の訂正が `:215`（Free 10ms / Paid 既定 30 秒 + #34 で Paid 確定）。(c) 実測結果節が `:165-194`。(d) `grep -n "210,000\|210_000\|210000\|pbkdf2-sha256\|PBKDF2-HMAC-SHA256\|PBKDF2-SHA256" .thread/1/adr.md` の残存ヒットを全件確認し、**本文修正済みの行（`:632` / `:118` の見出し・保存形式）／括弧書きで現行値が添えられた行（`:1024` / `:1058` / `:1263` / `:1249`）／一括宣言が覆う歴史的記述**のいずれかに収まっていること、および `210,000` を含む全行が **#20 後も真**であることを確認した。数字が矛盾する状態は残っていない。
- **AC-13: 充足。** `.thread/1/progress.md` の (a) spec-sync 記録が `WebCrypto PBKDF2-HMAC-SHA512（ADR-003 / 方式は #20 で SHA-256 から変更）`、(b) スコープ外項目1が見出しごと「旧コスト・**旧アルゴリズム**の保存ハッシュ」へ広がり、ピンの対（`DEFAULT_PBKDF2_ITERATIONS` / `ALGORITHM_ID`）、残差の大きさ（約 97ms、出典つき）、影響範囲の根拠の付け替え（「一度も上げていない」→「本番に行が1つも無い」）まで入っている。ADR-034 が要求する「JSDoc と `progress.md` の対」も成立。
- **AC-15: 充足。** `grep -n "SHA-256\|SHA256" packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` の残存ヒットは `:14`（`type Digest` の値域）と `:40`（`hashFor` の旧枝）の2件のみで、**どちらも旧読み取り枝に属する**。OWASP 反復回数の誤帰属は消えており、`:61-64` は SHA-512 の行として正しく述べている。

### その他の確認

- **`.adr/003-sqlite-fts5-only-search.md` は無傷。** `git diff --name-only origin/main...HEAD` に `.adr/` 配下のファイルは1件も無い（R-7 / steps.md:397 の禁止事項を遵守）。
- **`CLAUDE.md`「Default to no comments」。** round 3 で3箇所に重複していたゲート説明が1箇所へ集約され、`ALGORITHM_ID` 側から6行、`identity.integration.test.ts` 側から4行が参照へ置き換わった。集約先が9行増えているので**総量はほぼ横ばい**だが、同じ説明が3箇所で別々にドリフトする構造は解消されており、方向としては正しい。残っているコメントはいずれも WHY（なぜ自己言及にしないか / なぜこの assertion では守れないか）で、自明な言い換えは無い。W-002 の1点を除き過剰とは判断しない。
- **リポジトリ全体の方式名の整合。** `.thread/34/{adr,design}.md` は「PBKDF2 210,000 回」を当時の前提として引くだけで方式名を持たず、反復回数は据え置きなので陳腐化しない（plan.md「含まれないもの」の判断どおり）。`docs/test.md:37` も方式名を持たない。`spec/` は方式をアダプター責務として委譲しており更新不要。**PR のスコープ外に取り残された陳腐化は無い。**

### カバレッジ

- 確認: `.thread/1/adr.md`（ADR-003 全文 / ADR-014 / 021 / 026 / 027 / 033 / 034）, `.thread/1/progress.md`, `.thread/20/adr.md`, `.thread/20/plan.md`, `.thread/20/steps.md`（ステップ5 / 8-5 / 9）, `.thread/20/testing.md`, `.thread/20/review/triage.md`, `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`, `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`, `packages/core/src/application/identity/loginWithPassword.ts`, `packages/core/src/application/identity/__tests__/identity.integration.test.ts`, `spec/inventory/adapter.md:53`（ADR が引く参照先の実在確認）, `docs/test.md`, `.thread/34/{adr,design}.md`, `.thread/36/plan.md`
- スキップ: `.thread/20/review/review-00{1,2,3}-*.md` — 過去ラウンドのレビュー成果物そのもので、triage の裁定メモが要約を持つ。決着した事項の蒸し返しを避けるため内容判定はしていない（triage の裁定メモ6件は通読済み）。
- スキップ: `pnpm typecheck` / `pnpm test` の実行 — 本観点は文書整合であり、型・テストは Code / Test 観点の担当。round 3 で変異注入つきで検証済みという記録がある。

## マージ可能か

**マージ可能。** Blocker はゼロで、Warning 2件はいずれも文言・参照形式のみでコードの挙動にも ADR の結論にも影響しない。W-001（行番号参照3箇所）はマージ前に直すのが望ましいが、実体の対は揃っているので単独でブロックする性質ではない。
