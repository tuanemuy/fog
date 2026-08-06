# レビュー 002 — Adapter / Infrastructure 観点

- 対象 PR: #53（`issue/20/pbkdf2-cost-parameters` → `main`）／round 2（ゼロベース）
- 契約: `.thread/20/plan.md` / `.thread/20/steps.md` / `.thread/20/adr.md`
- 判定: **Blocker 0 / Warning 3**

## Adapter / Infrastructure

### Blockers

**なし。**

観点として名指しされた5項目（レイヤー境界と依存方向 / ポート契約 / エラー契約 / 書き出し経路の全域性 / 後方互換 / DI 配線）はいずれも成立している。round 1 の6件は実装・文書とも反映されており、コードは収束したと判断してよい。検証の実測は「補足」に置く。

### Warnings

- **[W-001]** `DEFAULT_PBKDF2_ITERATIONS` の JSDoc が、`.thread/20/adr.md` ADR-001 が round 1 で明示的に退けた未出典の断定をそのまま述べている
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:57-59`
  - 理由: 該当文は「The SHA-256 row of the same table is 600,000; **the two numbers differ because the table calibrates each algorithm to roughly the same defender cost**, and SHA-512 costs more per iteration.」。ところが `.thread/20/adr.md:20`（ADR-001 Context）は round 1 の指摘を受けて

    > **ただし「各アルゴリズムで防御側の所要時間が揃うようにキャリブレートされている」という言い方も採らない** — チートシート自身はこれらの設定を（防御側にとって）等価な選択肢として並べているだけで、キャリブレーションという説明は出典の文言ではなく我々の読みである。誤引用を正す文脈で別の未出典の断定を置けば、次に誰かがこの一文を引用したときに同じ経路で帰属が滑る。

    と書いており、`.thread/1/adr.md:132` の訂正ブロックも同じ書き分けに直っている。**訂正が入ったのは ADR だけで、その ADR から導かれた指示（`.thread/20/steps.md:303` / `:266` は「キャリブレートされたもので…」と書けと明示的に指示している）と、その指示に従って書かれた JSDoc は round 1 の裁定の外に取り残されている。** 本 Issue の主眼は「未出典の OWASP 帰属がコードのコメントに定着したこと」の是正であり、是正後のコメントに同種の未出典の断定が残っているのは、ADR 自身が「形を変えた再生産」と呼んでいる状態そのものである。

    加えてこの断定は**本 PR 自身の実測と整合しない**。`.thread/1/adr.md:177-179`（同じ CI ラン / x86_64）は `SHA-512 @ 210,000` = 127.2ms、`SHA-256 @ 600,000` = 86.2ms、比 **1.476** を記録しており、「防御側コストがおおむね揃う」は測って否定されている（`SHA-256 @ 210,000` = 30.2ms との比較でも、1反復あたりの差は 4.2 倍で、表の回数比 600k/210k ≈ 2.86 とは一致しない）。「SHA-512 costs more per iteration」の部分は実測どおり正しく、問題は**その差の理由を OWASP に帰属させている前半**だけである。
  - 提案: 57-59 行を `.thread/1/adr.md:132` と同じ書き分けへ揃える。1文の差し替えで足りる。例:

    > The SHA-256 row of the same table is 600,000. The cheat sheet lists these as equivalent options without saying why the counts differ; what we can say from our own measurement is that SHA-512 costs more per iteration (`.thread/1/adr.md` ADR-003 の実測節).

    併せて `.thread/20/steps.md:303` / `:266` の同じ文言も直しておかないと、次に steps.md を読んだ実装者が同じ文を書き戻す。**参考（本観点の対象外・Docs へ）:** `.thread/1/adr.md:202` にも「OWASP の表は防御側コストのキャリブレーションであって意図の記述ではない」が残っており、同一ファイル内で `:132` と食い違っている。

- **[W-002]** `Digest` を `export` する必要が無く、`@repo/core` のフラットな `exports` の下では汎用名の型が1つ公開 API に増える
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:14`
  - 理由: `Digest` を名前付きの型に括り出したこと自体は round 1 の W-004 の指摘どおりで妥当（3箇所の手書きユニオンが1箇所になり、`StoredHash.digest` / `derive(digest)` の改名で `hash` の語の多義も解消している。実装の意味は変わっていない — `derive` に渡る値も `deriveBits` の `{ hash: digest }` も差分前と同一）。問題は `export` の要否だけで、**この型を参照しているのは同一ファイル内の3箇所だけ**（`hashFor` の戻り、`StoredHash.digest`、`derive` の第4引数）で、テストも他モジュールも参照していない。`packages/core/tsconfig.json` は `"noEmit": true` で宣言ファイルを出さないため、`export` していない型を export された関数のシグネチャに使っても型検査は通る（`hashFor` / `ALGORITHM_ID` の export は steps.md 5-1 / 6-10 がテストからの参照を理由に明示的に決めているので、そちらは前例どおりで妥当）。`ALGORITHM_ID` / `hashFor` と違って `Digest` には「テストが直接呼ぶ」という export の根拠が無く、`@repo/core` の `"./*": "./src/*.ts"` の下では `Digest` という汎用名がアダプターのサブパスから到達可能になる。ポート契約（`domain/identity/ports/passwordHasher.ts:3-7`）が「アルゴリズム・パラメータ・エンコードは完全にアダプターの business」と宣言している以上、外に出さないで済む語彙は出さないほうが契約と整合する。
  - 提案: `export type Digest` → `type Digest` に落とす（他は無変更）。1文字の差で、挙動もテストも変わらない。export を維持するなら、`ALGORITHM_ID` / `hashFor` と同じく**なぜ export するのか**を JSDoc に1行足しておきたい。

