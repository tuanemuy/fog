# レビュー 003 — Test 観点 / PR #53（Issue #20）

round 3。ゼロベースで差分全量を確認し、受け入れ基準 AC-1〜AC-15 のうちテストで担保されるべきものを変異注入で検証した。

## Test

### Blockers

なし。

### Warnings

- **[W-001]** `ALGORITHM_ID` の型ピンのコメントが、3層目（統合テストのリテラル正規表現）に「アダプター側の `: typeof …` 注釈が外れたこと」の検出を割り当てているが、変異注入では**注釈の除去そのものはどのゲートも検出しない**
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:326-328`
  - 検証（分離ワークツリー / 変異 M-D）: アダプターの `export const ALGORITHM_ID: typeof DUMMY_PASSWORD_HASH_ALGORITHM_ID = "pbkdf2-sha512"` から注釈と `import type` を落としただけの状態で、`tsgo` = 緑 / unit 87 件 = 全緑 / `identity.integration.test.ts` 36 件 = 全緑。統合テストの `^pbkdf2-sha512\$` は**ダミー側の値から組み立てられた文字列**を見ているので、アダプター側の注釈が消えたこと自体には反応しない
  - 補足（変異 M-E）: M-D に加えて `DUMMY_PASSWORD_HASH_ALGORITHM_ID` を `"pbkdf2-sha256"` へずらすと、typecheck 緑・unit 全緑のまま統合テスト `burns against a hash the production hasher derives from…` の1件だけが赤くなった。つまり統合テストが覆うのは「**注釈が外れた後に application 側の定数がずれること**」であって、注釈の除去ではない。統合テスト側のコメント（`identity.integration.test.ts:648-654`）はこの向きを正しく限定して書けている（「What this catches is drift in the dummy's own constants … drift on the adapter's side falls to the unit tests and to TC-loginWithPassword-009」）ので、**不正確なのは単体テスト側の要約1文だけ**
  - 提案: 同ファイル `:303-307`（`DEFAULT_PBKDF2_ITERATIONS` 側）も同じ言い回しなので、両方を「注釈が外れた**後に**残る網」と読める形に揃える。文言案 — `… and the literal `pbkdf2-sha512` regex in `identity.integration.test.ts` for what stays visible once that annotation is gone: the application-side constant drifting away from it.` コード・テストの変更は不要（守備範囲そのものは設計どおりで、穴は無い）

## 変異注入の記録

分離ワークツリー（`git worktree add` → `git worktree remove --force`）で実施。ベースラインは unit 87 件全緑 / integration（`packages/core/src/application/identity`）36 件全緑 / `tsgo` 緑。

| # | 変異 | typecheck | unit | integration | 判定 |
|---|---|---|---|---|---|
| M-A | `SHIPPED_HASH` を `"SHA-256"` へ（`ALGORITHM_ID` は据え置き） | — | **4 件赤**（`verifies a password it hashed` / `draws a fresh salt per call` / `reads the iteration count back…` / `accepts exactly the floor…`） | — | ADR-002 の「往復テストが必ず赤くする」＝**成立**。裁定1（表引きを採らない）の根拠が実証された |
| M-B | `DUMMY_PASSWORD_HASH_ALGORITHM_ID: string` へ拡張 | **TS2578**（`pbkdf2PasswordHasher.test.ts:330`） | — | — | AC-9 のアルゴリズム型ピンが assertion として**機能する** |
| M-B' | `DUMMY_PASSWORD_HASH_ALGORITHM_ID: "pbkdf2-sha512" \| "pbkdf2-sha256"`（「まだ読めるユニオンへの拡張」） | **TS2578** | — | — | コメント `:322` の「a union that still reads, is caught here」も**成立** |
| M-C | `DUMMY_PASSWORD_HASH_ITERATIONS: number` へ拡張 | **TS2578**（`:309`） | — | — | 既存の反復回数ピンも**機能する** |
| M-D | アダプターの `ALGORITHM_ID` から `: typeof …` を除去 | 緑 | 全緑 | 全緑 | → W-001 |
| M-E | M-D ＋ `DUMMY_PASSWORD_HASH_ALGORITHM_ID = "pbkdf2-sha256"` | 緑 | 全緑 | **1 件赤**（`burns against a hash…`） | 統合テストのコメントの主張どおり。**「最後の砦」の方向の限定は正確** |
| M-F | アダプターの `DEFAULT_PBKDF2_ITERATIONS` から `: typeof …` を除去 ＋ `DUMMY_PASSWORD_HASH_ITERATIONS = 150_000` | 緑 | 全緑 | **1 件赤**（同上） | `:303-307` の「What covers that case is the runtime comparison in `identity.integration.test.ts`」も**成立** |
| M-G | `verify` が `stored.digest` ではなく `SHIPPED_HASH` で導出 | — | **1 件赤**（`still verifies a hash written in the pre-#20 SHA-256 encoding`） | — | AC-7 の旧枝リグレッションが**唯一の生存確認**として機能している |
| M-H | `derive` の鍵素材に pepper を混入（`encode(plain)` → `encode(\`${plain}x\`)`） | — | **2 件赤**（旧形式フィクスチャ＋出荷形式 golden vector のみ） | — | 往復テストは全緑のまま。golden vector のコメントが述べる「a round trip cannot see a change to what `derive` feeds WebCrypto」が**そのとおり実証された**。ADR-002:136 の「削除時に確認する1点」も裏が取れた |

