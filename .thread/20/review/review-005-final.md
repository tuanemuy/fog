# レビュー round 5（最終確認） — PR #53 / Issue #20

**視点:** Code / Test / Documentation の3レンズ
**対象:** `origin/main...HEAD`（HEAD = `d2cc576`）、特に `32eb1c7..HEAD`
**検証環境:** `git worktree add` で分離した作業ツリー（検証後 `git worktree remove --force` 済み）

## Final Review

### Blockers

- **なし**

### Warnings

- **なし**

round 4 の3件の修正はいずれも**実装・実測と一致している**ことを分離ワークツリーでの変異注入により確認した。ゲート全件がローカルで緑（typecheck 0 / lint 0 / format:check 0 / unit 417 passed / integration 104 passed）。

## round 4 の3件の修正の検証

### 修正1 — `identity.integration.test.ts:608-620` のコメント（アルゴリズム差し替え時の挙動）

書き直し後の主張は「アルゴリズム差し替えは *equalisation cost nothing* ではなく、`pbkdf2-sha256` 枝が読めるのでダミーは verify され続け、**間違ったコストで**動く」。

**変異注入 C で実測確認した。** R-3 が描く経路（ピンの注釈が外れたうえでダミーが旧アルゴリズムに取り残される）を再現するため、分離ワークツリーで

- `ALGORITHM_ID` から `: typeof DUMMY_PASSWORD_HASH_ALGORITHM_ID` の注釈を除去（値は `"pbkdf2-sha512"` のまま）
- `DUMMY_PASSWORD_HASH_ALGORITHM_ID` を `"pbkdf2-sha256"` へ

を当てた結果:

| ゲート | 結果 |
|---|---|
| `pnpm --filter @repo/core typecheck` | **緑**（ピンが外れているので当然） |
| `pnpm test:unit` | **緑**（24 files / 417 passed） |
| `pnpm test:integration` | **`burns against a hash the production hasher derives from` の1件だけ赤** |

赤くなった箇所が決定的である。失敗は
`AssertionError: expected 'pbkdf2-sha256$210000$IPASLZIobSfU953I…' to match /^pbkdf2-sha512\$210000\$/`
であり、**その手前の `createPbkdf2PasswordHasher().verify(...)` は `resolves.toBe(false)` を満たして通過している** — つまり本番ハッシャーは旧形式のダミーを throw せず読み切り、SHA-256 @ 210,000 という**間違ったコスト**で導出していた。等時化はゼロにならず、間違ったコストで成立していた。新しいコメントの記述と完全に一致する。旧コメント（「アルゴリズム差し替えも equalisation cost nothing になる」）が事実と異なっていたことも同時に確認できた。

「The fake never parses its input, so this is the only place that can notice either」も、上表のとおり typecheck / unit がどちらも緑のまま、integration のこの1件だけが赤くなったことで裏付けられている。

### 修正2 — `pbkdf2PasswordHasher.test.ts:305-310` のゲート分業表への補足

追記された文言は「drift in the adapter's own value: the unit tests in this file（**ピンが掛かっている間は型検査も同時に捕まえる。リテラルが `typeof` を満たさなくなるため**）」。

**変異注入 A / B で両方の定数について確認した。**

- 変異 A: `DEFAULT_PBKDF2_ITERATIONS = 210_000` → `300_000`（注釈はそのまま）
  - typecheck: `error TS2322: Type '300000' is not assignable to type '210000'.`（赤）
  - unit: `declares the OWASP count for the algorithm it ships` が赤（1 failed / 86 passed）
- 変異 B: `ALGORITHM_ID = "pbkdf2-sha512"` → `"pbkdf2-sha256"`（注釈はそのまま）
  - typecheck: `error TS2322: Type '"pbkdf2-sha256"' is not assignable to type '"pbkdf2-sha512"'.`（赤）