- **[W-003]** `MAX_PBKDF2_ITERATIONS` の上限が守る最悪ケースの CPU が 4.2 倍になったのに、据え置きの根拠が案 B の想定のまま
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:89-96`、`.thread/20/plan.md:44`（スコープ「含まれないもの」）
  - 理由: plan.md は `MAX` 据え置きの根拠を「10,000,000 は **600,000 に対しても**十分な余裕がある」と書いており、これは案 B（SHA-256 @ 600k）を前提にした余裕の議論である。確定したのは案 A なので、`MAX` について実際に問われるのは既定値からの余裕ではなく**上限に張り付いた保存値1行が1回のログインで焼く CPU** のほうで、本 PR の実測（`SHA-512 @ 210,000` = 127.2ms / CI x86_64）から外挿すると `10,000,000` 回は **約 6.0 秒**になる（#20 以前の `SHA-256` なら約 1.4 秒）。JSDoc の根拠「A row carrying an absurd count would otherwise turn one login into an unbounded CPU burn (a Worker killed by its CPU limit)」は CF Paid の 30 秒予算に対して依然成立しており、**到達には DB 書き込み権限が要る（JSDoc 自身が「guards data corruption rather than an attacker」と限定している）ので、脅威モデルは変わっていない**。したがって定数を動かす提案ではない。指摘は「据え置きの根拠として plan.md に書かれた文が、確定した案では成立していない」という記録の穴のみ。
  - 提案: 定数もコードも変えず、`.thread/1/adr.md` の「実測結果（#20 / 2026-08-07）」節の観測項目に1行足して閉じる（例:「`MAX_PBKDF2_ITERATIONS = 10,000,000` の最悪ケースは SHA-512 では約 6.0 秒（従来 約 1.4 秒）。CF Paid の 30 秒予算内で、到達には DB 書き込み権限が要るため据え置き」）。round 1 の裁定2（ファクトリ引数のピンの穴を「記録のみ」で閉じた）と同じ扱いでよい。

## 補足: 実際に確認したこと

Warning に上げるほどではないが、名指しされた観点の検証結果と、共有しておきたい観測を残す。

- **レイヤー境界 / 依存方向 — 問題なし。** アダプター → application の参照は `import type` 1文・2シンボル（`DUMMY_PASSWORD_HASH_ALGORITHM_ID` / `DUMMY_PASSWORD_HASH_ITERATIONS`）のみで、`verbatimModuleSyntax: true` の下で実行時のエッジは生まれない。逆向きの漏れは無い — `loginWithPassword.ts:1-10` の import は domain / `../errors` / `../ports` / `../types` だけで、`ALGORITHM_ID` を adapters から引いていない（plan.md R-10 の要求どおり）。`grep -rn "ALGORITHM_ID\|hashFor\|Digest\b"` の全ヒットを確認し、アダプター外の参照はテスト2ファイルだけであることも確認した。
- **ポート契約 — 崩れていない。** `verify` の throw 経路は `parse`（`DataIntegrityError`）と `derive`（`CryptoError`）の2つだけで、照合結果は `timingSafeEqual` の `boolean` に閉じている。SHA-512 でも導出は 32 byte（`DERIVED_BITS = 256`）なので、旧形式・新形式のどちらの保存値でも `timingSafeEqual` が長さ不一致で早期 return する経路には落ちない。`PlainPassword` を例外に載せない条項も従来どおり守られている（`derive` の catch が載せるのは WebCrypto 例外だけ）。
- **エラー契約 — 既存の使い分けどおり。** 未知の識別子は `hashFor` の `null` として既存の「not in a recognised encoding」に合流し `SystemError(DataIntegrityError)`。`CryptoError` は `derive` の catch のみ。`application/errors.ts:190-193` のコメント（「`CryptoError` は WebCrypto が計算を拒否したとき。`DataIntegrityError` は*保存された*ハッシュが読めないとき」）と一致する。plan.md R-9 を満たす。
- **書き出し経路の全域性 — 型で保証されている。** `SHIPPED_HASH: "SHA-512"` → `derive(digest: Digest)` の経路に `null` / `undefined` は型として現れず、`hash()` は `hashFor` を一度も引かない。`ALGORITHM_ID` と `SHIPPED_HASH` の一致は型に出ていないが、**round 1 の裁定1（表を導入せずコードは現状維持）の下では現状が最善形**だと判断する。根拠: (a) 成立しない根拠（`Map` の一節）は削除済みで、残った JSDoc「A table keyed by a literal type would be total as well, but with only two algorithms the cost of keeping the table outweighs what it buys」は裁定1の文言と一致し、事実としても正しい。(b) ドリフトはテストで必ず落ちる — `hashFor("pbkdf2-sha512") === "SHA-512"` と `ALGORITHM_ID === "pbkdf2-sha512"` をリテラルで固定した単体テスト（`:101-105`）に、外部生成の SHA-512 golden vector（`:130-138`）と往復テスト（`:35-38` 他）が重なるので、`SHIPPED_HASH` を単独でずらすと往復が、`ALGORITHM_ID` ごとずらすと型ピンが赤くなる。自己言及を避けてリテラルで書く方針も統合テスト側の正規表現まで一貫している。
- **`hashFor` / `ALGORITHM_ID` / `SHIPPED_HASH` の三者 — 命名と役割の分離は妥当。** 「読める識別子は複数（部分関数）・書く識別子は1つ（全域）」という非対称がそのままコードの形に出ている。`parse()` が `algorithm === undefined ? null : hashFor(algorithm)` と書いているのは `noUncheckedIndexedAccess` 由来の形式的な分岐で（`String.prototype.split` は必ず1要素以上返すので実行時には到達しない）、実害は無い。
- **後方互換 — フィクスチャを独立に再計算して検証した。** `node:crypto` で再導出したところ、旧形式フィクスチャ `pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$…` は `pbkdf2Sync("password123", salt, 1000, 32, "sha256")` と**完全一致**（sha512 では不一致）、新形式フィクスチャ `pbkdf2-sha512$1000$xV4JrROqj4l6BU/mz+2B9g==$…` は `"sha512"` と**完全一致**（sha256 では不一致）。テストのコメントが主張する「SHA-512 の枝が本当に走ったことを意味する」は事実である。ダミーハッシュの salt / derived も 16 / 32 byte で、方式変更後も `parse` を通る。保存形式の文字列長は不変（`pbkdf2-sha256` と `pbkdf2-sha512` は同じ 13 文字）なので D1 スキーマ・マイグレーションへの影響は無い。
- **`DERIVED_BITS = 256` は SHA-512 でも妥当。** PBKDF2 のブロック数は `ceil(dkLen / hLen)` = `ceil(32 / 64)` = 1 で、SHA-256 のときと同じ 1 ブロック。反復回数が実効的に倍になる罠（`ceil` が 2 以上）は踏んでいない。`.thread/20/adr.md` ADR-001 末尾の記述と一致する。
- **DI 配線 — 取りこぼし無し。** `createPbkdf2PasswordHasher` の本番呼び出しは `packages/core/src/application/di/serverCloudflare.ts:145` の1箇所のみで、引数なし＝既定値なので新しい方式に自動追随する。`di/` 配下の他ファイル（`env.ts` / `secrets.ts` / `containerStore.ts` / `types.ts`）にハッシュ方式は現れず、wrangler 設定・環境変数・シードにも無い。`apps/web` 側でハッシャーに触れるのは presentation のテストのスタブ3件だけ。
- **JSDoc の照合 — W-001 の1件を除いて実装と一致。** `hashFor` の JSDoc（プロトタイプキー / 表の維持コスト / 旧枝の退役条件）、`SHIPPED_HASH` の「`hashFor` を引かないので `null` が書き出し経路に現れない」、ファクトリ JSDoc の「読む形式は書く形式より広い」、`DEFAULT_PBKDF2_ITERATIONS` の「ピンはアルゴリズムにも掛かった」「salt と digest だけが任意」「残差は cost or algorithm」はいずれも実装どおり。`loginWithPassword.ts` 側の新 JSDoc（ピンの向き、ダミーが取り残されても parse も verify も成功して警告が出ない、という R-3 の説明）も実装と一致する。
- **`packages/core/src/adapters/d1/__tests__/{userRepository,unitOfWork}.integration.test.ts` に `pbkdf2-sha256$1$c2FsdA==$aGFzaA==` が残っている。** plan.md「含まれないもの」はドメインテストのフィクスチャしか挙げていないが、この2件も同じく**リポジトリが解釈しない不透明文字列**として使われているだけ（`PasswordHasher` を通らない）なので、更新不要という結論は変わらない。旧枝を将来削除しても壊れない。
- **ローカル実行での確認。** `pnpm vitest run packages/core/src/adapters/webcrypto` → 87 件 pass（tests 101ms）。`pnpm vitest run --config vitest.config.integration.ts packages/core/src/application/identity` → 36 件 pass（AC-8 の workerd 上での裏取り）。`_probe.integration.test.ts` は作業ツリーにも `git diff --stat` にも無い（AC-3）。
- **⚠️ `pnpm typecheck` が1度だけ赤くなった（再現せず / 共有のみ）。** 本レビューの最初の実行で `src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts(330,5): error TS2578: Unused '@ts-expect-error' directive.`（＝本 PR が新設した `ALGORITHM_ID` のピン検査）が出た。ソースは一切変更していない状態で、その後 **root `pnpm typecheck` 3回・`packages/core` の `tsgo` 単体 28回・`tsc --noEmit` 1回すべてクリーン**。ピン自体は意味的に正しく（`typeof ALGORITHM_ID` は `"pbkdf2-sha512"` なので `"pbkdf2-sha256"` の代入は本物のエラー）、`tsc` も緑なので**コード側の欠陥ではなく `tsgo` 側の非決定性**と考えている。ただし本 PR は**同一ファイル内の `@ts-expect-error` を1件から2件へ増やす**変更であり、AC-11 / AC-14 が typecheck の緑を受け入れ基準に置いている以上、CI の `lint-typecheck-unit` がまれに同じ形で赤くなる可能性を共有しておく（対処は再実行で足り、本 PR で取れる修正は無い）。

## カバレッジ

- 確認: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`
- 確認: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`
- 確認: `packages/core/src/application/identity/loginWithPassword.ts`
- 確認: `packages/core/src/application/identity/__tests__/identity.integration.test.ts`
- 確認: `.thread/20/plan.md`（受け入れ基準 AC-4〜AC-9 / AC-11 / AC-15 とスコープ「含まれないもの」を判定基準として使用）
- 確認: `.thread/20/adr.md`（ADR-001 の判定ゲート・OWASP 引用の書き分け・`DERIVED_BITS` の据え置き根拠、ADR-002 の旧枝保持と型ピンの二層論）
- 確認: `.thread/20/steps.md`（ステップ3-2 / 4 / 5【案 A】/ 6 / 7 と実装の一致を照合。実装は指示どおりで、W-001 は指示そのものが ADR の訂正に追随していない）
- 確認: `.thread/1/adr.md`（ADR-003 の訂正ブロック・「実測結果（#20 / 2026-08-07）」節・ADR-026 / 034 の追随 — W-001 / W-003 の根拠）
- 確認: `.thread/1/progress.md`（残差 97ms の記録とアルゴリズムピンへの追随がアダプター JSDoc と対で直っていること）
- 確認（差分外・判断のため）: `packages/core/src/domain/identity/ports/passwordHasher.ts` / `packages/core/src/application/di/serverCloudflare.ts` / `packages/core/src/adapters/webcrypto/encoding.ts` / `packages/core/src/application/errors.ts` / `packages/core/tsconfig.json` / `spec/inventory/adapter.md` / `spec/domains/identity.md` / `docs/test.md`
- スキップ: `.thread/20/review/review-001-{adapter,docs,security,test}.md` / `.thread/20/review/triage.md` — round 1 のレビュー成果物（Phase 8 で削除予定）。裁定内容の把握のためにのみ参照し、レビュー対象とはしていない
- スキップ: `.thread/20/testing.md` — 手動テスト手順書であり、Adapter / Infrastructure 観点の判定材料にならない（保存ハッシュの目視確認手順が新形式・旧形式を覆っているかは round 1 で確認済み）