## 個別の確認結果

### golden vector 2本（`node:crypto` で自前に再計算）

`node -e` で `crypto.pbkdf2Sync` を直接回して照合した。**2本とも本物**。

- 旧形式 `pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$6hroV6AYx3/sZCNZ2b6b5dEvGwem7QxDxqru/lNUeiQ=`
  → `pbkdf2Sync("password123", salt, 1000, 32, "sha256")` = `6hroV6AYx3/sZCNZ2b6b5dEvGwem7QxDxqru/lNUeiQ=` **一致**
- 出荷形式 `pbkdf2-sha512$1000$xV4JrROqj4l6BU/mz+2B9g==$i5P8QP0hYHeNdKtkyb1rETDplCkz+X7QmHsa1UC9YKA=`
  → `pbkdf2Sync("password123", salt, 1000, 32, "sha512")` = `i5P8QP0hYHeNdKtkyb1rETDplCkz+X7QmHsa1UC9YKA=` **一致**
- 弁別性: 同じ salt での SHA-256 導出は `vRCtX0MoXdrCZmx5w8iDccf7JwiYB+iRuXRavoAcOfs=` で別値。旧 salt での SHA-512 導出も別値。したがってテストコメントの「confirmed to differ from the SHA-256 derivation of the same inputs, so passing it means the SHA-512 branch really ran」は**正しい**

### `@ts-expect-error` によるピン2本

M-B / M-B' / M-C のとおり、両方とも**拡張のあらゆる形に対して TS2578 で赤くなる**。assertion として機能している（AC-9 / AC-11）。ピンが覆わない範囲（注釈の除去そのもの、ファクトリ引数 `iterations` 経由の配線）は M-D の結果と裁定2 のとおりで、後者は ADR-003 Consequences に残穴として記録済み。

### 自己言及の有無

自己言及になっているテストは**無い**。

- `expect(ALGORITHM_ID).toBe("pbkdf2-sha512")` / `hashFor("pbkdf2-sha512")` / `expect(DEFAULT_PBKDF2_ITERATIONS).toBe(210_000)` — すべてリテラル
- 統合テストの `` new RegExp(`^pbkdf2-sha512\\$${DEFAULT_PBKDF2_ITERATIONS}\\$`) `` — 識別子はリテラル、反復回数はアダプター側定数で、比較相手（`dummy`）は application 側定数から作られる**別モジュールの値**。M-E / M-F が示すとおり実際に検出力を持つ
- ADR-002:112 が禁じた `expect(hashFor(ALGORITHM_ID)).toBe(SHIPPED_HASH)` の形は**採られていない**

### round 2 の変更がテストの検証力を落としていないか

- **`Digest` の非 export 化** — テストは `Digest` を import しておらず（`ALGORITHM_ID` / `hashFor` / `DEFAULT|MIN|MAX_PBKDF2_ITERATIONS` / `createPbkdf2PasswordHasher` のみ）、`hashFor(...)` の戻り値は `.toBe("SHA-512")` / `.toBeNull()` のリテラルで見ている。`tsgo` も緑。**検証力の低下なし**
- **統合テストのコメントの書き直し** — M-E / M-F で守備範囲と一致することを確認。**記述は正確**（W-001 は単体テスト側の要約1文のみ）
- **`DEFAULT_PBKDF2_ITERATIONS` の JSDoc 圧縮** — 単体テスト `:297-307` が依拠する記述（「Typed as the login path's `DUMMY_PASSWORD_HASH_ITERATIONS` rather than as `number`」と、`ALGORITHM_ID` への相互参照）は**両方とも残っている**。削られたのは未出典のキャリブレーション断定と版指定だけで、テストが参照する部分ではない

### 本番強度（210,000 回）の実導出を踏むテストの件数

**2 件で据え置き**（R-6 充足）。`createPbkdf2PasswordHasher()` を引数なしで呼ぶテストは全リポジトリで次の2箇所のみ:

- `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:219`（node プール、実測 50ms）
- `packages/core/src/application/identity/__tests__/identity.integration.test.ts:642`（workerd プール）

他の `createPbkdf2PasswordHasher(...)` 呼び出しはすべて `iterations: 1_000` / `2_000` / `MIN_PBKDF2_ITERATIONS` の低コスト注入か、`serverCloudflare.ts` の本番配線。unit 全体は 24 ファイル 417 件で 1.45s、`pbkdf2PasswordHasher.test.ts` 単体は 38 件 237ms なので `docs/test.md` の記述への実害もない。