「unit テストが捕まえる」も「ピンが掛かっている間は型検査も同時に赤くなる」も、**両ピンについて成立する**。補足は正確である。なお同ブロックが並記する他の3行（アプリケーション側定数の拡幅 → `@ts-expect-error`、注釈が消えた後のドリフト → 統合テスト、注釈の除去そのものは何も捕まえない）は、変異 C の結果（typecheck・unit 緑、統合1件だけ赤）と矛盾しない。

### 修正3 — `.thread/1/adr.md` への行番号参照3件の節名化

`plan.md` AC-13 行 / `steps.md` ステップ5【案 A】7 / ステップ9-2 の `.thread/1/adr.md:1221` が、いずれも
`.thread/1/adr.md` の ADR-034（Consequences の「残る限界」）
へ置き換わっている。参照先の実在を確認した — `.thread/1/adr.md:1255` に `## ADR-034: ダミーハッシュの反復回数を…`、その `### Consequences` に「- 残る限界: …この限界は `DEFAULT_PBKDF2_ITERATIONS` の JSDoc と `progress.md` に書いた」が実在する。**参照が指しているのは節名どおりの内容であり、追記による行番号ずれの再発もこれで断たれている。** `.thread/20/adr.md` 側は round 3 で既に節名参照化済みで、今回の3件で同種の参照は残っていない。

## 受け入れ基準の充足