### 捨てプローブの撤去（AC-3）

- `packages/core/src/application/identity/__tests__/` に `_probe.integration.test.ts` は**存在しない**（残るのは `eventDecoders.test.ts` / `identity.integration.test.ts` / `loginWithPassword.test.ts` / `logout.test.ts`）
- `git diff origin/main...HEAD --stat -- vitest.config.integration.ts .github/workflows/ci.yml` が**空**（設定ファイルの一時編集は発生していない）
- `git status --short` も空

なお AC-3 の残る1項目「プローブ撤去後の CI ランで `integration` が緑」は round 1・2 の台帳で fix 済み扱いだが**リポジトリ内からは検証できない**（最終 head の CI 結果）。台帳の「再指摘 1」のまま、完了報告での run URL 提示に委ねる。

### AC 別のテスト担保状況

| AC | 担保箇所 | 判定 |
|---|---|---|
| AC-4 | `takes the OWASP default for its algorithm when given no argument`（`:218-222`、引数なしのハッシャーの先頭2フィールド） | ✅ 権威が1件に一本化されている |
| AC-5 | `encodes algorithm, iterations, salt and derived key`（`:61-62`、salt 16 byte / derived 32 byte） | ✅ |
| AC-6 | `writes one identifier and derives with the digest it names`（リテラル）＋ 拒否ケース表 14 行（`constructor` / `__proto__` / `empty algorithm` / `too many fields` を含む） | ✅ |
| AC-7 | `still verifies a hash written in the pre-#20 SHA-256 encoding`（golden vector 実物） | ✅ M-G で唯一性も確認 |
| AC-8 | `burns against a hash the production hasher derives from, not just any string`（本番強度の `verify` が `false` に落ち、かつ先頭2フィールドがリテラル正規表現に一致） | ✅ M-E / M-F で検出力を確認 |
| AC-9 | 型ピン2本 ＋ `@ts-expect-error` 2件 | ✅ M-B / M-B' / M-C |
| AC-10 | `grep -n "OWASP\|210k"` の残存ヒットは `:25`（`PBKDF2-HMAC-SHA512 at 210k`）/ `:92` / `:94` / `:218` の4件で、いずれも確定方式と組になった記述 | ✅ |
| AC-11 | `pnpm typecheck` 緑 | ✅ |
| AC-14 | `pnpm test:unit` 24 ファイル 417 件緑 / `pnpm test:integration:cf` 9 ファイル 104 件緑 / `pnpm lint` 緑（infos 2 件は変更ファイル外の既存分）/ `pnpm format:check` 緑 | ✅ |

AC-1 / AC-2 / AC-12 / AC-13 / AC-15 は実測記録・ADR・JSDoc の文面が対象なので Docs / Adapter 観点へ委ねる（AC-15 の grep だけ機械確認: `pbkdf2PasswordHasher.ts` の `SHA-256` 残存ヒットは `:14` の `type Digest` と `:37` の `hashFor` 旧枝の2件で、いずれも旧読み取り枝の記述）。

### `.thread/20/testing.md`（手動確認計画）

テスト観点で読める範囲では整合している。確認項目2 の期待値（`pbkdf2-sha512` / `210000` / derived 32 byte）、確認項目5 の低コスト旧形式フィクスチャ、異常系2 の `argon2id$1000$c2FsdA==$aGFzaA==` は、いずれも単体テストが固定している値と一致する。「対象外（実機では確認しないこと）」の割り振り（AC-6 の識別子対応・拒否ケース表を単体テストの権威に置く）も `docs/test.md` の階層分けと矛盾しない。

## カバレッジ

- 確認: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`, `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`, `packages/core/src/application/identity/__tests__/identity.integration.test.ts`, `packages/core/src/application/identity/loginWithPassword.ts`, `.thread/20/plan.md`, `.thread/20/testing.md`, `.thread/20/review/triage.md`（裁定メモ）, `docs/test.md`, `CLAUDE.md`
- 部分確認: `.thread/20/adr.md` — ADR-002（往復テストの二層検出・旧枝の退役条件・golden vector の削除時確認）と ADR-003（ピンの残穴）のテスト関連記述のみ照合。実測値・CI ラン来歴は Docs 観点へ
- 部分確認: `.thread/20/steps.md` — ステップ3-2（フィクスチャ採取）とステップ6（テスト改訂指示）のみ照合
- 部分確認: `.thread/1/progress.md` — テスト観点での担保対象なし。差分内容を目視のみ
- スキップ: `.thread/1/adr.md` — ADR 本文の訂正で、テスト観点の担保対象を含まない（Docs 観点）
- スキップ: `.thread/20/review/**`（9ファイル）— 過去ラウンドのレビュー成果物。`triage.md` の裁定メモのみ読了

## 判定

**マージ可能。** Blocker なし。W-001 はコード変更を伴わないコメント1文の精度の問題で、マージを止めない。