| AC | 判定 | 何を見て判断したか |
|---|---|---|
| AC-1 | 充足 | `.thread/1/adr.md`「実測結果（#20 / 2026-08-07）」節。G-0 は「通過」（ローカル・CI とも `supported: true`）。CI（`ubuntu-latest` = x86_64 の `integration` ジョブ）の min / 中央値 / max が `SHA-512 @ 210k` = 126.6 / 127.2 / 139、`SHA-256 @ 600k` = 86.2 / 86.2 / 86.4 で表になっており、ワークフロー実行 URL `https://github.com/tuanemuy/fog/actions/runs/31121514993` と attempt 1〜4 の内訳（1〜2 はランナー確保失敗、3・4 が完走）まで記載。回収手段（プローブが故意に投げる `Error`）がローカル・CI 共通である旨も同節に明記 |
| AC-2 | 充足 | 同節の「**確定した判定ゲートの行: `G-1`（`t_A ≤ 2.0 × t_B` → 127.2 ≤ 172.4）→ 案 A**」。比 1.476 がノイズ再測帯（1.8〜2.2）の外である旨、attempt 3 の比 1.508 も同じ `G-1` に落ちる旨も併記され、実測値とゲート行の対応だけで案が決まっている。100ms 超過は「観測項目（判定には使っていない）」として明示的にゲート外に置かれており、ゲート表の外に追加条件は無い |
| AC-3 | 前半充足 / 後半は既知の未達（指摘対象外） | `packages/core/src/application/identity/__tests__/` の実ファイルは `eventDecoders.test.ts` / `identity.integration.test.ts` / `loginWithPassword.test.ts` / `logout.test.ts` の4件のみでプローブは不在。`git status --short` は空。`git diff origin/main...HEAD -- vitest.config.integration.ts .github/` が**完全に空**（設定ファイルの一時編集は発生していない）。後半（プローブ撤去後の CI 緑）は GitHub Actions 側の詰まりで未確認 — 指示により指摘対象外 |
| AC-4 | 充足 | `pbkdf2PasswordHasher.test.ts` の `takes the OWASP default for its algorithm when given no argument`（`createPbkdf2PasswordHasher()` を引数なしで呼び、先頭2フィールドが `"pbkdf2-sha512"` と `String(DEFAULT_PBKDF2_ITERATIONS)`）と `declares the OWASP count for the algorithm it ships`（`DEFAULT_PBKDF2_ITERATIONS === 210_000`）。実際に unit スイートを走らせて緑を確認 |
| AC-5 | 充足 | `pbkdf2PasswordHasher.ts:58` が `DERIVED_BITS = 256` のまま。`encodes algorithm, iterations, salt and derived key` が `atob(salt)` = 16、`atob(derived)` = 32 を表明。unit スイート緑 |
| AC-6 | 充足 | `hashFor` が全域関数（`pbkdf2-sha512` → `"SHA-512"` / `pbkdf2-sha256` → `"SHA-256"` / それ以外 `null`）で、書き出しは `ALGORITHM_ID` + `SHIPPED_HASH` の直参照。拒否ケース表に `prototype key as algorithm`（`constructor$…`）と `__proto__ as algorithm` の2行があり、いずれも `SystemError(DATA_INTEGRITY_ERROR)` を表明。`writes one identifier and derives with the digest it names` が **リテラルで** `ALGORITHM_ID === "pbkdf2-sha512"` / `hashFor("pbkdf2-sha512") === "SHA-512"` / `hashFor("argon2id") === null` を固定（定数どうしの突き合わせになっていないことをコメントで宣言済み） |
| AC-7 | 充足 | `still verifies a hash written in the pre-#20 SHA-256 encoding` がハードコードした `pbkdf2-sha256$1000$…` を verify → `true`、誤パスワード → `false` を表明し、実行して緑。加えて出荷形式側の外部生成フィクスチャ（`verifies a SHA-512 hash it did not write itself`）が独立に置かれており、旧枝を撤去してもこちらは残る構成になっている |
| AC-8 | 充足 | `identity.integration.test.ts` の `burns against a hash the production hasher derives from…`。実ハッシャー（`createPbkdf2PasswordHasher()` = 本番パラメータ）で `verify` が **throw せず** `false` を返すこと、および `^pbkdf2-sha512\$210000\$` にマッチすることの2点を表明。変異 C で「この2つの表明のうち regex だけが落ちる」＝ダミーが読める状態と読めない状態を区別できていることも確認 |
| AC-9 | 充足 | `loginWithPassword.ts:51` の `DUMMY_PASSWORD_HASH_ALGORITHM_ID` と `pbkdf2PasswordHasher.ts:48` の `ALGORITHM_ID: typeof DUMMY_PASSWORD_HASH_ALGORITHM_ID`。**変異 B で型検査が実際に赤くなることを実測**（`TS2322`）。依存方向は `adapters → application` の `import type` で R-10 を満たす |
| AC-10 | 充足 | `grep -n "OWASP\|210k" packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts` の残存ヒットは 25 行（`Production strength is PBKDF2-HMAC-SHA512 at 210k iterations`）、92-94 行（`declares the OWASP count for the algorithm it ships`）、218 行（`takes the OWASP default for its algorithm when given no argument`）で、**すべて確定した方式（SHA-512）と組**になっている。plan.md が挙げた旧3箇所の文言は残っていない |
| AC-11 | 充足 | 分離ワークツリーで `pnpm typecheck` を実行 → exit 0（`tsgo` + `pnpm -r typecheck` の3プロジェクトすべて Done）。`@ts-expect-error` 2件も「抑制すべきエラーが無い」で落ちていない |
| AC-12 | 充足 | `.thread/1/adr.md:94-96` の一括訂正注記（射程はアルゴリズム識別子だけ／210,000 は #20 後も現行値、と明示）＋ ADR-003 Decision 直下の OWASP 取り違え訂正ブロック（出典 URL と参照日 2026-08-07、3行の表を掲載）＋「実測結果（#20 / 2026-08-07）」節＋「訂正: PBKDF2-HMAC-SHA512 へ切り替える」節。CPU 予算は 213 行に残る。AC-12(d) の grep（`210,000\|210_000\|210000\|pbkdf2-sha256\|PBKDF2-HMAC-SHA256\|PBKDF2-SHA256`）の残存ヒットを全件目視 — 114/118/121/124-134/148-162 は ADR-003 の当時記録と訂正ブロック本体、632/1024/1058/1249/1263 は本文修正または `#20 以降は…` の括弧書き付き、881/1020/1274-1275 は現行値である 210,000 への言及。矛盾したまま残っている行は無い |
| AC-13 | 充足 | `.thread/1/progress.md` の (a) 82 行相当が「実装は WebCrypto PBKDF2-HMAC-SHA512（ADR-003 / 方式は #20 で SHA-256 から変更）」、(b) 見出しが「旧コスト・**旧アルゴリズム**の保存ハッシュが残る間の等時間化」へ広がり、ピンが `ALGORITHM_ID` にも掛かった旨・残差が「旧コストまたは旧アルゴリズム」へ広がった旨・残差の大きさ（約 97ms、CI 実測の出典付き）・「本番に行が1つも無い」への根拠の書き換えがすべて入っている。対になるアダプター JSDoc 側（`pbkdf2PasswordHasher.ts:77-79` の `an earlier cost or algorithm`）も広がっており、ADR-034 が言う2箇所の対が保たれている |
| AC-14 | 充足 | 分離ワークツリーで4ゲートを実行 — `pnpm test:unit` 24 files / 417 passed、`pnpm test:integration` 9 files / 104 passed、`pnpm lint` exit 0、`pnpm format:check` exit 0（167 files, no fixes） |
| AC-15 | 充足 | `grep -n "SHA-256\|SHA256" packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` の残存ヒットは 14 行（`type Digest = "SHA-256" \| "SHA-512"`）と 40 行（`hashFor` の旧読み取り枝）の2件のみで、いずれも**旧読み取り枝そのもの**。ファクトリ JSDoc（192-221 行）は `PBKDF2-HMAC-SHA512` / `pbkdf2-sha512$…` へ直り、「読める形式は複数・書く形式は1つ」も明記。22-24 行相当（`nothing else in the dummy needs regenerating`）は「アルゴリズム識別子も第2のピンで覆われた／任意のままなのは salt と digest だけ」へ、26-28 行相当は `an earlier cost or algorithm` へ書き換わっている |

**満たされていない AC: なし**（AC-3 後半のみ既知の未達で、指摘対象外）。

## カバレッジ

- 確認: `git diff 32eb1c7..HEAD` 全件（コード2ファイル / ドキュメント4ファイル）。コード側の変更はコメント2箇所のみで挙動の変更ゼロであることを diff で確認
- 確認: `git diff origin/main...HEAD` のソース4ファイル（`pbkdf2PasswordHasher.ts` / `pbkdf2PasswordHasher.test.ts` / `loginWithPassword.ts` / `identity.integration.test.ts`）を全文または全 hunk で通読
- 確認: 分離ワークツリー（`git worktree add` → 検証 → `git worktree remove --force`）での変異注入3種
  - A: アダプター側 `DEFAULT_PBKDF2_ITERATIONS` のドリフト → typecheck 赤 + unit 赤
  - B: アダプター側 `ALGORITHM_ID` のドリフト → typecheck 赤
  - C: ピンの注釈除去 + ダミーが旧アルゴリズムに取り残される → typecheck 緑 / unit 緑 / 統合テスト1件だけ赤、かつ**ダミーは throw せず verify され続ける**
- 確認: 全ゲートのベースライン実行（typecheck / lint / format:check / test:unit / test:integration）— すべて緑
- 確認: AC-1〜AC-15 を1件ずつ、根拠となるファイル・行・実行結果に当てて判定
- 確認: `.thread/20/review/triage.md` の裁定メモ6件 — 裁定済み事項（`hashFor` の表引き、ファクトリ引数のピン、`parse()` の長さ検証、レート制限 / rehash-on-login、ADR 昇格）は再提案していない
- 未確認: プローブ撤去後の CI ラン（GitHub Actions 側の詰まりにより最新コミットに対するランが未作成 — 既知の未達として指摘対象外）

## 結論

**マージ可能。** round 4 の3件の修正はいずれも実装・実測と一致しており、変異注入で裏付けが取れた。新規の Blocker / Warning は無く、受け入れ基準は AC-3 後半（CI ラン。既知・指摘対象外）を除いて全件充足している。**収束したと判断する。**
